const fs=require('fs');
const path=require('path');
const {EXCHANGES}=require('./exchanges');
const {createAdapters}=require('./cex-adapters');

function settings(env=process.env) {
  const config={enabled:env.CEX_ENABLED!=='0',pollMs:Number(env.CEX_POLL_MS??60000),
    timeoutMs:Number(env.CEX_TIMEOUT_MS??10000),concurrency:Number(env.CEX_CONCURRENCY??8),
    maxAgeMs:Number(env.CEX_MAX_AGE_MS??20000),maxSkewMs:Number(env.CEX_MAX_SKEW_MS??5000),
    fees:JSON.parse(env.CEX_TAKER_FEES_BPS||'{}'),
    sizes:JSON.parse(env.CEX_BASE_SIZES||'{"BTC":[0.001,0.01],"ETH":[0.05,0.5]}'),
    csvPath:env.CEX_CSV_PATH||'results/cex-observations.csv'};
  for(const key of ['pollMs','timeoutMs','concurrency','maxAgeMs','maxSkewMs'])
    if(!Number.isSafeInteger(config[key])||config[key]<1) throw new Error(`Invalid CEX ${key}`);
  if(config.pollMs<30000) throw new Error('CEX_POLL_MS must be at least 30000 for public rate limits');
  if(!config.fees||Array.isArray(config.fees)||typeof config.fees!=='object') throw new Error('Invalid CEX fees');
  for(const [id,fee] of Object.entries(config.fees))
    if(!EXCHANGES.some(e=>e.id===id)||typeof fee!=='number'||!Number.isFinite(fee)||fee<0||fee>10000) throw new Error('Invalid CEX fee override');
  if(!config.sizes||Array.isArray(config.sizes)||typeof config.sizes!=='object') throw new Error('Invalid CEX sizes');
  for(const [base,sizes] of Object.entries(config.sizes))
    if(!['BTC','ETH'].includes(base)||!Array.isArray(sizes)||!sizes.length||sizes.some(n=>typeof n!=='number'||!Number.isFinite(n)||n<=0)) throw new Error('Invalid CEX sizes');
  return config;
}

