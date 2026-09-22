const test=require('node:test');
const assert=require('node:assert/strict');
const {rankThreeWayPicks,summarizeThreeWay}=require('../lib/model-forward');

test('daily ranking selects exactly top eight and nine without dropping lower rows',()=>{
 const rows=Array.from({length:10},(_,i)=>({gamePk:100+i,available:true,threeWay:{pickProbability:.40+i/100}}));
 const ranked=rankThreeWayPicks(rows);
 assert.equal(ranked.filter(x=>x.selectedTop8).length,8);
 assert.equal(ranked.filter(x=>x.selectedTop9).length,9);
 assert.equal(ranked.find(x=>x.gamePk===109).dailyThreeWayRank,1);
 assert.equal(ranked.length,10);
});

test('fewer than eight predictions creates no top-eight cohort',()=>{
 const ranked=rankThreeWayPicks(Array.from({length:7},(_,i)=>({gamePk:i,available:true,threeWay:{pickProbability:.5}})));
 assert.equal(ranked.some(x=>x.selectedTop8||x.selectedTop9),false);
});

test('three-way summaries count ties as losses',()=>{
 const report={results:[
  {status:'graded',provenance:'verified',selectedTop8:true,threeWay:{},threeWayWin:true,tie:false},
  {status:'graded',provenance:'verified',selectedTop8:true,threeWay:{},threeWayWin:false,tie:true}
 ]};
 assert.deepEqual(summarizeThreeWay([report],'top8'),{selection:'top8',picks:2,wins:1,lossesIncludingTies:1,ties:1,winPct:50});
});
