const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {parseEvent,normTeam,getLiveMarkets}=require('../lib/kalshi-board');
const {selectLatestQuote,quoteSetQuality}=require('../lib/kalshi-quotes');
const {grade,summarize}=require('../lib/kalshi-forward');
async function json(url){const r=await fetch(url,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error(`HTTP ${r.status}`);return r.json();}
async function main(){
 const date=process.argv[2];if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw Error('Supply YYYY-MM-DD');
 const source=await json(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore`),games=(source.dates||[]).flatMap(d=>d.games||[]),markets=await getLiveMarkets(),events=new Map();
 for(const m of markets){if(!events.has(m.event_ticker))events.set(m.event_ticker,[]);events.get(m.event_ticker).push(m);}
 const rows=[],rejected=[];
 for(const [ticker,ms]of events){const parsed=parseEvent(ticker);if(!parsed||parsed.date!==date)continue;
  const matched=games.filter(g=>normTeam(g.teams.home.team.name)===normTeam(parsed.homeTeam)&&normTeam(g.teams.away.team.name)===normTeam(parsed.awayTeam));
  if(matched.length!==1){rejected.push({ticker,reason:'Ambiguous MLB match'});continue;}
  const g=matched[0],start=Date.parse(g.gameDate);if(start>Date.now())continue;
  if(Object.keys(g).some(k=>/^resum/i.test(k)&&g[k])){rejected.push({ticker,reason:'Resumed game'});continue;}
  const qs={},raw={},tickers={};let error=null;
  for(const [side,suffix] of [['away',parsed.awayCode],['home',parsed.homeCode],['tie','TIE']]){
   const contracts=ms.filter(m=>m.ticker.split('-').at(-1)===suffix);if(contracts.length!==1){error='Missing or ambiguous outcome';break;}
   const m=contracts[0];tickers[side]=m.ticker;
   const params=new URLSearchParams({start_ts:String(Math.floor(start/1000)-600),end_ts:String(Math.floor(start/1000)-1),period_interval:'1'});
   try{const d=await json(`https://external-api.kalshi.com/trade-api/v2/series/KXMLBF5/markets/${encodeURIComponent(m.ticker)}/candlesticks?${params}`);raw[side]=d;
    const result=selectLatestQuote(d.candlesticks,g.gameDate,start-1,.15);if(!result.quote){error=result.reason;break;}qs[side]=result.quote;
   }catch(e){error=e.message;break;}
  }
  if(!error){const q=quoteSetQuality(Object.values(qs),start-1);if(!q.available)error=q.reason;}
  if(error){rejected.push({ticker,reason:error,raw});continue;}
  const p=qs.home.mid/(qs.home.mid+qs.away.mid),side=p>=.5?'HOME':'AWAY',confidence=Math.max(p,1-p);
  const r={provenance:'historically-reconstructed',retrievedAt:new Date().toISOString(),gamePk:g.gamePk,officialDate:g.officialDate,firstPitchUtc:g.gameDate,homeId:g.teams.home.team.id,awayId:g.teams.away.team.id,homeTeam:parsed.homeTeam,awayTeam:parsed.awayTeam,eventTicker:ticker,kalshiPickSide:side,kalshiPickTeam:side==='HOME'?parsed.homeTeam:parsed.awayTeam,kalshiConfidence:confidence,baseline:confidence>=.58,candidate:confidence>=.62,outcomeQuotes:qs,marketTickers:tickers,observedAsk:qs[side.toLowerCase()].ask,rawCandles:raw,mlbSource:g};
  rows.push({...r,...grade(r,g)});
 }
 const dir=path.join(process.cwd(),'data','kalshi-reconstructed');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,`${date}-${Date.now()}-${crypto.randomUUID()}.json`);
 const report={date,retrievedAt:new Date().toISOString(),method:'Latest completed one-minute candle strictly before scheduled first pitch; all three quotes within five minutes and one minute of one another. Reconstructed, not live or executed. Current schedule cannot prove historical schedule changes.',baseline:summarize(rows,'baseline'),candidate:summarize(rows,'candidate'),rows,rejected};
 fs.writeFileSync(file,JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({file,baseline:report.baseline,rows:rows.map(r=>({game:r.awayTeam+' @ '+r.homeTeam,pick:r.kalshiPickTeam,confidence:r.kalshiConfidence,ask:r.observedAsk,baseline:r.baseline,status:r.status,result:r.result})),rejected:rejected.map(r=>({ticker:r.ticker,reason:r.reason}))}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
