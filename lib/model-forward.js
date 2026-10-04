const fs = require('fs'), path = require('path');
const { getSchedule, todayPacific, mlProbability, toKalshiScheduleRow } = require('./mlb');
const { getLiveHistoricalContext, liveFeatureVector, liveFullGameFeatureVector, firstFiveRuns } = require('./historical-f5');
const { liveRollingPitcherQuality } = require('./pitcher-history');
const { PARK_FACTORS, TEAM_ABBR } = require('./config');
const { loadFullGameModel, probability: fullGameProbability, topFeatureContributions } = require('./full-game-model');
// Safe to require at the top level here (unlike lib/mlb.js): lib/model-forward.js is not itself
// required by lib/kalshi-board.js/lib/kalshi-board-fullgame.js, so there is no cycle. Used only for
// the pure, model-independent getKalshi(FullGame)QuoteRows() -- see FEATURE-WISHLIST.md #41.
const kalshiBoard = require('./kalshi-board');
const kalshiBoardFullGame = require('./kalshi-board-fullgame');

// TRACKED-MODEL VERSIONING (see FEATURE-WISHLIST.md #31 and #41): this tracker originally recorded
// and graded the F5 model exclusively (legacy records, no `trackedModel` field at all). #31 moved
// new records to `trackedModel: 'full-game'`, recording the full-game MODEL's own pick as primary.
// #41 moves new records again, to `trackedModel: 'kalshi-primary'`: the PRIMARY pick for each
// market (full-game and F5, tracked completely separately, never blended) is now whichever side
// the LIVE KALSHI PRICE favors, not either model's own probability. Both models' picks are kept as
// informational agree/disagree flags (fgModelPickSide/fgModelAgreesWithKalshi for the full-game
// market, f5ModelPickSide/f5ModelAgreesWithKalshi for the F5 market). As always, records written
// before this change are NEVER rewritten or reinterpreted -- gradeDate()/summarize() keep grading
// and reporting 'full-game' and legacy (undefined) records under their original conventions
// exactly as before; 'kalshi-primary' is a third, clearly separate cohort.
const VERSION = 'model-forward-v3';
const TRACKED_MODEL = 'kalshi-primary';
// The immediately-prior convention (#31), kept as its own named constant (rather than a hardcoded
// 'full-game' string sprinkled through this file) so the three-way branching below reads as
// "current / prior / legacy" rather than two unrelated string literals.
const PRIOR_TRACKED_MODEL = 'full-game';
const crypto = require('crypto');
// Verifies the PRIMARY recorded pick was reproducible from its saved model+features. Used only for
// the two model-driven conventions ('full-game' and legacy/F5) -- see provenance() below.
// `predict` is the model-appropriate probability function.
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
// A kalshi-primary pick's PRIMARY side comes from a live market quote, not a reproducible formula
// -- there is nothing to recompute the way verifyPrimary() recomputes a model's sigmoid output.
// This instead verifies the temporal integrity that matters for a live quote (captured pregame,
// against a real gameDate) and that a genuine Kalshi quote snapshot (quoteTime) was actually
// stored, so a malformed/backfilled record can't silently claim 'verified'.
function kalshiQuoteProvenance(p, record, { pickSideKey, confidenceKey, quoteTimeKey, availableKey }) {
  const at = p.capturedAt || p.filledAt || record.generatedAt;
  if (!Number.isFinite(Date.parse(at)) || !Number.isFinite(Date.parse(p.gameDate)) || Date.parse(at) >= Date.parse(p.gameDate)) return 'retrospective';
  if (!p[availableKey]) return 'legacy-unverified';
  if (!p[quoteTimeKey] || !Number.isFinite(Date.parse(p[quoteTimeKey])) || !p[pickSideKey] || !Number.isFinite(p[confidenceKey])) return 'legacy-unverified';
  if (Date.parse(p[quoteTimeKey]) >= Date.parse(p.gameDate)) return 'invalid-cutoff';
  return 'verified';
}
// Legacy records (no `trackedModel` field) recorded the F5 model as primary; 'full-game' records
// (#31) recorded the full-game model as primary; 'kalshi-primary' records (#41) record the live
// Kalshi full-game price as primary, verified against the quote snapshot instead of a model.
function provenance(p, record) {
  if (record?.trackedModel === TRACKED_MODEL) {
    return kalshiQuoteProvenance(p, record, { pickSideKey: 'pickSide', confidenceKey: 'confidence', quoteTimeKey: 'kalshiQuoteTime', availableKey: 'available' });
  }
  return verifyPrimary(p, record, record?.trackedModel === PRIOR_TRACKED_MODEL ? fullGameProbability : mlProbability);
}
// Secondary-field verification for the F5 pick kept alongside a full-game-primary ('full-game',
// #31) record. Uses the same shape of check as provenance() but against
// f5Model/f5Features/f5ModelSha256/f5PickSide, so the secondary field can independently be trusted
// (or not) without affecting the primary cohort. Not used for 'kalshi-primary' records -- see
// f5KalshiProvenance() below, which verifies THAT convention's F5 leg (the live F5 Kalshi price,
// not the F5 model) against its own quote snapshot instead.
function f5Provenance(p, record) {
  if (!p.f5Model || !p.f5Features || !p.f5ModelSha256) return 'legacy-unverified';
  return verifyPrimary({
    model: p.f5Model, features: p.f5Features, modelSha256: p.f5ModelSha256,
    capturedAt: p.capturedAt, filledAt: p.filledAt, gameDate: p.gameDate, officialDate: p.officialDate,
    featuresThroughDate: p.featuresThroughDate, pickSide: p.f5PickSide, confidence: p.f5Confidence
  }, record, mlProbability);
}
// F5 leg of a 'kalshi-primary' record: verifies the live F5 Kalshi price's own quote snapshot,
// completely independent of the full-game leg's provenance (F5 liquidity is thin -- this leg is
// very often simply unavailable, which is expected, not an error -- see FEATURE-WISHLIST.md #41).
function f5KalshiProvenance(p, record) {
  if (record?.trackedModel !== TRACKED_MODEL) return 'legacy-unverified';
  return kalshiQuoteProvenance(p, record, { pickSideKey: 'f5PickSide', confidenceKey: 'f5Confidence', quoteTimeKey: 'f5KalshiQuoteTime', availableKey: 'f5Available' });
}
function canRecord(game, at) {
  return ['Scheduled','Pre-Game'].includes(game.status) && Number.isFinite(Date.parse(game.gameDate)) && Date.parse(game.gameDate)>Date.parse(at);
}

