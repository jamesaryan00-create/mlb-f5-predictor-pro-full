const fs=require('fs'),path=require('path');
const {grade:gradeF5}=require('./kalshi-forward');
const VERSION='combined-evidence-v1';
function capture(game,assessment,at=new Date().toISOString()) {
 if(!['Scheduled','Pre-Game'].includes(game.status)||!Number.isFinite(Date.parse(at))||Date.parse(game.gameDate)<=Date.parse(at)||!Number.isFinite(Date.parse(game.gameDate)))return null;
 if(assessment.gamePk!==game.gamePk||assessment.throughDate>=game.officialDate||!['home','away'].includes(assessment.side)||!assessment.available)return null;
 return {version:VERSION,gamePk:game.gamePk,officialDate:game.officialDate,firstPitchUtc:game.gameDate,homeId:game.home.id,awayId:game.away.id,homeTeam:game.home.name,awayTeam:game.away.name,pick:game[assessment.side].name,kalshiPickSide:assessment.side.toUpperCase(),capturedAt:at,assessment};
}
function grade(record,game){const g=gradeF5(record,game);return {...g,outcome:g.status==='graded'?g.tie?'TIE':g.win?'WIN':'LOSS':g.status.toUpperCase()};}
function summary(rows){const graded=rows.filter(r=>r.status==='graded'),wins=graded.filter(r=>r.win).length,ties=graded.filter(r=>r.tie).length;return {recorded:rows.length,graded:graded.length,wins,losses:graded.length-wins-ties,ties,pending:rows.filter(r=>r.status==='pending').length,excluded:rows.filter(r=>r.status==='excluded').length,winPct:graded.length?100*wins/graded.length:null};}
const directory=()=>path.join(process.cwd(),'data','combined-forward');
function records(){const dir=directory();if(!fs.existsSync(dir))return [];return fs.readdirSync(dir).filter(f=>/^pick-\d+\.json$/.test(f)).map(f=>JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')));}
function save(record){const dir=directory();fs.mkdirSync(dir,{recursive:true});try{fs.writeFileSync(path.join(dir,`pick-${record.gamePk}.json`),JSON.stringify(record,null,2),{flag:'wx',mode:0o600});return true;}catch(e){if(e.code==='EEXIST')return false;throw e;}}
function results(){const dir=directory();return records().map(r=>{const p=path.join(dir,`grade-${r.gamePk}.json`);return {...r,...(fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{status:'pending',outcome:'PENDING'})};});}
async function run(){const {getSchedule,todayPacific}=require('./mlb'),{assess}=require('./matchup-logic');const known=new Set(records().map(r=>r.gamePk));const skipped=[];let added=0;
 for(const game of await getSchedule(todayPacific())){if(known.has(game.gamePk)||!['Scheduled','Pre-Game'].includes(game.status)||Date.parse(game.gameDate)<=Date.now())continue;try{const assessment=await assess(game,game.officialDate);const fresh=(await getSchedule(todayPacific())).find(g=>g.gamePk===game.gamePk);const unchanged=fresh&&fresh.gameDate===game.gameDate&&['home','away'].every(side=>fresh[side].probablePitcher?.id===game[side].probablePitcher?.id);const record=unchanged?capture(fresh,assessment):null;if(record){if(save(record))added++;}else skipped.push({gamePk:game.gamePk,reason:'No pregame direction or incomplete evidence'});}catch(e){skipped.push({gamePk:game.gamePk,reason:e.message});}}
 for(const record of records()){try{const r=await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePk=${record.gamePk}&hydrate=linescore`,{signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error(`MLB ${r.status}`);const source=await r.json(),games=(source.dates||[]).flatMap(d=>d.games||[]);if(games.length!==1)throw Error('Ambiguous game');const g={...grade(record,games[0]),gradedAt:new Date().toISOString()};const p=path.join(directory(),`grade-${record.gamePk}.json`),tmp=p+'.tmp';fs.writeFileSync(tmp,JSON.stringify(g));fs.renameSync(tmp,p);}catch(e){skipped.push({gamePk:record.gamePk,reason:e.message});}}
 return {added,skipped};}
module.exports={capture,grade,summary,records,results,run};
