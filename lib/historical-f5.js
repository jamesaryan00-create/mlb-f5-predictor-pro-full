const { PARK_FACTORS = {}, TEAM_ABBR = {} } = require('./config');
const { historicalPitcherQuality } = require('./pitcher-history');

const MLB_BASE = 'https://statsapi.mlb.com/api/v1';
const cache = new Map();
const DEFAULT_TTL = 30 * 60 * 1000;
const RECENT_GAMES = 10;
const PRIOR_GAMES = 5;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function teamAbbr(team) { return team?.abbreviation || TEAM_ABBR[team?.name] || TEAM_ABBR[team] || ''; }
function dateOnly(value) { return String(value || '').slice(0, 10); }
function addDays(date, days) { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function daysBetween(a, b) { if (!a || !b) return null; return Math.max(0, Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000)); }

async function fetchJson(url, ttl = DEFAULT_TTL) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'mlb-f5-predictor-history/1.0' } });
  if (!res.ok) throw new Error(`MLB Stats API ${res.status}: ${url}`);
  const data = await res.json();
  cache.set(url, { at: Date.now(), data });
  return data;
}

function firstFiveRuns(game) {
  const innings = game?.linescore?.innings || [];
  let home = 0, away = 0;
  for (let n = 1; n <= 5; n++) {
    const matches = innings.filter((inning) => Number(inning?.num) === n);
    if (matches.length !== 1) return null;
    const h = matches[0]?.home?.runs, a = matches[0]?.away?.runs;
    if (h == null || a == null || h === '' || a === '') return null;
    if (![Number(h), Number(a)].every((v) => Number.isInteger(v) && v >= 0)) return null;
    home += Number(h); away += Number(a);
  }
  return { home, away };
}

// Repeated schedule entries must never update a team's state twice.
// Conflicting snapshots require investigation rather than arbitrary selection.
function uniqueHistoricalGames(games) {
  const byId = new Map();
  for (const game of games) {
    if (!Number.isSafeInteger(Number(game.gamePk)) || Number(game.gamePk) <= 0) throw new Error('Historical game ID unavailable');
    const key = Number(game.gamePk);
    const signature = (g) => JSON.stringify([g.officialDate, g.gameDate, ...['home', 'away'].flatMap((side) => [g.teams?.[side]?.team?.id, g.teams?.[side]?.score, g.teams?.[side]?.isWinner]), firstFiveRuns(g)]);
    if (byId.has(key) && signature(byId.get(key)) !== signature(game)) {
      throw new Error(`Conflicting historical snapshots for game ${key}`);
    }
    byId.set(key, game);
  }
  return [...byId.values()].sort((a, b) => String(a.gameDate).localeCompare(String(b.gameDate)) || Number(a.gamePk) - Number(b.gamePk));
}

function completedRegularGames(payload) {
  const games = (payload?.dates || []).flatMap((d) => d.games || []);
  const resumed = new Set(games.filter((g) => Object.keys(g).some((k) => /^resum/i.test(k) && g[k])).map((g) => g.gamePk));
  return uniqueHistoricalGames(games.filter((g) =>
    g.gameType === 'R' && /^(Final|Game Over|Completed Early)(:|$)/.test(g.status?.detailedState || '') &&
    !resumed.has(g.gamePk) && firstFiveRuns(g) &&
    Number.isFinite(Date.parse(g.gameDate)) &&
    typeof g.teams?.home?.isWinner === 'boolean' && typeof g.teams?.away?.isWinner === 'boolean'));
}

async function fetchSeasonGames(season, { throughDate = null, ttl = 24 * 60 * 60 * 1000 } = {}) {
  const startDate = `${season}-03-01`;
  const hardEnd = `${season}-11-30`;
  const endDate = throughDate && String(throughDate).slice(0, 4) === String(season) ? dateOnly(throughDate) : hardEnd;
  const url = `${MLB_BASE}/schedule?sportId=1&gameType=R&startDate=${startDate}&endDate=${endDate}&hydrate=team,linescore`;
  let data;
  // Optional immutable raw snapshots for reproducible offline training.
  if (process.env.HISTORY_SNAPSHOT_DIR) {
    const fs = require('fs'), path = require('path');
    const file = path.join(process.env.HISTORY_SNAPSHOT_DIR, `${season}-${endDate}.json`);
    if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));
    else { data = await fetchJson(url, ttl); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data), { flag: 'wx' }); }
  } else data = await fetchJson(url, ttl);
  return completedRegularGames(data);
}