const dir = () => path.join(process.cwd(), 'data', 'model-forward');
const pickFile = (date) => path.join(dir(), `picks-${date}.json`);
const gradeFile = (date) => path.join(dir(), `grades-${date}.json`);

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
  // The retry filter below only looks at the full-game leg's `available` flag (not `f5Available`)
  // -- once the full-game Kalshi-primary pick is recorded for a game it is never touched again on
  // a later run that day, even if the F5 leg was (and often stays) unavailable due to thin F5
  // Kalshi liquidity (FEATURE-WISHLIST.md #41). This mirrors the pre-existing "an available pick is
  // never touched" invariant, just scoped to the full-game leg, which is the one that gates whether
  // a game is considered "picked" at all.
  const eligible = existing ? upcoming.filter((g) => !known.get(g.gamePk)?.available) : upcoming;
  if (existing && !eligible.length) return { skipped: true, reason: 'Picks recorded; nothing left to fill in', file };
  const context = await getLiveHistoricalContext(date);
  // Our own models are still computed for the agree/disagree flags (fgModelPickSide/f5ModelPickSide
  // below) -- but they no longer determine the PRIMARY pick. See TRACKED_MODEL comment above.
  const fullGameModel = loadFullGameModel();
  if (!fullGameModel) throw Error('Full-game model (data/full-game-model.json) unavailable -- refusing to record picks without it (needed for the model-agrees flag)');
  const f5Model = JSON.parse(fs.readFileSync(path.join(process.cwd(),'data','model.json'),'utf8'));

  // Live Kalshi price for each eligible game, fetched once for the whole batch and joined by
  // gamePk below -- reuses the exact quote-quality/freshness/spread filters already enforced by
  // lib/kalshi-board.js/lib/kalshi-board-fullgame.js (never reimplemented here). A Kalshi outage
  // degrades to "no live price for any game" (every pick recorded available:false/f5Available:false
  // with a plain reason) rather than throwing -- design requirement 1/8.
  let kalshiFullGameByGamePk = new Map(), kalshiF5ByGamePk = new Map();
  try {
    const scheduleRows = eligible.map(toKalshiScheduleRow);
    const [fgMarkets, f5Markets] = await Promise.all([
      kalshiBoardFullGame.getLiveMarkets().catch(() => []),
      kalshiBoard.getLiveMarkets().catch(() => [])
    ]);
    const [fgResult, f5Result] = await Promise.all([
      kalshiBoardFullGame.getKalshiFullGameQuoteRows(scheduleRows, fgMarkets).catch(() => ({ board: [] })),
      kalshiBoard.getKalshiQuoteRows(scheduleRows, f5Markets).catch(() => ({ board: [] }))
    ]);
    kalshiFullGameByGamePk = new Map((fgResult.board || []).map((r) => [r.gamePk, r]));
    kalshiF5ByGamePk = new Map((f5Result.board || []).map((r) => [r.gamePk, r]));
  } catch { /* leave both maps empty -- every game records as unavailable, not a crash */ }

  let picks = await Promise.all(eligible.map(async (g) => {
    const parkFactor = PARK_FACTORS[TEAM_ABBR[g.home.name]] ?? 1;
    const [homePitcherQuality, awayPitcherQuality] = await Promise.all([
      liveRollingPitcherQuality(g.home.probablePitcher?.id, g.officialDate).catch(() => null),
      liveRollingPitcherQuality(g.away.probablePitcher?.id, g.officialDate).catch(() => null)
    ]);
    const pitcherQuality = { home: homePitcherQuality, away: awayPitcherQuality };
    const fullGameFeatures = liveFullGameFeatureVector(g, context, parkFactor, pitcherQuality);
    const f5Features = liveFeatureVector(g, context, parkFactor, pitcherQuality);
    const fgModelHomeProbability = fullGameFeatures ? fullGameProbability(fullGameFeatures, fullGameModel) : null;
    const f5ModelHomeProbability = f5Features ? mlProbability(f5Features, f5Model) : null;
    const fgModelPickSide = Number.isFinite(fgModelHomeProbability) ? (fgModelHomeProbability >= 0.5 ? 'HOME' : 'AWAY') : null;
    const f5ModelPickSide = Number.isFinite(f5ModelHomeProbability) ? (f5ModelHomeProbability >= 0.5 ? 'HOME' : 'AWAY') : null;
    const base = { gamePk: g.gamePk, away: g.away.name, home: g.home.name, awayId: g.away.id, homeId: g.home.id, officialDate: g.officialDate, gameDate: g.gameDate,
      pitcherIds: { home: g.home.probablePitcher?.id ?? null, away: g.away.probablePitcher?.id ?? null } };

    // PRIMARY: whichever side the live Kalshi price favors -- full-game and F5 markets tracked
    // completely separately (design requirement 1: a pick only exists with a usable live Kalshi
    // price for that specific market).
    const kalshiFullGameRow = kalshiFullGameByGamePk.get(g.gamePk) || null;
    const kalshiF5Row = kalshiF5ByGamePk.get(g.gamePk) || null;
    const available = Boolean(kalshiFullGameRow && Number.isFinite(kalshiFullGameRow.kalshiConfidence) && kalshiFullGameRow.kalshiPickSide);
    const f5Available = Boolean(kalshiF5Row && Number.isFinite(kalshiF5Row.kalshiConfidence) && kalshiF5Row.kalshiPickSide);

    const pickSide = available ? kalshiFullGameRow.kalshiPickSide : null;
    const f5PickSide = f5Available ? kalshiF5Row.kalshiPickSide : null;

    // "Why our model agrees/disagrees" -- computed from the exact features/model used for the
    // flag, over the exact same captured features the live site would show pregame (mirrors #39's
    // topFactors precedent, now framed as explaining the model's agree/disagree flag rather than
    // "why we picked this", since Kalshi -- not the model -- drives the pick).
    const topFactors = fgModelPickSide ? topFeatureContributions(fullGameFeatures, fullGameModel, 4, fgModelPickSide === 'HOME' ? 'home' : 'away') : null;

    return { ...base,
      available,
      pickSide, pickTeam: available ? (pickSide === 'HOME' ? g.home.name : g.away.name) : null,
      confidence: available ? (pickSide === 'HOME' ? kalshiFullGameRow.kalshiConfidence : kalshiFullGameRow.kalshiConfidence) : null,
      kalshiQuoteTime: available ? kalshiFullGameRow.quoteTime : null, kalshiTier: available ? kalshiFullGameRow.tier : null,
      reason: available ? null : 'No usable live Kalshi price for the full-game market at capture time',

      fgModelPickSide, fgModelPickTeam: fgModelPickSide ? (fgModelPickSide === 'HOME' ? g.home.name : g.away.name) : null,
      fgModelConfidence: Number.isFinite(fgModelHomeProbability) ? (fgModelPickSide === 'HOME' ? fgModelHomeProbability : 1 - fgModelHomeProbability) : null,
      fgModelAgreesWithKalshi: available && fgModelPickSide ? fgModelPickSide === pickSide : null,
      topFactors,
      featuresThroughDate: context.throughDate,
      imputedFeatures: fullGameFeatures ? ['homePitcherWhipDiff','homePitcherFipDiff'].filter((k) => fullGameFeatures[k] === null) : [],

      f5Available,
      f5PickSide, f5PickTeam: f5Available ? (f5PickSide === 'HOME' ? g.home.name : g.away.name) : null,
      f5Confidence: f5Available ? kalshiF5Row.kalshiConfidence : null,
      f5KalshiQuoteTime: f5Available ? kalshiF5Row.quoteTime : null, f5KalshiTier: f5Available ? kalshiF5Row.tier : null,
      f5Reason: f5Available ? null : 'No usable live Kalshi price for the F5 market at capture time (F5 Kalshi liquidity is thin -- see FEATURE-WISHLIST.md #41)',

      f5ModelPickSide, f5ModelPickTeam: f5ModelPickSide ? (f5ModelPickSide === 'HOME' ? g.home.name : g.away.name) : null,
      f5ModelConfidence: Number.isFinite(f5ModelHomeProbability) ? (f5ModelPickSide === 'HOME' ? f5ModelHomeProbability : 1 - f5ModelHomeProbability) : null,
      f5ModelAgreesWithKalshi: f5Available && f5ModelPickSide ? f5ModelPickSide === f5PickSide : null
    };
  }));

  // Recheck at the persistence boundary after all remote work; reject late results. This still
  // gates on the full-game leg (pitcher IDs / schedule / provenance) exactly as before -- if the
  // game itself turns out to be late/changed, BOTH legs are invalidated together, since the F5
  // leg's model-agree flag depends on the same pitcher/schedule integrity.
  const refreshed = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher`,{signal:AbortSignal.timeout(20000)});
  if (!refreshed.ok) throw Error('Unable to refresh schedule before capture');
  const freshGames = (await refreshed.json()).dates?.flatMap(d=>d.games||[]) || [];
  const capturedAt = new Date().toISOString();
  picks = picks.map(p=>{
    if(!p.available)return p;
    const fresh=freshGames.find(g=>g.gamePk===p.gamePk);
    const valid=fresh && fresh.gameDate===p.gameDate && canRecord({status:fresh.status?.detailedState,gameDate:fresh.gameDate},capturedAt) && ['home','away'].every(side=>fresh.teams?.[side]?.probablePitcher?.id===p.pitcherIds[side]);
    const candidate={...p,capturedAt};
    return valid && provenance(candidate,{trackedModel:TRACKED_MODEL})==='verified' ? candidate : {...p,available:false,f5Available:false,reason:'Late, changed starter/schedule, or invalid Kalshi quote provenance'};
  });
  if (!existing) {
    const record = { version: VERSION, trackedModel: TRACKED_MODEL, date, generatedAt: new Date().toISOString(), totalGames: games.length, eligibleGames: eligible.length,
      note: 'Primary pick/grade for each market is the live Kalshi price -- full-game (KXMLBGAME) and F5 (KXMLBF5), tracked completely separately, never blended. Our full-game/F5 models\' own picks are kept as agree/disagree flags (fgModelPickSide/fgModelAgreesWithKalshi, f5ModelPickSide/f5ModelAgreesWithKalshi), not the driver of either pick. Records with trackedModel === \'full-game\' predate this convention and remain full-game-model-primary; records with no trackedModel field at all predate that and remain F5-model-primary -- see FEATURE-WISHLIST.md #31/#41.',
      picks };
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

// The MLB schedule API returns one entry per (gamePk, date). A postponed-then-replayed game keeps
// its gamePk, so ?gamePk=X yields TWO entries: the original slot (status Postponed, with the
// original gameDate) and the makeup slot (Final, new gameDate). Verified 2026-09-24 with gamePk
// 824785 (TOR@BAL, postponed 9/22, played 9/23). The old `games.length !== 1` check therefore
// excluded BOTH the 9/22 and 9/23 picks as 'Ambiguous schedule'. The pick recorded its own
// gameDate, so we select the entry for exactly that slot. All identity/look-ahead checks in
// gradeDate still run on the selected entry.
function selectScheduleEntry(games, p) {
  if (!games.length) return { reason: 'Game not found in schedule' };
  const slot = games.filter((g) => g.gamePk === p.gamePk && g.gameDate === p.gameDate);
  if (slot.length > 1) return { reason: 'Ambiguous schedule' };
  if (slot.length === 0) return { reason: 'Rescheduled -- recorded time slot no longer exists (pick not graded against a different slot)' };
  const g = slot[0], st = g.status?.detailedState || '';
  const resumed = Object.keys(g).some((k) => /^resum/i.test(k) && g[k]);
  if (/^Postponed/i.test(st)) return { reason: `Postponed -- not played in this slot${g.rescheduleDate ? ` (rescheduled to ${g.rescheduleDate})` : ''}` };
  if (/^(Cancelled|Canceled)/i.test(st)) return { reason: 'Cancelled -- not played' };
  if (/^Suspended/i.test(st) || resumed) return { reason: 'Suspended/resumed -- not graded' };
  return { game: g };
}

async function gradeDate(date) {
  const file = pickFile(date);
  if (!fs.existsSync(file)) return null;
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));

  const results = [];
  for (const raw of record.picks) {
    const trackedModelLabel = record.trackedModel === TRACKED_MODEL ? 'kalshi-primary' : record.trackedModel === PRIOR_TRACKED_MODEL ? 'full-game' : 'f5-legacy';
    const p = { ...raw, provenance: provenance(raw, record), trackedModel: trackedModelLabel };
    if (trackedModelLabel === 'kalshi-primary') p.f5Provenance = f5KalshiProvenance(raw, record);
    // 'kalshi-primary' records can have EITHER leg (full-game, F5) available independently -- only
    // exclude outright if neither market had a usable Kalshi price at pick time.
    const noPickAtAll = trackedModelLabel === 'kalshi-primary' ? (!p.available && !p.f5Available) : !p.available;
    if (noPickAtAll) {
      results.push({ ...p, status: 'excluded', reason: trackedModelLabel === 'kalshi-primary' ? 'No live Kalshi price for either market at pick time' : 'Model unavailable at pick time' });
      continue;
    }
    try {
      const r = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePk=${p.gamePk}&hydrate=linescore`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`MLB ${r.status}`);
      const source = await r.json();
      const games = (source.dates || []).flatMap((d) => d.games || []);
      const sel = selectScheduleEntry(games, p);
      if (sel.reason) { results.push({ ...p, status: 'excluded', reason: sel.reason }); continue; }
      const game = sel.game;
      if (game.gamePk !== p.gamePk || game.officialDate !== p.officialDate || Object.keys(game).some(k=>/^resum/i.test(k)&&game[k]) || game.teams?.home?.team?.id !== p.homeId || game.teams?.away?.team?.id !== p.awayId || game.gameDate !== p.gameDate) { results.push({ ...p, status: 'excluded', reason: 'Changed schedule or identity mismatch' }); continue; }
      const isFinal = /^(Final|Game Over|Completed Early)(:|$)/.test(game.status?.detailedState || '');
      if (!isFinal && trackedModelLabel !== 'kalshi-primary') { results.push({ ...p, status: 'pending' }); continue; }
      const f5Complete = isFinal || Number(game.linescore?.currentInning) > 5 || (Number(game.linescore?.currentInning) === 5 && game.linescore?.inningState === 'End');
      const f5Runs = f5Complete ? firstFiveRuns(game) : null;
      const finalHome = Number(game.linescore?.teams?.home?.runs), finalAway = Number(game.linescore?.teams?.away?.runs);
      const hasFinalScore = Number.isFinite(finalHome) && Number.isFinite(finalAway);

      if (trackedModelLabel === 'kalshi-primary') {
        // Full-game leg: our own Kalshi-primary full-game pick, graded against the real final
        // score. Full games can't tie -- an equal final score is an anomaly, excluded rather than
        // silently graded, matching lib/kalshi-forward-fullgame.js's convention.
        let fgStatus, fgReason = null, result = null, win = null;
        if (!p.available) { fgStatus = 'excluded'; fgReason = 'No live Kalshi price for the full-game market at pick time'; }
        else if (!isFinal) { fgStatus = 'pending'; }
        else if (!hasFinalScore) { fgStatus = 'excluded'; fgReason = 'Incomplete final score'; }
        else if (finalHome === finalAway) { fgStatus = 'excluded'; fgReason = 'Tied final score (unexpected for full game)'; }
        else { result = finalHome > finalAway ? 'HOME' : 'AWAY'; win = result === p.pickSide; fgStatus = 'graded'; }

        // F5 leg: our own Kalshi-primary F5 pick (separate market, separate quote, ties possible),
        // graded independently -- often 'excluded' for "no live Kalshi price" given thin F5
        // liquidity (FEATURE-WISHLIST.md #41), which is expected, not a bug.
        let f5Status, f5Reason = null, f5Result = null, f5Win = null, f5Tie = null;
        if (!p.f5Available) { f5Status = 'excluded'; f5Reason = 'No live Kalshi price for the F5 market at pick time'; }
        else if (!f5Runs) { f5Status = isFinal ? 'excluded' : 'pending'; f5Reason = 'Incomplete F5 innings'; }
        else { f5Result = f5Runs.home === f5Runs.away ? 'TIE' : f5Runs.home > f5Runs.away ? 'HOME' : 'AWAY'; f5Win = f5Result === p.f5PickSide; f5Tie = f5Result === 'TIE'; f5Status = 'graded'; }

        // Top-level status/reason mirror the full-game leg (the headline market) for backward-
        // compatible filtering; fgStatus/f5Status are the real, never-blended per-market truth.
        results.push({ ...p, status: fgStatus, reason: fgReason,
          finalHome: isFinal && hasFinalScore ? finalHome : null, finalAway: isFinal && hasFinalScore ? finalAway : null, result, win, tie: false,
          fgStatus, fgReason,
          f5Status, f5Reason, f5Home: f5Runs?.home ?? null, f5Away: f5Runs?.away ?? null, f5Result, f5Win, f5Tie });
      } else if (trackedModelLabel === 'full-game') {
        // Primary grade: full-game final score against the full-game pick. Full games can't tie
        // (extra innings force a winner) -- an equal final score is an anomaly, excluded rather
        // than silently graded, matching lib/kalshi-forward-fullgame.js's convention.
        if (!hasFinalScore) { results.push({ ...p, status: 'excluded', reason: 'Incomplete final score' }); continue; }
        if (finalHome === finalAway) { results.push({ ...p, status: 'excluded', reason: 'Tied final score (unexpected for full game)' }); continue; }
        const result = finalHome > finalAway ? 'HOME' : 'AWAY';
        // Secondary: F5 pick (if one was recorded) graded against F5 innings, same as always.
        const f5Result = f5Runs ? (f5Runs.home === f5Runs.away ? 'TIE' : f5Runs.home > f5Runs.away ? 'HOME' : 'AWAY') : null;
        results.push({ ...p, status: 'graded', finalHome, finalAway, result, win: result === p.pickSide, tie: false,
          f5Home: f5Runs?.home ?? null, f5Away: f5Runs?.away ?? null, f5Result,
          f5Win: p.f5PickSide && f5Result ? f5Result === p.f5PickSide : null, f5Tie: f5Result === 'TIE' });
      } else {
        // Legacy (pre-#31) record: primary grade stays F5-primary, exactly as it always has.
        if (!f5Runs) { results.push({ ...p, status: 'excluded', reason: 'Incomplete F5 innings' }); continue; }
        const result = f5Runs.home === f5Runs.away ? 'TIE' : f5Runs.home > f5Runs.away ? 'HOME' : 'AWAY';
        results.push({ ...p, status: 'graded', f5Home: f5Runs.home, f5Away: f5Runs.away, result, win: result === p.pickSide,
          tie: result === 'TIE' });
      }
    } catch (e) {
      results.push({ ...p, status: 'pending', reason: e.message });
    }
  }

  const report = { version: VERSION, date, gradedAt: new Date().toISOString(), results };
  // Used to also write a full snapshot to data/model-forward/grade-history/ on every grade run
  // (cron runs every 30 min -- thousands of files/day accumulated with zero code ever reading
  // them back). Grew to 373MB/7,466 files with no consumer, and was very likely why Vercel
  // deployments were failing (a single serverless function traced 7,502 data/model-forward
  // files, blowing past the 250MB function size limit). gradeFile(date) below is already the
  // real, current, single source of truth for a date's grade -- removed the redundant archive
  // write entirely rather than just excluding it from tracing, since nothing needs it kept.
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

