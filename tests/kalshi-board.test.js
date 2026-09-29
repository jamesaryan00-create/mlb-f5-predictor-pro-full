const test=require('node:test'),assert=require('node:assert/strict');
const {decideTier,parseEvent,normTeam,resolveScheduleGame}=require('../lib/kalshi-board');
test('V5 preserves all 58% selections regardless of model agreement or availability',()=>{
 for(const agree of [true,false,null]) for(const modelAvailable of [true,false]) {
 assert.equal(decideTier({kalshiConfidence:.58,agree,modelAvailable,modelConfidence:null,maxSpread:.1}),'PLAY');
 assert.equal(decideTier({kalshiConfidence:.62,agree,modelAvailable,modelConfidence:null,maxSpread:.1}),'STRONG');
 }
 assert.equal(decideTier({kalshiConfidence:.579}),'PASS');
 assert.equal(decideTier({kalshiConfidence:null}),'PASS');
});

// KXMLBF5 tickers carry no G1/G2 doubleheader suffix (unlike KXMLBGAME's, see
// lib/kalshi-board-fullgame.js's parseEvent), so resolveScheduleGame here can only fall back to
// "which schedule entry is still upcoming/tradeable" -- same overall shape/tests as the full-game
// board's resolveScheduleGame, minus the game-number disambiguation path.
function schedRow(over){return {awayTeam:'Toronto Blue Jays',homeTeam:'Baltimore Orioles',awayNorm:normTeam('Toronto Blue Jays'),homeNorm:normTeam('Baltimore Orioles'),scheduleDate:'2026-09-23',gameNumber:1,status:'Scheduled',gamePk:1,...over};}

test('resolveScheduleGame: normal single-match day resolves exactly as before',()=>{
 const schedule=[schedRow()];
 const r=resolveScheduleGame(schedule,parseEvent('KXMLBF5-26SEP231305TORBAL'));
 assert.ok(r.game);assert.equal(r.game.gamePk,1);
});

test('resolveScheduleGame: doubleheader without a G-suffix (F5 tickers never have one) falls back to the still-upcoming entry',()=>{
 const schedule=[schedRow({gamePk:824785,status:'Final'}),schedRow({gamePk:824786,status:'Scheduled'})];
 const r=resolveScheduleGame(schedule,parseEvent('KXMLBF5-26SEP231305TORBAL'));
 assert.ok(r.game);assert.equal(r.game.gamePk,824786);
});

test('resolveScheduleGame: genuine no-match rejects with a specific reason',()=>{
 const r=resolveScheduleGame([],parseEvent('KXMLBF5-26SEP231305TORBAL'));
 assert.equal(r.reason,'No schedule match');
});

test('resolveScheduleGame: unresolvable doubleheader/reschedule ambiguity rejects with a specific reason',()=>{
 const schedule=[schedRow({gamePk:1,status:'Scheduled'}),schedRow({gamePk:2,status:'Pre-Game'})];
 const r=resolveScheduleGame(schedule,parseEvent('KXMLBF5-26SEP231305TORBAL'));
 assert.equal(r.reason,'Ambiguous doubleheader/reschedule match, could not disambiguate');
});

test('resolveScheduleGame: a postponed game is still returned (caller judges tradeability), not silently treated as an ambiguity',()=>{
 const schedule=[schedRow({gamePk:1,status:'Postponed'})];
 const r=resolveScheduleGame(schedule,parseEvent('KXMLBF5-26SEP231305TORBAL'));
 assert.ok(r.game);
 assert.equal(r.game.status,'Postponed');
});
