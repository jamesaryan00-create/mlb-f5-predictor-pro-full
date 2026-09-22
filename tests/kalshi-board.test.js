const test=require('node:test'),assert=require('node:assert/strict');
const {decideTier}=require('../lib/kalshi-board');
test('V5 preserves all 58% selections regardless of model agreement or availability',()=>{
 for(const agree of [true,false,null]) for(const modelAvailable of [true,false]) {
 assert.equal(decideTier({kalshiConfidence:.58,agree,modelAvailable,modelConfidence:null,maxSpread:.1}),'PLAY');
 assert.equal(decideTier({kalshiConfidence:.62,agree,modelAvailable,modelConfidence:null,maxSpread:.1}),'STRONG');
 }
 assert.equal(decideTier({kalshiConfidence:.579}),'PASS');
 assert.equal(decideTier({kalshiConfidence:null}),'PASS');
});
