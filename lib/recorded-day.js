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
  const trackedModel = picksFile.trackedModel === 'full-game' ? 'full-game' : 'f5-legacy';
  const grades = new Map((Array.isArray(gradesFile?.results) ? gradesFile.results : []).map((r) => [r.gamePk, r]));
  const primary = tally(), f5 = tally();
  let excluded = 0;
  const games = picksFile.picks.map((p) => {
    const g = grades.get(p.gamePk);
    const graded = g && g.status === 'graded';
    const team = (id, name) => ({ id: id ?? null, name: name || 'TBD', abbreviation: TEAM_ABBR[name] || '', probablePitcher: null });
    const recordedPick = p.available ? {
      pick: p.pickTeam ?? null, side: p.pickSide ?? null, confidence: pctOf(p.confidence),
      capturedAt: p.capturedAt || p.filledAt || null, modelVersion: p.model?.version ?? null, trackedModel,
      f5Pick: trackedModel === 'full-game' && p.f5PickTeam ? { pick: p.f5PickTeam, side: p.f5PickSide ?? null, confidence: pctOf(p.f5Confidence) } : null
    } : null;
    let recordedResult = null;
    if (recordedPick && graded) {
      recordedResult = { result: g.result, win: g.win, tie: g.tie, trackedModel, finalHome: g.finalHome ?? null, finalAway: g.finalAway ?? null };
      if (g.f5Result !== undefined) Object.assign(recordedResult, { f5Result: g.f5Result, f5Win: g.f5Win, f5Tie: g.f5Tie, f5Home: g.f5Home ?? null, f5Away: g.f5Away ?? null });
    }
    if (recordedPick) {
      const t = !graded ? primary.pending++ : (g.tie ? primary.ties++ : g.win ? primary.wins++ : primary.losses++);
      void t;
      if (recordedPick.f5Pick && graded && g.f5Result !== undefined) { if (g.f5Tie) f5.ties++; else if (g.f5Win) f5.wins++; else f5.losses++; }
    } else excluded++;
    return {
      gamePk: p.gamePk, gameDate: p.gameDate || null, officialDate: p.officialDate || date,
      status: graded ? 'Final' : (g?.status || 'Recorded'), venue: '',
      home: team(p.homeId, p.home), away: team(p.awayId, p.away),
      prediction: { pick: null, confidence: null, label: 'RECORDED', note: 'Recorded past day: showing the pregame pick and result, not a live prediction.' },
      recordedPick, recordedResult, recordedExcluded: !recordedPick,
      exclusionNote: recordedPick ? null : 'No pregame pick was recorded for this game (unavailable/excluded).',
      fullGamePrediction: {}, f5Prediction: {}, fullGameMonteCarlo: {}, fullGameMonteCarloV2: {}, market: {}, factors: {}
    };
  });
  return { ...base, games, summary: { trackedModel, primary, f5Secondary: trackedModel === 'full-game' ? f5 : null, excluded, total: games.length } };
}

module.exports = { getRecordedDay };
