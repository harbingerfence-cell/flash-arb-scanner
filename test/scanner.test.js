const test = require('node:test');
const assert = require('node:assert/strict');
const {ethers} = require('ethers');
const {scanOnce,scoreRoutes} = require('../scanner/core');
const {quoteMany,encodeAggregate3} = require('../scanner/multicall');
const {mcIface} = require('../scanner/quotes');
const {contractRoute,simulateRoute,executorInterface,feeOracleInterface} = require('../scanner/simulation');
const {recordScan} = require('../scanner/scan');
const cfg = require('../scanner/config');
const addr = n => ethers.getAddress('0x'+n.toString(16).padStart(40,'0'));
const eth = ethers.parseEther;
const venue = {name:'UniswapV3',type:'v3',quoter:addr(1),fees:[100,500]};
const route = {token:'TEST',tokenAddress:addr(3),sizeWei:eth('1'),backWei:eth('1.01'),
  buyVenue:'UniswapV3',sellVenue:'PancakeV3',buyPool:'fee500',sellPool:'fee100',netWei:eth('0.009')};

test('manual multicall encoding matches the canonical ABI encoder', () => {
  const calls=[{target:addr(1),data:'abcdef'},{target:addr(2),data:'11'.repeat(65)}];
  assert.equal(encodeAggregate3(calls),mcIface.encodeFunctionData('aggregate3',[
    calls.map(c=>({target:c.target,allowFailure:true,callData:'0x'+c.data}))]));
});

test('all quote chunks use one block; excluded buy pool cannot be selected', async () => {
  const seen=[];
  const provider={getBlockNumber:async()=>123,call:async tx=>{
    seen.push(tx.blockTag);
    const [calls]=mcIface.decodeFunctionData('aggregate3',tx.data);
    return mcIface.encodeFunctionResult('aggregate3',[calls.map(()=>({success:true,
      returnData:ethers.AbiCoder.defaultAbiCoder().encode(['uint256'],[42n])}))]);
  }};
  const requests=[{key:'a',venue,tokenIn:addr(2),tokenOut:addr(3),amountIn:1n,excludePool:'fee100'},
    {key:'b',venue,tokenIn:addr(2),tokenOut:addr(3),amountIn:1n}];
  const quotes=await quoteMany(provider,addr(9),requests,1,2);
  assert.deepEqual(seen,[123,123,123]);
  assert.equal(quotes.get('a').pool,'fee500');
  await assert.rejects(quoteMany(provider,addr(9),requests,1,0),/positive integers/);
});

test('failed subquotes cannot become quotes and truncated batches fail closed', async () => {
  const requests=[{key:'a',venue:{...venue,fees:[100]},tokenIn:addr(2),tokenOut:addr(3),amountIn:1n}];
  const provider={getBlockNumber:async()=>5,call:async()=>mcIface.encodeFunctionResult('aggregate3',[[{success:false,returnData:'0x'}]])};
  assert.equal((await quoteMany(provider,addr(9),requests,1)).size,0);
  provider.call=async()=>mcIface.encodeFunctionResult('aggregate3',[[]]);
  await assert.rejects(quoteMany(provider,addr(9),requests,1),/count mismatch/);
});

function scanFixture({reorg=false,stale=false,missingGas=false}={}) {
  let blocks=0, tokenReads=0, rounds=0;
  const config={...cfg,WETH:addr(2),VENUES:[venue,{...venue,name:'PancakeV3'}],
    SIZES_ETH:[1],L1_FEE_ETH:0,ARB_GAS_UNITS:1,FLASH_FEE:0,PROFIT_BUFFER_ETH:'0',
    tokenList:()=>{tokenReads++;return [{sym:'TEST',addr:addr(3),sizes:[1]}];}};
  const provider={getBlockNumber:async()=>stale?110:100,getFeeData:async()=>({gasPrice:missingGas?null:1n}),
    getBlock:async()=>({hash:++blocks===2 && reorg?'0xbb':'0xaa'})};
  const quote=async(p,m,requests,b,c,options)=>{
    assert.equal(options.blockTag,100);
    rounds++;
    if (rounds===1) return new Map([['TEST|1|UniswapV3',{amountOut:99n,pool:'fee100'}]]);
    assert.equal(requests.length,2,'sell venue does not need a successful forward quote');
    assert.equal(requests[0].excludePool,'fee100');
    assert.equal(requests[1].onlyPool,undefined,'reverse pool must be independently optimized');
    assert.ok(requests.every(r=>r.amountIn===99n));
    return new Map(requests.map(r=>[r.key,{amountOut:eth('1.01'),pool:'fee500'}]));
  };
  return {run:()=>scanOnce(provider,{config,quote,blockNumber:100}),reads:()=>tokenReads};
}

