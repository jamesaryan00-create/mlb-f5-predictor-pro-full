const test=require('node:test'),assert=require('node:assert/strict');
const {decideTier,parseEvent,normTeam}=require('../lib/kalshi-board-fullgame');
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