function newTeamState() {
  return { games: 0, wins: 0, losses: 0, fullFor: 0, fullAgainst: 0, f5For: 0, f5Against: 0, f5Wins: 0, f5Decided: 0, recent: [], recentFull: [], lastGameDate: null };
}
function getState(states, id) {
  if (!states.has(id)) states.set(id, newTeamState());
  return states.get(id);
}
function shrunkWinPct(s) { return (s.wins + PRIOR_GAMES * 0.5) / (s.games + PRIOR_GAMES); }
function shrunkF5For(s) { return s.f5For / (s.games + PRIOR_GAMES); }
function shrunkF5Against(s) { return s.f5Against / (s.games + PRIOR_GAMES); }
function shrunkF5Net(s) { return (s.f5For - s.f5Against) / (s.games + PRIOR_GAMES); }
function shrunkFullNet(s) { return (s.fullFor - s.fullAgainst) / (s.games + PRIOR_GAMES); }
function shrunkLateNet(s) { return ((s.fullFor - s.f5For) - (s.fullAgainst - s.f5Against)) / (s.games + PRIOR_GAMES); }
// Distinct from shrunkF5Net (run differential): this is the F5-specific WIN RECORD, the literal
// wins-and-losses the user asked for, not runs. F5 ties are excluded from both numerator and
// denominator here, same "push, not a loss" convention used everywhere else in this project.
function shrunkF5WinPct(s) { return (s.f5Wins + PRIOR_GAMES * 0.5) / (s.f5Decided + PRIOR_GAMES); }
function recentNet(s) {
  if (!s.recent.length) return 0;
  return s.recent.reduce((sum, x) => sum + x, 0) / s.recent.length;
}
function recentFullNet(s) {
  if (!s.recentFull.length) return 0;
  return s.recentFull.reduce((sum, x) => sum + x, 0) / s.recentFull.length;
}
function restDays(s, gameDate) {
  if (!s.lastGameDate) return 3;
  const gap = daysBetween(s.lastGameDate, gameDate);
  return clamp((gap == null ? 3 : Math.max(gap - 1, 0)), 0, 7);
}

function pitcherDiff(homeQuality, awayQuality, key) {
  // Oriented like the other Diff features: positive favors home. Lower WHIP/FIP is better
  // pitching, so a home advantage is away's number minus home's. Either side missing (not
  // enough prior starts, or no boxscore data) makes the feature null rather than a guess --
  // Inference explicitly imputes these two missing differences to neutral zero, matching
  // training; underlying pitcher statistics remain unavailable and captures disclose imputation.
  if (!homeQuality || !awayQuality) return null;
  const home = homeQuality[key], away = awayQuality[key];
  return Number.isFinite(home) && Number.isFinite(away) ? away - home : null;
}

function featureVector(homeState, awayState, { homeAbbr = '', gameDate = '', parkFactor = null, homePitcherQuality = null, awayPitcherQuality = null } = {}) {
  const pf = Number.isFinite(Number(parkFactor)) ? Number(parkFactor) : Number(PARK_FACTORS[homeAbbr] || 1);
  return {
    homeWinPctDiff: shrunkWinPct(homeState) - shrunkWinPct(awayState),
    homeF5WinPctDiff: shrunkF5WinPct(homeState) - shrunkF5WinPct(awayState),
    homeF5RunDiff: shrunkF5Net(homeState) - shrunkF5Net(awayState),
    homeRecentRunDiff: recentNet(homeState) - recentNet(awayState),
    homePitchingRunDiff: shrunkF5Against(awayState) - shrunkF5Against(homeState),
    homeParkFactor: pf - 1,
    homeRestDiff: clamp(restDays(homeState, gameDate) - restDays(awayState, gameDate), -5, 5),
    homePitcherWhipDiff: pitcherDiff(homePitcherQuality, awayPitcherQuality, 'whipLast10'),
    homePitcherFipDiff: pitcherDiff(homePitcherQuality, awayPitcherQuality, 'fipLast10')
  };
}

function fullGameFeatureVector(homeState, awayState, context = {}) {
  const f5 = featureVector(homeState, awayState, context);
  return {
    ...f5,
    homeFullRunDiff: shrunkFullNet(homeState) - shrunkFullNet(awayState),
    homeLateRunDiff: shrunkLateNet(homeState) - shrunkLateNet(awayState),
    homeRecentFullRunDiff: recentFullNet(homeState) - recentFullNet(awayState),
    homePitchingFullRunDiff: (awayState.fullAgainst - homeState.fullAgainst) / (Math.max(awayState.games, homeState.games) + PRIOR_GAMES)
  };
}

