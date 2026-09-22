const test=require('node:test'),assert=require('node:assert/strict');
const {combine}=require('../lib/matchup-logic');
const team=(fip,ops,runs)=>({pitching:{season:{fip}},batting:{ops},f5:{runs}});
test('combines all domains directionally without claiming a probability',()=>{const r=combine(team(2,.8,3),team(5,.6,2));assert.equal(r.side,'home');assert.equal(r.probability,null);assert.equal(r.score,1);assert.equal(combine(team(5,.6,2),team(2,.8,3)).side,'away');});
test('missing domain is unavailable rather than invented neutral data',()=>{const r=combine(team(2,.8,3),team(null,.6,2));assert.equal(r.available,false);assert.equal(r.side,null);assert.equal(r.score,null);});
test('equal evidence is not treated as a predicted game tie',()=>{const r=combine(team(3,.7,2),team(3,.7,2));assert.equal(r.available,true);assert.equal(r.side,null);assert.equal(r.score,0);});
test('conflicting signals retain games and reject nonfinite values',()=>{const r=combine(team(2,.6,3),team(5,.8,2));assert.equal(r.side,'home');assert.ok(r.signals.some(s=>s.vote===-1));assert.equal(combine(team(NaN,.6,3),team(5,.8,2)).available,false);});
