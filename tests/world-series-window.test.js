const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {PLAN,isOpen,accepts}=require('../lib/world-series-window');
const {main}=require('../scripts/price-paper');
test('World Series window is bounded, exclusive at end, and rejects other or missing game types',()=>{
 assert.equal(isOpen(Date.parse(PLAN.start)-1),false);assert.equal(isOpen(Date.parse(PLAN.start)),true);assert.equal(isOpen(Date.parse(PLAN.end)),false);
 assert.equal(accepts({gameType:'W',firstPitchUtc:PLAN.start}),true);
 for(const gameType of ['R','D','L',undefined])assert.equal(accepts({gameType,firstPitchUtc:PLAN.start}),false);
 assert.equal(accepts({gameType:'W',firstPitchUtc:PLAN.end}),false);
});
test('extension captures and grades stay isolated; grading works after its window ends',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'world-series-test-'));
 let now=Date.parse('2026-10-23T22:30:00Z');
 const source=path.join(root,'data',PLAN.captureDirectory);fs.mkdirSync(source,{recursive:true});
 const r={gamePk:1,gameType:'W',officialDate:'2026-10-23',firstPitchUtc:'2026-10-23T23:00:00Z',capturedAt:new Date(now).toISOString(),homeId:1,awayId:2,modelAvailable:true,modelPickSide:'HOME',modelConfidence:.5,outcomeQuotes:{home:{bid:.58,ask:.60,time:new Date(now).toISOString()},away:{bid:.4,ask:.42,time:new Date(now).toISOString()}}};
 fs.writeFileSync(path.join(source,'capture-1.json'),JSON.stringify({allRecords:[r,{...r,gamePk:2,gameType:'L'}]}));
 const out=path.join(root,'data',PLAN.paperDirectory);
 try{
  await main({root,extension:true,nowFn:()=>now,log:()=>{}});
  assert.equal(JSON.parse(fs.readFileSync(path.join(out,'decision-1.json'))).cohort,PLAN.cohort);
  assert.equal(fs.existsSync(path.join(out,'decision-2.json')),false);
  assert.equal(fs.existsSync(path.join(root,'data/price-paper')),false);
  now=Date.parse(PLAN.end)+1000;
  await main({root,extension:true,nowFn:()=>now,log:()=>{},fetchFn:async()=>({ok:true,json:async()=>({gameData:{status:{detailedState:'Final'},teams:{home:{id:1},away:{id:2}},datetime:{dateTime:r.firstPitchUtc}},liveData:{linescore:{teams:{home:{runs:2},away:{runs:3}}}}})})});
  assert.equal(JSON.parse(fs.readFileSync(path.join(out,'grade-1.json'))).win,true);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
