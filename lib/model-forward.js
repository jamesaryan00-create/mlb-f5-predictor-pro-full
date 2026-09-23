const fs = require('fs'), path = require('path');
const { getSchedule, todayPacific, mlProbability } = require('./mlb');
const { getLiveHistoricalContext, liveFeatureVector, liveFullGameFeatureVector, firstFiveRuns } = require('./historical-f5');
const { liveRollingPitcherQuality } = require('./pitcher-history');
const { PARK_FACTORS, TEAM_ABBR } = require('./config');
const { loadThreeWayModel, rankedSelection } = require('./three-way-model');
const { loadFullGameModel, probability: fullGameProbability } = require('./full-game-model');

// Model-only forward tracking: no Kalshi dependency, so it keeps producing a real record even
// if market capture (data/kalshi-forward) is down. Picks for a date are written to disk before
// any game that day starts, so grading them later carries no look-ahead risk.
//
// TRACKED-MODEL VERSIONING (see FEATURE-WISHLIST.md #31): this tracker originally recorded and
// graded the F5 model exclusively, from before the site's headline pick switched to the full-game
// model (lib/mlb.js's PICK_PIPELINE_VERSION, FEATURE-WISHLIST.md #27). Records written going
// forward carry `trackedModel: 'full-game'` at the top level and record the full-game model's pick
// as PRIMARY (graded against the actual final score, which can't tie), with the F5 pick kept as a
// secondary field for continuity. Records written before this fix carry no `trackedModel` field at
// all -- those are never rewritten (doing so now would be look-ahead bias: today's full-game model
// may differ from what existed pregame on those dates) and continue to be graded under the original
// F5-primary convention so their historical meaning doesn't change retroactively.
const VERSION = 'model-forward-v2';
const TRACKED_MODEL = 'full-game';
const crypto = require('crypto');
// Verifies the PRIMARY recorded pick was reproducible from its saved model+features, independent
// of which model is primary for a given record (full-game going forward, F5 for legacy records --
// see TRACKED_MODEL / trackedModel above). `predict` is the model-appropriate probability function.
function verifyPrimary(p, record, predict) {
  const at = p.capturedAt || p.filledAt || record.generatedAt;
  if (!Number.isFinite(Date.parse(at)) || Date.parse(at) >= Date.parse(p.gameDate)) return 'retrospective';
  if (!Number.isFinite(Date.parse(p.gameDate))) return 'invalid-cutoff';
  if (!p.model || !p.features || !p.modelSha256 || !p.capturedAt) return 'legacy-unverified';
  if (crypto.createHash('sha256').update(JSON.stringify(p.model)).digest('hex') !== p.modelSha256) return 'invalid-model';
  if (!p.model.throughDate || p.model.throughDate >= p.officialDate || !Number.isFinite(Date.parse(p.model.trainedAt)) || Date.parse(p.model.trainedAt) > Date.parse(at)) return 'invalid-cutoff';
  if (!p.featuresThroughDate || p.featuresThroughDate >= p.officialDate) return 'invalid-cutoff';
  const probability = predict(p.features, p.model);
  if (probability == null || (probability >= .5 ? 'HOME' : 'AWAY') !== p.pickSide || Math.abs(Math.max(probability,1-probability)-p.confidence)>1e-10) return 'invalid-prediction';
  return 'verified';
}
// Legacy records (no `trackedModel` field -- written before FEATURE-WISHLIST.md #31) recorded the
// F5 model as primary; records with `trackedModel === 'full-game'` record the full-game model as
// primary. Each is verified against the model that was actually its primary pick at capture time.
function provenance(p, record) {
  return verifyPrimary(p, record, record?.trackedModel === TRACKED_MODEL ? fullGameProbability : mlProbability);
}
// Secondary-field verification for the F5 pick kept alongside a full-game-primary record. Uses the
// same shape of check as provenance() but against f5Model/f5Features/f5ModelSha256/f5PickSide, so
// the secondary field can independently be trusted (or not) without affecting the primary cohort.
function f5Provenance(p, record) {
  if (!p.f5Model || !p.f5Features || !p.f5ModelSha256) return 'legacy-unverified';
  return verifyPrimary({
    model: p.f5Model, features: p.f5Features, modelSha256: p.f5ModelSha256,
    capturedAt: p.capturedAt, filledAt: p.filledAt, gameDate: p.gameDate, officialDate: p.officialDate,
    featuresThroughDate: p.featuresThroughDate, pickSide: p.f5PickSide, confidence: p.f5Confidence
  }, record, mlProbability);
}
function canRecord(game, at) {
  return ['Scheduled','Pre-Game'].includes(game.status) && Number.isFinite(Date.parse(game.gameDate)) && Date.parse(game.gameDate)>Date.parse(at);
}

