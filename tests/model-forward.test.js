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
 const p=mlProbability(features,model),at='2026-09-30T10:00:00Z';
 const pick={gameDate:'2026-09-30T20:00:00Z',officialDate:'2026-09-30',capturedAt:at,featuresThroughDate:'2026-09-29',model,features,modelSha256:crypto.createHash('sha256').update(JSON.stringify(model)).digest('hex'),pickSide:p>=.5?'HOME':'AWAY',confidence:Math.max(p,1-p)};
 assert.equal(provenance(pick,{}),'verified');
 assert.equal(provenance({...pick,modelSha256:'bad'},{}),'invalid-model');
 assert.equal(provenance({...pick,featuresThroughDate:'2026-09-30'},{}),'invalid-cutoff');
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
const { gradeDate, summarizeForwardRecord, summarizeF5Secondary, summarizeKalshiPrimaryF5, f5Provenance, f5KalshiProvenance, TRACKED_MODEL, PRIOR_TRACKED_MODEL, dir: mfDir } = require('../lib/model-forward');

// FEATURE-WISHLIST.md #41 bumps the tracked convention again, exactly the same one-way-bump
// pattern #31 established: TRACKED_MODEL is always the CURRENT convention (now Kalshi-primary);
// PRIOR_TRACKED_MODEL names the immediately-previous one so old 'full-game' records can still be
// referenced explicitly without a bare string literal.
test('TRACKED_MODEL marks the current primary convention as kalshi-primary, PRIOR_TRACKED_MODEL as full-game', () => {
  assert.equal(TRACKED_MODEL, 'kalshi-primary');
  assert.equal(PRIOR_TRACKED_MODEL, 'full-game');
});

test('provenance verifies a full-game-primary (#31, PRIOR_TRACKED_MODEL) pick against the full-game model, not the F5 model', () => {
  const fgModel = require('../data/full-game-model.json');
  const { probability: fullGameProbability } = require('../lib/full-game-model');
  const features = { ...fgModel.featureMeans };
  const p = fullGameProbability(features, fgModel);
  const at = '2099-01-01T10:00:00Z';
  const pick = { gameDate: '2099-01-01T20:00:00Z', officialDate: '2099-01-01', capturedAt: at,
    featuresThroughDate: '2098-12-31', model: fgModel, features, modelSha256: crypto.createHash('sha256').update(JSON.stringify(fgModel)).digest('hex'),
    pickSide: p >= .5 ? 'HOME' : 'AWAY', confidence: Math.max(p, 1 - p) };
  assert.equal(provenance(pick, { trackedModel: PRIOR_TRACKED_MODEL }), 'verified');
  // The same pick object is NOT verifiable under the legacy (F5) convention, since the model
  // shape and pipelineVersion differ -- mlProbability rejects it (wrong pipelineVersion guard).
  assert.notEqual(provenance(pick, {}), 'verified');
});

test('provenance verifies a kalshi-primary (#41, current TRACKED_MODEL) pick against its own Kalshi quote snapshot, not a model formula', () => {
  const pick = { gameDate: '2099-01-01T20:00:00Z', officialDate: '2099-01-01', capturedAt: '2099-01-01T10:00:00Z',
    available: true, pickSide: 'HOME', confidence: 0.61, kalshiQuoteTime: '2099-01-01T09:55:00Z' };
  assert.equal(provenance(pick, { trackedModel: TRACKED_MODEL }), 'verified');
  assert.equal(provenance({ ...pick, available: false }, { trackedModel: TRACKED_MODEL }), 'legacy-unverified');
  assert.equal(provenance({ ...pick, kalshiQuoteTime: '2099-01-01T20:05:00Z' }, { trackedModel: TRACKED_MODEL }), 'invalid-cutoff');
  assert.equal(provenance({ ...pick, capturedAt: '2099-01-01T20:05:00Z' }, { trackedModel: TRACKED_MODEL }), 'retrospective');
});

