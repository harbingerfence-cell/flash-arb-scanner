const { ethers } = require('ethers');
const cfg = require('./config');
const { quoteMany } = require('./multicall');
function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a,b) => a-b), m = Math.floor(s.length/2);
  return s.length%2 ? s[m] : (s[m-1]+s[m])/2;
}
function filterOutliers(outs, pct) {
  const entries = Object.entries(outs).map(([v,q]) => [v,q,Number(q.amountOut)]);
  if (entries.length < 3) return outs;
  let best = [], bestRef = 0;
  for (const [,,ref] of entries) {
    const group = entries.filter(([,,x]) => Math.abs(x-ref)/ref*100 <= pct);
    if (group.length > best.length || group.length === best.length && ref > bestRef) {
      best = group; bestRef = ref;
    }
  }
  return Object.fromEntries(best.map(([v,q]) => [v,q]));
}
function scoreRoutes(legs, {gasCostWei, flashFee, profitBufferWei = 0n}) {
  if (!Number.isFinite(flashFee) || flashFee < 0 || flashFee > 1) throw new Error('Invalid FLASH_FEE');
  const feePpm = BigInt(Math.ceil(flashFee*1e6));
  return legs.map(l => {
    const flashFeeWei = (l.sizeWei*feePpm+999999n)/1000000n;
    const grossWei = l.backWei-l.sizeWei;
    return {...l, flashFeeWei, grossWei, netWei:grossWei-gasCostWei-flashFeeWei-profitBufferWei,
      spreadPct:Number(grossWei)/Number(l.sizeWei)*100};
  }).sort((a,b) => b.netWei>a.netWei ? 1 : b.netWei<a.netWei ? -1 : 0);
}
// Dependency injection allows full-scan regression tests without a live RPC.
async function scanOnce(provider, {config=cfg, quote=quoteMany, blockNumber:requestedBlock}={}) {
  const [blockNumber, feeData] = await Promise.all([
    requestedBlock ?? provider.getBlockNumber(), provider.getFeeData()
  ]);
  const block = await provider.getBlock(blockNumber);
  if (!block?.hash) throw new Error('Scan block unavailable');
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
  if (gasPrice == null || gasPrice <= 0n) throw new Error('Gas price unavailable');
  const gasCostWei = gasPrice*BigInt(config.ARB_GAS_UNITS)+ethers.parseEther(String(config.L1_FEE_ETH));
  // Snapshot discovery once: a background refresh cannot change the second leg's universe.
  const tokens = config.tokenList();
  const r1 = [];
  for (const {sym,addr,sizes} of tokens) for (const size of sizes) for (const venue of config.VENUES) {
    r1.push({key:`${sym}|${size}|${venue.name}`,venue,tokenIn:config.WETH,tokenOut:addr,
      amountIn:ethers.parseEther(String(size))});
  }
  const quoteAtBlock = requests => quote(provider,config.MULTICALL3,requests,
    config.CALLS_PER_BATCH,config.CONCURRENCY,{blockTag:blockNumber});
  const q1 = await quoteAtBlock(r1), r2 = [], legMeta = [];
  for (const {sym,addr,sizes} of tokens) for (const size of sizes) {
    const outs = {};
    for (const venue of config.VENUES) {
      const q = q1.get(`${sym}|${size}|${venue.name}`);
      if (q) outs[venue.name] = q;
    }
    const valid = filterOutliers(outs,config.OUTLIER_PCT);
    for (const [a,buy] of Object.entries(valid)) for (const venue of config.VENUES) {
      const key = `${sym}|${size}|${a}|${venue.name}`;
      // Search every sell pool at the actual intermediate amount. A same-venue
      // route must exclude the buy pool because that pool's state was changed.
      r2.push({key,venue,tokenIn:addr,tokenOut:config.WETH,amountIn:buy.amountOut,
        excludePool:a===venue.name ? buy.pool : undefined});
      legMeta.push({key,token:sym,tokenAddress:addr,sizeWei:ethers.parseEther(String(size)),
        buyVenue:a,sellVenue:venue.name,buyPool:buy.pool});
    }
  }
  const q2 = await quoteAtBlock(r2), legs = [];
  for (const m of legMeta) {
    const q = q2.get(m.key);
    if (!q || q.amountOut > m.sizeWei*12n/10n) continue;
    legs.push({...m,backWei:q.amountOut,sellPool:q.pool,status:'quoted'});
  }
  if ((await provider.getBlock(blockNumber))?.hash !== block.hash) throw new Error('Scan block reorganized; discard quotes');
  if (await provider.getBlockNumber()-blockNumber > (config.MAX_QUOTE_AGE_BLOCKS ?? 2)) throw new Error('Stale scan; discard quotes');
  const usdc = config.VENUES.map(v => q1.get(`USDC|${config.SIZES_ETH[0]}|${v.name}`))
    .filter(Boolean).map(q => Number(q.amountOut)/1e6/config.SIZES_ETH[0]);
  return {blockNumber,blockHash:block.hash,gasCostWei,ethUsd:median(usdc),
    venuesAnswering:new Set([...q1.keys()].map(k => k.split('|')[2])),
    routes:scoreRoutes(legs,{gasCostWei,flashFee:config.FLASH_FEE,
      profitBufferWei:ethers.parseEther(String(config.PROFIT_BUFFER_ETH ?? 0))})};
}
module.exports = {scanOnce,scoreRoutes,filterOutliers,median};
