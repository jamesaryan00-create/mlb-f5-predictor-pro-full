const fs = require('fs'), path = require('path');
const { getSchedule, todayPacific, mlProbability } = require('./mlb');
const { getLiveHistoricalContext, liveFeatureVector, firstFiveRuns } = require('./historical-f5');
const { liveRollingPitcherQuality } = require('./pitcher-history');
const { PARK_FACTORS, TEAM_ABBR } = require('./config');
const { loadThreeWayModel, rankedSelection } = require('./three-way-model');

// Model-only forward tracking: no Kalshi dependency, so it keeps producing a real record even
// if market capture (data/kalshi-forward) is down. Picks for a date are written to disk before
// any game that day starts, so grading them later carries no look-ahead risk.
const VERSION = 'model-forward-v2';
const crypto = require('crypto');
function provenance(p, record) {
  const at = p.capturedAt || p.filledAt || record.generatedAt;
  if (!Number.isFinite(Date.parse(at)) || Date.parse(at) >= Date.parse(p.gameDate)) return 'retrospective';
  if (!Number.isFinite(Date.parse(p.gameDate))) return 'invalid-cutoff';
  if (!p.model || !p.features || !p.modelSha256 || !p.capturedAt) return 'legacy-unverified';
  if (crypto.createHash('sha256').update(JSON.stringify(p.model)).digest('hex') !== p.modelSha256) return 'invalid-model';
  if (!p.model.throughDate || p.model.throughDate >= p.officialDate || !Number.isFinite(Date.parse(p.model.trainedAt)) || Date.parse(p.model.trainedAt) > Date.parse(at)) return 'invalid-cutoff';
  if (!p.featuresThroughDate || p.featuresThroughDate >= p.officialDate) return 'invalid-cutoff';
  const probability = mlProbability(p.features, p.model);
  if (probability == null || (probability >= .5 ? 'HOME' : 'AWAY') !== p.pickSide || Math.abs(Math.max(probability,1-probability)-p.confidence)>1e-10) return 'invalid-prediction';
  return 'verified';
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
  const model = JSON.parse(fs.readFileSync(path.join(process.cwd(),'data','model.json'),'utf8'));
  const modelSha256 = crypto.createHash('sha256').update(JSON.stringify(model)).digest('hex');
  const threeWayModel = loadThreeWayModel();
  const threeWayModelSha256 = crypto.createHash('sha256').update(JSON.stringify(threeWayModel)).digest('hex');

  let picks = await Promise.all(eligible.map(async (g) => {
    const parkFactor = PARK_FACTORS[TEAM_ABBR[g.home.name]] ?? 1;
    const [homePitcherQuality, awayPitcherQuality] = await Promise.all([
      liveRollingPitcherQuality(g.home.probablePitcher?.id, g.officialDate).catch(() => null),
      liveRollingPitcherQuality(g.away.probablePitcher?.id, g.officialDate).catch(() => null)
    ]);
    const features = liveFeatureVector(g, context, parkFactor, { home: homePitcherQuality, away: awayPitcherQuality });
    const homeProbability = features ? mlProbability(features, model) : null;
    const threeWay = features ? rankedSelection(features, threeWayModel) : null;
    const base = { gamePk: g.gamePk, away: g.away.name, home: g.home.name, awayId: g.away.id, homeId: g.home.id, officialDate: g.officialDate, gameDate: g.gameDate };
    if (homeProbability === null || homeProbability === undefined) return { ...base, available: false };
    const pickSide = homeProbability >= 0.5 ? 'HOME' : 'AWAY';
    return { ...base, model, modelSha256, features, featuresThroughDate:context.throughDate, imputedFeatures:['homePitcherWhipDiff','homePitcherFipDiff'].filter(k=>features[k]===null), pitcherIds:{home:g.home.probablePitcher?.id??null,away:g.away.probablePitcher?.id??null}, available: true, pickSide, pickTeam: pickSide === 'HOME' ? g.home.name : g.away.name, confidence: pickSide === 'HOME' ? homeProbability : 1 - homeProbability,
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
    return valid && provenance(candidate,{})==='verified' ? candidate : {...p,available:false,reason:'Late, changed starter/schedule, or invalid model provenance'};
  });
  if (!existing) picks=rankThreeWayPicks(picks);
  if (!existing) {
    const record = { version: VERSION, date, generatedAt: new Date().toISOString(), totalGames: games.length, eligibleGames: eligible.length,
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
    const p={...raw,provenance:provenance(raw,record)};
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
      const runs = firstFiveRuns(game);
      if (!runs) { results.push({ ...p, status: 'excluded', reason: 'Incomplete F5 innings' }); continue; }
      const result = runs.home === runs.away ? 'TIE' : runs.home > runs.away ? 'HOME' : 'AWAY';
      results.push({ ...p, status: 'graded', f5Home: runs.home, f5Away: runs.away, result, win: result === p.pickSide,
        threeWayWin:p.threeWay ? result===p.threeWay.pickSide : null, tie: result === 'TIE' });
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

function summarize(reports, { minConfidence = 0, cohort = 'verified' } = {}) {
  const rows = reports.flatMap((r) => r.results || []).filter((r) => r.status === 'graded' && r.provenance === cohort && r.confidence >= minConfidence);
  const wins = rows.filter((r) => r.win).length;
  const ties = rows.filter((r) => r.tie).length;
  const decided = rows.length - ties;
  return { cohort, picks: rows.length, decided, winPct: rows.length ? Number((100*wins/rows.length).toFixed(1)) : null, wins, losses: decided - wins, ties, winPctDecided: decided ? Number((100 * wins / decided).toFixed(1)) : null };
}

function summarizeThreeWay(reports, selection) {
  const key=selection==='top9'?'selectedTop9':'selectedTop8';
  const rows=reports.flatMap(r=>r.results||[]).filter(r=>r.status==='graded'&&r.provenance==='verified'&&r[key]&&r.threeWay);
  const wins=rows.filter(r=>r.threeWayWin).length,ties=rows.filter(r=>r.tie).length;
  return {selection,picks:rows.length,wins,lossesIncludingTies:rows.length-wins,ties,winPct:rows.length?Number((100*wins/rows.length).toFixed(1)):null};
}

module.exports = { generatePicks, gradeDate, summarize, summarizeThreeWay, rankThreeWayPicks, pickFile, gradeFile, dir, VERSION, provenance, canRecord };