const dir = () => path.join(process.cwd(), 'data', 'model-forward');
const pickFile = (date) => path.join(dir(), `picks-${date}.json`);
const gradeFile = (date) => path.join(dir(), `grades-${date}.json`);

function rankThreeWayPicks(picks) {
  const eligible = picks.filter((p) => p.available && p.threeWay && Number.isFinite(p.threeWay.pickProbability));
  const ranked = [...eligible].sort((a,b) => b.threeWay.pickProbability-a.threeWay.pickProbability || a.gamePk-b.gamePk);
  const rank = new Map(ranked.map((p,i)=>[p.gamePk,i+1]));
  return picks.map((p)=>({ ...p, dailyThreeWayRank:rank.get(p.gamePk)??null,
    selectedTop8:ranked.length>=8 && rank.get(p.gamePk)<=8,
    selectedTop9:ranked.length>=9 && rank.get(p.gamePk)<=9 }));
}

// First run of the day writes the file. Later runs are append-only fill-ins: a game with no
// usable prediction at the first run (starter not yet listed, transient API failure) can get one
// later, but ONLY while it is still unstarted, and an existing available pick is never touched.
async function generatePicks(date = todayPacific()) {
  fs.mkdirSync(dir(), { recursive: true });
  const file = pickFile(date);
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  const known = new Map((existing?.picks || []).map((p) => [p.gamePk, p]));

  const games = await getSchedule(date);
  const upcoming = games.filter((g) => ['Scheduled', 'Pre-Game'].includes(g.status) && Date.parse(g.gameDate) > Date.now());
  const eligible = existing ? upcoming.filter((g) => !known.get(g.gamePk)?.available) : upcoming;
  if (existing && !eligible.length) return { skipped: true, reason: 'Picks recorded; nothing left to fill in', file };
  const context = await getLiveHistoricalContext(date);
  // Primary pick: the full-game model, matching the live site's actual headline pick
  // (lib/mlb.js's PICK_PIPELINE_VERSION / FEATURE-WISHLIST.md #27). Secondary pick: the F5 model,
  // kept for continuity with the record's original F5-only history -- see TRACKED_MODEL above.
  const fullGameModel = loadFullGameModel();
  if (!fullGameModel) throw Error('Full-game model (data/full-game-model.json) unavailable -- refusing to record picks without the site\'s primary model');
  const fullGameModelSha256 = crypto.createHash('sha256').update(JSON.stringify(fullGameModel)).digest('hex');
  const f5Model = JSON.parse(fs.readFileSync(path.join(process.cwd(),'data','model.json'),'utf8'));
  const f5ModelSha256 = crypto.createHash('sha256').update(JSON.stringify(f5Model)).digest('hex');
  const threeWayModel = loadThreeWayModel();
  const threeWayModelSha256 = crypto.createHash('sha256').update(JSON.stringify(threeWayModel)).digest('hex');

  let picks = await Promise.all(eligible.map(async (g) => {
    const parkFactor = PARK_FACTORS[TEAM_ABBR[g.home.name]] ?? 1;
    const [homePitcherQuality, awayPitcherQuality] = await Promise.all([
      liveRollingPitcherQuality(g.home.probablePitcher?.id, g.officialDate).catch(() => null),
      liveRollingPitcherQuality(g.away.probablePitcher?.id, g.officialDate).catch(() => null)
    ]);
    const pitcherQuality = { home: homePitcherQuality, away: awayPitcherQuality };
    const fullGameFeatures = liveFullGameFeatureVector(g, context, parkFactor, pitcherQuality);
    const f5Features = liveFeatureVector(g, context, parkFactor, pitcherQuality);
    const homeProbability = fullGameFeatures ? fullGameProbability(fullGameFeatures, fullGameModel) : null;
    const f5HomeProbability = f5Features ? mlProbability(f5Features, f5Model) : null;
    const threeWay = f5Features ? rankedSelection(f5Features, threeWayModel) : null;
    const base = { gamePk: g.gamePk, away: g.away.name, home: g.home.name, awayId: g.away.id, homeId: g.home.id, officialDate: g.officialDate, gameDate: g.gameDate };
    if (homeProbability === null || homeProbability === undefined) return { ...base, available: false };
    const pickSide = homeProbability >= 0.5 ? 'HOME' : 'AWAY';
    const f5PickSide = f5HomeProbability === null || f5HomeProbability === undefined ? null : (f5HomeProbability >= 0.5 ? 'HOME' : 'AWAY');
    return { ...base, model: fullGameModel, modelSha256: fullGameModelSha256, features: fullGameFeatures, featuresThroughDate:context.throughDate, imputedFeatures:['homePitcherWhipDiff','homePitcherFipDiff'].filter(k=>fullGameFeatures[k]===null), pitcherIds:{home:g.home.probablePitcher?.id??null,away:g.away.probablePitcher?.id??null}, available: true, pickSide, pickTeam: pickSide === 'HOME' ? g.home.name : g.away.name, confidence: pickSide === 'HOME' ? homeProbability : 1 - homeProbability,
      f5Model: f5PickSide ? f5Model : null, f5ModelSha256: f5PickSide ? f5ModelSha256 : null, f5Features: f5PickSide ? f5Features : null,
      f5PickSide, f5PickTeam: f5PickSide ? (f5PickSide === 'HOME' ? g.home.name : g.away.name) : null,
      f5Confidence: f5PickSide ? (f5PickSide === 'HOME' ? f5HomeProbability : 1 - f5HomeProbability) : null,
      threeWay: threeWay ? { ...threeWay, modelVersion: threeWayModel.version, modelSha256: threeWayModelSha256 } : null };
  }));

  // Recheck at the persistence boundary after all remote work; reject late results.
  const refreshed = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher`,{signal:AbortSignal.timeout(20000)});
  if (!refreshed.ok) throw Error('Unable to refresh schedule before capture');
  const freshGames = (await refreshed.json()).dates?.flatMap(d=>d.games||[]) || [];
  const capturedAt = new Date().toISOString();
  picks = picks.map(p=>{
    if(!p.available)return p;
    const fresh=freshGames.find(g=>g.gamePk===p.gamePk);
    const valid=fresh && fresh.gameDate===p.gameDate && canRecord({status:fresh.status?.detailedState,gameDate:fresh.gameDate},capturedAt) && ['home','away'].every(side=>fresh.teams?.[side]?.probablePitcher?.id===p.pitcherIds[side]);
    const candidate={...p,capturedAt};
    return valid && provenance(candidate,{trackedModel:TRACKED_MODEL})==='verified' ? candidate : {...p,available:false,reason:'Late, changed starter/schedule, or invalid model provenance'};
  });
  if (!existing) picks=rankThreeWayPicks(picks);
  if (!existing) {
    const record = { version: VERSION, trackedModel: TRACKED_MODEL, date, generatedAt: new Date().toISOString(), totalGames: games.length, eligibleGames: eligible.length,
      note: 'Primary pick/grade is the full-game model (matches the live site\'s headline pick, PICK_PIPELINE_VERSION in lib/mlb.js). F5 model pick is kept in f5PickSide/f5PickTeam/f5Confidence as a secondary field. Records without a trackedModel field predate this convention and remain F5-primary -- see FEATURE-WISHLIST.md #31.',
      threeWaySelectionPolicy:'Rank direct team-lead probability at the fixed capture; select exactly 8/9 only when that many predictions are available', picks };
    fs.writeFileSync(file, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
    return { skipped: false, file, picks: picks.length };
  }

  const now = new Date().toISOString();
  const filled = picks.filter((p) => p.available).map((p) => ({ ...p, filledAt: now }));
  if (!filled.length) return { skipped: true, reason: 'Still no usable prediction for the unfilled games', file };
  const merged = existing.picks.map((p) => filled.find((f) => f.gamePk === p.gamePk) || p);
  for (const f of filled) if (!known.has(f.gamePk)) merged.push(f);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...existing, updatedAt: now, picks: merged }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { skipped: false, file, filled: filled.length };
}

async function gradeDate(date) {
  const file = pickFile(date);
  if (!fs.existsSync(file)) return null;
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));

  const results = [];
  for (const raw of record.picks) {
    const p={...raw,provenance:provenance(raw,record),trackedModel: record.trackedModel === TRACKED_MODEL ? 'full-game' : 'f5-legacy'};
    if (!p.available) { results.push({ ...p, status: 'excluded', reason: 'Model unavailable at pick time' }); continue; }
    try {
      const r = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePk=${p.gamePk}&hydrate=linescore`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`MLB ${r.status}`);
      const source = await r.json();
      const games = (source.dates || []).flatMap((d) => d.games || []);
      if (games.length !== 1) { results.push({ ...p, status: 'excluded', reason: 'Ambiguous schedule' }); continue; }
      const game = games[0];
      if (game.gamePk !== p.gamePk || game.officialDate !== p.officialDate || Object.keys(game).some(k=>/^resum/i.test(k)&&game[k]) || game.teams?.home?.team?.id !== p.homeId || game.teams?.away?.team?.id !== p.awayId || game.gameDate !== p.gameDate) { results.push({ ...p, status: 'excluded', reason: 'Changed schedule or identity mismatch' }); continue; }
      if (!/^(Final|Game Over|Completed Early)(:|$)/.test(game.status?.detailedState || '')) { results.push({ ...p, status: 'pending' }); continue; }
      const f5Runs = firstFiveRuns(game);
      const finalHome = Number(game.linescore?.teams?.home?.runs), finalAway = Number(game.linescore?.teams?.away?.runs);
      const hasFinalScore = Number.isFinite(finalHome) && Number.isFinite(finalAway);

      if (record.trackedModel === TRACKED_MODEL) {
        // Primary grade: full-game final score against the full-game pick. Full games can't tie
        // (extra innings force a winner) -- an equal final score is an anomaly, excluded rather
        // than silently graded, matching lib/kalshi-forward-fullgame.js's convention.
        if (!hasFinalScore) { results.push({ ...p, status: 'excluded', reason: 'Incomplete final score' }); continue; }
        if (finalHome === finalAway) { results.push({ ...p, status: 'excluded', reason: 'Tied final score (unexpected for full game)' }); continue; }
        const result = finalHome > finalAway ? 'HOME' : 'AWAY';
        // Secondary: F5 pick (if one was recorded) graded against F5 innings, same as always.
        const f5Result = f5Runs ? (f5Runs.home === f5Runs.away ? 'TIE' : f5Runs.home > f5Runs.away ? 'HOME' : 'AWAY') : null;
        results.push({ ...p, status: 'graded', finalHome, finalAway, result, win: result === p.pickSide, tie: false,
          threeWayWin: p.threeWay ? f5Result === p.threeWay.pickSide : null,
          f5Home: f5Runs?.home ?? null, f5Away: f5Runs?.away ?? null, f5Result,
          f5Win: p.f5PickSide && f5Result ? f5Result === p.f5PickSide : null, f5Tie: f5Result === 'TIE' });
      } else {
        // Legacy (pre-#31) record: primary grade stays F5-primary, exactly as it always has.
        if (!f5Runs) { results.push({ ...p, status: 'excluded', reason: 'Incomplete F5 innings' }); continue; }
        const result = f5Runs.home === f5Runs.away ? 'TIE' : f5Runs.home > f5Runs.away ? 'HOME' : 'AWAY';
        results.push({ ...p, status: 'graded', f5Home: f5Runs.home, f5Away: f5Runs.away, result, win: result === p.pickSide,
          threeWayWin:p.threeWay ? result===p.threeWay.pickSide : null, tie: result === 'TIE' });
      }
    } catch (e) {
      results.push({ ...p, status: 'pending', reason: e.message });
    }
  }

  const report = { version: VERSION, date, gradedAt: new Date().toISOString(), results };
  const archive=path.join(dir(),'grade-history'); fs.mkdirSync(archive,{recursive:true});
  fs.writeFileSync(path.join(archive,`${date}-${crypto.randomUUID()}.json`),JSON.stringify(report,null,2),{flag:'wx'});
  if(fs.existsSync(gradeFile(date)))fs.copyFileSync(gradeFile(date),path.join(archive,`${date}-previous-${crypto.randomUUID()}.json`));
  fs.writeFileSync(gradeFile(date)+'.tmp', JSON.stringify(report, null, 2)); fs.renameSync(gradeFile(date)+'.tmp',gradeFile(date));
  return report;
}

