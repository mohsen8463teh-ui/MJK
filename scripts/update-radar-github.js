const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const OUT = path.join(process.cwd(), 'radar-data');
fs.mkdirSync(OUT, { recursive: true });

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 MJK-Radar/1.0',
  'Accept': '*/*',
  'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache'
};

function request(url, timeout = 20000, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      return reject(new Error('too many redirects'));
    }

    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;

    const req = lib.get(u, { headers: HEADERS }, res => {
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        res.resume();
        return resolve(
          request(
            new URL(res.headers.location, u).toString(),
            timeout,
            redirects + 1
          )
        );
      }

      let body = '';
      res.setEncoding('utf8');

      res.on('data', x => {
        body += x;
      });

      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(
            new Error(`HTTP ${res.statusCode}`)
          );
        }

        resolve(body);
      });
    });

    req.setTimeout(timeout, () => {
      req.destroy(new Error('timeout'));
    });

    req.on('error', reject);
  });
}

async function get(url, attempts = 2) {
  let last;

  for (let i = 0; i < attempts; i++) {
    try {
      return await request(url);
    } catch (e) {
      last = e;

      if (i + 1 < attempts) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }

  throw last;
}

function num(v) {
  const n = Number(
    String(v ?? '')
      .replace(/,/g, '')
      .trim()
  );

  return Number.isFinite(n) ? n : null;
}

function parseMarketWatch(raw) {
  const parts = raw.split('@');

  if (parts.length < 3) {
    throw new Error(
      `invalid MarketWatch response: ${parts.length} parts`
    );
  }

  const rows = (parts[2] || '').split(';');
  const result = [];

  for (const row of rows) {
    const x = row.split(',');

    if (x.length < 26) continue;

    const insCode = String(x[0] || '').trim();
    const isin = String(x[1] || '').trim();
    const symbol = String(x[2] || '').trim();
    const name = String(x[3] || '').trim();

    const last = num(x[7]);
    const close = num(x[6]);
    const prev = num(x[13]);

    if (!insCode || !symbol || last == null) continue;

    result.push({
      insCode,
      isin,
      symbol,
      name,
      last,
      close,
      prev,
      change:
        prev && last != null
          ? ((last - prev) / prev) * 100
          : null,
      vol: num(x[9]),
      value: num(x[10]),
      trades: num(x[8]),
      eps: num(x[14]),
      flow: num(x[17]),
      yval: String(x[22] || '').trim(),
      hEven: num(x[4]),
      open: num(x[5]),
      min: num(x[11]),
      max: num(x[12]),
      baseVol: num(x[15])
    });
  }

  if (!result.length) {
    throw new Error('no valid MarketWatch rows');
  }

  return result;
}

async function legacyDirect() {
  const urls = [
    'http://old.tsetmc.com/tsev2/data/MarketWatchInit.aspx?h=0&r=0',
    'http://www.tsetmc.com/tsev2/data/MarketWatchInit.aspx?h=0&r=0'
  ];

  let last;

  for (const url of urls) {
    try {
      console.log('Trying direct:', url);
      return parseMarketWatch(await get(url));
    } catch (e) {
      console.warn('Direct failed:', e.message);
      last = e;
    }
  }

  throw last;
}

async function legacyViaJina() {
  const target =
    'http://old.tsetmc.com/tsev2/data/MarketWatchInit.aspx?h=0&r=0';

  const url =
    'https://r.jina.ai/' + target;

  console.log('Trying Jina Reader:', url);

  const raw = await get(url, 3000);

  return parseMarketWatch(raw);
}

async function officialCash() {
  const url =
    'https://webgw.tse.ir/InstrumentProvider/api/v1/MarketWatch/MarketWatchCash/fa';

  console.log('Trying official TSE gateway');

  const raw = await get(url, 2);
  const j = JSON.parse(raw);

  const items =
    Array.isArray(j)
      ? j
      : (
          j.items ||
          j.Items ||
          j.marketWatch ||
          j.MarketWatch ||
          []
        );

  const result = [];

  for (const x of items) {
    const value = v =>
      v && typeof v === 'object'
        ? (v.value ?? v.Value ?? null)
        : v;

    const symbol = String(
      x.symbol ??
      x.Symbol ??
      x.instrumentName ??
      x.InstrumentName ??
      ''
    ).trim();

    const last = num(
      value(
        x.lastPrice ??
        x.LastPrice ??
        x.pl
      )
    );

    if (!symbol || last == null) continue;

    const prev = num(
      value(
        x.yesterdayPrice ??
        x.YesterdayPrice ??
        x.py
      )
    );

    result.push({
      insCode: String(
        x.insCode ??
        x.InsCode ??
        ''
      ),
      isin: String(
        x.isin ??
        x.ISIN ??
        x.instrumentId ??
        ''
      ),
      symbol,
      name: String(
        x.name ??
        x.Name ??
        x.companyName ??
        x.CompanyName ??
        ''
      ),
      last,
      close: num(
        value(
          x.closingPrice ??
          x.ClosingPrice ??
          x.pc
        )
      ),
      prev,
      change:
        prev && last != null
          ? ((last - prev) / prev) * 100
          : null,
      vol: num(
        value(
          x.tradeVolume ??
          x.TradeVolume ??
          x.tvol
        )
      ),
      value: num(
        value(
          x.tradeValue ??
          x.TradeValue ??
          x.tval
        )
      ),
      trades: num(
        value(
          x.tradeCount ??
          x.TradeCount ??
          x.tno
        )
      ),
      flow: num(
        value(
          x.flow ??
          x.Flow
        )
      )
    });
  }

  if (!result.length) {
    throw new Error('official gateway returned no valid rows');
  }

  return result;
}

async function getAllMarketData() {
  const sources = [
    ['Jina Reader', legacyViaJina],
    ['Official TSE', officialCash],
    ['Legacy direct', legacyDirect]
  ];

  let last;

  for (const [name, fn] of sources) {
    try {
      const rows = await fn();

      console.log(
        `${name} OK: ${rows.length} rows`
      );

      if (rows.length) return rows;
    } catch (e) {
      console.warn(
        `${name} failed:`,
        e.message
      );

      last = e;
    }
  }

  throw last || new Error('all market sources failed');
}

async function main() {
  const all = await getAllMarketData();

  const stocks = all.filter(x =>
    [1, 2, 4, 5].includes(x.flow)
  );

  const commodities = all.filter(x =>
    [3, 6, 7].includes(x.flow) ||
    x.yval === '701'
  );

  if (!stocks.length) {
    throw new Error(
      'NO STOCK DATA — refusing fabricated data'
    );
  }

  if (!commodities.length) {
    throw new Error(
      'NO COMMODITY DATA — refusing fabricated data'
    );
  }

  const timestamp = Date.now();

  fs.writeFileSync(
    path.join(OUT, 'stocks.json'),
    JSON.stringify({
      source:
        'TSETMC market snapshot via GitHub Actions',
      timestamp,
      live: false,
      upstreamOk: true,
      marketStatus: 'snapshot',
      items: stocks
    })
  );

  fs.writeFileSync(
    path.join(OUT, 'commodities.json'),
    JSON.stringify({
      source:
        'TSETMC commodity snapshot via GitHub Actions',
      timestamp,
      live: false,
      upstreamOk: true,
      marketStatus: 'snapshot',
      items: commodities
    })
  );

  console.log(
    `SUCCESS stocks=${stocks.length} commodities=${commodities.length}`
  );
}

main().catch(err => {
  console.error(
    'RADAR UPDATE FAILED:',
    err.stack || err.message || err
  );

  process.exit(1);
});
