// Full-game analogue of scripts/kalshi-forward.js. Captures/grades the KXMLBGAME marketTrust
// cohort into its own directory (data/kalshi-forward-fullgame/) so records never mix with the
// existing F5 capture/grade files in data/kalshi-forward/.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {getKalshiFullGameBoard}=require('../lib/kalshi-board-fullgame');
const {capture,grade,summarize}=require('../lib/kalshi-forward-fullgame');
const dir=path.join(process.cwd(),'data','kalshi-forward-fullgame');fs.mkdirSync(dir,{recursive:true});
const modelPlanFile=path.join(dir,'model-agreement-plan.json');
if(!fs.existsSync(modelPlanFile)) {
 const start=new Date(),end=new Date(start.getTime()+30*86400000);
 fs.writeFileSync(modelPlanFile,JSON.stringify({version:1,start:start.toISOString(),end:end.toISOString(),rule:'marketTrust',definition:'Full-game model (lib/full-game-model.js) side agrees with Kalshi KXMLBGAME side; Kalshi confidence >= 0.62; model confidence >= 0.55.',metric:'Wins / (wins + losses)',market:'KXMLBGAME (full game, 2-way, no tie contract)',policy:'First fresh snapshot per game in the final 60 minutes before scheduled first pitch. Fixed 30-day collection, then wait for outcomes. No early promotion. Inconclusive if fewer than 100 graded marketTrust picks. No automatic rule changes.'},null,2),{flag:'wx'});
}
const modelPlan=JSON.parse(fs.readFileSync(modelPlanFile));
function save(kind,data){const file=path.join(dir,`${kind}-${Date.now()}-${crypto.randomUUID()}.json`);fs.writeFileSync(file,JSON.stringify(data,null,2),{flag:'wx',mode:0o600});return file;}
function records(){const byGame=new Map();for(const file of fs.readdirSync(dir).filter(f=>f.startsWith('capture-')))for(const r of JSON.parse(fs.readFileSync(path.join(dir,file))).records){const old=byGame.get(r.gamePk);if(!old||r.capturedAt<old.capturedAt)byGame.set(r.gamePk,r);}return [...byGame.values()];}
async function main(){
 if(process.argv[2]==='capture') {
  if(Date.now()>=Date.parse(modelPlan.end))throw Error('Fixed collection window ended; run grading.');
  const board=await getKalshiFullGameBoard({maxMinutesToPitch:60}),at=new Date().toISOString(),known=new Set(records().map(r=>r.gamePk));
  const eligible=board.board.filter(r=>!known.has(r.gamePk)&&Date.parse(r.firstPitchUtc)-Date.parse(at)<=3600000).map(r=>capture(r,at)).filter(Boolean);
  const file=save('capture',{modelPlan,capturedAt:at,records:eligible,board});console.log(JSON.stringify({at:new Date().toISOString(),file,recorded:eligible.length,boardRows:board.board.length,rejected:board.rejected}));
 }else if(process.argv[2]==='grade') {
  const results=[];
  for(const r of records()){
   try {const res=await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePk=${r.gamePk}&hydrate=linescore`,{signal:AbortSignal.timeout(15000)});if(!res.ok)throw Error(`MLB ${res.status}`);const source=await res.json(),games=(source.dates||[]).flatMap(d=>d.games||[]);results.push({...r,...(games.length===1?grade(r,games[0]):{status:'excluded',reason:'Ambiguous schedule'}),source});}
   catch(e){results.push({...r,status:'pending',reason:e.message});}
  }
  const report={modelPlan,generatedAt:new Date().toISOString(),marketTrust:summarize(results,'marketTrust'),results};
  console.log(JSON.stringify({file:save('grades',report),marketTrust:report.marketTrust}));
 }else throw Error('Use capture or grade');
}
const timer=setTimeout(()=>{console.error('Timed out');process.exit(1);},300000);
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>clearTimeout(timer));
