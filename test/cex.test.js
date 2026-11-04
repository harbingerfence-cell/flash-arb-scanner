const test=require('node:test');
const assert=require('node:assert/strict');
const {EXCHANGES}=require('../scanner/exchanges');
const {createAdapters,nativeRequest}=require('../scanner/cex-adapters');
const {settings,normalizeBook,quoteBase,compareBooks,createMonitor,errorStatus,monitorText}=require('../scanner/cex');
const raw={asks:[[101,2],[102,3]],bids:[[100,2],[99,3]]};
const context={id:'a',name:'A',symbol:'BTC/USD',requestedAt:1000,receivedAt:1100};
const config=settings({});

test('registry covers exactly the requested 50 distinct spot exchanges in order',()=>{
  assert.equal(EXCHANGES.length,50);assert.equal(new Set(EXCHANGES.map(e=>e.id)).size,50);
  assert.deepEqual(EXCHANGES.slice(0,10).map(e=>e.name),['Coinbase','Kraken','Binance','Binance.US','Gemini','Bitstamp','Crypto.com Exchange','OKX','Bybit','KuCoin']);
  assert.equal(EXCHANGES[49].name,'Bit2Me');
  assert.equal(EXCHANGES.filter(e=>e.adapter==='native').length,11);
});
test('order book normalization rejects invalid, crossed and auction snapshots',()=>{
  assert.throws(()=>normalizeBook({...raw,bids:[[102,1]]},context),/crossed/);
  assert.throws(()=>normalizeBook({...raw,asks:[[NaN,1]]},context),/invalid_book/);
  assert.throws(()=>normalizeBook({...raw,auction_mode:true},context),/auction/);
  const b=normalizeBook({...raw,cacheAgeMs:100,timestamp:1050},context);
  assert.equal(b.observedAt,900);
  assert.equal(normalizeBook({...raw,bids:[[100,0],[99,1]]},context).bids[0][0],99);
});
test('shared HTTP status report includes the CEX watchlist and JSON without trading access',async()=>{
  const {createStatusServer}=require('../scanner/live');
  const monitor=createMonitor({config,adapters:EXCHANGES.map(e=>({...e,fetchBook:async()=>raw})),append:()=>{},log:()=>{}});
  const stats={scans:0,errors:0,profitable:0,byToken:{},byRoute:{}};
  const server=createStatusServer(stats,Date.now(),monitor);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const root=`http://127.0.0.1:${server.address().port}`;
    const jsonResponse=await fetch(root+'/markets.json');
    const json=await jsonResponse.json();
    assert.equal(jsonResponse.headers.get('cache-control'),'no-store');
    assert.equal(json.configuredExchanges,50);assert.equal(json.markets.length,100);
    const text=await (await fetch(root)).text();
    assert.match(text,/Centralized exchange monitoring/);assert.match(text,/50\. Bit2Me/);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
test('existing database dashboard and CSV remain available alongside the CEX monitor',async()=>{
  const {createStatusServer}=require('../scanner/live');
  let flushed=0;
  const database={enabled:()=>true,flush:async()=>flushed++,history:async()=>({hours:[],recent:[],totals:{n:0,usd:0,best:0}}),
    allOpportunities:async()=>[{time:new Date(0),token:'TEST',net_usd:1}]};
  const monitor=createMonitor({config,adapters:EXCHANGES.map(e=>({...e,fetchBook:async()=>raw})),append:()=>{},log:()=>{}});
  const server=createStatusServer({scans:0,errors:0,profitable:0,byToken:{},byRoute:{}},Date.now(),monitor,{database});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const root=`http://127.0.0.1:${server.address().port}`;
    const response=await fetch(root);const html=await response.text();
    assert.match(response.headers.get('content-type'),/text\/html/);
    assert.match(html,/Base Arb Scanner/);assert.match(html,/50\. Bit2Me/);assert.equal(flushed,1);
    const csv=await (await fetch(root+'/csv')).text();assert.match(csv,/TEST/);
    const text=await (await fetch(root+'/text')).text();assert.match(text,/Centralized exchange monitoring/);
    database.history=async()=>{throw new Error('credential-bearing upstream failure');};
    const failure=await fetch(root);assert.equal(failure.status,500);
    assert.doesNotMatch(await failure.text(),/credential/);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
test('depth pricing walks levels and rejects insufficient liquidity',()=>{
  assert.equal(quoteBase(raw.asks,3),304);
  assert.equal(quoteBase(raw.asks,6),null);
});
test('comparisons use equal base sizes, exact pairs, configured fees and fresh snapshots',()=>{
  const buy=normalizeBook(raw,context);
  const sell=normalizeBook({asks:[[105,5]],bids:[[104,5]]},{...context,id:'b',name:'B'});
  const c={...config,sizes:{BTC:[3]},fees:{a:10,b:20}};
  const routes=compareBooks([buy,sell],c,1200),r=routes.find(r=>r.buy==='A');
  assert.equal(r.buyCost,304);assert.equal(r.sellProceeds,312);
  assert.ok(Math.abs(r.netQuote-(312*0.998-304*1.001))<1e-9);
  assert.equal(r.execution,'monitor_only');
  assert.equal(compareBooks([buy,{...sell,symbol:'BTC/USDT'}],c,1200).length,0);
  assert.equal(compareBooks([buy,{...sell,observedAt:99999}],c,100000).length,0);
  assert.equal(compareBooks([buy,sell],c,100000).length,0);
  assert.equal(compareBooks([buy,sell],{...c,fees:{}},1200)[0].netQuote,null);
});

const nativeFixtures={
  bitmart:{code:1000,data:raw},gmocoin:{status:0,data:{asks:[{price:'101',size:'1'}],bids:[{price:'100',size:'1'}]}},
  bitkub:{error:0,result:raw},valr:{Asks:[{price:'101',quantity:'1'}],Bids:[{price:'100',quantity:'1'}]},
  coinjar:raw,paribu:{...raw,timestamp:1},osl:raw,
  coinw:{code:'200',data:{...raw,pair:'BTC_USDT'}},pionex:{result:true,data:{...raw,updateTime:1000}},
  coinstore:{code:0,data:{a:raw.asks,b:raw.bids}},bit2me:raw
};
test('all eleven native adapters normalize documented public response shapes',()=>{
  for(const feed of EXCHANGES.filter(e=>e.adapter==='native')) {
    const request=nativeRequest(feed.id,feed.symbols[0]);
    assert.ok(request.url.startsWith('https://'));
    const parsed=request.parse(nativeFixtures[feed.id]);
    const book=normalizeBook(parsed,{...context,...feed,symbol:feed.symbols[0]});
    assert.equal(book.bids[0][0],100);assert.equal(book.asks[0][0],101);
  }
  assert.equal(nativeRequest('coinw','BTC/USDT').parse({code:'200',data:[{...raw,pair:'BTC_USDT'}]}).bids[0][0],100);
  assert.throws(()=>nativeRequest('paribu','BTC/TRY').parse(null),/unsupported_market/);
});
test('adapter API exposes public books only and rejects inactive/nonspot markets',async()=>{
  const classes={};let publicCalls=0;
  for(const spec of EXCHANGES.filter(e=>e.adapter==='ccxt')) classes[spec.id]=class {
    constructor(options){assert.equal(options.apiKey,undefined);this.has={fetchCurrencies:true};this.markets=Object.fromEntries(spec.symbols.map(s=>[s,{spot:true,active:true}]));}
    async loadMarkets(){}
    async fetchSpotMarkets(){return Object.values(this.markets);}
    async fetchOrderBook(){publicCalls++;return raw;}
    async createOrder(){assert.fail('Trading called');}
    async withdraw(){assert.fail('Withdrawal called');}
  };
  const feeds=createAdapters({ccxtModule:classes,fetchImpl:async(url,options)=>{
    assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,undefined);
    return {ok:true,headers:{get:()=>null},json:async()=>raw};
  }});
  for(const feed of feeds.filter(f=>f.adapter==='ccxt')) {
    await feed.fetchBook(feed.symbols[0]);assert.equal(feed.createOrder,undefined);
    await assert.rejects(feed.fetchBook('NOT/LISTED'),/unsupported_market/);
  }
  assert.equal(publicCalls,39);
});
test('monitor isolates failed venues, exposes all statuses, and skips overlapping cycles',async()=>{
  let release;const wait=new Promise(r=>release=r);
  const adapters=[{id:'a',name:'A',symbols:['BTC/USD'],fetchBook:async()=>{await wait;return raw;}},
    {id:'b',name:'B',symbols:['BTC/USD'],fetchBook:async()=>{throw {status:451};}}];
  let written=0;
  const monitor=createMonitor({config,adapters,now:()=>1000,append:()=>written++,log:()=>{}});
  const first=monitor.pollOnce();
  assert.equal((await monitor.pollOnce()).cycles,0);
  release();const s=await first;
  assert.equal(s.cycles,1);assert.equal(s.respondingExchanges,1);
  assert.equal(s.markets.find(m=>m.id==='b').status,'access_restricted');
  assert.equal(written,1);
});
test('watchlist health enumerates all 50 even when a source fails or becomes stale',async()=>{
  let clock=1000;
  const adapters=EXCHANGES.map((e,i)=>({...e,fetchBook:async()=>{
    if(i===0) throw new Error('unsupported_market');return raw;
  }}));
  const monitor=createMonitor({config,adapters,now:()=>clock,append:()=>{},log:()=>{}});
  const s=await monitor.pollOnce();
  assert.equal(s.configuredExchanges,50);assert.equal(s.respondingExchanges,49);
  assert.equal(s.markets.length,100);assert.equal(s.mode,'monitor_only');
  assert.match(monitorText(monitor),/50\. Bit2Me/);
  clock+=config.maxAgeMs+1;
  assert.equal(monitor.snapshot().respondingExchanges,0);
  assert.equal(monitor.snapshot().routes.length,0);
});
test('error messages are sanitized and fee/size configuration fails closed',()=>{
  assert.equal(errorStatus({message:'secret URL apiKey=abc'}),'unavailable');
  assert.equal(errorStatus({status:429}),'rate_limited');
  assert.equal(errorStatus({name:'ExchangeNotAvailable',message:'451 Unavailable For Legal Reasons'}),'access_restricted');
  assert.throws(()=>settings({CEX_TAKER_FEES_BPS:'{"kraken":-1}'}),/fee/);
  assert.throws(()=>settings({CEX_BASE_SIZES:'{"BTC":[0]}'}),/sizes/);
  assert.throws(()=>settings({CEX_POLL_MS:'100'}),/rate limits/);
});