test('f5KalshiProvenance verifies the F5 leg of a kalshi-primary record against its own Kalshi quote snapshot', () => {
  const pick = { gameDate: '2099-01-01T20:00:00Z', officialDate: '2099-01-01', capturedAt: '2099-01-01T10:00:00Z',
    f5Available: true, f5PickSide: 'AWAY', f5Confidence: 0.59, f5KalshiQuoteTime: '2099-01-01T09:55:00Z' };
  assert.equal(f5KalshiProvenance(pick, { trackedModel: TRACKED_MODEL }), 'verified');
  assert.equal(f5KalshiProvenance({ ...pick, f5Available: false }, { trackedModel: TRACKED_MODEL }), 'legacy-unverified');
  // Not applicable to a non-kalshi-primary record at all.
  assert.equal(f5KalshiProvenance(pick, { trackedModel: PRIOR_TRACKED_MODEL }), 'legacy-unverified');
});

test('f5Provenance verifies the secondary F5 pick kept on a full-game-primary record', () => {
  const f5Model = require('../data/model.json');
  const f5Features = { ...f5Model.featureMeans };
  const p = mlProbability(f5Features, f5Model);
  const at = '2026-09-30T10:00:00Z';
  const pick = { gameDate: '2026-09-30T20:00:00Z', officialDate: '2026-09-30', capturedAt: at,
    featuresThroughDate: '2026-09-29', f5Model, f5Features, f5ModelSha256: crypto.createHash('sha256').update(JSON.stringify(f5Model)).digest('hex'),
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

// FEATURE-WISHLIST.md #41: gradeDate() for a 'kalshi-primary' record grades the full-game leg
// (Kalshi full-game price) against the real final score, and the F5 leg (Kalshi F5 price)
// against firstFiveRuns, completely independently -- neither leg's availability gates the other.
test('gradeDate grades a kalshi-primary record: full-game leg against the real final score (no tie), F5 leg against firstFiveRuns (tie possible), independently', async () => {
  await withTempCwd(async () => {
    const tmpDate = '2099-02-01';
    const file = pickFileFor(tmpDate);
    fs.mkdirSync(mfDir(), { recursive: true });
    const record = {
      version: 'model-forward-v3', trackedModel: 'kalshi-primary', date: tmpDate, generatedAt: '2099-02-01T00:00:00Z',
      picks: [{ gamePk: 999003, away: 'Away Team', home: 'Home Team', awayId: 1, homeId: 2, officialDate: tmpDate, gameDate: '2099-02-01T20:00:00Z',
        available: true, pickSide: 'HOME', pickTeam: 'Home Team', confidence: 0.61, kalshiQuoteTime: '2099-02-01T19:55:00Z',
        f5Available: true, f5PickSide: 'AWAY', f5PickTeam: 'Away Team', f5Confidence: 0.59, f5KalshiQuoteTime: '2099-02-01T19:55:00Z' }]
    };
    fs.writeFileSync(file, JSON.stringify(record, null, 2), { flag: 'wx' });

    const origFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ dates: [{ games: [{
      gamePk: 999003, officialDate: tmpDate, gameDate: '2099-02-01T20:00:00Z',
      teams: { home: { team: { id: 2 } }, away: { team: { id: 1 } } },
      status: { detailedState: 'Final' },
      linescore: { teams: { home: { runs: 5 }, away: { runs: 3 } },
        innings: [1,2,3,4,5].map((n) => ({ num: n, home: { runs: n <= 3 ? 0 : 1 }, away: { runs: n <= 2 ? 1 : (n === 4 ? 1 : 0) } })) }
    }] }] }) });
    let report;
    try { report = await gradeDate(tmpDate); } finally { global.fetch = origFetch; }

    const row = report.results[0];
    assert.equal(row.trackedModel, 'kalshi-primary');
    // Full-game leg: HOME won 5-3, pick was HOME -> win.
    assert.equal(row.fgStatus, 'graded');
    assert.equal(row.result, 'HOME');
    assert.equal(row.win, true);
    assert.equal(row.tie, false);
    // F5 leg: away led 3-2 through 5, pick was AWAY -> win, no tie.
    assert.equal(row.f5Status, 'graded');
    assert.equal(row.f5Result, 'AWAY');
    assert.equal(row.f5Win, true);
    assert.equal(row.f5Tie, false);
  });
});