// `trackedModel` optionally restricts to 'full-game' rows (site's actual primary pick, graded
// against the final score -- no ties possible) or 'f5-legacy' rows (pre-#31 records, F5-primary,
// graded against firstFiveRuns -- ties possible). Omitted, it blends both, which is only meaningful
// once nearly all data is legacy-free; prefer summarizeForwardRecord() below for anything shown to
// a viewer, since blending silently mixes two different questions ("did the full-game pick win" vs
// "did the F5 pick win").
function summarize(reports, { minConfidence = 0, cohort = 'verified', trackedModel } = {}) {
  const rows = reports.flatMap((r) => r.results || []).filter((r) => r.status === 'graded' && r.provenance === cohort && r.confidence >= minConfidence && (trackedModel === undefined || r.trackedModel === trackedModel));
  const wins = rows.filter((r) => r.win).length;
  const ties = rows.filter((r) => r.tie).length;
  const decided = rows.length - ties;
  return { cohort, trackedModel: trackedModel ?? null, picks: rows.length, decided, winPct: rows.length ? Number((100*wins/rows.length).toFixed(1)) : null, wins, losses: decided - wins, ties, winPctDecided: decided ? Number((100 * wins / decided).toFixed(1)) : null };
}

// F5 pick kept as a secondary field on full-game-primary records (see generatePicks()). Graded
// against firstFiveRuns, same rule as F5 has always used, but reported separately from the primary
// (full-game) record so it's never confused with "the" record.
function summarizeF5Secondary(reports, { minConfidence = 0 } = {}) {
  const rows = reports.flatMap((r) => r.results || []).filter((r) => r.status === 'graded' && r.trackedModel === 'full-game' && r.f5PickSide && r.f5Result && r.f5Confidence >= minConfidence);
  const wins = rows.filter((r) => r.f5Win).length;
  const ties = rows.filter((r) => r.f5Tie).length;
  const decided = rows.length - ties;
  return { picks: rows.length, decided, winPct: rows.length ? Number((100*wins/rows.length).toFixed(1)) : null, wins, losses: decided - wins, ties, winPctDecided: decided ? Number((100 * wins / decided).toFixed(1)) : null };
}

