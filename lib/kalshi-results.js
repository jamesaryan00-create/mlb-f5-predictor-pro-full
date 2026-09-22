const fs=require('fs'),path=require('path');
const {summarize}=require('./kalshi-forward');
function readResults(dir=path.join(process.cwd(),'data','kalshi-forward'),now=Date.now()) {
 const warnings=[];
 const read=name=>{try{return JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));}catch(e){if(e.code!=='ENOENT')warnings.push(`Could not read ${name}`);return null;}};
 if(!fs.existsSync(dir))return {available:false,warnings:['No local Kalshi tracking data found.'],rows:[]};
 const plan=read('plan.json');const modelPlan=read('model-agreement-plan.json');const files=fs.readdirSync(dir);
 const captures=files.filter(f=>/^capture-.*\.json$/.test(f)).map(read).filter(Boolean).sort((a,b)=>Date.parse(a.capturedAt)-Date.parse(b.capturedAt));
 const reports=files.filter(f=>/^grades-.*\.json$/.test(f)).map(read).filter(Boolean).sort((a,b)=>Date.parse(a.generatedAt)-Date.parse(b.generatedAt));
 const latest=captures.at(-1),report=reports.at(-1),unique=new Map();
 for(const c of captures)for(const r of c.records||[])if(!unique.has(r.gamePk))unique.set(r.gamePk,r);
 const grades=new Map((report?.results||[]).map(r=>[r.gamePk,r]));
 const rows=[...unique.values()].map(r=>{const g=grades.get(r.gamePk);const match=g?.capturedAt===r.capturedAt;return {gamePk:r.gamePk,awayTeam:r.awayTeam,homeTeam:r.homeTeam,pick:r.kalshiPickTeam,confidence:r.kalshiConfidence,capturedAt:r.capturedAt,firstPitchUtc:r.firstPitchUtc,baseline:r.baseline,candidate:r.candidate,marketTrust:r.marketTrust,modelAvailable:r.modelAvailable,modelPickSide:r.modelPickSide,modelConfidence:r.modelConfidence,modelAgreesWithKalshi:r.modelAgreesWithKalshi,status:match?g.status:'pending',win:match?g.win:false,tie:match?g.tie:false,result:match?g.result:null,reason:match?g.reason:null};}).sort((a,b)=>Date.parse(b.firstPitchUtc)-Date.parse(a.firstPitchUtc));
 const baseline=summarize(rows,'baseline'),candidate=summarize(rows,'candidate'),marketTrust=summarize(rows,'marketTrust');
 const archiveDir=path.join(path.dirname(dir),'kalshi-reconstructed');
 const reconstructed=[];
 if(fs.existsSync(archiveDir)){const byDate=new Map();for(const f of fs.readdirSync(archiveDir).filter(f=>f.endsWith('.json')).sort()){try{const r=JSON.parse(fs.readFileSync(path.join(archiveDir,f),'utf8'));byDate.set(r.date,r);}catch{warnings.push('Unreadable reconstructed record');}}for(const r of byDate.values())reconstructed.push({date:r.date,retrievedAt:r.retrievedAt,baseline:r.baseline,rows:r.rows.map(x=>({gamePk:x.gamePk,awayTeam:x.awayTeam,homeTeam:x.homeTeam,pick:x.kalshiPickTeam,confidence:x.kalshiConfidence,ask:x.observedAsk,status:x.status,win:x.win,tie:x.tie,baseline:x.baseline})),rejected:r.rejected.map(x=>({ticker:x.ticker,reason:x.reason}))});}
 const age=latest?(now-Date.parse(latest.capturedAt))/60000:null;
 return {available:true,reconstructed,plan,modelPlan,baseline,candidate,marketTrust,rows,warnings,health:{lastCapture:latest?.capturedAt||null,lastGrade:report?.generatedAt||null,captureAgeMinutes:age,overdue:age===null||age>30,captureRuns:captures.length,lastRecorded:latest?.records?.length||0,lastBoardRows:latest?.board?.board?.length||0,rejected:latest?.board?.rejected||[]},evaluation:{collectionEnded:plan?now>=Date.parse(plan.end):false,candidateMinimum:100,candidateProgress:candidate.graded,targetWinPct:60,status:!plan?'Plan unavailable':now<Date.parse(plan.end)?'Collecting — no conclusion yet':baseline.pending+candidate.pending>0?'Waiting for outcomes':candidate.graded<100?'Inconclusive — fewer than 100 candidate picks':'Ready for review — no automatic rule change'},modelEvaluation:{collectionEnded:modelPlan?now>=Date.parse(modelPlan.end):false,marketTrustMinimum:100,marketTrustProgress:marketTrust.graded,targetWinPct:60,status:!modelPlan?'Plan unavailable':now<Date.parse(modelPlan.end)?'Collecting — no conclusion yet':marketTrust.pending>0?'Waiting for outcomes':marketTrust.graded<100?'Inconclusive — fewer than 100 marketTrust picks':'Ready for review — no automatic rule change'}};
}
module.exports={readResults};