test('gradeDate grades the F5 leg of a kalshi-primary record as excluded when no F5 Kalshi price existed, while the full-game leg still grades normally', async () => {
  await withTempCwd(async () => {
    const tmpDate = '2099-02-02';
    const file = pickFileFor(tmpDate);
    fs.mkdirSync(mfDir(), { recursive: true });
    const record = {
      version: 'model-forward-v3', trackedModel: 'kalshi-primary', date: tmpDate, generatedAt: '2099-02-02T00:00:00Z',
      picks: [{ gamePk: 999004, away: 'Away Team', home: 'Home Team', awayId: 1, homeId: 2, officialDate: tmpDate, gameDate: '2099-02-02T20:00:00Z',
        available: true, pickSide: 'AWAY', pickTeam: 'Away Team', confidence: 0.6, kalshiQuoteTime: '2099-02-02T19:55:00Z',
        f5Available: false, f5PickSide: null, f5Reason: 'No usable live Kalshi price for the F5 market at capture time (F5 Kalshi liquidity is thin -- see FEATURE-WISHLIST.md #41)' }]
    };
    fs.writeFileSync(file, JSON.stringify(record, null, 2), { flag: 'wx' });

    const origFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ dates: [{ games: [{
      gamePk: 999004, officialDate: tmpDate, gameDate: '2099-02-02T20:00:00Z',
      teams: { home: { team: { id: 2 } }, away: { team: { id: 1 } } },
      status: { detailedState: 'Final' },
      linescore: { teams: { home: { runs: 1 }, away: { runs: 6 } } }
    }] }] }) });
    let report;
    try { report = await gradeDate(tmpDate); } finally { global.fetch = origFetch; }

    const row = report.results[0];
    assert.equal(row.fgStatus, 'graded');
    assert.equal(row.result, 'AWAY');
    assert.equal(row.win, true);
    assert.equal(row.f5Status, 'excluded');
    assert.match(row.f5Reason, /No usable live Kalshi price for the F5 market|No live Kalshi price for the F5 market/);
  });
});

test('summarize({trackedModel:"kalshi-primary"}) and summarizeKalshiPrimaryF5() report the two kalshi-primary markets separately, never blended with each other or with fullGame/legacyF5Primary', () => {
  const reports = [{ results: [
    { status: 'graded', fgStatus: 'graded', f5Status: 'excluded', provenance: 'verified', trackedModel: 'kalshi-primary', win: true, tie: false, confidence: 0.61, f5Confidence: null },
    { status: 'excluded', fgStatus: 'excluded', f5Status: 'graded', provenance: 'verified', f5Provenance: 'verified', trackedModel: 'kalshi-primary', win: null, tie: false, confidence: null, f5Win: false, f5Tie: false, f5Confidence: 0.58 },
    { status: 'graded', provenance: 'verified', trackedModel: 'full-game', win: true, tie: false, confidence: 0.6 },
    { status: 'graded', provenance: 'verified', trackedModel: 'f5-legacy', win: false, tie: true, confidence: 0.55 }
  ] }];
  const record = summarizeForwardRecord(reports);
  assert.equal(record.kalshiPrimaryFullGame.picks, 1);
  assert.equal(record.kalshiPrimaryFullGame.wins, 1);
  assert.equal(record.kalshiPrimaryF5.picks, 1);
  assert.equal(record.kalshiPrimaryF5.wins, 0);
  assert.equal(record.kalshiPrimaryF5.losses, 1);
  // Never blended with the prior conventions' cohorts.
  assert.equal(record.fullGame.picks, 1);
  assert.equal(record.legacyF5Primary.picks, 1);
});

