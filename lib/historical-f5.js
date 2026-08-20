const { PARK_FACTORS = {}, TEAM_ABBR = {} } = require('./config');

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
  let home = 0, away = 0, counted = 0;
  for (const inning of innings) {
    const n = Number(inning?.num);
    if (!Number.isFinite(n) || n > 5) continue;
    home += Number(inning?.home?.runs || 0);
    away += Number(inning?.away?.runs || 0);
    counted += 1;
  }
  if (counted < 5) return null;
  return { home, away };
}

function completedRegularGames(payload) {
  return (payload?.dates || [])
    .flatMap((d) => d.games || [])
    .filter((g) => (g.gameType === 'R' || !g.gameType) && (g.status?.abstractGameState === 'Final' || g.status?.detailedState === 'Final' || g.status?.detailedState === 'Game Over'))
    .sort((a, b) => String(a.gameDate || a.officialDate).localeCompare(String(b.gameDate || b.officialDate)) || Number(a.gamePk) - Number(b.gamePk));
}

async function fetchSeasonGames(season, { throughDate = null, ttl = 24 * 60 * 60 * 1000 } = {}) {
  const startDate = `${season}-03-01`;
  const hardEnd = `${season}-11-30`;
  const endDate = throughDate && String(throughDate).slice(0, 4) === String(season) ? dateOnly(throughDate) : hardEnd;
  const url = `${MLB_BASE}/schedule?sportId=1&gameType=R&startDate=${startDate}&endDate=${endDate}&hydrate=team,linescore`;
  const data = await fetchJson(url, ttl);
  return completedRegularGames(data);
}

function newTeamState() {
  return { games: 0, wins: 0, losses: 0, f5For: 0, f5Against: 0, recent: [], lastGameDate: null };
}
function getState(states, id) {
  if (!states.has(id)) states.set(id, newTeamState());
  return states.get(id);
}
function shrunkWinPct(s) { return (s.wins + PRIOR_GAMES * 0.5) / (s.games + PRIOR_GAMES); }
function shrunkF5For(s) { return s.f5For / (s.games + PRIOR_GAMES); }
function shrunkF5Against(s) { return s.f5Against / (s.games + PRIOR_GAMES); }
function shrunkF5Net(s) { return (s.f5For - s.f5Against) / (s.games + PRIOR_GAMES); }
function recentNet(s) {
  if (!s.recent.length) return 0;
  return s.recent.reduce((sum, x) => sum + x, 0) / s.recent.length;
}
function restDays(s, gameDate) {
  if (!s.lastGameDate) return 3;
  const gap = daysBetween(s.lastGameDate, gameDate);
  return clamp((gap == null ? 3 : Math.max(gap - 1, 0)), 0, 7);
}

function featureVector(homeState, awayState, { homeAbbr = '', gameDate = '', parkFactor = null } = {}) {
  const pf = Number.isFinite(Number(parkFactor)) ? Number(parkFactor) : Number(PARK_FACTORS[homeAbbr] || 1);
  return {
    homeWinPctDiff: shrunkWinPct(homeState) - shrunkWinPct(awayState),
    homeF5RunDiff: shrunkF5Net(homeState) - shrunkF5Net(awayState),
    homeRecentRunDiff: recentNet(homeState) - recentNet(awayState),
    homePitchingRunDiff: shrunkF5Against(awayState) - shrunkF5Against(homeState),
    homeParkFactor: pf - 1,
    homeRestDiff: clamp(restDays(homeState, gameDate) - restDays(awayState, gameDate), -5, 5)
  };
}

function updateState(state, scored, allowed, won, date) {
  state.games += 1;
  if (won) state.wins += 1; else state.losses += 1;
  state.f5For += scored;
  state.f5Against += allowed;
  state.recent.push(scored - allowed);
  if (state.recent.length > RECENT_GAMES) state.recent.shift();
  state.lastGameDate = date;
}

function buildFeatureRows(games) {
  const states = new Map();
  const rows = [];
  for (const game of games) {
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
    const features = featureVector(homeState, awayState, { homeAbbr: hAbbr, gameDate, parkFactor: PARK_FACTORS[hAbbr] || 1 });
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
      features
    });
    const homeScore = Number(game?.teams?.home?.score);
    const awayScore = Number(game?.teams?.away?.score);
    const homeWon = game?.teams?.home?.isWinner != null ? Boolean(game.teams.home.isWinner) : (Number.isFinite(homeScore) && Number.isFinite(awayScore) ? homeScore > awayScore : false);
    const awayWon = game?.teams?.away?.isWinner != null ? Boolean(game.teams.away.isWinner) : (Number.isFinite(homeScore) && Number.isFinite(awayScore) ? awayScore > homeScore : false);
    updateState(homeState, f5.home, f5.away, homeWon && !awayWon, gameDate);
    updateState(awayState, f5.away, f5.home, awayWon && !homeWon, gameDate);
  }
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

function liveFeatureVector(game, context, parkFactor) {
  if (!context?.states) return null;
  const homeId = game?.home?.id;
  const awayId = game?.away?.id;
  if (!homeId || !awayId) return null;
  const homeState = context.states.get(homeId) || newTeamState();
  const awayState = context.states.get(awayId) || newTeamState();
  return featureVector(homeState, awayState, {
    homeAbbr: teamAbbr(game.home),
    gameDate: dateOnly(game.officialDate || game.gameDate),
    parkFactor
  });
}

module.exports = {
  MLB_BASE,
  firstFiveRuns,
  fetchSeasonGames,
  buildFeatureRows,
  getLiveHistoricalContext,
  liveFeatureVector,
  featureVector,
  newTeamState,
  clamp
};
