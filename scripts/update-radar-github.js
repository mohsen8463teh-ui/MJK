const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const OUT = path.join(process.cwd(), 'radar-data');
fs.mkdirSync(OUT, { recursive: true });

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
  'Accept':
    'application/json,text/plain,text/html,*/*',
  'Accept-Language':
    'fa-IR,fa;q=0.9,en;q=0.8',
  'Cache-Control':
    'no-cache'
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function request(url, timeoutMs = 15000, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('too many redirects'));
      return;
    }

    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;

    const req = lib.get(
      u,
      {
        headers: HEADERS,
        timeout: timeoutMs
      },
      res => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();

          const next =
            new URL(
              res.headers.location,
              u
            ).toString();

          resolve(
            request(
              next,
              timeoutMs,
              redirects + 1
            )
          );

          return;
        }

        let body = '';

        res.setEncoding('utf8');

        res.on('data', chunk => {
          body += chunk;
        });

        res.on('end', () => {
          if (
            res.statusCode < 200 ||
            res.statusCode >= 300
          ) {
            reject(
              new Error(
                `HTTP ${res.statusCode}`
              )
            );
            return;
          }

          resolve(body);
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new Error(
          `timeout after ${timeoutMs}ms`
        )
      );
    });

    req.on('error', reject);
  });
}

async function get(url, attempts = 2, timeoutMs = 15000) {
  let lastError;

  for (let i = 0; i < attempts; i++) {
    try {
      console.log(
        `GET attempt ${i + 1}/${attempts}: ${url}`
      );

      return await request(
        url,
        timeoutMs
      );
    } catch (err) {
      lastError = err;

      console.warn(
        `GET failed: ${err.message}`
      );

      if (i + 1 < attempts) {
        await sleep(1000);
      }
    }
  }

  throw lastError;
}

function num(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const n = Number(
    String(value)
      .replace(/,/g, '')
      .trim()
  );

  return Number.isFinite(n)
    ? n
    : null;
}

function pick(obj, keys) {
  for (const key of keys) {
    if (
      obj &&
      obj[key] !== undefined &&
      obj[key] !== null
    ) {
      return obj[key];
    }
  }

  return null;
}

function unwrapMarketwatch(json) {
  if (
    json &&
    Array.isArray(json.marketwatch)
  ) {
    return json.marketwatch;
  }

  if (
    json &&
    Array.isArray(json.marketWatch)
  ) {
    return json.marketWatch;
  }

  if (
    json &&
    Array.isArray(json.items)
  ) {
    return json.items;
  }

  if (
    json &&
    Array.isArray(json.Items)
  ) {
    return json.Items;
  }

  return [];
}

function normalizeMarketwatchRow(row) {
  const symbol = String(
    pick(row, [
      'lVal18AFC',
      'l18',
      'symbol',
      'Symbol',
      'instrumentName',
      'InstrumentName'
    ]) ?? ''
  ).trim();

  const name = String(
    pick(row, [
      'lVal30',
      'l30',
      'name',
      'Name',
      'companyName',
      'CompanyName'
    ]) ?? ''
  ).trim();

  const insCode = String(
    pick(row, [
      'insCode',
      'inscode',
      'InsCode'
    ]) ?? ''
  ).trim();

  const isin = String(
    pick(row, [
      'isin',
      'ISIN'
    ]) ?? ''
  ).trim();

  const last = num(
    pick(row, [
      'pl',
      'pDrCotVal',
      'lastPrice',
      'LastPrice',
      'last'
    ])
  );

  const close = num(
    pick(row, [
      'pc',
      'pClosing',
      'closingPrice',
      'ClosingPrice',
      'close'
    ])
  );

  const prev = num(
    pick(row, [
      'py',
      'priceYesterday',
      'yesterdayPrice',
      'YesterdayPrice',
      'prev'
    ])
  );

  const flow = num(
    pick(row, [
      'flow',
      'Flow'
    ])
  );

  const yval = String(
    pick(row, [
      'yval',
      'YVal'
    ]) ?? ''
  ).trim();

  if (
    !symbol ||
    last === null
  ) {
    return null;
  }

  return {
    insCode,
    isin,
    symbol,
    name,

    last,
    close,
    prev,

    change:
      prev !== null &&
      prev !== 0
        ? ((last - prev) / prev) * 100
        : null,

    vol: num(
      pick(row, [
        'qTotTran5J',
        'tvol',
        'tradeVolume',
        'TradeVolume',
        'vol'
      ])
    ),

    value: num(
      pick(row, [
        'qTotCap',
        'tval',
        'tradeValue',
        'TradeValue',
        'value'
      ])
    ),

    trades: num(
      pick(row, [
        'zTotTran',
        'tno',
        'tradeCount',
        'TradeCount',
        'trades'
      ])
    ),

    eps: num(
      pick(row, [
        'eps',
        'EPS'
      ])
    ),

    flow,
    yval,

    open: num(
      pick(row, [
        'pf',
        'open',
        'first'
      ])
    ),

    min: num(
      pick(row, [
        'pmin',
        'priceMin',
        'min'
      ])
    ),

    max: num(
      pick(row, [
        'pmax',
        'priceMax',
        'max'
      ])
    ),

    baseVol: num(
      pick(row, [
        'baseVol',
        'bvol'
      ])
    ),

    sourceType: 'tsetmc-cdn'
  };
}