// F5 pick kept as a secondary field on full-game-primary ('full-game', #31) records. Graded
// against firstFiveRuns, same rule as F5 has always used, but reported separately from the primary
// (full-game) record so it's never confused with "the" record. Not used for 'kalshi-primary'
// records -- see summarizeKalshiPrimaryF5() below, which is that convention's F5 PRIMARY leg (a
// different Kalshi price, not the F5 model), never blended with this one.
function summarizeF5Secondary(reports, { minConfidence = 0 } = {}) {
  const rows = reports.flatMap((r) => r.results || []).filter((r) => r.status === 'graded' && r.trackedModel === 'full-game' && r.f5PickSide && r.f5Result && r.f5Confidence >= minConfidence);
  const wins = rows.filter((r) => r.f5Win).length;
  const ties = rows.filter((r) => r.f5Tie).length;
  const decided = rows.length - ties;
  return { picks: rows.length, decided, winPct: rows.length ? Number((100*wins/rows.length).toFixed(1)) : null, wins, losses: decided - wins, ties, winPctDecided: decided ? Number((100 * wins / decided).toFixed(1)) : null };
}

// F5 PRIMARY leg of 'kalshi-primary' records (#41): the live F5 Kalshi price's own pick, graded
// against firstFiveRuns (ties possible), completely independent of the full-game leg -- and, given
// thin F5 Kalshi liquidity, often has far fewer graded rows than the full-game leg. This is a
// primary market pick in its own right (not a model-agree flag), just for a different market, so it
// is reported on equal footing with kalshiPrimaryFullGame below, never blended into it.
function summarizeKalshiPrimaryF5(reports, { minConfidence = 0, cohort = 'verified' } = {}) {
  const rows = reports.flatMap((r) => r.results || []).filter((r) => r.trackedModel === 'kalshi-primary' && r.f5Status === 'graded' && r.f5Provenance === cohort && r.f5Confidence >= minConfidence);
  const wins = rows.filter((r) => r.f5Win).length;
  const ties = rows.filter((r) => r.f5Tie).length;
  const decided = rows.length - ties;
  return { cohort, market: 'f5', picks: rows.length, decided, winPct: rows.length ? Number((100*wins/rows.length).toFixed(1)) : null, wins, losses: decided - wins, ties, winPctDecided: decided ? Number((100 * wins / decided).toFixed(1)) : null };
}

