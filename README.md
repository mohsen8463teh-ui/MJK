# MJK Final

Standalone Android crypto analysis app for BTCUSDT 15m.

## Strategy
- Closed candles only; current forming candle is excluded.
- EMA20, EMA200 on close, ATR14 (Wilder smoothing).
- BUY when close > EMA200, EMA20 > EMA200, low touches EMA20, green candle, close > EMA20, and at least 10 candles since the previous issued signal.
- Entry = signal close.
- SL = Entry - 1.5*ATR14.
- TP = Entry + 3*ATR14.
- Maximum one open trade at a time.

## Backtest
- BTCUSDT 15m.
- 3m / 6m / 1y selectable.
- Starting balance $1000.
- Fixed risk $10 (1% of starting capital) per trade.
- 0.25% fee per side (0.5% round trip).
- SL is assumed first when both SL and TP are touched in the same OHLC candle because intrabar order is unavailable.

## Data
Live price and candles are requested directly from the public Binance REST API. No API key and no exchange order execution are used.

## Paper trading
Signals create a local open trade. Live BTC price is checked while the app is active; SL/TP closes the paper trade and records the result, R, fees and net PnL.

## Notifications
The Android package requests notification permission and the app includes an Android background worker in the source. Background scheduling is OS-controlled and is not guaranteed to run exactly on every 15-minute boundary.

## MJK launcher icon
The launcher icon and in-app logo use the exact user-supplied MJK portrait/globe artwork. Density-specific launcher assets and Android 8+ adaptive icon resources are included.
