const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const {main}=require('../scripts/price-paper');
const {readRecord}=require('../lib/price-paper-record');
test('isolated full cycle: lock pregame, ignore changed signal, grade once, retain same-game benchmark',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'paper-cycle-test-'));
 let now=Date.parse('2026-10-08T20:00:00Z');
 const dir=path.join(root,'data/kalshi-forward-fullgame');fs.mkdirSync(dir,{recursive:true});
 const record={gamePk:1,officialDate:'2026-10-08',firstPitchUtc:'2026-10-08T20:45:00Z',capturedAt:new Date(now).toISOString(),homeTeam:'Test Home',awayTeam:'Test Away',homeId:1,awayId:2,modelAvailable:true,modelPickSide:'HOME',modelConfidence:.5,outcomeQuotes:{home:{bid:.58,ask:.6,time:new Date(now).toISOString()},away:{bid:.4,ask:.42,time:new Date(now).toISOString()}}};
 const put=()=>fs.writeFileSync(path.join(dir,'capture-1000.json'),JSON.stringify({allRecords:[record]}));
 const fetchFn=async()=>({ok:true,json:async()=>({gameData:{status:{detailedState:'Final'},teams:{home:{id:1},away:{id:2}},datetime:{dateTime:record.firstPitchUtc}},liveData:{linescore:{teams:{home:{runs:2},away:{runs:3}}}}})});
 try{
  put();await main({root,nowFn:()=>now,fetchFn,log:()=>{}});
  const locked=fs.readFileSync(path.join(root,'data/price-paper/decision-1.json'),'utf8');
  assert.equal(readRecord(path.join(root,'data/price-paper')).pending,1);
  record.modelConfidence=.9;put();await main({root,nowFn:()=>now,fetchFn,log:()=>{}});
  assert.equal(fs.readFileSync(path.join(root,'data/price-paper/decision-1.json'),'utf8'),locked);
  now+=4*3600000;await main({root,nowFn:()=>now,fetchFn,log:()=>{}});
  const result=readRecord(path.join(root,'data/price-paper'));
  assert.equal(result.wins,1);assert.equal(result.pending,0);assert.ok(result.net>0);assert.ok(result.benchmarkNet<0);
  const grade=fs.readFileSync(path.join(root,'data/price-paper/grade-1.json'),'utf8');
  await main({root,nowFn:()=>now,fetchFn:()=>{throw Error('Graded game fetched again');},log:()=>{}});
  assert.equal(fs.readFileSync(path.join(root,'data/price-paper/grade-1.json'),'utf8'),grade);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
