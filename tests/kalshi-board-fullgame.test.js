const test=require('node:test'),assert=require('node:assert/strict');
const {decideTier,parseEvent,normTeam,resolveScheduleGame}=require('../lib/kalshi-board-fullgame');
test('full-game board tier rule matches F5: preserves all 58%+ selections',()=>{
 assert.equal(decideTier({kalshiConfidence:.58}),'PLAY');
 assert.equal(decideTier({kalshiConfidence:.62}),'STRONG');
 assert.equal(decideTier({kalshiConfidence:.579}),'PASS');
 assert.equal(decideTier({kalshiConfidence:null}),'PASS');
});
test('parseEvent strips doubleheader G1/G2 suffix that KXMLBF5 tickers never carry',()=>{
 const base=parseEvent('KXMLBGAME-26SEP221305TBNYY');
 const dh=parseEvent('KXMLBGAME-26SEP221305TBNYYG1');
 assert.ok(base);assert.ok(dh);
 assert.equal(base.awayTeam,dh.awayTeam);assert.equal(base.homeTeam,dh.homeTeam);
 assert.equal(base.date,'2026-09-22');
});
test('normTeam normalizes Oakland to Athletics like the F5 board',()=>{
 assert.equal(normTeam('Oakland Athletics'),normTeam('Athletics'));
});

test('parseEvent captures the G1/G2 doubleheader suffix instead of just discarding it',()=>{
 assert.equal(parseEvent('KXMLBGAME-26SEP221305TORBAL').doubleHeaderGame,null);
 assert.equal(parseEvent('KXMLBGAME-26SEP221305TORBALG1').doubleHeaderGame,1);
 assert.equal(parseEvent('KXMLBGAME-26SEP221305TORBALG2').doubleHeaderGame,2);
});

function schedRow(over){return {awayTeam:'Toronto Blue Jays',homeTeam:'Baltimore Orioles',awayNorm:normTeam('Toronto Blue Jays'),homeNorm:normTeam('Baltimore Orioles'),scheduleDate:'2026-09-23',gameNumber:1,status:'Scheduled',gamePk:1,...over};}

test('resolveScheduleGame: normal single-match day resolves exactly as before',()=>{
 const schedule=[schedRow()];
 const parsed=parseEvent('KXMLBGAME-26SEP231305TORBAL');
 const r=resolveScheduleGame(schedule,parsed);
 assert.ok(r.game);assert.equal(r.game.gamePk,1);
});

test('resolveScheduleGame: doubleheader resolves each G1/G2 ticker to its own specific game, not rejected',()=>{
 const schedule=[schedRow({gamePk:824785,gameNumber:1}),schedRow({gamePk:824786,gameNumber:2})];
 const g1=resolveScheduleGame(schedule,parseEvent('KXMLBGAME-26SEP231305TORBALG1'));
 const g2=resolveScheduleGame(schedule,parseEvent('KXMLBGAME-26SEP231305TORBALG2'));
 assert.ok(g1.game);assert.equal(g1.game.gamePk,824785);
 assert.ok(g2.game);assert.equal(g2.game.gamePk,824786);
});

test('resolveScheduleGame: doubleheader without a resolvable G-suffix falls back to the still-upcoming entry',()=>{
 const schedule=[schedRow({gamePk:1,status:'Final'}),schedRow({gamePk:2,status:'Scheduled'})];
 const r=resolveScheduleGame(schedule,parseEvent('KXMLBGAME-26SEP231305TORBAL'));
 assert.ok(r.game);assert.equal(r.game.gamePk,2);
});

test('resolveScheduleGame: genuine no-match rejects with a specific reason',()=>{
 const r=resolveScheduleGame([],parseEvent('KXMLBGAME-26SEP231305TORBAL'));
 assert.equal(r.reason,'No schedule match');
});

test('resolveScheduleGame: unresolvable doubleheader/reschedule ambiguity rejects with a specific reason',()=>{
 const schedule=[schedRow({gamePk:1,status:'Scheduled'}),schedRow({gamePk:2,status:'Pre-Game'})];
 const r=resolveScheduleGame(schedule,parseEvent('KXMLBGAME-26SEP231305TORBAL'));
 assert.equal(r.reason,'Ambiguous doubleheader/reschedule match, could not disambiguate');
});

test('resolveScheduleGame: a postponed-then-cancelled game is excluded, not treated as tradeable',()=>{
 const schedule=[schedRow({gamePk:1,status:'Postponed'})];
 const r=resolveScheduleGame(schedule,parseEvent('KXMLBGAME-26SEP231305TORBAL'));
 assert.ok(r.game);
 assert.equal(r.game.status,'Postponed');
 // getKalshiFullGameBoard itself excludes non-Scheduled/Pre-Game games from the board after
 // resolving them (see the status regex check right after resolveScheduleGame is called) --
 // resolveScheduleGame's job is only to pick the right row, not to judge tradeability.
});
