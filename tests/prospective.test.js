const test=require('node:test'),assert=require('node:assert/strict');
const {snapshot,grade}=require('../lib/prospective');
const model=require('../data/model.json');
const at='2027-04-01T18:00:00Z';
function fixture(){return {gamePk:1,officialDate:'2027-04-01',gameDate:'2027-04-01T20:00:00Z',status:'Scheduled',home:{id:1,name:'Home',modelProbability:55},away:{id:2,name:'Away'},prediction:{pick:'Home'},factors:{historicalF5Features:{...model.featureMeans}},market:{quoteSnapshot:{homeTeam:'Home',awayTeam:'Away',scheduledAt:'2027-04-01T20:00:00Z',observedAt:at}}};}
function final(){return {gamePk:1,officialDate:'2027-04-01',gameDate:'2027-04-01T20:00:00Z',teams:{home:{team:{id:1}},away:{team:{id:2}}},status:{detailedState:'Final'},linescore:{innings:Array.from({length:5},(_,i)=>({num:i+1,home:{runs:0},away:{runs:0}}))}};}
test('capture rejects post-start, invalid model cutoff, mismatched quotes and keeps exact probability',()=>{
 const g=fixture();const r=snapshot(g,model,at);assert.ok(r);assert.ok(r.quote);assert.equal(r.evEligible,false);
 assert.notEqual(r.homeProbability,.55);
 assert.equal(snapshot(g,model,'2027-04-01T20:00:00Z'),null);
 assert.equal(snapshot(g,{...model,throughDate:'2027-04-01'},at),null);
 g.market.quoteSnapshot.homeTeam='Wrong';assert.equal(snapshot(g,model,at).quote,null);
});
test('grades ties separately, rejects reschedules and incomplete innings',()=>{
 const r=snapshot(fixture(),model,at), g=final();
 assert.equal(grade(r,g).tie,true);assert.equal(grade(r,g).brier,null);
 g.linescore.innings[0].home.runs=1;assert.equal(grade(r,g).result,'home');assert.equal(grade(r,g).realizedProfit,null);
 g.gameDate='2027-04-02T20:00:00Z';assert.equal(grade(r,g).status,'excluded');
 g.gameDate=r.scheduledAt;g.linescore.innings.pop();assert.equal(grade(r,g).status,'excluded');
});
