const http=require('http');
const fs=require('fs');
const {ethers}=require('ethers');
const cfg=require('./config');
const {quoteMany}=require('./multicall');
const {discoverTokens}=require('./discover');
const {summaryText}=require('./summary');
const {monitorText}=require('./cex');
async function refreshTokens(provider) {
  if(cfg.DISCOVER_MAX<=0) return;
  cfg.EXTRA_TOKENS=await discoverTokens({weth:cfg.WETH,exclude:Object.values(cfg.TOKENS),
    max:cfg.DISCOVER_MAX,minLiqUsd:cfg.DISCOVER_MIN_LIQ_USD});
  console.log(`Discovered ${Object.keys(cfg.EXTRA_TOKENS).length} extra tokens: ${Object.keys(cfg.EXTRA_TOKENS).join(', ')||'none'}`);
  if(Object.keys(cfg.EXTRA_TOKENS).length) await coverage(provider,cfg.EXTRA_TOKENS);
}
async function coverage(provider,extra) {
  const reqs=[];
  for(const [sym,addr] of Object.entries(extra)) for(const venue of cfg.VENUES)
    reqs.push({key:`${sym}|${venue.name}`,venue,tokenIn:cfg.WETH,tokenOut:addr,amountIn:ethers.parseEther('0.05')});
  const q=await quoteMany(provider,cfg.MULTICALL3,reqs,cfg.CALLS_PER_BATCH,cfg.CONCURRENCY);
  for(const sym of Object.keys(extra)) {
    const hits=cfg.VENUES.filter(v=>q.has(`${sym}|${v.name}`)).map(v=>`${v.name}(${q.get(`${sym}|${v.name}`).pool})`);
    console.log(`  ${sym} priced on ${hits.length}: ${hits.join(' ')||'-'}`);
  }
}
function sendCsv(res,file) {
  res.setHeader('content-type','text/csv');
  fs.createReadStream(file).on('error',()=>{res.statusCode=404;res.end('No observations recorded');}).pipe(res);
}
function createStatusServer(stats,started,monitor) {
  return http.createServer((req,res)=>{
    res.setHeader('cache-control','no-store');
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/markets.json') {
      res.setHeader('content-type','application/json');
      return res.end(JSON.stringify(monitor?.snapshot()||{mode:'monitor_only',enabled:false}));
    }
    if(url.pathname==='/cex.csv') return sendCsv(res,monitor?.config.csvPath||'results/cex-observations.csv');
    if(url.pathname==='/csv') return sendCsv(res,cfg.CSV_PATH);
    res.setHeader('content-type','text/plain; charset=utf-8');
    res.end(summaryText(stats,started)+monitorText(monitor)+`Tokens: ${cfg.tokenList().map(t=>t.sym).join(', ')}\nDEX quote observations: /csv\n`);
  });
}
function startLive(provider,stats,started,monitor) {
  setInterval(()=>console.log('\n'+summaryText(stats,started)+monitorText(monitor)),cfg.SUMMARY_EVERY_MIN*60000).unref();
  setInterval(()=>refreshTokens(provider).catch(()=>console.error('rediscover failed; check discovery service')),cfg.REDISCOVER_HOURS*3600000).unref();
  if(!process.env.PORT) return;
  const server=createStatusServer(stats,started,monitor);
  server.listen(Number(process.env.PORT),()=>console.log(`Status page listening on port ${process.env.PORT}`));
  return server;
}
module.exports={refreshTokens,startLive,coverage,createStatusServer};
