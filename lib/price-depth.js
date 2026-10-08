const {tradeProjection}=require('./trade-projection');
// A YES purchase consumes NO bids in the SAME contract. Other team markets
// must never be substituted for this contract's NO book.
function assessDepth(raw, ask, budget=1000) {
  const rows=raw?.orderbook_fp?.no_dollars;
  if(!Array.isArray(rows))return {status:'unavailable',reason:'Missing fixed-point order book'};
  const levels=[];
  for(const row of rows){
    if(!Array.isArray(row)||row.length!==2||row.some(v=>v===null||v===''))return {status:'unavailable',reason:'Malformed depth'};
    const bid=Number(row[0]),quantity=Number(row[1]);
    if(!Number.isFinite(bid)||bid<=0||bid>=1||!Number.isFinite(quantity)||quantity<0)return {status:'unavailable',reason:'Invalid depth'};
    if(quantity>0)levels.push({ask:Math.round((1-bid)*10000)/10000,quantity});
  }
  levels.sort((a,b)=>a.ask-b.ask);
  const scenario=price=>{
    const trade=tradeProjection(budget,price);
    if(!trade)return null;
    const available=levels.filter(l=>l.ask<=price+1e-9).reduce((n,l)=>n+l.quantity,0);
    return {price,requiredContracts:trade.contracts,availableContracts:available,sufficient:available+1e-8>=trade.contracts};
  };
  return {status:'observed',bestAsk:levels[0]?.ask??null,atQuotedAsk:scenario(ask),atOneCentWorse:scenario(ask+.01),
    limitation:'Displayed depth at observation time, not a guaranteed fill; no queue, cancellation, or historical fee override validation.'};
}
async function captureDepth(row,{fetchFn=fetch,nowFn=Date.now}={}){
  const sides={};
  for(const side of ['home','away']){
    const ticker=row.marketTickers?.[side];
    if(typeof ticker!=='string'||!ticker.startsWith('KXMLBGAME-')){sides[side]={status:'unavailable',reason:'Missing full-game ticker'};continue;}
    const requestedAt=new Date(nowFn()).toISOString();
    try{
      const res=await fetchFn(`https://external-api.kalshi.com/trade-api/v2/markets/${encodeURIComponent(ticker)}/orderbook`,{signal:AbortSignal.timeout(10000)});
      if(!res.ok)throw Error(`Order book HTTP ${res.status}`);
      const raw=await res.json(),observedAt=new Date(nowFn()).toISOString();
      sides[side]={ticker,requestedAt,observedAt,beforeFirstPitch:Date.parse(observedAt)<Date.parse(row.firstPitchUtc),...assessDepth(raw,row.outcomeQuotes?.[side]?.ask),raw};
    }catch(e){sides[side]={ticker,requestedAt,status:'unavailable',reason:e.message};}
  }
  return {gamePk:row.gamePk,diagnosticOnly:true,sides};
}
module.exports={assessDepth,captureDepth};