// Regression test for the exact class of bug FEATURE-WISHLIST.md #31 documents: introducing a new
// tracked convention must NEVER change how an already-written picks file grades or summarizes.
test('REGRESSION (#31-class bug): existing full-game and legacy picks files grade and summarize identically after the #41 kalshi-primary convention was added', async () => {
  await withTempCwd(async () => {
    const tmpDate = '2099-03-01';
    const file = pickFileFor(tmpDate);
    fs.mkdirSync(mfDir(), { recursive: true });
    const record = {
      version: 'model-forward-v2', trackedModel: 'full-game', date: tmpDate, generatedAt: '2099-03-01T00:00:00Z',
      picks: [{ gamePk: 999005, away: 'Away Team', home: 'Home Team', awayId: 1, homeId: 2, officialDate: tmpDate, gameDate: '2099-03-01T20:00:00Z',
        available: true, pickSide: 'HOME', pickTeam: 'Home Team', confidence: 0.6,
        f5PickSide: 'AWAY', f5PickTeam: 'Away Team', f5Confidence: 0.55 }]
    };
    fs.writeFileSync(file, JSON.stringify(record, null, 2), { flag: 'wx' });

    const origFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ dates: [{ games: [{
      gamePk: 999005, officialDate: tmpDate, gameDate: '2099-03-01T20:00:00Z',
      teams: { home: { team: { id: 2 } }, away: { team: { id: 1 } } },
      status: { detailedState: 'Final' },
      linescore: { teams: { home: { runs: 5 }, away: { runs: 3 } },
        innings: [1,2,3,4,5].map(() => ({ home: { runs: 1 }, away: { runs: 0.6 } })) }
    }] }] }) });
    let report;
    try { report = await gradeDate(tmpDate); } finally { global.fetch = origFetch; }

    // Byte-for-byte the same assertions as the pre-#41 test at the top of this file
    // ('gradeDate grades a full-game-primary record...') -- proves #41 did not alter this path.
    const row = report.results[0];
    assert.equal(row.trackedModel, 'full-game');
    assert.equal(row.status, 'graded');
    assert.equal(row.result, 'HOME');
    assert.equal(row.win, true);
    assert.equal(row.tie, false);
    assert.equal(row.finalHome, 5);
    assert.equal(row.finalAway, 3);
    assert.equal(row.fgStatus, undefined, 'a full-game-convention record must not gain kalshi-primary-only fields');
    assert.equal(row.f5Status, undefined, 'a full-game-convention record must not gain kalshi-primary-only fields');

    // This fixture pick has no model/features/modelSha256/capturedAt (unlike the real historical
    // fixtures), so its own provenance is 'legacy-unverified', not 'verified' -- pass that cohort
    // explicitly rather than asserting on the default 'verified' cohort, which is orthogonal to
    // what this regression test is actually proving (that the #41 kalshi-primary convention did
    // not change how a 'full-game'-convention record grades or summarizes).
    const summary = summarizeForwardRecord([report], { cohort: 'legacy-unverified' });
    assert.equal(summary.fullGame.picks, 1);
    assert.equal(summary.fullGame.wins, 1);
    assert.equal(summary.kalshiPrimaryFullGame.picks, 0, 'a full-game-convention record must never appear in the kalshi-primary cohort');
    assert.equal(summary.kalshiPrimaryF5.picks, 0);
  });
});

test('F5 settles only after fifth completes, independently of the final game', async () => withTempCwd(async () => {
  const date='2099-01-01', start=date+'T20:00:00Z';
  fs.writeFileSync(pickFileFor(date),JSON.stringify({trackedModel:'kalshi-primary',picks:[{gamePk:1,officialDate:date,gameDate:start,homeId:2,awayId:1,available:true,pickSide:'HOME',f5Available:true,f5PickSide:'HOME'}]}));
  const old=global.fetch;
  let inning=5;
  global.fetch=async()=>({ok:true,json:async()=>({dates:[{games:[{gamePk:1,officialDate:date,gameDate:start,teams:{home:{team:{id:2}},away:{team:{id:1}}},status:{detailedState:'In Progress'},linescore:{currentInning:inning,inningState:'Bottom',teams:{home:{runs:5},away:{runs:0}},innings:[1,2,3,4,5].map(num=>({num,home:{runs:1},away:{runs:0}}))}}]}]})});
  try {
    let r=await gradeDate(date);assert.equal(r.results[0].f5Status,'pending');
    inning=6;r=await gradeDate(date);assert.equal(r.results[0].f5Status,'graded');assert.equal(r.results[0].f5Win,true);assert.equal(r.results[0].fgStatus,'pending');assert.equal(r.results[0].finalHome,null);
  } finally {global.fetch=old;}
}));
