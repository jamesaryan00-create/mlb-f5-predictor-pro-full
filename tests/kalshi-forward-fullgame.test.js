const test=require('node:test'),assert=require('node:assert/strict');
const {capture,grade,summarize}=require('../lib/kalshi-forward-fullgame');
const now='2026-09-14T20:00:00Z';
const row={gamePk:1,homeId:2,awayId:3,officialDate:'2026-09-14',firstPitchUtc:'2026-09-14T20:30:00Z',gameStatus:'Scheduled',outcomeQuotes:Object.fromEntries([['home',.62],['away',.38]].map(([s,mid])=>[s,{mid,time:now}]))};
test('same fresh snapshot selects the pick and rejects stale or started games (no tie leg)',()=>{
 const r=capture(row,now);assert.equal(r.baseline,true);assert.equal(r.candidate,true);assert.equal(r.kalshiPickSide,'HOME');
 assert.equal(capture(row,'2026-09-14T20:06:00Z'),null);assert.equal(capture(row,'2026-09-14T20:30:00Z'),null);
});
test('grade never returns a tie: full-game always resolves HOME or AWAY',()=>{
 const r=capture(row,now);
 const game={gamePk:1,officialDate:row.officialDate,gameDate:row.firstPitchUtc,teams:{home:{team:{id:2}},away:{team:{id:3}}},status:{detailedState:'Final'},linescore:{teams:{home:{runs:5},away:{runs:2}}}};
 const graded={...r,...grade(r,game)};
 assert.equal(graded.status,'graded');assert.equal(graded.result,'HOME');assert.equal(graded.win,true);assert.equal(graded.tie,false);
});
test('a tied final score is excluded rather than misgraded, since full games should never tie',()=>{
 const r=capture(row,now);
 const tiedGame={gamePk:1,officialDate:row.officialDate,gameDate:row.firstPitchUtc,teams:{home:{team:{id:2}},away:{team:{id:3}}},status:{detailedState:'Final'},linescore:{teams:{home:{runs:3},away:{runs:3}}}};
 assert.equal(grade(r,tiedGame).status,'excluded');
});
test('identity mismatch and schedule change are excluded like the F5 grader',()=>{
 const r=capture(row,now);
 const game={gamePk:1,officialDate:row.officialDate,gameDate:row.firstPitchUtc,teams:{home:{team:{id:2}},away:{team:{id:3}}},status:{detailedState:'Final'},linescore:{teams:{home:{runs:5},away:{runs:2}}}};
 assert.equal(grade(r,{...game,gamePk:99}).status,'excluded');
 assert.equal(grade(r,{...game,gameDate:'2026-09-15T20:30:00Z'}).status,'excluded');
});
test('pending games stay pending until final',()=>{
 const r=capture(row,now);
 const game={gamePk:1,officialDate:row.officialDate,gameDate:row.firstPitchUtc,teams:{home:{team:{id:2}},away:{team:{id:3}}},status:{detailedState:'In Progress'}};
 assert.equal(grade(r,game).status,'pending');
});
test('summarize has no ties field and computes win rate as wins/(wins+losses)',()=>{
 const rows=[{marketTrust:true,status:'graded',win:true},{marketTrust:true,status:'graded',win:false},{marketTrust:true,status:'graded',win:true},{marketTrust:true,status:'pending'}];
 const s=summarize(rows,'marketTrust');
 assert.equal(s.selected,4);assert.equal(s.graded,3);assert.equal(s.wins,2);assert.equal(s.losses,1);assert.equal(s.pending,1);
 assert.ok(Math.abs(s.winPct-200/3)<1e-9);
});