function normalizeRows(rows) {
  return rows
    .map(normalizeMarketwatchRow)
    .filter(Boolean);
}

async function fetchCdnMarket(
  market,
  label
) {
  const url =
    'https://cdn.tsetmc.com/api/ClosingPrice/GetMarketWatch' +
    `?market=${market}` +
    '&industrialGroup=' +
    '&paperTypes%5B0%5D=1' +
    '&paperTypes%5B1%5D=2' +
    '&paperTypes%5B2%5D=3' +
    '&paperTypes%5B3%5D=4' +
    '&paperTypes%5B4%5D=5' +
    '&paperTypes%5B5%5D=6' +
    '&paperTypes%5B6%5D=7' +
    '&paperTypes%5B7%5D=8' +
    '&paperTypes%5B8%5D=9' +
    '&showTraded=false' +
    '&withBestLimits=false' +
    '&hEven=0' +
    '&RefID=0';

  console.log(
    `Trying CDN ${label}: ${url}`
  );

  const raw = await get(
    url,
    2,
    15000
  );

  const json = JSON.parse(raw);

  const rows =
    normalizeRows(
      unwrapMarketwatch(json)
    );

  if (!rows.length) {
    throw new Error(
      `CDN ${label} returned zero valid rows`
    );
  }

  console.log(
    `CDN ${label} OK: ${rows.length} rows`
  );

  return rows;
}

async function fetchOfficialCash() {
  const url =
    'https://webgw.tse.ir/InstrumentProvider/api/v1/MarketWatch/MarketWatchCash/fa';

  console.log(
    'Trying official TSE cash gateway'
  );

  const raw = await get(
    url,
    1,
    15000
  );

  const json = JSON.parse(raw);

  const rows =
    normalizeRows(
      unwrapMarketwatch(json)
    );

  if (!rows.length) {
    throw new Error(
      'official cash gateway returned zero valid rows'
    );
  }

  console.log(
    `Official cash OK: ${rows.length} rows`
  );

  return rows;
}

async function fetchOfficialFuture() {
  const url =
    'https://webgw.tse.ir/InstrumentProvider/api/v1/MarketWatch/MarketWatchFuture/fa';

  console.log(
    'Trying official TSE future gateway'
  );

  const raw = await get(
    url,
    1,
    15000
  );

  const json = JSON.parse(raw);

  const rows =
    normalizeRows(
      unwrapMarketwatch(json)
    );

  if (!rows.length) {
    throw new Error(
      'official future gateway returned zero valid rows'
    );
  }

  console.log(
    `Official future OK: ${rows.length} rows`
  );

  return rows;
}

function parseLegacy(raw) {
  const parts = raw.split('@');

  if (parts.length < 5) {
    throw new Error(
      `invalid legacy response: ${parts.length} parts`
    );
  }

  const priceRows =
    parts[2] || '';

  const rows =
    priceRows
      .split(';')
      .map(line => {
        const x = line.split(',');

        if (x.length < 26) {
          return null;
        }

        return {
          insCode:
            String(x[0] || '').trim(),

          isin:
            String(x[1] || '').trim(),

          symbol:
            String(x[2] || '').trim(),

          name:
            String(x[3] || '').trim(),

          last:
            num(x[7]),

          close:
            num(x[6]),

          prev:
            num(x[13]),

          change:
            num(x[13]) &&
            num(x[13]) !== 0
              ? (
                  (num(x[7]) -
                    num(x[13])) /
                  num(x[13])
                ) * 100
              : null,

          vol:
            num(x[9]),

          value:
            num(x[10]),

          trades:
            num(x[8]),

          eps:
            num(x[14]),

          flow:
            num(x[17]),

          yval:
            String(x[22] || '').trim(),

          open:
            num(x[5]),

          min:
            num(x[11]),

          max:
            num(x[12]),

          baseVol:
            num(x[15]),

          sourceType:
            'tsetmc-legacy'
        };
      })
      .filter(
        x =>
          x &&
          x.symbol &&
          x.last !== null
      );

  if (!rows.length) {
    throw new Error(
      'legacy source returned zero valid rows'
    );
  }

  return rows;
}