// The clear, non-blended view: what a viewer of the "MODEL-FORWARD RECORD" tile should see.
// fullGame is the site's actual primary pick (full-game model) since FEATURE-WISHLIST.md #31,
// graded against the real final score -- no ties possible. legacyF5Primary is every record written
// before that fix, still graded under the original F5-primary convention (ties possible) so its
// historical meaning is unchanged. f5Secondary is the F5 pick recorded alongside new full-game
// records, purely informational. These are three different questions and are never blended.
function summarizeForwardRecord(reports, opts = {}) {
  return {
    fullGame: summarize(reports, { ...opts, trackedModel: 'full-game' }),
    legacyF5Primary: summarize(reports, { ...opts, trackedModel: 'f5-legacy' }),
    f5Secondary: summarizeF5Secondary(reports, opts),
    note: 'fullGame = live site\'s actual primary pick (full-game model), graded against the real final score, no ties possible. legacyF5Primary = records from before this tracker was fixed (FEATURE-WISHLIST.md #31), still graded under the original F5-primary convention so their meaning does not change retroactively. f5Secondary = the F5 model\'s pick, recorded alongside new full-game-primary records for continuity, graded against first-5-innings score. These are different questions and are reported separately, never blended into one number.'
  };
}

function summarizeThreeWay(reports, selection) {
  const key=selection==='top9'?'selectedTop9':'selectedTop8';
  const rows=reports.flatMap(r=>r.results||[]).filter(r=>r.status==='graded'&&r.provenance==='verified'&&r[key]&&r.threeWay);
  const wins=rows.filter(r=>r.threeWayWin).length,ties=rows.filter(r=>r.tie).length;
  return {selection,picks:rows.length,wins,lossesIncludingTies:rows.length-wins,ties,winPct:rows.length?Number((100*wins/rows.length).toFixed(1)):null};
}

module.exports = { generatePicks, gradeDate, summarize, summarizeF5Secondary, summarizeForwardRecord, summarizeThreeWay, rankThreeWayPicks, pickFile, gradeFile, dir, VERSION, TRACKED_MODEL, provenance, f5Provenance, canRecord };
