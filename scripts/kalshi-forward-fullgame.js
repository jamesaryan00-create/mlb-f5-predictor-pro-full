// Full-game analogue of scripts/kalshi-forward.js. Captures/grades the KXMLBGAME marketTrust
// cohort into its own directory (data/kalshi-forward-fullgame/) so records never mix with the
// existing F5 capture/grade files in data/kalshi-forward/.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {getKalshiFullGameBoard}=require('../lib/kalshi-board-fullgame');
const {capture,grade,summarize}=require('../lib/kalshi-forward-fullgame');
const {whaleActivityForRecord}=require('../lib/whale-trades');
const {mapWithConcurrency}=require('../lib/kalshi-http');
const {todayPacific}=require('../lib/mlb');
const {hasGamesOnDate,logSkip}=require('../lib/season-guard');
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
  const today=todayPacific();
  if(!(await hasGamesOnDate(today))){logSkip(`No MLB games scheduled for ${today}`);return;}
  // NOTE (#7/#8 line-movement/CLV fix): this used to skip any game already present in a prior
  // capture file (`known`), so every game only ever got exactly one snapshot for its entire life --
  // enough for a marketTrust "entry price" but not enough for line-movement.js to build a
  // multi-point quote chain. grade()/records() below already dedupe to the *earliest* capture per
  // game for marketTrust grading, so it's safe to keep capturing the same game across repeated
  // ~20-minute cron runs within its pregame window; line-movement.js reads every capture file
  // undeduped to chain them.
  const board=await getKalshiFullGameBoard({maxMinutesToPitch:60}),at=new Date().toISOString();
  const eligible=board.board.filter(r=>Date.parse(r.firstPitchUtc)-Date.parse(at)<=3600000).map(r=>capture(r,at)).filter(Boolean);
  // Whale/large-trade detection (new, exploratory -- see FEATURE-WISHLIST.md): same capture cycle,
  // additive field only.
  await mapWithConcurrency(eligible,2,async(r)=>{r.whaleActivity=await whaleActivityForRecord(r).catch(e=>({error:e.message}));});
  const file=save('capture',{modelPlan,capturedAt:at,records:eligible,board});console.log(JSON.stringify({at:new Date().toISOString(),file,recorded:eligible.length,boardRows:board.board.length,rejected:board.rejected}));
 }else if(process.argv[2]==='grade') {
  const pending=records();
  if(!pending.length){logSkip('No ungraded capture data pending for prior dates');return;}
  const results=[];
  for(const r of pending){
   try {const res=await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePk=${r.gamePk}&hydrate=linescore`,{signal:AbortSignal.timeout(15000)});if(!res.ok)throw Error(`MLB ${res.status}`);const source=await res.json(),games=(source.dates||[]).flatMap(d=>d.games||[]);results.push({...r,...(games.length===1?grade(r,games[0]):{status:'excluded',reason:'Ambiguous schedule'}),source});}
   catch(e){results.push({...r,status:'pending',reason:e.message});}
  }
  const report={modelPlan,generatedAt:new Date().toISOString(),marketTrust:summarize(results,'marketTrust'),results};
  console.log(JSON.stringify({file:save('grades',report),marketTrust:report.marketTrust}));
 }else throw Error('Use capture or grade');
}
const timer=setTimeout(()=>{console.error('Timed out');process.exit(1);},300000);
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>clearTimeout(timer));