async function fetchLegacyViaJina() {
  const target =
    'http://old.tsetmc.com/tsev2/data/MarketWatchInit.aspx?h=0&r=0';

  const url =
    'https://r.jina.ai/' +
    target;

  console.log(
    'Trying Jina fallback with 15s timeout'
  );

  const raw = await get(
    url,
    1,
    15000
  );

  const rows =
    parseLegacy(raw);

  console.log(
    `Jina legacy OK: ${rows.length} rows`
  );

  return rows;
}

async function getStocks() {
  const sources = [
    {
      name: 'CDN market=0',
      fn: () =>
        fetchCdnMarket(
          0,
          'stocks'
        )
    },

    {
      name: 'Official TSE cash',
      fn: fetchOfficialCash
    },

    {
      name: 'Jina legacy',
      fn: fetchLegacyViaJina
    }
  ];

  let lastError;

  for (const source of sources) {
    try {
      const rows =
        await source.fn();

      const stocks =
        rows.filter(row =>
          row.flow === null ||
          [1, 2, 4, 5].includes(
            row.flow
          )
        );

      if (stocks.length) {
        console.log(
          `${source.name}: stocks=${stocks.length}`
        );

        return stocks;
      }

      throw new Error(
        `${source.name} produced no stock rows`
      );
    } catch (err) {
      console.warn(
        `${source.name} failed: ${err.message}`
      );

      lastError = err;
    }
  }

  throw (
    lastError ||
    new Error(
      'all stock sources failed'
    )
  );
}

async function getCommodities() {
  const sources = [
    {
      name: 'CDN market=1',
      fn: () =>
        fetchCdnMarket(
          1,
          'commodities'
        )
    },

    {
      name: 'Official TSE future',
      fn: fetchOfficialFuture
    },

    {
      name: 'Jina legacy',
      fn: fetchLegacyViaJina
    }
  ];

  let lastError;

  for (const source of sources) {
    try {
      const rows =
        await source.fn();

      let commodities =
        rows.filter(row =>
          row.flow === null ||
          [3, 6, 7].includes(
            row.flow
          ) ||
          row.yval === '701'
        );

      /*
       * For market=1, if the upstream itself
       * has already restricted the market to
       * commodity/future instruments, accept
       * all valid rows.
       */
      if (
        source.name === 'CDN market=1' &&
        commodities.length === 0
      ) {
        commodities = rows;
      }

      if (commodities.length) {
        console.log(
          `${source.name}: commodities=${commodities.length}`
        );

        return commodities;
      }

      throw new Error(
        `${source.name} produced no commodity rows`
      );
    } catch (err) {
      console.warn(
        `${source.name} failed: ${err.message}`
      );

      lastError = err;
    }
  }

  throw (
    lastError ||
    new Error(
      'all commodity sources failed'
    )
  );
}

function writeSnapshot(
  filename,
  source,
  items
) {
  if (
    !Array.isArray(items) ||
    items.length === 0
  ) {
    throw new Error(
      `refusing to write empty snapshot: ${filename}`
    );
  }

  const data = {
    source,
    timestamp: Date.now(),

    /*
     * This is a scheduled snapshot, not a
     * direct live connection from the APK.
     */
    live: false,

    upstreamOk: true,

    marketStatus:
      'snapshot',

    dataAgeSec: 0,

    items
  };

  fs.writeFileSync(
    path.join(OUT, filename),
    JSON.stringify(data)
  );

  console.log(
    `Wrote ${filename}: ${items.length} items`
  );
}

async function main() {
  console.log(
    '=== MJK RADAR UPDATE START ==='
  );

  const stocks =
    await getStocks();

  const commodities =
    await getCommodities();

  if (!stocks.length) {
    throw new Error(
      'NO STOCK DATA - refusing fabricated data'
    );
  }

  if (!commodities.length) {
    throw new Error(
      'NO COMMODITY DATA - refusing fabricated data'
    );
  }

  writeSnapshot(
    'stocks.json',
    'TSETMC market snapshot via GitHub Actions',
    stocks
  );

  writeSnapshot(
    'commodities.json',
    'TSETMC commodity/future snapshot via GitHub Actions',
    commodities
  );

  console.log(
    `SUCCESS stocks=${stocks.length} commodities=${commodities.length}`
  );

  console.log(
    '=== MJK RADAR UPDATE COMPLETE ==='
  );
}

main().catch(error => {
  console.error(
    'RADAR UPDATE FAILED:'
  );

  console.error(
    error.stack ||
    error.message ||
    error
  );

  process.exit(1);
});
