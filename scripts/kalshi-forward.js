const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {getKalshiBoard}=require('../lib/kalshi-board');
const {capture,grade,summarize}=require('../lib/kalshi-forward');
const {whaleActivityForRecord}=require('../lib/whale-trades');
const {mapWithConcurrency}=require('../lib/kalshi-http');
const {todayPacific}=require('../lib/mlb');
const {hasGamesOnDate,logSkip}=require('../lib/season-guard');
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
  const today=todayPacific();
  if(!(await hasGamesOnDate(today))){logSkip(`No MLB games scheduled for ${today}`);return;}
  // NOTE (#7/#8 line-movement/CLV fix): this used to skip any game already present in a prior
  // capture file (`known`), so every game only ever got exactly one snapshot for its entire life --
  // enough for a marketTrust "entry price" but not enough for line-movement.js to build a
  // multi-point quote chain. grade()/records() below already dedupe to the *earliest* capture per
  // game for marketTrust grading, so it's safe to keep capturing the same game across repeated
  // ~20-minute cron runs within its pregame window; line-movement.js reads every capture file
  // undeduped to chain them.
  // Fetch unrestricted (no maxMinutesToPitch) so this one capture cycle serves both: `records`,
  // marketTrust's own <=60-minute-before-first-pitch definition (unchanged), and `allRecords`,
  // every pregame game with a usable quote regardless of time to first pitch -- added for #42 so
  // lib/kalshi-capture-store.js can serve the live site's Kalshi-primary pick all day, not just in
  // the final hour before first pitch (see scripts/kalshi-forward-fullgame.js's matching fix for
  // the full-game side, same reasoning).
  const board=await getKalshiBoard(),at=new Date().toISOString();
  const eligible=board.board.filter(r=>Date.parse(r.firstPitchUtc)-Date.parse(at)<=3600000).map(r=>capture(r,at)).filter(Boolean);
  const allRecords=board.board.map(r=>capture(r,at)).filter(Boolean);
  // Whale/large-trade detection (new, exploratory -- see FEATURE-WISHLIST.md): pulled in the same
  // capture cycle so it lands in the same capture-*.json record as the existing quote data,
  // additive fields only (see lib/kalshi-results.js's readResults, which only reads specific named
  // fields off each record and is unaffected by new ones). Only computed for the marketTrust-eligible
  // set (unchanged scope/cost).
  await mapWithConcurrency(eligible,2,async(r)=>{r.whaleActivity=await whaleActivityForRecord(r).catch(e=>({error:e.message}));});
  const file=save('capture',{plan,capturedAt:at,records:eligible,allRecords,board});console.log(JSON.stringify({at:new Date().toISOString(),file,recorded:eligible.length,allRecorded:allRecords.length,boardRows:board.board.length,rejected:board.rejected}));
 }else if(process.argv[2]==='grade') {
  const pending=records();
  if(!pending.length){logSkip('No ungraded capture data pending for prior dates');return;}
  const results=[];
  for(const r of pending){
   try {const res=await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePk=${r.gamePk}&hydrate=linescore`,{signal:AbortSignal.timeout(15000)});if(!res.ok)throw Error(`MLB ${res.status}`);const source=await res.json(),games=(source.dates||[]).flatMap(d=>d.games||[]);results.push({...r,...(games.length===1?grade(r,games[0]):{status:'excluded',reason:'Ambiguous schedule'}),source});}
   catch(e){results.push({...r,status:'pending',reason:e.message});}
  }
  const report={plan,modelPlan,generatedAt:new Date().toISOString(),baseline:summarize(results,'baseline'),candidate:summarize(results,'candidate'),marketTrust:summarize(results,'marketTrust'),results};
  console.log(JSON.stringify({file:save('grades',report),baseline:report.baseline,candidate:report.candidate,marketTrust:report.marketTrust}));
 }else throw Error('Use capture or grade');
}
const timer=setTimeout(()=>{console.error('Timed out');process.exit(1);},300000);
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>clearTimeout(timer));
