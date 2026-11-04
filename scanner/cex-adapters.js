const {EXCHANGES}=require('./exchanges');
const pairs = side => side?.map(x=>Array.isArray(x)?x:[x.price,x.size??x.quantity]);
function nativeRequest(id,symbol) {
  const [base,quote]=symbol.split('/'), joined=base+quote, underscored=base+'_'+quote;
  switch(id) {
    case 'bitmart':return {url:`https://api-cloud.bitmart.com/spot/quotation/v3/books?symbol=${underscored}&limit=20`,parse:j=>{
      if(j.code!==1000) throw new Error('exchange_error');return {...j.data,timestamp:j.data.ts==null?undefined:Number(j.data.ts)};}};
    case 'gmocoin':return {url:`https://api.coin.z.com/public/v1/orderbooks?symbol=${base}`,parse:j=>{
      if(quote!=='JPY'||j.status!==0) throw new Error('exchange_error');
      return {asks:pairs(j.data.asks),bids:pairs(j.data.bids)};}};
    case 'bitkub':return {url:`https://api.bitkub.com/api/v3/market/depth?sym=${underscored.toLowerCase()}&lmt=20`,parse:j=>{
      if(j.error!==0) throw new Error('exchange_error');return j.result;}};
    case 'valr':return {url:`https://api.valr.com/v1/public/${joined}/orderbook`,parse:j=>({asks:pairs(j.Asks),bids:pairs(j.Bids)})};
    case 'coinjar':return {url:`https://data.exchange.coinjar.com/products/${joined}/book`,parse:j=>j};
    case 'paribu':return {url:`https://api.paribu.com/orderbook?market=${base.toLowerCase()}_${quote==='TRY'?'tl':quote.toLowerCase()}&limit=20`,parse:j=>{
      if(!j) throw new Error('unsupported_market');return {...j,timestamp:Number(j.timestamp)*1000};}};
    case 'osl':return {url:`https://trade-hk.osl.com/api/v4/orderBook/L2?symbol=${joined}&depth=25`,parse:j=>j};
    case 'coinw':return {url:`https://api.coinw.com/api/v1/public?command=returnOrderBook&symbol=${underscored}&size=20`,parse:j=>{
      if(String(j.code)!=='200') throw new Error('exchange_error');
      return Array.isArray(j.data)?j.data.find(x=>x.pair===underscored):j.data;}};
    case 'pionex':return {url:`https://api.pionex.com/api/v1/market/depth?symbol=${underscored}&limit=20`,parse:j=>{
      if(j.result!==true) throw new Error('exchange_error');return {...j.data,timestamp:j.data.updateTime};}};
    case 'coinstore':return {url:`https://api.coinstore.com/api/v1/market/depth/${joined}?depth=20`,parse:j=>{
      if(j.code!==0) throw new Error('exchange_error');return {asks:j.data.a,bids:j.data.b};}};
    case 'bit2me':return {url:`https://gateway.bit2me.com/v2/trading/order-book?symbol=${encodeURIComponent(symbol)}`,parse:j=>j};
    default:throw new Error('adapter_unavailable');
  }
}
function createAdapters({timeoutMs=10000,fetchImpl=fetch,ccxtModule}={}) {
  const ccxt=ccxtModule??require('ccxt');
  return EXCHANGES.map(spec=>{
    if(spec.adapter==='native') return {...spec,async fetchBook(symbol){
      const request=nativeRequest(spec.id,symbol);
      const response=await fetchImpl(request.url,{method:'GET',headers:{accept:'application/json'},signal:AbortSignal.timeout(timeoutMs)});
      if(!response.ok) throw Object.assign(new Error('http_error'),{status:response.status});
      const book=request.parse(await response.json());
      if(!book) throw new Error('unsupported_market');
      // Account for public cache age instead of treating old cached data as new.
      const cacheAge=Number(response.headers?.get('age')??0)*1000;
      return {...book,cacheAgeMs:Number.isFinite(cacheAge)?Math.max(0,cacheAge):0};
    }};
    const Exchange=ccxt[spec.id];
    if(!Exchange) return {...spec,async fetchBook(){throw new Error('adapter_unavailable');}};
    const options={defaultType:'spot'};
    if(spec.id==='bybit') options.fetchMarkets={types:['spot']};
    if(spec.id==='htx') options.fetchMarkets={types:{spot:true,linear:false,inverse:false}};
    const client=new Exchange({enableRateLimit:true,timeout:timeoutMs,options});
    // Spot books do not require currency/network metadata or derivative listings.
    client.has.fetchCurrencies=false;
    if(spec.id==='bingx') client.fetchMarkets=client.fetchSpotMarkets.bind(client);
    // Expose only the public data method; never accept API keys or account objects.
    return {...spec,async fetchBook(symbol){
      await client.loadMarkets();
      const market=client.markets[symbol];
      if(!market || !market.spot || market.active===false) throw new Error('unsupported_market');
      return client.fetchOrderBook(symbol,spec.id==='bitfinex'?25:20);
    }};
  });
}
module.exports={createAdapters,nativeRequest};
