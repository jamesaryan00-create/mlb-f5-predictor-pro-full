const test=require('node:test'),assert=require('node:assert/strict');
const {capture,grade,summarize}=require('../lib/kalshi-forward');
const now='2026-09-14T20:00:00Z';
const row={gamePk:1,homeId:2,awayId:3,officialDate:'2026-09-14',firstPitchUtc:'2026-09-14T20:30:00Z',gameStatus:'Scheduled',outcomeQuotes:Object.fromEntries([['home',.6],['away',.25],['tie',.15]].map(([s,mid])=>[s,{mid,time:now}]))};
test('same fresh snapshot selects both groups and rejects stale or started games',()=>{
 const r=capture(row,now);assert.equal(r.baseline,true);assert.equal(r.candidate,true);assert.equal(r.kalshiPickSide,'HOME');
 assert.equal(capture(row,'2026-09-14T20:06:00Z'),null);assert.equal(capture(row,'2026-09-14T20:30:00Z'),null);
});
test('ties are non-wins in primary denominator; pending and exclusions stay visible',()=>{
 const r=capture(row,now);const game={gamePk:1,officialDate:row.officialDate,gameDate:row.firstPitchUtc,teams:{home:{team:{id:2}},away:{team:{id:3}}},status:{detailedState:'Final'},linescore:{innings:Array.from({length:5},(_,i)=>({num:i+1,home:{runs:0},away:{runs:0}}))}};
 const tied={...r,...grade(r,game)};assert.equal(tied.win,false);assert.equal(tied.tie,true);
 const summary=summarize([tied,{...r,status:'graded',win:true,tie:false},{...r,status:'pending'}],'baseline');assert.equal(summary.winPct,50);assert.equal(summary.ties,1);assert.equal(summary.pending,1);
 game.gameDate='2026-09-15T20:30:00Z';assert.equal(grade(r,game).status,'excluded');
});

test('summarize reports win rate both with ties as losses and excluding ties',()=>{
 const rows=[{baseline:true,status:'graded',win:true,tie:false},{baseline:true,status:'graded',win:false,tie:true},{baseline:true,status:'graded',win:false,tie:false},{baseline:true,status:'graded',win:true,tie:false}];
 const s=require('../lib/kalshi-forward').summarize(rows,'baseline');
 assert.equal(s.winPct,50);assert.equal(s.decided,3);assert.ok(Math.abs(s.winPctDecided-200/3)<1e-9);
});
