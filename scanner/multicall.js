const {variantsFor,A,W,SEL} = require('./quotes');
function encodeAggregate3(calls) {
  const elems = calls.map(({target,data}) => {
    const len = data.length/2;
    return A(target)+W(1)+W(96)+W(len)+data.padEnd(Math.ceil(len/32)*64,'0');
  });
  let offset = elems.length*32;
  const heads = elems.map(e => { const h=W(offset); offset+=e.length/2; return h; });
  return '0x'+SEL.mc+W(32)+W(elems.length)+heads.join('')+elems.join('');
}
function decodeAggregate3(raw) {
  const h=raw.slice(2), word=i=>h.slice(i*2,i*2+64);
  const base=Number(BigInt('0x'+word(0))), n=Number(BigInt('0x'+word(base))), start=base+32;
  const out=[];
  for (let i=0;i<n;i++) {
    const el=start+Number(BigInt('0x'+word(start+i*32)));
    const success=BigInt('0x'+word(el))===1n;
    const dOff=el+Number(BigInt('0x'+word(el+32))), len=Number(BigInt('0x'+word(dOff)));
    out.push({success,data:h.slice((dOff+32)*2,(dOff+32+len)*2)});
  }
  return out;
}
async function quoteMany(provider,multicall,requests,batchSize,concurrency=1,{blockTag}={}) {
  if (!Number.isInteger(batchSize) || batchSize<1 || !Number.isInteger(concurrency) || concurrency<1)
    throw new Error('Batch size and concurrency must be positive integers');
  const snapshot = blockTag ?? await provider.getBlockNumber();
  const flat=[];
  for (const req of requests) for (const v of variantsFor(req.venue,req.tokenIn,req.tokenOut,req.amountIn)) {
    if (req.onlyPool && v.label!==req.onlyPool || req.excludePool && v.label===req.excludePool) continue;
    flat.push({req,v});
  }
  const best=new Map(), chunks=[];
  for (let i=0;i<flat.length;i+=batchSize) chunks.push(flat.slice(i,i+batchSize));
  const runChunk=async chunk => {
    const data=encodeAggregate3(chunk.map(c=>({target:c.v.target,data:c.v.encode()})));
    const raw=await provider.call({to:multicall,data,blockTag:snapshot});
    const results=decodeAggregate3(raw);
    if (results.length!==chunk.length) throw new Error('Multicall result count mismatch');
    results.forEach((r,j)=>{
      const {req,v}=chunk[j];
      if (!r.success || r.data.length<(v.word+1)*64) return;
      const out=BigInt('0x'+r.data.slice(v.word*64,v.word*64+64));
      if (out<=0n) return;
      const prev=best.get(req.key);
      if (!prev || out>prev.amountOut) best.set(req.key,{amountOut:out,pool:v.label});
    });
  };
  for (let i=0;i<chunks.length;i+=concurrency) await Promise.all(chunks.slice(i,i+concurrency).map(runChunk));
  return best;
}
module.exports={quoteMany,encodeAggregate3,decodeAggregate3};