function shrunkRate(total, games, priorMean) { return (total + PRIOR_GAMES * priorMean) / (games + PRIOR_GAMES); }
function starterRunMultiplier(quality) {
  if (!quality) return 1;
  const fip = Number.isFinite(quality.fipLast10) ? quality.fipLast10 : 4.2;
  const whip = Number.isFinite(quality.whipLast10) ? quality.whipLast10 : 1.3;
  return Math.exp(clamp((fip - 4.2) * 0.07 + (whip - 1.3) * 0.18, -0.3, 0.3));
}
function fullGameSimulationInputs(homeState, awayState, { parkFactor = 1, homePitcherQuality = null, awayPitcherQuality = null } = {}) {
  const calibration = require('../data/full-game-mc-calibration.json');
  const f5Mean = 2.35, lateMean = 2.05;
  const component = (offense, defense, period) => {
    const isF5 = period === 'f5';
    const prior = isF5 ? f5Mean : lateMean;
    const offTotal = isF5 ? offense.f5For : offense.fullFor - offense.f5For;
    const defTotal = isF5 ? defense.f5Against : defense.fullAgainst - defense.f5Against;
    return Math.sqrt(shrunkRate(offTotal, offense.games, prior) * shrunkRate(defTotal, defense.games, prior));
  };
  const park = clamp(Number(parkFactor) || 1, 0.85, 1.2);
  const homeEarly = component(homeState, awayState, 'f5') * starterRunMultiplier(awayPitcherQuality);
  const awayEarly = component(awayState, homeState, 'f5') * starterRunMultiplier(homePitcherQuality);
  return {
    homeEarlyRuns: homeEarly * park * calibration.earlyFactors.home,
    awayEarlyRuns: awayEarly * park * calibration.earlyFactors.away,
    homeLateRuns: component(homeState, awayState, 'late') * park * calibration.lateFactors.home,
    awayLateRuns: component(awayState, homeState, 'late') * park * calibration.lateFactors.away
  };
}

function updateState(state, scored, allowed, won, date, f5Result, fullScored, fullAllowed) {
  state.games += 1;
  if (won) state.wins += 1; else state.losses += 1;
  state.f5For += scored;
  state.f5Against += allowed;
  state.fullFor += fullScored;
  state.fullAgainst += fullAllowed;
  if (f5Result === 'win') { state.f5Wins += 1; state.f5Decided += 1; }
  else if (f5Result === 'loss') { state.f5Decided += 1; }
  state.recent.push(scored - allowed);
  if (state.recent.length > RECENT_GAMES) state.recent.shift();
  state.recentFull.push(fullScored - fullAllowed);
  if (state.recentFull.length > RECENT_GAMES) state.recentFull.shift();
  state.lastGameDate = date;
}

function buildFeatureRows(games) {
  const states = new Map();
  const rows = [];
  let pending = [], activeDate = null;
  const flush = () => { for (const args of pending) updateState(...args); pending = []; };
  for (const game of uniqueHistoricalGames(games)) {
    const date = dateOnly(game.officialDate || game.gameDate);
    if (date !== activeDate) { flush(); activeDate = date; }
    const f5 = firstFiveRuns(game);
    if (!f5) continue;
    const homeId = game?.teams?.home?.team?.id;
    const awayId = game?.teams?.away?.team?.id;
    if (!homeId || !awayId) continue;
    const homeState = getState(states, homeId);
    const awayState = getState(states, awayId);
    const gameDate = dateOnly(game.officialDate || game.gameDate);
    const homeName = game?.teams?.home?.team?.name || '';
    const awayName = game?.teams?.away?.team?.name || '';
    const hAbbr = TEAM_ABBR[homeName] || game?.teams?.home?.team?.abbreviation || '';
    const aAbbr = TEAM_ABBR[awayName] || game?.teams?.away?.team?.abbreviation || '';
    const homePitcherQuality = historicalPitcherQuality(game.gamePk, 'HOME');
    const awayPitcherQuality = historicalPitcherQuality(game.gamePk, 'AWAY');
    const featureContext = { homeAbbr: hAbbr, gameDate, parkFactor: PARK_FACTORS[hAbbr] || 1, homePitcherQuality, awayPitcherQuality };
    const features = featureVector(homeState, awayState, featureContext);
    const fullGameFeatures = fullGameFeatureVector(homeState, awayState, featureContext);
    const fullGameSimulation = fullGameSimulationInputs(homeState, awayState, featureContext);
    const push = f5.home === f5.away;
    rows.push({
      gamePk: game.gamePk,
      date: gameDate,
      season: Number(gameDate.slice(0, 4)),
      homeId,
      awayId,
      homeTeam: homeName,
      awayTeam: awayName,
      homeAbbr: hAbbr,
      awayAbbr: aAbbr,
      homeF5: f5.home,
      awayF5: f5.away,
      result: push ? 'push' : (f5.home > f5.away ? 'home' : 'away'),
      target: push ? null : (f5.home > f5.away ? 1 : 0),
      homeFinal: Number(game?.teams?.home?.score),
      awayFinal: Number(game?.teams?.away?.score),
      fullResult: Number(game?.teams?.home?.score) > Number(game?.teams?.away?.score) ? 'home' : 'away',
      fullTarget: Number(game?.teams?.home?.score) > Number(game?.teams?.away?.score) ? 1 : 0,
      features,
      fullGameFeatures,
      fullGameSimulation
    });
    const homeScore = Number(game?.teams?.home?.score);
    const awayScore = Number(game?.teams?.away?.score);
    const homeWon = game?.teams?.home?.isWinner != null ? Boolean(game.teams.home.isWinner) : (Number.isFinite(homeScore) && Number.isFinite(awayScore) ? homeScore > awayScore : false);
    const awayWon = game?.teams?.away?.isWinner != null ? Boolean(game.teams.away.isWinner) : (Number.isFinite(homeScore) && Number.isFinite(awayScore) ? awayScore > homeScore : false);
    const homeF5Result = push ? 'push' : (f5.home > f5.away ? 'win' : 'loss');
    const awayF5Result = push ? 'push' : (f5.away > f5.home ? 'win' : 'loss');
    pending.push([homeState, f5.home, f5.away, homeWon && !awayWon, gameDate, homeF5Result, homeScore, awayScore]);
    pending.push([awayState, f5.away, f5.home, awayWon && !homeWon, gameDate, awayF5Result, awayScore, homeScore]);
  }
  flush();
  return { rows, states };
}

