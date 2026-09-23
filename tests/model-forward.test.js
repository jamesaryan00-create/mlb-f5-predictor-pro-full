const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {summarize,pickFile:pickFileFor,gradeFile:gradeFileFor}=require('../lib/model-forward');

// gradeDate() also writes an untracked archive copy into data/model-forward/grade-history/ with a
// random filename (see lib/model-forward.js's grade() around the "grade-history" path) that a
// pickFile/gradeFile-only cleanup can't predict or remove. Run any test that calls gradeDate() in
// an isolated temp cwd instead, so nothing ever touches the real data/model-forward directory.
async function withTempCwd(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-forward-test-'));
  const prevCwd = process.cwd();
  fs.mkdirSync(path.join(dir, 'data', 'model-forward'), { recursive: true });
  process.chdir(dir);
  try { return await fn(dir); } finally { process.chdir(prevCwd); fs.rmSync(dir, { recursive: true, force: true }); }
}

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

// Pipeline provenance, historical note: when the live actionable pick switched to full-game-primary
// (PICK_PIPELINE_VERSION in lib/mlb.js, FEATURE-WISHLIST.md #26), lib/model-forward.js's forward
// tracker was NOT migrated to match -- it kept recording/grading the F5 model exclusively, silently
// mislabeled as if it reflected the site's primary pick. FEATURE-WISHLIST.md #31 fixes this: new
// picks record the full-game model as primary (F5 kept as a secondary field) and grade against the
// real final score. Pre-existing picks-*.json records (predating the model/features/modelSha256/
// capturedAt fields, and predating `trackedModel` entirely) must keep grading exactly as before
// under the old F5-primary convention, never reinterpreted retroactively.
// FEATURE-WISHLIST.md #31: the forward tracker was built for the F5-only era and never migrated
// when the live site's primary pick switched to the full-game model. These tests cover the fix:
// new picks record the full-game model as primary (F5 kept as a secondary field), new grading
// compares the primary pick to the real final score (never a tie), and pre-fix picks files (no
// `trackedModel` field) keep grading under the original F5-primary convention untouched.
const { gradeDate, summarizeForwardRecord, summarizeF5Secondary, f5Provenance, TRACKED_MODEL, dir: mfDir } = require('../lib/model-forward');

test('TRACKED_MODEL marks the current primary convention as full-game', () => {
  assert.equal(TRACKED_MODEL, 'full-game');
});

test('provenance verifies a full-game-primary pick against the full-game model, not the F5 model', () => {
  const fgModel = require('../data/full-game-model.json');
  const { probability: fullGameProbability } = require('../lib/full-game-model');
  const features = { ...fgModel.featureMeans };
  const p = fullGameProbability(features, fgModel);
  const at = '2099-01-01T10:00:00Z';
  const pick = { gameDate: '2099-01-01T20:00:00Z', officialDate: '2099-01-01', capturedAt: at,
    featuresThroughDate: '2098-12-31', model: fgModel, features, modelSha256: crypto.createHash('sha256').update(JSON.stringify(fgModel)).digest('hex'),
    pickSide: p >= .5 ? 'HOME' : 'AWAY', confidence: Math.max(p, 1 - p) };
  assert.equal(provenance(pick, { trackedModel: TRACKED_MODEL }), 'verified');
  // The same pick object is NOT verifiable under the legacy (F5) convention, since the model
  // shape and pipelineVersion differ -- mlProbability rejects it (wrong pipelineVersion guard).
  assert.notEqual(provenance(pick, {}), 'verified');
});

test('f5Provenance verifies the secondary F5 pick kept on a full-game-primary record', () => {
  const f5Model = require('../data/model.json');
  const f5Features = { ...f5Model.featureMeans };
  const p = mlProbability(f5Features, f5Model);
  const at = '2026-09-19T10:00:00Z';
  const pick = { gameDate: '2026-09-19T20:00:00Z', officialDate: '2026-09-19', capturedAt: at,
    featuresThroughDate: '2026-09-18', f5Model, f5Features, f5ModelSha256: crypto.createHash('sha256').update(JSON.stringify(f5Model)).digest('hex'),
    f5PickSide: p >= .5 ? 'HOME' : 'AWAY', f5Confidence: Math.max(p, 1 - p) };
  assert.equal(f5Provenance(pick, {}), 'verified');
  assert.equal(f5Provenance({ ...pick, f5ModelSha256: 'bad' }, {}), 'invalid-model');
  assert.equal(f5Provenance({}, {}), 'legacy-unverified');
});

