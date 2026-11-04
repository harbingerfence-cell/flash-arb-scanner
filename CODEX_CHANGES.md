# Codex handoff to Claude

## Follow-up: 50 centralized exchanges, monitoring only

The user expanded scope to all 50 listed exchanges and explicitly confirmed
monitoring only. Added `scanner/exchanges.js` (ordered registry),
`scanner/cex-adapters.js` (39 CCXT and 11 native public adapters), and
`scanner/cex.js` (background monitoring, depth comparisons, fee/freshness guards,
status and CSV). Integrated the watchlist into the same process and HTTP status
page, with `/markets.json`, `/cex.csv`, and `npm run cex:health`.

`test/cex.test.js` expands the suite to 22 passing tests. The final live sweep
attempted all 50; 43 had fresh books at completion. Availability failures are
explicit and retried. See `CEX_MONITORING.md` for precise market coverage, external
restrictions, source documentation, configuration, and validation limits.

Dependency additions: pinned ccxt 4.5.91 and patched undici 7.30.1 override;
Node minimum is now 20.18.1. Audit: zero known vulnerabilities. This remains
read-only and does not deploy Railway, fund accounts, or submit trades.

While this follow-up was in progress, main advanced to `bd9441e` with Claude's
PostgreSQL history and chart dashboard. Merged that main into this branch and
preserved database initialization, DEX scan recording, shutdown flushing, HTML
charts, history-backed CSV, and `/text`. The CEX watchlist is included in both
the HTML dashboard's live section and the plain-text status. Added an integration
test for database-enabled HTML, CSV, and text paths without a live database.

User authorized improvements to the existing scanner and requested an identifiable
handoff. This work is isolated on `codex/quote-integrity-and-simulation`, based on
`6c60b905c295823a9b673a859ab2ef55e341e677`. Commits use the `[Codex]` prefix.
Use `git diff 6c60b905...codex/quote-integrity-and-simulation` to see the changes.

## Changes

- `scanner/core.js`: pin both quote legs to one numbered block, snapshot token
  discovery, reject reorganized/stale scans and unavailable gas prices, independently
  optimize sell pools, consider same-venue/different-pool routes, attach token
  addresses, round fractional flash fees upward, and subtract an optional reserve.
- `scanner/multicall.js`: carry the block tag through every chunk, support buy-pool
  exclusion, validate batch/concurrency inputs and result counts. Batch RPC failure
  discards the scan instead of silently producing partial success.
- `scanner/simulation.js`: optional read-only full transaction simulation using the
  existing deployed contract ABI. Restrict encoding to supported venues, decode
  actual repayment, estimate the successful path with pinned `eth_estimateGas`,
  query Base's L1 fee oracle with a placeholder signed payload, apply a configurable
  gas margin, and distinguish failures/unsupported routes from simulation passes.
- `scanner/scan.js`: rotate a bounded token subset, disable ethers' short request
  cache for freshness checks, check block freshness again after simulations,
  keep CSV quote and simulation fields separate, avoid logging RPC URLs/errors,
  and count only completed scans in block coverage.
- `scanner/config.js`, `.env.example`: validate configuration and expose new limits,
  reserve, and optional deployed executor address. CSV defaults to a new v2 filename.
- `scanner/summary.js`, `scanner/live.js`: describe estimates as quote sightings;
  explicitly state that the scanner does not measure realized profit.
- `package.json`, `package-lock.json`: fix broken test command, pin ethers 6.17.0,
  lock transitive dependencies. `.gitignore` excludes dependencies, results, secrets.
- `test/scanner.test.js`, `.github/workflows/scanner-tests.yml`: regression suite
  and automatic tests on pushes and pull requests.

## Validation

- 11 offline regression tests passed: canonical ABI batching, block pinning,
  reverse-pool selection, same-venue buy-pool exclusion, failed subquotes,
  reorg/stale/missing-gas rejection, fees and reserve, unsupported routes,
  full simulation and pinned cost calls, failure handling, and separate reporting.
- Public Base RPC health check returned quotes from all nine venues.
- Read-only USDC two-venue scan returned four routes at block 53489972.
- Full default 10-token scan took 13.6 seconds and was rejected as stale.
- Rotated one-token scan with all venues/default sizes completed in 2.7 seconds,
  returning 210 routes at block 53490008. These are quotes, not profitable trades.
- Dependency audit after update reported zero known vulnerabilities.
- GitHub CI passed the scanner push tests and the existing contract fork-test job.

## Railway state and rollout

The supplied Railway service was online, connected to GitHub `main`, and configured
to auto-deploy pushes to `main`. Its Node runtime was 20.20.2. This branch does not
change Railway settings, deploy, or execute trades.

Before merging: review the PR and CI, retain the prior deployment for rollback,
and check any custom `CSV_PATH` variable against the new CSV schema. Use a new
filename if necessary. A persistent Railway volume is required to retain results
through restarts. Do not place wallet keys in this read-only scanner.

Simulation is disabled until `EXECUTOR_ADDRESS` names a deployed compatible
contract. Its owner must have enough ETH for the gas estimator's balance checks.
An RPC supporting recent historical calls and `eth_estimateGas` block tags is
required; errors fail closed. No deployed executor address was supplied or verified
in this work, so simulation tests use a deterministic mocked RPC.

## Remaining work before live trading

- Solidity and existing fork tests were not changed. The existing fork-test job
  passed automatically in GitHub CI after this branch was pushed; no fork tests
  were run locally. Verify router ABIs,
  addresses, lender liquidity/fees, and actual contract deployment on a pinned Base
  fork. Add contract expiry, safe token transfers, and per-leg output bounds with
  fork tests in a separately reviewed contract revision.
- Simulation is not a submission mechanism or an inclusion guarantee. No signer,
  private submission, nonce handling, wallet funding, receipt reconciliation, daily
  loss limit, or automated trading has been introduced.
- Quote ranking still uses configured gas/loan estimates; only selected simulated
  candidates use transaction-specific estimates and actual simulated repayment.
  Fee-oracle payload uses placeholder signature/nonce and is an estimate with a
  buffer, not the fee of a signed transaction. Recheck all applicable chain fees
  immediately before any future submission.
- Fixed trade sizes, the existing outlier filter, and the >20% quote sanity cutoff
  remain. Buying uses the best forward pool per venue; this is not exhaustive
  optimization over every pool combination or trade size.
- Token rotation means each token is revisited later. Tune coverage against measured
  latency; move to pool-event caching/subscriptions if more coverage is needed.
- Discovered tokens are not security-approved. A quote or simulation is not a token
  safety assessment. Keep a reviewed allowlist before any future execution.
- Establish an empirical edge in shadow mode, then measure realized results from
  transaction receipts if trading is later implemented and authorized. Profitability
  has not been established by this change.
