const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {decide,selectedPortfolio}=require('../lib/price-decision');
const {readRecord}=require('../lib/price-paper-record');
const now=Date.parse('2026-10-08T20:00:00Z');
function input(p,h=.6,a=.42){return {now,firstPitch:'2026-10-08T21:00:00Z',homeProbability:p,budget:1000,quotes:{home:{bid:h-.02,ask:h,time:new Date(now).toISOString()},away:{bid:a-.02,ask:a,time:new Date(now).toISOString()}}};}
test('chooses a valuable underdog despite lower chance of winning',()=>{const d=decide(input(.5,.6,.42));assert.equal(d.action,'UNDERDOG');assert.equal(d.side,'away');assert.ok(d.selected.expected>0);});
test('favorite can qualify; confidence without a good price passes',()=>{
 assert.equal(decide(input(.75)).action,'FAVORITE');
 assert.equal(decide(input(.6)).action,'PASS');
 assert.equal(decide(input(.62)).action,'PASS'); // fees plus adverse entry absorb tiny apparent edge
});
test('missing, stale, crossed, future and post-start data never becomes a pick',()=>{
 for(const edit of [r=>r.homeProbability=null,r=>r.quotes.home.ask=null,r=>r.quotes.home.bid=.9,r=>r.quotes.home.time='bad',r=>r.quotes.home.time=new Date(now-301000).toISOString(),r=>r.quotes.home.time=new Date(now+1).toISOString(),r=>r.firstPitch=new Date(now).toISOString()]){const r=input(.75);edit(r);assert.equal(decide(r).side,null);}
});
test('portfolio uses per-game probabilities and excludes passes',()=>{
 const a=decide(input(.75)),b=decide(input(.5)),p=selectedPortfolio([a,b,decide(input(.6))]);
 assert.equal(p.count,2);assert.equal(p.expected,a.selected.expected+b.selected.expected);assert.equal(selectedPortfolio([]).expected,null);
});
test('new ledger cannot blend historical Kalshi grades, pending picks or passes into net',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'price-record-'));
 try{
  const d=decide(input(.75));
  fs.writeFileSync(path.join(dir,'decision-1.json'),JSON.stringify({gamePk:1,decision:d}));
  fs.writeFileSync(path.join(dir,'decision-2.json'),JSON.stringify({gamePk:2,decision:decide(input(.6))}));
  fs.writeFileSync(path.join(dir,'grades-legacy.json'),JSON.stringify({net:99999}));
  assert.equal(readRecord(dir).pending,1);assert.equal(readRecord(dir).net,0);assert.equal(readRecord(dir).passes,1);
  fs.writeFileSync(path.join(dir,'grade-1.json'),JSON.stringify({status:'graded',win:false,net:-d.selected.trade.cost}));
  const r=readRecord(dir);assert.equal(r.losses,1);assert.equal(r.pending,0);assert.equal(r.net,-d.selected.trade.cost);
 }finally{fs.rmSync(dir,{recursive:true});}
});
