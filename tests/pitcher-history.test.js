const test=require('node:test'),assert=require('node:assert/strict');
const {liveRollingPitcherQuality}=require('../lib/pitcher-history');
test('live pitcher window crosses seasons and excludes analysis date',async()=>{
 const original=global.fetch,years=[];
 global.fetch=async url=>{const year=new URL(url).searchParams.get('season');years.push(year);return {ok:true,json:async()=>({stats:[{type:{displayName:'gameLog'},splits:Array.from({length:year==='2026'?1:10},(_,i)=>({date:year==='2026'?'2026-04-01':`2025-09-${String(i+1).padStart(2,'0')}`,gameType:'R',game:{gamePk:Number(year)*100+i},stat:{gamesStarted:1,inningsPitched:'5.0',hits:5,baseOnBalls:1,hitBatsmen:0,strikeOuts:5,homeRuns:1}}))}]})};};
 try{const r=await liveRollingPitcherQuality(999991,'2026-04-01');assert.deepEqual(years,['2026','2025']);assert.equal(r.starts,10);assert.equal(r.whipLast10,1.2);}finally{global.fetch=original;}
});
