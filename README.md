# flash-arb-scanner
Read-only multi-DEX arbitrage gap scanner for Base

## Run and verify

Requires Node.js 20 or newer. Run `npm ci`, then `npm test` and `npm run health`.
Use `npm start` for continuous scanning. Railway's existing Node start command
continues to work. Configuration comes from environment variables; `.env.example`
documents the new settings (the application does not automatically load `.env`).

Quotes are pinned to one block. Scans are discarded after a reorganization or when
they exceed `MAX_QUOTE_AGE_BLOCKS` (default 2). An overloaded RPC may therefore
produce fewer accepted scans; reduce token/size coverage or improve RPC capacity
before relaxing freshness requirements.

The continuous scanner rotates through `SCAN_TOKENS_PER_BLOCK` tokens per scan
(default 1). This bounds quote work; it does not scan every token every block.
Increase coverage only after measuring latency on your RPC. A full default
10-token scan took 13.6 seconds on the public RPC during validation and was
correctly rejected as stale.

`EXECUTOR_ADDRESS` optionally enables read-only simulation against an already
deployed compatible `FlashArb` contract. Only supported Uniswap V3, Pancake V3,
and Aerodrome CL routes are simulated, up to `SIMULATE_TOP` positive quoted
candidates per scan. Unsupported venues remain visible with an explicit status.
The scanner calls the contract as its on-chain owner, decodes `SimResult`, and
estimates the successful transaction's gas and Base L1 data fee. The owner's
on-chain ETH balance and the RPC's historical gas-estimation support can affect
whether estimation succeeds. No private key is needed or read, and no trades
are submitted.

CSV rows and summaries describe **observations**, including repeated sightings
and multiple sizes. They are not executed trades, unique opportunities, or earned
profit. `net_eth` is the original quote estimate; `simulated_net_eth` uses the
full transaction simulation's repayment and estimated costs. Future inclusion,
competition, and actual fees can differ. Failed simulation is never a pass.

The default CSV is now `results/opportunities-v2.csv` because columns changed.
If Railway overrides `CSV_PATH`, select a new filename before deploying. Mount
a Railway volume at the chosen results directory if logs must survive restarts.

See [CODEX_CHANGES.md](CODEX_CHANGES.md) for the implementation handoff to Claude,
validation evidence, and work still needed before live trading.