// The clear, non-blended view: what a viewer of the "MODEL-FORWARD RECORD" tile should see.
// kalshiPrimaryFullGame/kalshiPrimaryF5 are the live site's current primary picks (#41: the live
// Kalshi price, per market), graded against the real outcome for each market separately.
// fullGame is the site's PRIOR primary pick convention (#31: full-game model), from before #41,
// graded against the real final score -- no ties possible. legacyF5Primary is every record written
// before #31 at all, still graded under the original F5-model-primary convention (ties possible) so
// its historical meaning is unchanged. f5Secondary is the F5 model's pick recorded alongside
// 'full-game' records, purely informational. Five different questions, never blended.
function summarizeForwardRecord(reports, opts = {}) {
  return {
    kalshiPrimaryFullGame: summarize(reports, { ...opts, trackedModel: 'kalshi-primary' }),
    kalshiPrimaryF5: summarizeKalshiPrimaryF5(reports, opts),
    fullGame: summarize(reports, { ...opts, trackedModel: 'full-game' }),
    legacyF5Primary: summarize(reports, { ...opts, trackedModel: 'f5-legacy' }),
    f5Secondary: summarizeF5Secondary(reports, opts),
    note: 'kalshiPrimaryFullGame/kalshiPrimaryF5 = the live site\'s CURRENT primary picks (FEATURE-WISHLIST.md #41), one per market (full-game KXMLBGAME, F5 KXMLBF5), each graded against its own real outcome, never blended with each other or with the two conventions below. fullGame = the PRIOR primary-pick convention (#31, full-game model), graded against the real final score, no ties possible -- kept exactly as it graded before #41, not reinterpreted. legacyF5Primary = records from before #31 at all, still graded under the original F5-model-primary convention so their meaning does not change retroactively. f5Secondary = the F5 model\'s pick, recorded alongside \'full-game\'-convention records for continuity, graded against first-5-innings score. These are five different questions and are reported separately, never blended into one number.'
  };
}

// Counts excluded picks by reason across grade reports (for the forward-record tile).
function summarizeExcluded(reports) {
  const byReason = {};
  let total = 0;
  for (const r of reports) for (const x of r.results || []) if (x.status === 'excluded') { total++; byReason[x.reason || 'Unspecified'] = (byReason[x.reason || 'Unspecified'] || 0) + 1; }
  return { total, byReason };
}

module.exports = { selectScheduleEntry, summarizeExcluded, generatePicks, gradeDate, summarize, summarizeF5Secondary, summarizeKalshiPrimaryF5, summarizeForwardRecord, pickFile, gradeFile, dir, VERSION, TRACKED_MODEL, PRIOR_TRACKED_MODEL, provenance, f5Provenance, f5KalshiProvenance, canRecord };
