const fs = require('fs');
const path = require('path');
const { TEAM_ABBR } = require('./config');

function readJsonSafe(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
const pctOf = (c) => (Number.isFinite(c) ? Number((c * 100).toFixed(1)) : null);
const tally = () => ({ wins: 0, losses: 0, ties: 0, pending: 0 });

// Builds a getPredictions()-shaped payload for a past date purely from recorded pregame picks/grades.
// Never throws; missing files yield an empty games list with a message.
function getRecordedDay(date) {
  const dir = path.join(process.cwd(), 'data', 'model-forward');
  const picksFile = readJsonSafe(path.join(dir, `picks-${date}.json`));
  const gradesFile = readJsonSafe(path.join(dir, `grades-${date}.json`));
  const base = { date, historicalRecord: true, odds: { available: false }, fullGameModel: null, games: [], summary: null };
  if (!picksFile || !Array.isArray(picksFile.picks) || !picksFile.picks.length) {
    return { ...base, message: `No recorded picks found for ${date}.` };
  }
  // Three never-blended conventions (FEATURE-WISHLIST.md #31/#41): 'kalshi-primary' (current,
  // #41 -- primary pick is the live Kalshi price per market), 'full-game' (#31, the PRIOR
  // convention -- primary pick was the full-game model), 'f5-legacy' (pre-#31 -- primary pick was
  // the F5 model). A past day's picks file always carries whichever convention was live when it
  // was written, and this label is never reinterpreted for it.
  const trackedModel = picksFile.trackedModel === 'kalshi-primary' ? 'kalshi-primary' : picksFile.trackedModel === 'full-game' ? 'full-game' : 'f5-legacy';
  const grades = new Map((Array.isArray(gradesFile?.results) ? gradesFile.results : []).map((r) => [r.gamePk, r]));
  const primary = tally(), f5 = tally();
  let excluded = 0, excludedAfterPick = 0;
  const games = picksFile.picks.map((p) => {
    const g = grades.get(p.gamePk);
    const graded = trackedModel === 'kalshi-primary' ? g && g.fgStatus === 'graded' : g && g.status === 'graded';
    const team = (id, name) => ({ id: id ?? null, name: name || 'TBD', abbreviation: TEAM_ABBR[name] || '', probablePitcher: null });
    const recordedPick = (p.available || (trackedModel === 'kalshi-primary' && p.f5Available)) ? {
      pick: p.available ? p.pickTeam ?? null : null, side: p.available ? p.pickSide ?? null : null, confidence: pctOf(p.confidence),
      capturedAt: p.capturedAt || p.filledAt || null, modelVersion: p.model?.version ?? null, trackedModel,
      // 'full-game' convention (#31): F5 MODEL's own pick, kept for continuity, purely informational.
      f5Pick: trackedModel === 'full-game' && p.f5PickTeam ? { pick: p.f5PickTeam, side: p.f5PickSide ?? null, confidence: pctOf(p.f5Confidence) } : null,
      // 'kalshi-primary' convention (#41): our full-game MODEL's agree/disagree flag on the primary
      // (Kalshi) pick -- never the driver of it.
      modelAgree: trackedModel === 'kalshi-primary' ? { pick: p.fgModelPickTeam ?? null, side: p.fgModelPickSide ?? null, confidence: pctOf(p.fgModelConfidence), agrees: p.fgModelAgreesWithKalshi ?? null } : null,
      // 'kalshi-primary' convention (#41): the F5 market's OWN primary pick (a different live
      // Kalshi price, KXMLBF5, not the F5 model) -- reported on equal footing with the full-game
      // pick above, never blended into it. Frequently unavailable (thin F5 Kalshi liquidity).
      f5Primary: trackedModel === 'kalshi-primary' ? (p.f5Available ? {
        pick: p.f5PickTeam ?? null, side: p.f5PickSide ?? null, confidence: pctOf(p.f5Confidence),
        modelAgree: { pick: p.f5ModelPickTeam ?? null, side: p.f5ModelPickSide ?? null, confidence: pctOf(p.f5ModelConfidence), agrees: p.f5ModelAgreesWithKalshi ?? null }
      } : { available: false, reason: p.f5Reason || null }) : null,
      // Pregame "why" breakdown captured at pick time (see lib/model-forward.js's generatePicks());
      // absent on picks recorded before this field existed -- omit gracefully rather than recomputing.
      topFactors: Array.isArray(p.topFactors) ? p.topFactors : null
    } : null;
    let recordedResult = null;
    if (recordedPick && (graded || (trackedModel === 'kalshi-primary' && g?.f5Status === 'graded'))) {
      if (trackedModel === 'kalshi-primary') {
        recordedResult = { result: graded ? g.result : null, win: graded ? g.win : null, tie: graded ? g.tie : null, trackedModel, finalHome: g.finalHome ?? null, finalAway: g.finalAway ?? null };
        if (g.f5Status === 'graded') Object.assign(recordedResult, { f5Result: g.f5Result, f5Win: g.f5Win, f5Tie: g.f5Tie, f5Home: g.f5Home ?? null, f5Away: g.f5Away ?? null });
      } else {
        recordedResult = { result: graded ? g.result : null, win: graded ? g.win : null, tie: graded ? g.tie : null, trackedModel, finalHome: g.finalHome ?? null, finalAway: g.finalAway ?? null };
        if (g.f5Result !== undefined) Object.assign(recordedResult, { f5Result: g.f5Result, f5Win: g.f5Win, f5Tie: g.f5Tie, f5Home: g.f5Home ?? null, f5Away: g.f5Away ?? null });
      }
    }
    const gradeExcluded = trackedModel === 'kalshi-primary' ? !!(recordedPick && g && g.fgStatus === 'excluded') : !!(recordedPick && g && g.status === 'excluded');
    if (recordedPick) {
      const t = gradeExcluded ? (excludedAfterPick++) : !graded ? primary.pending++ : (g.tie ? primary.ties++ : g.win ? primary.wins++ : primary.losses++);
      void t;
      if (trackedModel === 'kalshi-primary' && recordedPick.f5Primary?.pick && g?.f5Status === 'graded') { if (g.f5Tie) f5.ties++; else if (g.f5Win) f5.wins++; else f5.losses++; }
      else if (recordedPick.f5Pick && graded && g.f5Result !== undefined) { if (g.f5Tie) f5.ties++; else if (g.f5Win) f5.wins++; else f5.losses++; }
    } else excluded++;
    return {
      gamePk: p.gamePk, gameDate: p.gameDate || null, officialDate: p.officialDate || date,
      status: graded ? 'Final' : (g?.status || 'Recorded'), venue: '',
      home: team(p.homeId, p.home), away: team(p.awayId, p.away),
      prediction: { pick: null, confidence: null, label: 'RECORDED', note: 'Recorded past day: showing the pregame pick and result, not a live prediction.' },
      recordedPick, recordedResult, recordedExcluded: !recordedPick,
      exclusionNote: recordedPick ? null : 'No pregame pick was recorded for this game (unavailable/excluded).',
      exclusionReason: g && (trackedModel === 'kalshi-primary' ? g.fgStatus === 'excluded' : g.status === 'excluded') ? (g.fgReason || g.reason || null) : null,
      gradeExcluded,
      fullGamePrediction: {}, f5Prediction: {}, market: {}, factors: {}
    };
  });
  return { ...base, games, summary: { trackedModel, primary, f5Secondary: (trackedModel === 'full-game' || trackedModel === 'kalshi-primary') ? f5 : null, excluded, excludedAfterPick, total: games.length } };
}

module.exports = { getRecordedDay };
