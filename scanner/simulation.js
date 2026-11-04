const {ethers} = require('ethers');
const cfg = require('./config');
const executorInterface = new ethers.Interface([
  'function owner() view returns (address)',
  'function execute((address token,(uint8 dex,uint24 feeOrTickSpacing) buy,(uint8 dex,uint24 feeOrTickSpacing) sell) r,uint256 amount,uint256 minProfit,bool simulate)',
  'error SimResult(uint256 out,uint256 owed)'
]);
const feeOracleInterface = new ethers.Interface(['function getL1Fee(bytes data) view returns (uint256)']);
const FEE_ORACLE = '0x420000000000000000000000000000000000000F';
function contractLeg(venue,pool) {
  const spec = {UniswapV3:[0,/^fee(\d+)$/],PancakeV3:[1,/^fee(\d+)$/],AeroCL:[2,/^ts(\d+)$/]}[venue];
  const match = spec && spec[1].exec(pool);
  if (!match) return null;
  const parameter=Number(match[1]);
  if (!Number.isSafeInteger(parameter) || parameter <= 0 || parameter > 0xffffff) return null;
  return {dex:spec[0],feeOrTickSpacing:parameter};
}
function contractRoute(route) {
  const buy=contractLeg(route.buyVenue,route.buyPool), sell=contractLeg(route.sellVenue,route.sellPool);
  return buy && sell ? {token:route.tokenAddress,buy,sell} : null;
}
function revertData(error) {
  for (const data of [error?.data,error?.error?.data,error?.info?.error?.data]) {
    if (typeof data==='string' && data.startsWith('0x')) return data;
    if (typeof data?.data==='string') return data.data;
  }
  return null;
}
// Read-only eth_call and eth_estimateGas only. No signer or broadcast path.
async function simulateRoute(provider,route,blockNumber,{config=cfg}={}) {
  const r=contractRoute(route);
  if (!r) return {...route,status:'unsupported'};
  if (!config.EXECUTOR_ADDRESS) return {...route,status:'quoted_supported'};
  try {
    const block=await provider.getBlock(blockNumber);
    if (!block?.hash) throw new Error('Simulation block unavailable');
    const ownerRaw=await provider.call({to:config.EXECUTOR_ADDRESS,
      data:executorInterface.encodeFunctionData('owner'),blockTag:blockNumber});
    const [owner]=executorInterface.decodeFunctionResult('owner',ownerRaw);
    let result;
    try {
      await provider.call({to:config.EXECUTOR_ADDRESS,from:owner,blockTag:blockNumber,
        data:executorInterface.encodeFunctionData('execute',[r,route.sizeWei,0n,true])});
      throw new Error('Simulation returned without SimResult');
    } catch(error) {
      const data=revertData(error);
      if (!data) throw error;
      const decoded=executorInterface.parseError(data);
      if (decoded?.name!=='SimResult') throw new Error('Executor simulation reverted unexpectedly');
      result=decoded.args;
    }
    const [out,owed]=result;
    if (owed<route.sizeWei || out<0n) throw new Error('Invalid simulation balances');
    const flashFeeWei=owed-route.sizeWei;
    const buffer=ethers.parseEther(String(config.PROFIT_BUFFER_ETH));
    if (out<=owed+buffer) return {...route,status:'simulation_unprofitable',simulatedOutWei:out,flashFeeWei};
    const minProfit=out-owed; // Exact simulated surplus: estimate the real successful path.
    const data=executorInterface.encodeFunctionData('execute',[r,route.sizeWei,minProfit,false]);
    const gas=BigInt(await provider.send('eth_estimateGas',[{to:config.EXECUTOR_ADDRESS,from:owner,data},ethers.toQuantity(blockNumber)]));
    const gasLimit=(gas*BigInt(10000+config.GAS_BUFFER_BPS)+9999n)/10000n;
    const fees=await provider.getFeeData();
    const gasPrice=fees.maxFeePerGas ?? fees.gasPrice;
    if (gasPrice==null || gasPrice<=0n) throw new Error('Gas price unavailable');
    const tx=ethers.Transaction.from({type:2,chainId:8453,to:config.EXECUTOR_ADDRESS,data,
      gasLimit,maxFeePerGas:gasPrice,maxPriorityFeePerGas:fees.maxPriorityFeePerGas ?? 0n});
    // Placeholder signature estimates signed payload size without a wallet key.
    tx.signature=ethers.Signature.from({r:'0x'+'11'.repeat(32),s:'0x'+'22'.repeat(32),v:27});
    const oracleRaw=await provider.call({to:FEE_ORACLE,blockTag:blockNumber,
      data:feeOracleInterface.encodeFunctionData('getL1Fee',[tx.serialized])});
    const [l1Fee]=feeOracleInterface.decodeFunctionResult('getL1Fee',oracleRaw);
    const gasCostWei=gasLimit*gasPrice+(l1Fee*BigInt(10000+config.GAS_BUFFER_BPS)+9999n)/10000n;
    const netWei=out-owed-gasCostWei-buffer;
    if ((await provider.getBlock(blockNumber))?.hash!==block.hash) throw new Error('Simulation block reorganized');
    if (await provider.getBlockNumber()-blockNumber>config.MAX_QUOTE_AGE_BLOCKS) throw new Error('Stale simulation');
    return {...route,status:netWei>0n?'simulated_positive':'simulation_unprofitable',
      simulatedOutWei:out,simulatedNetWei:netWei,simulatedGasCostWei:gasCostWei,flashFeeWei};
  } catch(error) {
    // RPC messages can include credential-bearing URLs; expose a stable status only.
    return {...route,status:'simulation_failed'};
  }
}
async function validateCandidates(provider,routes,blockNumber,{config=cfg}={}) {
  let remaining=config.SIMULATE_TOP;
  const out=[];
  for (const route of routes) {
    if (!contractRoute(route)) {out.push({...route,status:'unsupported'});continue;}
    if (route.netWei<=0n || !config.EXECUTOR_ADDRESS || remaining<=0) {
      out.push({...route,status:'quoted_supported'});continue;
    }
    remaining--;
    out.push(await simulateRoute(provider,route,blockNumber,{config}));
  }
  return out;
}
module.exports={contractLeg,contractRoute,simulateRoute,validateCandidates,executorInterface,feeOracleInterface};
