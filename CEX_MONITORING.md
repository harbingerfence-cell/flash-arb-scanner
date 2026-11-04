# Centralized exchange monitoring

The user's complete 50-exchange list is registered in `scanner/exchanges.js`, in
the supplied order. All are enabled with BTC and ETH spot-market requests using
venue-specific quotes: USD, USDT, EUR, JPY, KRW, THB, IDR, ZAR, MXN, AUD, or TRY.
This covers two selected markets per venue, not every asset listed at that venue.

## Operation

- `npm start` runs the existing Base scanner and this monitor in one process.
  Public CEX requests run independently of the Base quote loop.
- `npm run cex:health` performs one 50-venue sweep and prints each market's status.
  A successful command means the sweep completed, not that every feed was healthy.
- The Railway status page includes the same watchlist. `/markets.json` returns
  detailed statuses, snapshot age, best bid/ask, and top 50 depth comparisons.
- `/cex.csv` exports the CEX observation log, separate from the DEX CSV because
  currencies and fee models differ. A maximum of 20 positive-gross observations
  per completed cycle are recorded. This is not a complete historical dataset.
- All integration methods are public data reads. No keys or funded accounts are
  required. No order placement, balance lookup, transfer, or withdrawal is invoked.

## Comparing prices

Compare the same base amount through each ask/bid level, rejecting insufficient
depth. Compare only identical symbols: BTC/USD never becomes BTC/USDT or BTC/JPY.
There is no assumed dollar parity, FX conversion, or ETH/WETH bridge execution.
Only fresh books within the configured observation-time skew are comparable.
Snapshots with invalid prices, crossed books, or auction indications are rejected.
Zero-size levels are removed; they contribute no fillable liquidity.

`netQuote` stays null until both venues have an explicit account-fee override.
When configured, it estimates taker fees in quote currency on both legs. Fees paid
in base/discount tokens, FX, transfers, funding, and rebalancing are not modeled.
Displayed spreads are observations, not executable guarantees or earned profits.
There is no CEX route in the flash-loan executor or automated trading pipeline.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| CEX_ENABLED | 1 | Set 0 to disable background CEX requests |
| CEX_POLL_MS | 60000 | Delay after a completed sweep; minimum 30000 |
| CEX_TIMEOUT_MS | 10000 | Per-request adapter timeout |
| CEX_CONCURRENCY | 8 | Concurrent venue workers; requests within a venue are sequential |
| CEX_MAX_AGE_MS | 20000 | Maximum book age for comparisons |
| CEX_MAX_SKEW_MS | 5000 | Maximum observation-time difference between legs |
| CEX_BASE_SIZES | BTC: 0.001, 0.01; ETH: 0.05, 0.5 | JSON base-amount arrays |
| CEX_TAKER_FEES_BPS | {} | JSON fee map by adapter ID; missing means unknown |
| CEX_CSV_PATH | results/cex-observations.csv | Separate observation log |

API failures are isolated and retried next cycle. CCXT rate limiting remains
enabled. No proxy, alternate region, or geographic-restriction bypass is used.
Metadata/spot eligibility comes from the adapter. Market-level inactive/unsupported
status is excluded from comparisons. Freshness is measured conservatively from
request start and source timestamps where available, including native HTTP cache
age. A lack of fresh books is visible as stale, not silently retained as live data.

The poll delay plus sweep duration exceeds the default freshness window, so books
can become stale between sweeps. The endpoint reports this explicitly. This is a
REST monitoring baseline, not a low-latency execution feed; WebSocket adapters and
reconnection/order-book synchronization would be a separate improvement.

## Sources

39 venues use pinned CCXT public spot adapters. The other 11 use public REST
snapshots. Vendor references used during implementation:

- [CCXT manual](https://github.com/ccxt/ccxt/wiki/manual)
- [BitMart spot depth](https://developer-pro.bitmart.com/en/spot/)
- [GMO Coin order books](https://api.coin.z.com/docs/en/)
- [Bitkub V3 depth](https://github.com/bitkub/bitkub-official-api-docs/blob/master/rest-v3.md)
- [VALR public order book](https://docs.valr.com/)
- [CoinJar public data API](https://docs.exchange.coinjar.com/reference/getting-started-data-api)
- [Paribu order book](https://docs.paribu.com/api/market-data/orderbook)
- [OSL order book](https://osl.com/reference/get-order-book)
- [CoinW spot order book](https://www.coinw.com/api-doc/en/spot-trading/market/get-order-book)
- [Pionex depth](https://pionex-doc.gitbook.io/apidocs/restful/markets/get-depth)
- [Coinstore depth](https://coinstore-openapi.github.io/en/index.html)
- [Bit2Me order book](https://api.bit2me.com/docs/pro/api-reference/marketdata/v2/trading/order-book/get)

## Validation and limits

21 tests passed, covering the original DEX work plus registry coverage, eleven
native response formats, public-only adapter calls, depth calculations, exact quote
matching, unknown fees, freshness/skew, failure isolation, concurrent-cycle guard,
zero-size levels, configuration checks, and the shared HTTP text/JSON endpoints.

The last full live sweep attempted all 100 selected markets and completed in 19.8
seconds. 43 of 50 exchanges had at least one fresh usable book at completion.
Binance, Bybit, and Tokocrypto returned access restrictions. BingX, BitMart, HashKey,
and Bitrue were unavailable in that sweep; some responded in individual retests.
Coincheck ETH/JPY and DigiFinex BTC/USDT were not eligible in the adapter's market
metadata; the venue's other selected market remained monitored. HTX, Bitfinex,
and Bithumb adapter issues found in the first sweep were corrected and retested.

This is evidence from the development host, not Railway. Availability can differ
on Railway and over time; the runtime status is authoritative. The live snapshot
is saved locally in ignored `results/cex-health.json`. Do not infer access eligibility
or account availability from a publicly accessible market-data endpoint.

CCXT 4.5.91 is pinned. Its transitive HTTP client is overridden to patched undici
7.30.1; Node >=20.18.1 is required (the inspected Railway runtime was 20.20.2).
The final dependency audit reports zero known vulnerabilities. Monitor dependency
updates and vendor API changes; retain `npm ci` and the lockfile for reproducibility.

Railway production is unchanged. Review the branch/PR before merging into its
auto-deployed `main`. Persistent log retention still requires a volume and a disk
retention policy. This change adds no new Railway service or paid provider.
