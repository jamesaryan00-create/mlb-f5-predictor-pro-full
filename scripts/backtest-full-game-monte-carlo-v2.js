const fs=require('fs'),path=require('path');
const {simulateV2}=require('../lib/full-game-monte-carlo');
const SIMS=Number(process.env.MC_SIMULATIONS||1200);
const rows=JSON.parse(fs.readFileSync(path.join(process.cwd(),'data/full-game-monte-carlo-picks.json')));
const bullpenRows=JSON.parse(fs.readFileSync(path.join(process.cwd(),'data/bullpen-quality-history-2010-2026.json')));
const bullpens=new Map(bullpenRows.map(r=>[`${r.gamePk}:${r.side}`,r]));
const strengths=(process.env.MC_STRENGTHS||'0,.25,.5,.75,1').split(',').map(Number), outcomes=Object.fromEntries(strengths.map(s=>[s,[]]));let available=0;const picks=[];
for(const row of rows){
 const home=bullpens.get(`${row.gamePk}:HOME`),away=bullpens.get(`${row.gamePk}:AWAY`);
 let primary=null;
 for(const strength of strengths){const mc=simulateV2(row.expectedRuns,{home,away},{simulations:SIMS,seed:row.gamePk,bullpenStrength:strength});if(!mc)continue;const side=mc.homeProbability>=.5?1:0,result=side===row.target?'win':'loss';outcomes[strength].push({season:row.season,result});if(primary===null||strength===1)primary={mc,result};}
 if(!primary)continue;available++;
 picks.push({gamePk:row.gamePk,date:row.date,season:row.season,homeTeam:row.homeTeam,awayTeam:row.awayTeam,target:row.target,homeProbability:primary.mc.homeProbability,result:primary.result,bullpenAvailable:Boolean(home?.available&&away?.available)});
}
const base=JSON.parse(fs.readFileSync(path.join(process.cwd(),'data/full-game-monte-carlo-backtest.json')));
const summary=r=>{const wins=r.filter(p=>p.result==='win').length;return{games:r.length,wins,losses:r.length-wins,accuracy:wins/r.length}};
const byStrength=Object.fromEntries(strengths.map(s=>[s,summary(outcomes[s])]));
const bySeason=[...new Set(picks.map(p=>p.season))].map(season=>({season,...Object.fromEntries(strengths.map(s=>[`strength${s}`,summary(outcomes[s].filter(r=>r.season===season))]))}));
const best=strengths.map(s=>({strength:s,...byStrength[s]})).sort((a,b)=>b.accuracy-a.accuracy)[0];
const report={generatedAt:new Date().toISOString(),simulationsPerGame:SIMS,coverage:'Same full-game walk-forward matchups; no confidence filtering.',...summary(picks),baselineMonteCarlo:base.monteCarlo,baselineLogistic:base.logistic,bullpenSnapshotsAvailable:picks.filter(p=>p.bullpenAvailable).length,byStrength,bestRetrospectiveStrength:best,bySeason};
fs.writeFileSync(path.join(process.cwd(),'data/full-game-monte-carlo-v2-backtest.json'),JSON.stringify(report,null,2));
fs.writeFileSync(path.join(process.cwd(),'data/full-game-monte-carlo-v2-picks.json'),JSON.stringify(picks));
console.log(JSON.stringify(report,null,2));
