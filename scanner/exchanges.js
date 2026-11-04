// User's 50-venue watchlist, in the original order. Spot public data only.
const rows = [
  ['coinbaseexchange','Coinbase','USD'],['kraken','Kraken','USD'],
  ['binance','Binance','USDT'],['binanceus','Binance.US','USDT'],
  ['gemini','Gemini','USD'],['bitstamp','Bitstamp','USD'],
  ['cryptocom','Crypto.com Exchange','USD'],['okx','OKX','USDT'],
  ['bybit','Bybit','USDT'],['kucoin','KuCoin','USDT'],
  ['bitget','Bitget','USDT'],['gate','Gate','USDT'],['mexc','MEXC','USDT'],
  ['htx','HTX','USDT'],['bitfinex','Bitfinex','USD'],['bingx','BingX','USDT'],
  ['phemex','Phemex','USDT'],['poloniex','Poloniex','USDT'],
  ['bitmart','BitMart','USDT'],['lbank','LBank','USDT'],
  ['upbit','Upbit','KRW'],['bithumb','Bithumb','KRW'],
  ['bitflyer','bitFlyer','JPY'],['coincheck','Coincheck','JPY'],
  ['bitbank','Bitbank','JPY'],['gmocoin','GMO Coin','JPY'],
  ['bittrade','BitTrade','JPY'],['bitkub','Bitkub','THB'],
  ['indodax','Indodax','IDR'],['tokocrypto','Tokocrypto','USDT'],
  ['bitvavo','Bitvavo','EUR'],['whitebit','WhiteBIT','USDT'],
  ['luno','Luno','ZAR'],['bitso','Bitso','MXN'],['valr','VALR','ZAR'],
  ['cex','CEX.IO','USD'],['coinjar','CoinJar Exchange','AUD'],
  ['blockchaincom','Blockchain.com','USD'],['btcturk','BtcTurk','TRY'],
  ['paribu','Paribu','TRY'],['bullish','Bullish','USD'],
  ['hashkey','HashKey Exchange','USDT'],['osl','OSL Exchange','USD'],
  ['btse','BTSE','USD'],['bitrue','Bitrue','USDT'],['coinw','CoinW','USDT'],
  ['digifinex','DigiFinex','USDT'],['pionex','Pionex','USDT'],
  ['coinstore','Coinstore','USDT'],['bit2me','Bit2Me','EUR']
];
const NATIVE = new Set(['bitmart','gmocoin','bitkub','valr','coinjar','paribu','osl','coinw','pionex','coinstore','bit2me']);
const EXCHANGES = rows.map(([id,name,quote],i)=>({id,name,number:i+1,quote,
  adapter:NATIVE.has(id)?'native':'ccxt',symbols:[`BTC/${quote}`,`ETH/${quote}`]}));
module.exports={EXCHANGES};