test('scan pins both legs, snapshots discovery and finds alternate sell pools', async () => {
  const fixture=scanFixture(), res=await fixture.run();
  assert.equal(res.routes.length,2);
  assert.equal(fixture.reads(),1);
  assert.equal(res.routes[0].tokenAddress,addr(3));
  assert.equal(res.routes[0].status,'quoted');
});
test('stale, reorganized, and missing-gas scans are rejected', async () => {
  await assert.rejects(scanFixture({stale:true}).run(),/Stale/);
  await assert.rejects(scanFixture({reorg:true}).run(),/reorganized/);
  await assert.rejects(scanFixture({missingGas:true}).run(),/Gas price unavailable/);
});
test('cost model rounds fees up and subtracts buffer before ranking', () => {
  const [r]=scoreRoutes([{sizeWei:1n,backWei:10n}],{gasCostWei:2n,flashFee:0.000001,profitBufferWei:3n});
  assert.equal(r.flashFeeWei,1n);
  assert.equal(r.netWei,3n);
  assert.throws(()=>scoreRoutes([],{gasCostWei:0n,flashFee:NaN}),/Invalid/);
});
test('executor route encoding rejects unsupported protocols and malformed pools', () => {
  assert.equal(contractRoute({...route,buyVenue:'UniswapV4'}),null);
  assert.equal(contractRoute({...route,buyPool:'feeNaN'}),null);
  assert.equal(contractRoute(route).sell.dex,1);
});

function simulationFixture({badRevert=false,stale=false,reorg=false}={}) {
  let blocks=0;
  const calls=[];
  const config={...cfg,EXECUTOR_ADDRESS:addr(10),PROFIT_BUFFER_ETH:'0.0001',GAS_BUFFER_BPS:2000};
  const provider={getBlock:async()=>({hash:++blocks===2 && reorg?'0xbb':'0xaa'}),
    getBlockNumber:async()=>stale?105:100,getFeeData:async()=>({maxFeePerGas:2n,maxPriorityFeePerGas:1n}),
    send:async(method,args)=>{
      calls.push(method);assert.equal(method,'eth_estimateGas');assert.equal(args[1],'0x64');return '0x186a0';
    },call:async tx=>{
      calls.push('eth_call');assert.equal(tx.blockTag,100);
      if (tx.to===addr(10)) {
        const parsed=executorInterface.parseTransaction({data:tx.data});
        if (parsed.name==='owner') return executorInterface.encodeFunctionResult('owner',[addr(11)]);
        assert.equal(tx.from,addr(11));
        assert.equal(parsed.args.simulate,true);
        throw {data:badRevert?'0xdeadbeef':executorInterface.encodeErrorResult('SimResult',[eth('1.01'),eth('1.0001')])};
      }
      const [serialized]=feeOracleInterface.decodeFunctionData('getL1Fee',tx.data);
      assert.equal(ethers.Transaction.from(serialized).isSigned(),true);
      return feeOracleInterface.encodeFunctionResult('getL1Fee',[1000n]);
    }};
  return {provider,config,calls};
}
test('simulation uses actual flash repayment and pinned transaction gas/L1 estimates without broadcasting', async () => {
  const {provider,config,calls}=simulationFixture();
  const result=await simulateRoute(provider,route,100,{config});
  assert.equal(result.status,'simulated_positive');
  assert.equal(result.flashFeeWei,eth('0.0001'));
  assert.equal(result.simulatedGasCostWei,241200n);
  assert.equal(result.simulatedNetWei,eth('0.0098')-241200n);
  assert.ok(calls.every(x=>['eth_call','eth_estimateGas'].includes(x)));
});
test('unexpected executor reverts, stale state and reorgs never pass simulation', async () => {
  for (const options of [{badRevert:true},{stale:true},{reorg:true}]) {
    const {provider,config}=simulationFixture(options);
    assert.equal((await simulateRoute(provider,route,100,{config})).status,'simulation_failed');
  }
});
test('positive quotes and successful simulations remain separate in reporting', () => {
  const stats={scans:0,profitable:0,simulatedPositive:0,simulationFailed:0,byToken:{},byRoute:{}};
  const lines=[];
  recordScan(stats,{blockNumber:100,gasCostWei:1n,ethUsd:0,routes:[{...route,grossWei:eth('0.01'),spreadPct:1,status:'unsupported'}]},'now',(p,s)=>lines.push(s));
  assert.equal(stats.profitable,1);assert.equal(stats.simulatedPositive,0);
  assert.match(lines[0],/unsupported/);
  assert.equal(stats.firstBlock,100);
});
test('invalid configuration fails instead of hanging or producing false zero-cost results', () => {
  assert.throws(()=>cfg.validateConfig({...cfg,CONCURRENCY:0}),/CONCURRENCY/);
  assert.throws(()=>cfg.validateConfig({...cfg,SIZES_ETH:[NaN]}),/Trade sizes/);
  assert.throws(()=>cfg.validateConfig({...cfg,FLASH_FEE:-1}),/FLASH_FEE/);
});