function normalizeBook(raw,{id,name,symbol,requestedAt,receivedAt}) {
  if(raw?.auction_mode===true||raw?.info?.auction_mode===true) throw new Error('auction');
  const side=(rows,descending)=>{
    if(!Array.isArray(rows)||!rows.length) throw new Error('invalid_book');
    const levels=rows.map(row=>[Number(row[0]),Number(row[1])]);
    if(levels.some(([p,q])=>!Number.isFinite(p)||!Number.isFinite(q)||p<=0||q<0)) throw new Error('invalid_book');
    const available=levels.filter(([,q])=>q>0);
    if(!available.length) throw new Error('invalid_book');
    return available.sort((a,b)=>descending?b[0]-a[0]:a[0]-b[0]);
  };
  const asks=side(raw.asks,false),bids=side(raw.bids,true);
  if(bids[0][0]>=asks[0][0]) throw new Error('crossed_book');
  const timestamp=raw.timestamp==null?null:Number(raw.timestamp);
  if(timestamp!==null&&(!Number.isFinite(timestamp)||timestamp>receivedAt+5000)) throw new Error('invalid_timestamp');
  // A source timestamp can only make a snapshot older, never newer than the request.
  const observedAt=Math.min(requestedAt-(raw.cacheAgeMs||0),timestamp??requestedAt);
  return {id,name,symbol,asks,bids,requestedAt,receivedAt,observedAt,
    timestampBasis:timestamp===null?'request_start':'source_and_request'};
}
function quoteBase(levels,amount) {
  let left=amount,total=0;
  for(const [price,size] of levels) {
    const fill=Math.min(left,size);total+=fill*price;left-=fill;
    if(left<=amount*1e-12) return total;
  }
  return null; // Never extrapolate past available order-book depth.
}
function compareBooks(books,config,now=Date.now()) {
  const fresh=books.filter(b=>now-b.observedAt<=config.maxAgeMs&&b.observedAt<=now);
  const routes=[];
  for(const buy of fresh) for(const sell of fresh) {
    if(buy.id===sell.id||buy.symbol!==sell.symbol||Math.abs(buy.observedAt-sell.observedAt)>config.maxSkewMs) continue;
    const [base,quote]=buy.symbol.split('/');
    for(const amount of config.sizes[base]||[]) {
      const buyCost=quoteBase(buy.asks,amount),sellProceeds=quoteBase(sell.bids,amount);
      if(buyCost===null||sellProceeds===null) continue;
      const buyFee=config.fees[buy.id],sellFee=config.fees[sell.id];
      const gross=sellProceeds-buyCost;
      const net=buyFee==null||sellFee==null?null:sellProceeds*(1-sellFee/10000)-buyCost*(1+buyFee/10000);
      routes.push({symbol:buy.symbol,baseAmount:amount,quoteCurrency:quote,buy:buy.name,sell:sell.name,
        buyCost,sellProceeds,grossQuote:gross,spreadBps:gross/buyCost*10000,netQuote:net,
        feeStatus:net===null?'unknown_account_fees':'configured_fee_estimate',
        observedAt:Math.min(buy.observedAt,sell.observedAt),execution:'monitor_only'});
    }
  }
  // Percentages rank cross-currency observations; amounts are never mixed across quotes.
  return routes.sort((a,b)=>b.spreadBps-a.spreadBps);
}
function errorStatus(error) {
  // Some CCXT adapters wrap HTTP codes in their exception text. Classify without
  // returning arbitrary upstream messages or URLs to the public status endpoint.
  if(/\b(403|451)\b|restricted location|block access.*country/i.test(error?.message||'')) return 'access_restricted';
  if(error?.message==='unsupported_market'||error?.name==='BadSymbol') return 'unsupported_market';
  if(error?.status===401||error?.name==='AuthenticationError') return 'authentication_required';
  if(error?.status===403||error?.status===451||error?.name==='PermissionDenied'||error?.name==='RestrictedLocation') return 'access_restricted';
  if(error?.status===429||error?.name==='RateLimitExceeded'||error?.name==='DDoSProtection') return 'rate_limited';
  if(['TimeoutError','RequestTimeout','AbortError'].includes(error?.name)) return 'timeout';
  if(['invalid_book','crossed_book','invalid_timestamp','auction'].includes(error?.message)) return error.message;
  return 'unavailable';
}
const HEADER='time,symbol,base_amount,quote_currency,buy,sell,buy_cost,sell_proceeds,gross_quote,spread_bps,net_quote,fee_status,execution';
function appendObservations(config,routes,now) {
  const positive=routes.filter(r=>r.grossQuote>0).slice(0,20);
  if(!positive.length) return;
  fs.mkdirSync(path.dirname(config.csvPath),{recursive:true});
  if(!fs.existsSync(config.csvPath)) fs.writeFileSync(config.csvPath,HEADER+'\n');
  const cell=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
  const lines=positive.map(r=>[new Date(now).toISOString(),r.symbol,r.baseAmount,r.quoteCurrency,
    r.buy,r.sell,r.buyCost,r.sellProceeds,r.grossQuote,r.spreadBps,r.netQuote,r.feeStatus,r.execution].map(cell).join(','));
  fs.appendFileSync(config.csvPath,lines.join('\n')+'\n');
}
function createMonitor({config=settings(),adapters,now=Date.now,append=appendObservations,log=console.log}={}) {
  const feeds=adapters??createAdapters({timeoutMs:config.timeoutMs});
  const books=new Map(),markets=new Map();
  let running=false,stopped=false,timer=null,cycles=0,lastCycleAt=null,lastError=null;
  for(const feed of feeds) for(const symbol of feed.symbols) markets.set(feed.id+'|'+symbol,{exchange:feed.name,id:feed.id,symbol,status:'pending'});
  function snapshot() {
    const at=now(),list=[...markets.values()].map(m=>{
      const book=books.get(m.id+'|'+m.symbol);
      return {...m,status:book&&at-book.observedAt>config.maxAgeMs?'stale':m.status,
        bestBid:book?.bids[0][0]??null,bestAsk:book?.asks[0][0]??null,
        ageMs:book?Math.max(0,at-book.observedAt):null,timestampBasis:book?.timestampBasis??null};
    });
    return {mode:'monitor_only',enabled:config.enabled,configuredExchanges:feeds.length,
      respondingExchanges:new Set(list.filter(m=>m.status==='ok').map(m=>m.id)).size,
      cycles,lastCycleAt,lastError,markets:list,routes:compareBooks([...books.values()],config,at).slice(0,50)};
  }
  async function pollOnce() {
    if(running||!config.enabled) return snapshot();
    running=true;
    let cursor=0;
    try {
      await Promise.all(Array.from({length:Math.min(config.concurrency,feeds.length)},async()=>{
        while(cursor<feeds.length) {
          const feed=feeds[cursor++];
          for(const symbol of feed.symbols) {
            const key=feed.id+'|'+symbol,requestedAt=now();
            books.delete(key);
            try {
              const raw=await feed.fetchBook(symbol);
              const book=normalizeBook(raw,{...feed,symbol,requestedAt,receivedAt:now()});
              books.set(key,book);markets.set(key,{exchange:feed.name,id:feed.id,symbol,status:'ok',lastCheckedAt:now()});
            } catch(error) {
              markets.set(key,{exchange:feed.name,id:feed.id,symbol,status:errorStatus(error),lastCheckedAt:now()});
            }
          }
        }
      }));
      cycles++;lastCycleAt=now();lastError=null;
      const result=snapshot();
      try {append(config,result.routes,lastCycleAt);} catch {lastError='csv_write_failed';}
      log(`CEX monitoring: ${result.respondingExchanges}/${feeds.length} exchanges fresh; ${result.routes.length} depth comparisons; no orders submitted`);
      return snapshot();
    } finally {running=false;}
  }
  function start() {
    stopped=false;
    const tick=async()=>{
      try {await pollOnce();} catch {lastError='monitor_cycle_failed';}
      if(!stopped) {timer=setTimeout(tick,config.pollMs);timer.unref();}
    };
    void tick();
  }
  return {config,snapshot,pollOnce,start,stop(){stopped=true;clearTimeout(timer);}};
}
function monitorText(monitor) {
  if(!monitor) return '';
  const s=monitor.snapshot();
  const lines=['','## Centralized exchange monitoring',`Mode: ${s.enabled?'monitor only':'disabled'}; ${s.respondingExchanges}/${s.configuredExchanges} exchanges currently fresh.`,
    'BTC and ETH spot books; local quote currencies stay separate. Fees unknown unless configured.',
    'Depth comparisons are observations, not trades. Transfer, FX, and rebalancing costs are excluded.'];
  for(const feed of EXCHANGES) {
    const rows=s.markets.filter(m=>m.id===feed.id);
    lines.push(`${feed.number}. ${feed.name}: ${rows.map(m=>`${m.symbol} ${m.status}${m.bestBid!==null?' bid '+m.bestBid+' / ask '+m.bestAsk:''}`).join('; ')}`);
  }
  for(const r of s.routes.slice(0,5)) lines.push(`Quote: ${r.symbol} ${r.baseAmount} buy ${r.buy} -> sell ${r.sell}; spread ${(r.spreadBps/100).toFixed(3)}%; ${r.netQuote===null?'net unknown (fees unconfigured)':'estimated net '+r.netQuote.toFixed(4)+' '+r.quoteCurrency}`);
  lines.push('JSON: /markets.json | CEX observations: /cex.csv');
  return lines.join('\n')+'\n';
}
if(require.main===module) {
  const monitor=createMonitor();
  monitor.pollOnce().then(()=>{console.log(monitorText(monitor));process.exit(0);})
    .catch(()=>{console.error('CEX monitoring check failed');process.exit(1);});
}
module.exports={settings,normalizeBook,quoteBase,compareBooks,errorStatus,createMonitor,monitorText,appendObservations};
