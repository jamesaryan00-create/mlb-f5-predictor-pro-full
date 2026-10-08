// Reads existing captures only; never places orders or rewrites historical picks.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {decide,POLICY}=require('../lib/price-decision');
const {readRecord}=require('../lib/price-paper-record');
const {captureDepth}=require('../lib/price-depth');
async function main({root=process.cwd(),nowFn=Date.now,fetchFn=fetch,log=console.log}={}){
  const dir=path.join(root,'data/price-paper');
  const stamp=()=>new Date(nowFn()).toISOString();
  function write(file,value){
    const temporary=path.join(dir,`.pending-${crypto.randomUUID()}`);
    fs.writeFileSync(temporary,JSON.stringify(value,null,2));
    try{fs.linkSync(temporary,path.join(dir,file));}finally{fs.unlinkSync(temporary);}
  }
  fs.mkdirSync(dir,{recursive:true});
  const lock=path.join(dir,'run.lock');let fd;
  try{fd=fs.openSync(lock,'wx');}catch(e){if(e.code==='EEXIST')return log('Already running');throw e;}
  try{
    const current=readRecord(dir),counts={};
    for(const r of current.rows)if(r.decision.selected)counts[r.date]=(counts[r.date]||0)+1;
    const source=path.join(root,'data/kalshi-forward-fullgame');
    const files=fs.readdirSync(source).filter(f=>/^capture-\d+.*\.json$/.test(f)).sort().slice(-12);
    const latest=new Map();
    for(const file of files){const raw=fs.readFileSync(path.join(source,file),'utf8'),d=JSON.parse(raw);
      for(const r of d.allRecords||d.records||[])if(!latest.has(r.gamePk)||Date.parse(r.capturedAt)>Date.parse(latest.get(r.gamePk).r.capturedAt))latest.set(r.gamePk,{r,file,hash:crypto.createHash('sha256').update(raw).digest('hex')});
    }
    for(const {r,file,hash} of [...latest.values()].sort((a,b)=>Date.parse(a.r.firstPitchUtc)-Date.parse(b.r.firstPitchUtc)||a.r.gamePk-b.r.gamePk)){
      if(fs.existsSync(path.join(dir,`decision-${r.gamePk}.json`)))continue;
      const now=nowFn(),mins=(Date.parse(r.firstPitchUtc)-now)/60000,age=now-Date.parse(r.capturedAt);
      if(!(mins>0&&mins<=60)||!Number.isFinite(age)||age<0||age>300000||!r.modelAvailable||!['HOME','AWAY'].includes(r.modelPickSide)||!Number.isFinite(r.modelConfidence))continue;
      const decision=decide({homeProbability:r.modelPickSide==='HOME'?r.modelConfidence:1-r.modelConfidence,quotes:r.outcomeQuotes,firstPitch:r.firstPitchUtc,now});
      // Invalid/missing snapshots are observations, not locked strategic passes.
      if(!decision.sides.length)continue;
      if(decision.selected&&(counts[r.officialDate]||0)>=POLICY.dailyCap){delete decision.selected;decision.side=null;decision.action='PASS';decision.reason='Daily paper cap of eight reached';}
      if(decision.selected)counts[r.officialDate]=(counts[r.officialDate]||0)+1;
      write(`decision-${r.gamePk}.json`,{gamePk:r.gamePk,date:r.officialDate,home:r.homeTeam,away:r.awayTeam,homeId:r.homeId,awayId:r.awayId,firstPitch:r.firstPitchUtc,lockedAt:stamp(),modelCapturedAt:r.capturedAt,
        sourceCapture:file,sourceSha256:hash,policy:POLICY,quotes:r.outcomeQuotes,decision});
      // Separate immutable diagnostic: never changes the frozen paper decision.
      write(`execution-${r.gamePk}.json`,await captureDepth(r,{fetchFn,nowFn}));
    }
    for(const row of readRecord(dir).rows.filter(r=>r.decision.selected&&!r.grade)){
      if(Date.parse(row.firstPitch)>nowFn())continue;
      const res=await fetchFn(`https://statsapi.mlb.com/api/v1.1/game/${row.gamePk}/feed/live`,{signal:AbortSignal.timeout(20000)});
      if(!res.ok)throw Error(`MLB grade HTTP ${res.status}`);
      const g=await res.json();
      if(g.gameData?.status?.detailedState!=='Final')continue;
      if(g.gameData?.teams?.home?.id!==row.homeId||g.gameData?.teams?.away?.id!==row.awayId)throw Error('Grading identity mismatch');
      const h=g.liveData?.linescore?.teams?.home?.runs,a=g.liveData?.linescore?.teams?.away?.runs;
      if(!Number.isFinite(h)||!Number.isFinite(a)||h===a)continue;
      // A rescheduled start requires review instead of silently using another game slot.
      if(Date.parse(g.gameData?.datetime?.dateTime)!==Date.parse(row.firstPitch))continue;
      const win=(h>a)===(row.decision.side==='home'),trade=row.decision.selected.trade;
      const market=row.decision.sides.find(s=>s.marketRole==='FAVORITE') || row.decision.sides.find(s=>s.side==='home');
      const marketWin=(h>a)===(market.side==='home');
      const benchmark={side:market.side,win:marketWin,net:(marketWin?market.trade.payout:0)-market.trade.cost};
      write(`grade-${row.gamePk}.json`,{status:'graded',gradedAt:stamp(),homeRuns:h,awayRuns:a,win,benchmark,net:(win?trade.payout:0)-trade.cost,settlementBasis:'MLB final result; hypothetical contract held to settlement, void rules unverified'});
    }
    const summary=readRecord(dir);log(JSON.stringify({at:stamp(),picks:summary.picks,passes:summary.passes,wins:summary.wins,losses:summary.losses,pending:summary.pending,net:summary.net}));
  }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
module.exports={main};
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
