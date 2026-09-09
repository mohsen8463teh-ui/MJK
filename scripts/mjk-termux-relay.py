import gzip, json, time, urllib.request, subprocess
from pathlib import Path

URL = "https://old.tsetmc.com/tsev2/data/MarketWatchInit.aspx?h=0&r=0"
OUT = Path("radar-data")
OUT.mkdir(parents=True, exist_ok=True)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "fa-IR,fa;q=0.9,en;q=0.8",
    "Referer": "https://www.tsetmc.com/",
    "Cache-Control": "no-cache",
}

def fetch():
    req = urllib.request.Request(URL, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=25) as r:
        b = r.read()
    if b[:2] == b"\x1f\x8b":
        b = gzip.decompress(b)
    return b.decode("utf-8", "replace")

def num(v):
    try:
        if v is None or str(v).strip() == "":
            return None
        x = float(str(v).replace(",", "").strip())
        return x if x == x and abs(x) != float("inf") else None
    except:
        return None

def parse(raw):
    rows = []
    for part in raw.split(";"):
        c = part.split(",")
        # TSETMC legacy MarketWatch price row = exactly 26 fields.
        if len(c) != 26:
            continue

        ins = c[0].strip()
        symbol = c[2].strip()
        name = c[3].strip()
        flow = int(c[17]) if c[17].strip().isdigit() else None

        if not ins.isdigit() or not symbol or flow is None:
            continue

        last = num(c[7])
        close = num(c[6])
        prev = num(c[13])
        vol = num(c[9])
        value = num(c[10])
        trades = num(c[8])
        eps = num(c[14])

        if last is None or last <= 0:
            continue

        change = None
        if prev is not None and prev != 0:
            change = (last - prev) / abs(prev) * 100

        item = {
            "insCode": ins,
            "isin": c[1].strip(),
            "symbol": symbol,
            "company": name,
            "last": last,
            "close": close,
            "prev": prev,
            "change": change,
            "trades": trades,
            "vol": vol,
            "value": value,
            "low": num(c[11]),
            "high": num(c[12]),
            "open": num(c[5]),
            "eps": eps,
            "baseVol": num(c[15]),
            "flow": flow,
            "sector": c[18].strip(),
            "max": num(c[19]),
            "min": num(c[20]),
            "state": "",
            "yval": c[22].strip(),
        }
        rows.append(item)

    return rows

def write_snapshot(name, rows, source):
    if not rows:
        raise RuntimeError("REFUSING TO WRITE EMPTY " + name)

    now = int(time.time() * 1000)

    data = {
        "source": source,
        "timestamp": now,
        "live": True,
        "upstreamOk": True,
        "marketStatus": "live-tsetmc",
        "dataAgeSec": 0,
        "items": rows,
    }

    p = OUT / name
    tmp = p.with_suffix(".tmp")
    tmp.write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8"
    )
    tmp.replace(p)

    print(name, "=>", len(rows), "items")

raw = fetch()
rows = parse(raw)

stocks = [x for x in rows if x["flow"] in (1, 2, 4)]
commodities = [x for x in rows if x["flow"] in (3, 6, 7)]

print("TSETMC valid rows:", len(rows))
print("Stocks:", len(stocks))
print("Commodities/Futures/Energy:", len(commodities))

if len(stocks) < 100:
    raise RuntimeError("STOCK SNAPSHOT TOO SMALL - NOT WRITING")

if len(commodities) < 20:
    raise RuntimeError("COMMODITY SNAPSHOT TOO SMALL - NOT WRITING")

write_snapshot(
    "stocks.json",
    stocks,
    "TSETMC legacy MarketWatch via Iran Termux relay"
)

write_snapshot(
    "commodities.json",
    commodities,
    "TSETMC legacy MarketWatch via Iran Termux relay"
)

print("\nVALIDATION OK")

subprocess.run(["git", "config", "user.name", "mjk-termux-relay"], check=True)
subprocess.run(["git", "config", "user.email", "mjk-termux-relay@users.noreply.github.com"], check=True)

subprocess.run(
    ["git", "add", "radar-data/stocks.json", "radar-data/commodities.json"],
    check=True
)

r = subprocess.run(
    ["git", "diff", "--cached", "--quiet"]
)

if r.returncode == 0:
    print("No snapshot change.")
else:
    subprocess.run(
        ["git", "commit", "-m", "chore: update TSETMC Iran radar snapshot"],
        check=True
    )
    subprocess.run(["git", "push", "origin", "main"], check=True)
    print("\nPUSH SUCCESS")