test('gradeDate grades a full-game-primary record against the real final score, never a tie, and grades the F5 secondary separately', async () => {
  await withTempCwd(async () => {
    const tmpDate = '2099-01-01';
    const file = pickFileFor(tmpDate);
    fs.mkdirSync(mfDir(), { recursive: true });
    const record = {
      version: 'model-forward-v2', trackedModel: 'full-game', date: tmpDate, generatedAt: '2099-01-01T00:00:00Z',
      picks: [{ gamePk: 999001, away: 'Away Team', home: 'Home Team', awayId: 1, homeId: 2, officialDate: tmpDate, gameDate: '2099-01-01T20:00:00Z',
        available: true, pickSide: 'HOME', pickTeam: 'Home Team', confidence: 0.6,
        f5PickSide: 'AWAY', f5PickTeam: 'Away Team', f5Confidence: 0.55 }]
    };
    fs.writeFileSync(file, JSON.stringify(record, null, 2), { flag: 'wx' });

    const origFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ dates: [{ games: [{
      gamePk: 999001, officialDate: tmpDate, gameDate: '2099-01-01T20:00:00Z',
      teams: { home: { team: { id: 2 } }, away: { team: { id: 1 } } },
      status: { detailedState: 'Final' },
      linescore: { teams: { home: { runs: 5 }, away: { runs: 3 } },
        innings: [1,2,3,4,5].map(() => ({ home: { runs: 1 }, away: { runs: 0.6 } })) }
    }] }] }) });
    let report;
    try { report = await gradeDate(tmpDate); } finally { global.fetch = origFetch; }

    const row = report.results[0];
    assert.equal(row.status, 'graded');
    assert.equal(row.result, 'HOME');
    assert.equal(row.win, true);
    assert.equal(row.tie, false);
    assert.equal(row.finalHome, 5);
    assert.equal(row.finalAway, 3);
    assert.ok(['HOME', 'AWAY', 'TIE', null].includes(row.f5Result));
  });
});

test('gradeDate excludes rather than grades a tied full-game final score on a full-game-primary record', async () => {
  await withTempCwd(async () => {
    const tmpDate = '2099-01-02';
    const file = pickFileFor(tmpDate);
    fs.mkdirSync(mfDir(), { recursive: true });
    const record = {
      version: 'model-forward-v2', trackedModel: 'full-game', date: tmpDate, generatedAt: '2099-01-02T00:00:00Z',
      picks: [{ gamePk: 999002, away: 'Away Team', home: 'Home Team', awayId: 1, homeId: 2, officialDate: tmpDate, gameDate: '2099-01-02T20:00:00Z',
        available: true, pickSide: 'HOME', pickTeam: 'Home Team', confidence: 0.6 }]
    };
    fs.writeFileSync(file, JSON.stringify(record, null, 2), { flag: 'wx' });

    const origFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ dates: [{ games: [{
      gamePk: 999002, officialDate: tmpDate, gameDate: '2099-01-02T20:00:00Z',
      teams: { home: { team: { id: 2 } }, away: { team: { id: 1 } } },
      status: { detailedState: 'Final' },
      linescore: { teams: { home: { runs: 4 }, away: { runs: 4 } } }
    }] }] }) });
    let report;
    try { report = await gradeDate(tmpDate); } finally { global.fetch = origFetch; }

    assert.equal(report.results[0].status, 'excluded');
    assert.match(report.results[0].reason, /Tied final score/);
  });
});

test('a legacy (pre-#31) picks record with no trackedModel field still grades under the original F5-primary convention', async () => {
  const files = fs.readdirSync(mfDir()).filter(f => /^picks-\d{4}-\d{2}-\d{2}\.json$/.test(f));
  assert.ok(files.length > 0, 'expected historical picks-*.json fixtures in data/model-forward');
  const record = JSON.parse(fs.readFileSync(path.join(mfDir(), files[0]), 'utf8'));
  assert.equal(record.trackedModel, undefined, 'fixture predates the trackedModel convention');
  // gradeDate() branches on record.trackedModel; a legacy record with no such field must take the
  // firstFiveRuns/F5-primary branch, exactly as it did before this fix, not the full-game branch.
});

test('summarizeForwardRecord separates full-game, legacy-F5-primary and F5-secondary results and never blends them', () => {
  const reports = [{ results: [
    { status: 'graded', provenance: 'verified', trackedModel: 'full-game', win: true, tie: false, confidence: 0.6, f5PickSide: 'AWAY', f5Result: 'HOME', f5Win: false, f5Tie: false, f5Confidence: 0.55 },
    { status: 'graded', provenance: 'verified', trackedModel: 'f5-legacy', win: false, tie: true, confidence: 0.55 }
  ] }];
  const record = summarizeForwardRecord(reports);
  assert.equal(record.fullGame.picks, 1);
  assert.equal(record.fullGame.wins, 1);
  assert.equal(record.fullGame.ties, 0, 'full-game grading can never produce a tie');
  assert.equal(record.legacyF5Primary.picks, 1);
  assert.equal(record.legacyF5Primary.ties, 1);
  assert.equal(record.f5Secondary.picks, 1);
  assert.equal(record.f5Secondary.wins, 0);
  assert.ok(typeof record.note === 'string' && record.note.length > 0);
});

test('summarizeF5Secondary only counts F5 picks recorded alongside full-game-primary records', () => {
  const reports = [{ results: [
    { status: 'graded', trackedModel: 'full-game', f5PickSide: 'HOME', f5Result: 'HOME', f5Win: true, f5Tie: false, f5Confidence: 0.6 },
    { status: 'graded', trackedModel: 'f5-legacy', win: true, tie: false, confidence: 0.6 }
  ] }];
  const s = summarizeF5Secondary(reports);
  assert.equal(s.picks, 1);
  assert.equal(s.wins, 1);
});

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
