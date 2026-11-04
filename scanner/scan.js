const {createMonitor}=require('./cex');
const fs = require('fs');
const path = require('path');
const {ethers} = require('ethers');
const cfg = require('./config');
const {quoteMany} = require('./multicall');
const {scanOnce,scoreRoutes,filterOutliers,median} = require('./core');
const {validateCandidates} = require('./simulation');
const {refreshTokens,startLive} = require('./live');
const {writeSummary} = require('./summary');
const fmt = wei => Number(ethers.formatEther(wei));
const CSV_HEADER = 'time,block,token,size_eth,buy_on,buy_pool,sell_on,sell_pool,spread_pct,gross_eth,gas_eth,net_eth,net_usd,status,simulated_net_eth,simulated_gas_eth';
function ensureCsv(p) {
  fs.mkdirSync(path.dirname(p),{recursive:true});
  if (!fs.existsSync(p)) fs.writeFileSync(p,CSV_HEADER+'\n');
  else if (fs.readFileSync(p,'utf8').split(/\r?\n/,1)[0]!==CSV_HEADER)
    throw new Error('CSV schema changed; set CSV_PATH to a new file (for example results/opportunities-v2.csv)');
}
const csvCell = value => '"'+String(value).replace(/"/g,'""')+'"';
function recordScan(stats,res,now=new Date().toISOString(),append=fs.appendFileSync) {
  stats.scans++;
  if (!stats.firstBlock) stats.firstBlock=res.blockNumber;
  stats.lastBlock=res.blockNumber;
  for (const r of res.routes) {
    if (!stats.bestSpread || r.spreadPct>stats.bestSpread.spreadPct) stats.bestSpread={...r,block:res.blockNumber,time:now};
    const t=stats.byToken[r.token] ||= {best:-Infinity,route:''};
    if (r.spreadPct>t.best) {t.best=r.spreadPct;t.route=`${r.buyVenue}->${r.sellVenue} @${fmt(r.sizeWei)}ETH`;}
    if (r.status==='simulated_positive') stats.simulatedPositive++;
    if (r.status==='simulation_failed') stats.simulationFailed++;
    if (r.netWei<=0n) continue;
    stats.profitable++;
    const id=`${r.token} ${r.buyVenue}(${r.buyPool})->${r.sellVenue}(${r.sellPool})`;
    const s=stats.byRoute[id] ||= {hits:0,maxNetEth:0};
    s.hits++;s.maxNetEth=Math.max(s.maxNetEth,fmt(r.netWei));
    if (!stats.bestNet || r.netWei>stats.bestNet.netWei) stats.bestNet={...r,block:res.blockNumber,time:now};
    append(cfg.CSV_PATH,[now,res.blockNumber,r.token,fmt(r.sizeWei),r.buyVenue,r.buyPool,
      r.sellVenue,r.sellPool,r.spreadPct.toFixed(4),fmt(r.grossWei),fmt(res.gasCostWei),fmt(r.netWei),
      res.ethUsd ? (fmt(r.netWei)*res.ethUsd).toFixed(2) : '',r.status,
      r.simulatedNetWei==null?'':fmt(r.simulatedNetWei),
      r.simulatedGasCostWei==null?'':fmt(r.simulatedGasCostWei)].map(csvCell).join(',')+'\n');
  }
}
async function health(provider) {
  console.log(`RPC configured; Base block: ${await provider.getBlockNumber()}`);
  const reqs=cfg.VENUES.map(venue=>({key:venue.name,venue,tokenIn:cfg.WETH,tokenOut:cfg.TOKENS.USDC,amountIn:ethers.parseEther('1')}));
  const q=await quoteMany(provider,cfg.MULTICALL3,reqs,cfg.CALLS_PER_BATCH,cfg.CONCURRENCY);
  for (const v of cfg.VENUES) {
    const r=q.get(v.name);
    console.log(`${v.name}: ${r ? '$'+(Number(r.amountOut)/1e6).toFixed(2)+' ('+r.pool+')' : 'NO QUOTE'}`);
  }
}
async function main() {
  cfg.validateConfig();
  const request=new ethers.FetchRequest(cfg.RPC_URL);
  request.timeout=30000;
  const provider=new ethers.JsonRpcProvider(request,8453,{staticNetwork:true,cacheTimeout:-1});
  if (process.argv.includes('--health')) return health(provider);
  ensureCsv(cfg.CSV_PATH);
  const started=Date.now();
  const stats={scans:0,errors:0,profitable:0,simulatedPositive:0,simulationFailed:0,firstBlock:0,lastBlock:0,bestNet:null,bestSpread:null,byRoute:{},byToken:{}};
  const monitor=createMonitor();
  const finish=()=>{monitor.stop();writeSummary(stats,started);process.exit(0);};
  process.on('SIGINT',finish);process.on('SIGTERM',finish);
  startLive(provider,stats,started,monitor);
  if(monitor.config.enabled) monitor.start();
  await refreshTokens(provider);
  console.log(`Read-only scan: ${cfg.tokenList().length} tokens, ${cfg.VENUES.length} venues. Simulation ${cfg.EXECUTOR_ADDRESS?'enabled':'disabled (set EXECUTOR_ADDRESS)'}.`);
  let lastScanned=0, tokenCursor=0;
  while (true) {
    if (cfg.DURATION_SEC && (Date.now()-started)/1000>=cfg.DURATION_SEC) return finish();
    let head;
    try {head=await provider.getBlockNumber();} catch {stats.errors++;await sleep(1000);continue;}
    if (head<=lastScanned) {await sleep(cfg.POLL_MS);continue;}
    lastScanned=head;
    const t0=Date.now();
    try {
      const tokens=cfg.tokenList();
      const selected=Array.from({length:Math.min(cfg.SCAN_TOKENS_PER_BLOCK,tokens.length)},
        (_,i)=>tokens[(tokenCursor+i)%tokens.length]);
      tokenCursor=tokens.length ? (tokenCursor+selected.length)%tokens.length : 0;
      const res=await scanOnce(provider,{blockNumber:head,config:{...cfg,tokenList:()=>selected}});
      res.routes=await validateCandidates(provider,res.routes,res.blockNumber);
      if ((await provider.getBlock(res.blockNumber))?.hash!==res.blockHash)
        throw new Error('Scan block reorganized; discard quotes');
      if (await provider.getBlockNumber()-res.blockNumber>cfg.MAX_QUOTE_AGE_BLOCKS)
        throw new Error('Stale scan; discard quotes');
      recordScan(stats,res);
      const top=res.routes[0];
      console.log(`#${res.blockNumber} ${top ? `QUOTE ${top.token} ${top.buyVenue}->${top.sellVenue} estimated ${fmt(top.netWei).toFixed(7)} ETH (${top.status})` : 'no comparable routes'} | ${((Date.now()-t0)/1000).toFixed(1)}s`);
    } catch(error) {
      stats.errors++;
      // Never print arbitrary RPC error text: it may contain provider credentials.
      console.error(error.message==='Stale scan; discard quotes' || error.message==='Scan block reorganized; discard quotes' ? error.message : 'Scan failed; check RPC health and configuration');
      await sleep(1000);
    }
  }
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
if (require.main===module) main().catch(()=>{console.error('Scanner startup failed; check configuration and RPC access');process.exit(1);});
module.exports={scanOnce,scoreRoutes,filterOutliers,median,recordScan,ensureCsv,CSV_HEADER};
