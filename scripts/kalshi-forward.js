const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {getKalshiBoard}=require('../lib/kalshi-board');
const {capture,grade,summarize}=require('../lib/kalshi-forward');
const dir=path.join(process.cwd(),'data','kalshi-forward');fs.mkdirSync(dir,{recursive:true});
const planFile=path.join(dir,'plan.json');
if(!fs.existsSync(planFile)) {
 const start=new Date(),end=new Date(start.getTime()+30*86400000);
 fs.writeFileSync(planFile,JSON.stringify({version:1,start:start.toISOString(),end:end.toISOString(),baseline:.58,candidate:.62,metric:'Wins / (wins + losses + ties)',policy:'First fresh snapshot per game in the final 60 minutes before scheduled first pitch; same snapshot for both rules. Fixed 30-day collection, then wait for outcomes. No early promotion. Inconclusive if fewer than 100 graded candidate picks. No automatic rule changes.'},null,2),{flag:'wx'});
}
const plan=JSON.parse(fs.readFileSync(planFile));
// Registered later than plan.json, after finding in retrospective 2026 data that requiring the
// trained model to agree with a confident Kalshi price outperformed Kalshi's price alone. This is
// a second, independent pre-registration for that specific rule -- it does not alter plan.json or
// baseline/candidate, and must clear its own fixed window and sample-size floor before being trusted.
const modelPlanFile=path.join(dir,'model-agreement-plan.json');
if(!fs.existsSync(modelPlanFile)) {
 const start=new Date(),end=new Date(start.getTime()+30*86400000);
 fs.writeFileSync(modelPlanFile,JSON.stringify({version:1,start:start.toISOString(),end:end.toISOString(),rule:'marketTrust',definition:'Trained historical model (lib/mlb.js) side agrees with Kalshi side; Kalshi confidence >= 0.62; model confidence >= 0.55.',metric:'Wins / (wins + losses + ties)',retrospectiveBasis:'2026 season, N=83, 62.65% wins/all-picks -- see codex-research/outputs and web-app/lib/kalshi-board.js comments.',policy:'Same capture snapshot and cadence as plan.json. Fixed 30-day collection, then wait for outcomes. No early promotion. Inconclusive if fewer than 100 graded marketTrust picks. No automatic rule changes.'},null,2),{flag:'wx'});
}
const modelPlan=JSON.parse(fs.readFileSync(modelPlanFile));
function save(kind,data){const file=path.join(dir,`${kind}-${Date.now()}-${crypto.randomUUID()}.json`);fs.writeFileSync(file,JSON.stringify(data,null,2),{flag:'wx',mode:0o600});return file;}
function records(){const byGame=new Map();for(const file of fs.readdirSync(dir).filter(f=>f.startsWith('capture-')))for(const r of JSON.parse(fs.readFileSync(path.join(dir,file))).records){const old=byGame.get(r.gamePk);if(!old||r.capturedAt<old.capturedAt)byGame.set(r.gamePk,r);}return [...byGame.values()];}
async function main(){
 if(process.argv[2]==='capture') {
  if(Date.now()>=Date.parse(plan.end))throw Error('Fixed collection window ended; run grading.');
  const board=await getKalshiBoard({maxMinutesToPitch:60}),at=new Date().toISOString(),known=new Set(records().map(r=>r.gamePk));
  const eligible=board.board.filter(r=>!known.has(r.gamePk)&&Date.parse(r.firstPitchUtc)-Date.parse(at)<=3600000).map(r=>capture(r,at)).filter(Boolean);
  const file=save('capture',{plan,capturedAt:at,records:eligible,board});console.log(JSON.stringify({at:new Date().toISOString(),file,recorded:eligible.length,boardRows:board.board.length,rejected:board.rejected}));
 }else if(process.argv[2]==='grade') {
  const results=[];
  for(const r of records()){
   try {const res=await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePk=${r.gamePk}&hydrate=linescore`,{signal:AbortSignal.timeout(15000)});if(!res.ok)throw Error(`MLB ${res.status}`);const source=await res.json(),games=(source.dates||[]).flatMap(d=>d.games||[]);results.push({...r,...(games.length===1?grade(r,games[0]):{status:'excluded',reason:'Ambiguous schedule'}),source});}
   catch(e){results.push({...r,status:'pending',reason:e.message});}
  }
  const report={plan,modelPlan,generatedAt:new Date().toISOString(),baseline:summarize(results,'baseline'),candidate:summarize(results,'candidate'),marketTrust:summarize(results,'marketTrust'),results};
  console.log(JSON.stringify({file:save('grades',report),baseline:report.baseline,candidate:report.candidate,marketTrust:report.marketTrust}));
 }else throw Error('Use capture or grade');
}
const timer=setTimeout(()=>{console.error('Timed out');process.exit(1);},300000);
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>clearTimeout(timer));
