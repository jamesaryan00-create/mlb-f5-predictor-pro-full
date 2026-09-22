const test=require('node:test'),assert=require('node:assert/strict');
const {summarize}=require('../lib/model-forward');

test('summarize counts ties as non-wins and excludes non-graded rows',()=>{
 const reports=[{results:[{status:'graded',provenance:'verified',win:true,tie:false,confidence:0.6},{status:'graded',provenance:'verified',win:false,tie:true,confidence:0.52},{status:'pending',confidence:0.7},{status:'excluded',confidence:0.65}]}];
 const s=summarize(reports);
 assert.equal(s.picks,2);assert.equal(s.wins,1);assert.equal(s.ties,1);assert.equal(s.decided,1);assert.equal(s.winPct,50);assert.equal(s.winPctDecided,100);
});

test('minConfidence filters to the stated tier only',()=>{
 const reports=[{results:[{status:'graded',provenance:'verified',win:true,tie:false,confidence:0.62},{status:'graded',provenance:'verified',win:false,tie:false,confidence:0.51}]}];
 assert.equal(summarize(reports,{minConfidence:0.6}).picks,1);
 assert.equal(summarize(reports,{minConfidence:0.6}).wins,1);
 assert.equal(summarize(reports).picks,2);
});

test('no graded rows yields a null win percentage rather than dividing by zero',()=>{
 const s=summarize([{results:[{status:'pending',confidence:0.6}]}]);
 assert.equal(s.decided,0);assert.equal(s.winPctDecided,null);
});
const {provenance,canRecord}=require('../lib/model-forward');
const {mlProbability}=require('../lib/mlb');
const crypto=require('crypto');
test('capture boundary rejects games that started during input collection',()=>{
 assert.equal(canRecord({status:'Scheduled',gameDate:'2026-09-19T20:00:00Z'},'2026-09-19T20:00:01Z'),false);
 assert.equal(canRecord({status:'In Progress',gameDate:'2026-09-19T21:00:00Z'},'2026-09-19T20:00:01Z'),false);
});
test('backfills and legacy picks cannot enter the verified primary record',()=>{
 assert.equal(provenance({gameDate:'2026-09-15T20:00:00Z'},{generatedAt:'2026-09-16T20:00:00Z'}),'retrospective');
 assert.equal(provenance({gameDate:'2026-09-15T20:00:00Z'},{generatedAt:'2026-09-15T10:00:00Z'}),'legacy-unverified');
 assert.equal(summarize([{results:[{status:'graded',provenance:'retrospective',confidence:.6,win:true}]}]).picks,0);
});
test('model provenance verifies hash, exact output and training cutoff',()=>{
 const model=require('../data/model.json'),features={...model.featureMeans};
 const p=mlProbability(features,model),at='2026-09-19T10:00:00Z';
 const pick={gameDate:'2026-09-19T20:00:00Z',officialDate:'2026-09-19',capturedAt:at,featuresThroughDate:'2026-09-18',model,features,modelSha256:crypto.createHash('sha256').update(JSON.stringify(model)).digest('hex'),pickSide:p>=.5?'HOME':'AWAY',confidence:Math.max(p,1-p)};
 assert.equal(provenance(pick,{}),'verified');
 assert.equal(provenance({...pick,modelSha256:'bad'},{}),'invalid-model');
 assert.equal(provenance({...pick,featuresThroughDate:'2026-09-19'},{}),'invalid-cutoff');
 assert.equal(provenance({...pick,confidence:.99},{}),'invalid-prediction');
});
test('live neutral pitcher-difference policy matches training without fabricating source stats',()=>{
 const model=require('../data/model.json'),f={...model.featureMeans,homePitcherWhipDiff:null,homePitcherFipDiff:null};
 assert.equal(mlProbability(f,model),mlProbability({...f,homePitcherWhipDiff:0,homePitcherFipDiff:0},model));
 assert.equal(f.homePitcherWhipDiff,null);
});

// Pipeline provenance: lib/model-forward.js's forward-tracking harness calls mlProbability()
// against data/model.json directly and never reads getPredictions()/calculateGamePrediction()'s
// `prediction` object, so switching the live actionable pick to full-game-primary (see
// PICK_PIPELINE_VERSION in lib/mlb.js and FEATURE-WISHLIST.md #26) does not change what
// model-forward.js records or how it grades. Pre-existing picks-*.json records (e.g. from before
// this change, which predate the model/features/modelSha256/capturedAt fields entirely) must
// keep grading exactly as before under the old fallback rule, not the new 'verified' path.
test('old F5-only pick records (pre-dating model/features/capturedAt fields) still grade as legacy-unverified, not crash or silently verify',()=>{
 const fs=require('fs'),path=require('path');
 const dir=path.join(process.cwd(),'data','model-forward');
 const files=fs.readdirSync(dir).filter(f=>/^picks-\d{4}-\d{2}-\d{2}\.json$/.test(f));
 assert.ok(files.length>0,'expected historical picks-*.json fixtures in data/model-forward');
 const record=JSON.parse(fs.readFileSync(path.join(dir,files[0]),'utf8'));
 const available=record.picks.filter(p=>p.available);
 assert.ok(available.length>0);
 for(const p of available){
   const prov=provenance(p,record);
   assert.ok(['legacy-unverified','verified','retrospective','invalid-cutoff'].includes(prov));
   // These fixtures predate modelSha256/capturedAt capture, so they cannot claim 'verified'.
   if(!p.modelSha256 || !p.capturedAt) assert.notEqual(prov,'verified');
 }
});
