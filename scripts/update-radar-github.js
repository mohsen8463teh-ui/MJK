const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const OUT = path.join(process.cwd(), 'radar-data');
fs.mkdirSync(OUT, { recursive: true });

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
  'Accept': 'application/json,text/plain,text/csv,text/html,*/*',
  'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.7',
  'Referer': 'https://www.tsetmc.com/',
  'Origin': 'https://www.tsetmc.com',
  'Cache-Control': 'no-cache'
};

function request(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));

    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;

    const req = lib.get(
      u,
      { headers: HEADERS, timeout: 18000 },
      res => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          return resolve(
            request(
              new URL(res.headers.location, u).toString(),
              redirects + 1
            )
          );
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', x => body += x);

        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}`));
          } else {
            resolve(body);
          }
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function get(url, attempts = 3) {
  let last;

  for (let i = 0; i < attempts; i++) {
    try {
      return await request(url);
    } catch (e) {
      last = e;

      if (i + 1 < attempts) {
        await new Promise(r => setTimeout(r, 1200 * (i + 1)));
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

function parseLegacyMarketWatch(raw) {
  const parts = raw.split('@');

  if (parts.length < 5) {
    throw new Error(
      `unexpected MarketWatchInit response: ${parts.length} parts`
    );
  }

  const rows = (parts[2] || '').split(';');
  const out = [];

  for (const line of rows) {
    const x = line.split(',');

    if (x.length < 26) continue;

    const insCode = String(x[0] || '').trim();
    const isin = String(x[1] || '').trim();
    const symbol = String(x[2] || '').trim();
    const name = String(x[3] || '').trim();

    const last = num(x[7]);
    const close = num(x[6]);
    const prev = num(x[13]);

    if (!insCode || !symbol || last == null) continue;

    out.push({
      insCode,
      isin,
      symbol,
      name,
      last,
      close,
      prev,
      change: prev
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

  if (!out.length) {
    throw new Error(
      'legacy MarketWatchInit returned no valid price rows'
    );
  }

  return out;
}

async function fetchLegacy() {
  const urls = [
    'http://old.tsetmc.com/tsev2/data/MarketWatchInit.aspx?h=0&r=0',
    'http://www.tsetmc.com/tsev2/data/MarketWatchInit.aspx?h=0&r=0'
  ];

  let last;

  for (const url of urls) {
    try {
      const raw = await get(url);
      return parseLegacyMarketWatch(raw);
    } catch (e) {
      last = e;
      console.warn(
        'legacy source failed:',
        url,
        e.message
      );
    }
  }

  throw last || new Error('no legacy source');
}

async function fetchWebgwFuture() {
  const url =
    'https://webgw.tse.ir/InstrumentProvider/api/v1/MarketWatch/MarketWatchFuture/fa';

  const raw = await get(url, 2);
  const j = JSON.parse(raw);

  const items = Array.isArray(j)
    ? j
    : (j.Items || j.items || []);

  const val = v =>
    v && typeof v === 'object'
      ? (v.value ?? v.Value ?? null)
      : v;

  return items
    .map(x => {
      const last = num(val(x.lastPrice));
      const close = num(val(x.closingPrice));
      const prev = num(val(x.yesterdayPrice));

      return {
        insCode: String(
          x.insCode ?? x.InsCode ?? ''
        ),
        isin: String(
          x.instrumentId ?? x.InstrumentId ?? ''
        ),
        symbol: String(
          x.instrumentName ??
          x.InstrumentName ??
          x.symbol ??
          ''
        ),
        name: String(
          x.companyNamePersian ??
          x.companyName ??
          ''
        ),
        last,
        close,
        prev,
        change:
          num(val(x.lastPriceChangePercent)) ??
          (
            prev && last != null
              ? ((last - prev) / prev) * 100
              : null
          ),
        vol: num(val(x.tradeVolume)),
        value: num(val(x.tradeValue)),
        trades: num(val(x.tradeCount)),
        flow: 3,
        sourceType: 'future'
      };
    })
    .filter(
      x => x.symbol && x.last != null
    );
}

async function main() {
  const all = await fetchLegacy();

  const stocks = all.filter(
    x =>
      x.flow === 1 ||
      x.flow === 2 ||
      x.flow === 4 ||
      x.flow === 5
  );

  let commodities = all.filter(
    x =>
      x.flow === 3 ||
      x.flow === 6 ||
      x.flow === 7 ||
      x.yval === '701'
  );

  if (!commodities.length) {
    try {
      commodities = await fetchWebgwFuture();
    } catch (e) {
      console.warn(
        'official future source unavailable:',
        e.message
      );
    }
  }

  if (!stocks.length) {
    throw new Error(
      'no valid stock rows after market filtering'
    );
  }

  if (!commodities.length) {
    throw new Error(
      'no valid commodity/future rows'
    );
  }

  const now = Date.now();

  fs.writeFileSync(
    path.join(OUT, 'stocks.json'),
    JSON.stringify({
      source:
        'TSETMC legacy MarketWatchInit via GitHub Actions',
      timestamp: now,
      live: false,
      upstreamOk: true,
      marketStatus: 'snapshot',
      dataAgeSec: 0,
      items: stocks
    })
  );

  fs.writeFileSync(
    path.join(OUT, 'commodities.json'),
    JSON.stringify({
      source:
        'TSETMC legacy MarketWatchInit / official future fallback via GitHub Actions',
      timestamp: now,
      live: false,
      upstreamOk: true,
      marketStatus: 'snapshot',
      dataAgeSec: 0,
      items: commodities
    })
  );

  console.log(
    `stocks=${stocks.length} commodities=${commodities.length}`
  );
}

main().catch(e => {
  console.error(
    'radar update failed:',
    e.stack || e.message || e
  );

  process.exit(1);
});
