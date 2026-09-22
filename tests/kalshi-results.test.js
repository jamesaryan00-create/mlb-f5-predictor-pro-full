const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {readResults}=require('../lib/kalshi-results');
test('dashboard counts ties as non-wins and retains new pending captures',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kalshi-results-'));
 try{
 const a={gamePk:1,capturedAt:'2026-09-14T10:00:00Z',baseline:true,candidate:true};const b={...a,gamePk:2};
 fs.writeFileSync(path.join(dir,'plan.json'),JSON.stringify({start:a.capturedAt,end:'2026-10-14T10:00:00Z'}));
 fs.writeFileSync(path.join(dir,'capture-a.json'),JSON.stringify({capturedAt:a.capturedAt,records:[a,b]}));
 fs.writeFileSync(path.join(dir,'grades-a.json'),JSON.stringify({generatedAt:a.capturedAt,results:[{...a,status:'graded',win:false,tie:true}]}));
 const r=readResults(dir,Date.parse(a.capturedAt));assert.equal(r.baseline.winPct,0);assert.equal(r.baseline.ties,1);assert.equal(r.baseline.pending,1);assert.equal(r.health.overdue,false);assert.equal(r.evaluation.status,'Collecting — no conclusion yet');
 fs.writeFileSync(path.join(dir,'capture-b.json'),'broken');assert.equal(readResults(dir).warnings.length,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
