// Run from the application root. Each file is new and exclusive; snapshots are never updated.
require('@next/env').loadEnvConfig(process.cwd());
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {snapshot,grade} = require('../lib/prospective');
const {getPredictions,todayPacific} = require('../lib/mlb');
const dir = process.env.PROSPECTIVE_DATA_DIR || path.join(process.cwd(),'data','prospective');
function save(kind,data) {
 fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,`${kind}-${Date.now()}-${crypto.randomUUID()}.json`);
 fs.writeFileSync(file,JSON.stringify(data,null,2),{flag:'wx',mode:0o600});return file;
}
async function main() {
 const command=process.argv[2];
 if(command==='capture') {
  const date=todayPacific();const data=await getPredictions(date);const capturedAt=new Date().toISOString();
  const records=data.games.map(g=>snapshot(g,data.model,capturedAt)).filter(Boolean);
  const file=save('capture',{schemaVersion:1,capturedAt,date,odds:data.odds,dataSources:data.dataSources,selectionPolicy:'Earliest valid capture per game used for evaluation',records,skippedGames:data.games.length-records.length});
  console.log(JSON.stringify({file,forecasts:records.length,matchedQuotes:records.filter(r=>r.quote).length,evEligible:0}));
 } else if(command==='grade') {
  const captures=fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>/^capture-.*\.json$/.test(f)):[];
  const unique=new Map();
  for(const f of captures) for(const r of JSON.parse(fs.readFileSync(path.join(dir,f))).records) {
   const previous=unique.get(r.gamePk);if(!previous||r.capturedAt<previous.capturedAt)unique.set(r.gamePk,r);
  }
  const results=[];
  for(const r of unique.values()) {
   const url=`https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePk=${r.gamePk}&hydrate=linescore`;
   try {
    const res=await fetch(url,{signal:AbortSignal.timeout(15000)});if(!res.ok)throw Error(`MLB HTTP ${res.status}`);
    const source=await res.json();const games=(source.dates||[]).flatMap(d=>d.games||[]);
    const outcome=games.length===1?grade(r,games[0]):{status:'excluded',reason:'Ambiguous or missing MLB game'};
    results.push({gamePk:r.gamePk,capturedAt:r.capturedAt,gradedAt:new Date().toISOString(),...outcome,source});
   } catch(e) {results.push({gamePk:r.gamePk,status:'pending',reason:e.message});}
  }
  const decided=results.filter(r=>r.status==='graded'&&!r.tie);
  const report={generatedAt:new Date().toISOString(),policy:'Earliest capture per game; ties excluded from binary metrics; no assumed bets',uniqueGames:unique.size,decided:decided.length,ties:results.filter(r=>r.tie).length,brier:decided.length?decided.reduce((s,r)=>s+r.brier,0)/decided.length:null,logLoss:decided.length?decided.reduce((s,r)=>s+r.logLoss,0)/decided.length:null,results};
  console.log(JSON.stringify({file:save('grades',report),uniqueGames:report.uniqueGames,decided:report.decided,ties:report.ties}));
 } else throw Error('Use capture or grade');
}
const deadline=setTimeout(()=>{console.error('Prospective run exceeded 5 minutes; retry the command.');process.exit(1);},300000);
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>clearTimeout(deadline));