async function getLiveHistoricalContext(date) {
  const season = Number(String(date).slice(0, 4));
  const throughDate = addDays(date, -1);
  const key = `live-context:${throughDate}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < DEFAULT_TTL) return hit.data;
  const games = await fetchSeasonGames(season, { throughDate, ttl: DEFAULT_TTL });
  const built = buildFeatureRows(games);
  const data = { available: true, season, throughDate, states: built.states, games: games.length };
  cache.set(key, { at: Date.now(), data });
  return data;
}

// pitcherQuality is pre-resolved by the caller (each side's rolling WHIP/FIP, or null if
// unavailable) so this stays synchronous -- the network lookup for a live probable starter
// happens in pitcher-history.js's liveRollingPitcherQuality, awaited by the caller first.
function liveFeatureVector(game, context, parkFactor, pitcherQuality = {}) {
  if (!context?.states) return null;
  const homeId = game?.home?.id;
  const awayId = game?.away?.id;
  if (!homeId || !awayId) return null;
  const homeState = context.states.get(homeId) || newTeamState();
  const awayState = context.states.get(awayId) || newTeamState();
  return featureVector(homeState, awayState, {
    homeAbbr: teamAbbr(game.home),
    gameDate: dateOnly(game.officialDate || game.gameDate),
    parkFactor,
    homePitcherQuality: pitcherQuality.home || null,
    awayPitcherQuality: pitcherQuality.away || null
  });
}

function liveFullGameFeatureVector(game, context, parkFactor, pitcherQuality = {}) {
  if (!context?.states) return null;
  const homeId = game?.home?.id;
  const awayId = game?.away?.id;
  if (!homeId || !awayId) return null;
  return fullGameFeatureVector(context.states.get(homeId) || newTeamState(), context.states.get(awayId) || newTeamState(), {
    homeAbbr: teamAbbr(game.home), gameDate: dateOnly(game.officialDate || game.gameDate), parkFactor,
    homePitcherQuality: pitcherQuality.home || null, awayPitcherQuality: pitcherQuality.away || null
  });
}

function liveFullGameSimulationInputs(game, context, parkFactor, pitcherQuality = {}) {
  if (!context?.states || !game?.home?.id || !game?.away?.id) return null;
  return fullGameSimulationInputs(context.states.get(game.home.id) || newTeamState(), context.states.get(game.away.id) || newTeamState(), {
    parkFactor, homePitcherQuality: pitcherQuality.home || null, awayPitcherQuality: pitcherQuality.away || null
  });
}

module.exports = {
  MLB_BASE,
  completedRegularGames,
  firstFiveRuns,
  uniqueHistoricalGames,
  fetchSeasonGames,
  buildFeatureRows,
  getLiveHistoricalContext,
  liveFeatureVector,
  liveFullGameFeatureVector,
  liveFullGameSimulationInputs,
  featureVector,
  fullGameFeatureVector,
  fullGameSimulationInputs,
  newTeamState,
  clamp
};
