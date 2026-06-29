const fs = require('fs');
const path = require('path');
const { TEAM_ABBR, PARK_FACTORS, VENUES } = require('./config');

const MLB_BASE = 'https://statsapi.mlb.com/api/v1';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';

const cache = new Map();
const CACHE_MS = 1000 * 60 * 5;

function todayPacific() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function seasonFromDate(date) { return Number(String(date || todayPacific()).slice(0, 4)); }
function addDays(date, days) { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function num(value, fallback = 0) { if (value === undefined || value === null || value === '') return fallback; const n = Number(String(value).replace('%', '')); return Number.isFinite(n) ? n : fallback; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function pct(n, d, fallback = 0.5) { return d ? n / d : fallback; }
function teamCode(team) { return team?.abbreviation || TEAM_ABBR[team?.name] || TEAM_ABBR[team] || ''; }
function normalizeName(name = '') { return String(name).toLowerCase().replace(/[^a-z0-9]/g, ''); }

async function fetchJson(url, { ttl = CACHE_MS } = {}) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.time < ttl) return hit.data;
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'mlb-f5-predictor/3.0' } });
  if (!res.ok) { const body = await res.text().catch(() => ''); throw new Error(`Request failed ${res.status}: ${url} ${body.slice(0, 120)}`); }
  const data = await res.json(); cache.set(url, { time: Date.now(), data }); return data;
}

function statMap(statsResponse, groupName) {
  const splits = statsResponse?.stats?.find((s) => s.group?.displayName?.toLowerCase() === groupName)?.splits;
  return splits?.[0]?.stat || {};
}

async function getSchedule(date = todayPacific()) {
  const url = `${MLB_BASE}/schedule?sportId=1&date=${encodeURIComponent(date)}&hydrate=probablePitcher,team,venue,linescore`;
  const data = await fetchJson(url, { ttl: 1000 * 60 * 2 });
  const games = (data.dates || []).flatMap((d) => d.games || []);
  return games.map((game) => ({
    gamePk: game.gamePk, officialDate: game.officialDate, gameDate: game.gameDate,
    status: game.status?.detailedState || game.status?.abstractGameState || 'Unknown', venue: game.venue?.name || 'TBD',
    home: { id: game.teams?.home?.team?.id, name: game.teams?.home?.team?.name, abbreviation: game.teams?.home?.team?.abbreviation || TEAM_ABBR[game.teams?.home?.team?.name], probablePitcher: game.teams?.home?.probablePitcher ? { id: game.teams.home.probablePitcher.id, fullName: game.teams.home.probablePitcher.fullName } : null },
    away: { id: game.teams?.away?.team?.id, name: game.teams?.away?.team?.name, abbreviation: game.teams?.away?.team?.abbreviation || TEAM_ABBR[game.teams?.away?.team?.name], probablePitcher: game.teams?.away?.probablePitcher ? { id: game.teams.away.probablePitcher.id, fullName: game.teams.away.probablePitcher.fullName } : null },
  }));
}

async function getTeamStats(teamId, season) {
  if (!teamId) return { hitting: {}, pitching: {} };
  const url = `${MLB_BASE}/teams/${teamId}/stats?stats=season&group=hitting,pitching&season=${season}`;
  const data = await fetchJson(url, { ttl: 1000 * 60 * 60 });
  return { hitting: statMap(data, 'hitting'), pitching: statMap(data, 'pitching') };
}

async function getTeamSplits(teamId, season) {
  if (!teamId) return { vsLHP: {}, vsRHP: {} };
  async function split(sitCode) {
    const url = `${MLB_BASE}/teams/${teamId}/stats?stats=statSplits&group=hitting&season=${season}&sitCodes=${sitCode}`;
    const data = await fetchJson(url, { ttl: 1000 * 60 * 60 * 6 }).catch(() => null);
    return statMap(data, 'hitting');
  }
  const [vsLHP, vsRHP] = await Promise.all([split('vl'), split('vr')]);
  return { vsLHP, vsRHP };
}

async function getPitcherStats(playerId, season) {
  if (!playerId) return {};
  const url = `${MLB_BASE}/people/${playerId}/stats?stats=season&group=pitching&season=${season}`;
  const data = await fetchJson(url, { ttl: 1000 * 60 * 60 });
  return statMap(data, 'pitching');
}

async function getPitcherBio(playerId) {
  if (!playerId) return {};
  const url = `${MLB_BASE}/people/${playerId}`;
  const data = await fetchJson(url, { ttl: 1000 * 60 * 60 * 24 }).catch(() => null);
  const p = data?.people?.[0] || {};
  return { throws: p.pitchHand?.code || null, throwsDescription: p.pitchHand?.description || null };
}

async function getOdds() {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return { available: false, games: [], reason: 'ODDS_API_KEY is not set' };
  const markets = process.env.ODDS_MARKETS || 'h2h,spreads,totals';
  const regions = process.env.ODDS_REGIONS || 'us';
  const url = `${ODDS_BASE}/sports/baseball_mlb/odds/?regions=${encodeURIComponent(regions)}&markets=${encodeURIComponent(markets)}&oddsFormat=american&apiKey=${encodeURIComponent(apiKey)}`;
  const data = await fetchJson(url, { ttl: 1000 * 60 * 5 });
  return { available: true, games: data, markets };
}

function marketOutcomes(oddsGame, key) { return (oddsGame?.bookmakers || []).flatMap((book) => (book.markets || []).filter((m) => m.key === key).map((m) => ({ book: book.title, outcomes: m.outcomes || [] }))); }
function bestBookLine(oddsGame, teamName, market = 'h2h') { const prices = marketOutcomes(oddsGame, market).flatMap((m) => m.outcomes.filter((o) => normalizeName(o.name) === normalizeName(teamName)).map((o) => ({ book: m.book, price: Number(o.price), point: o.point }))).filter((x) => Number.isFinite(x.price)); if (!prices.length) return null; return prices.sort((a, b) => b.price - a.price)[0]; }
function bestTotal(oddsGame) { const totals = marketOutcomes(oddsGame, 'totals').flatMap((m) => m.outcomes.map((o) => ({ book: m.book, name: o.name, price: Number(o.price), point: Number(o.point) }))).filter((x) => Number.isFinite(x.point)); if (!totals.length) return null; totals.sort((a, b) => a.point - b.point); return totals[Math.floor(totals.length / 2)]; }
function findOddsGame(oddsPayload, game) { if (!oddsPayload?.available) return null; return oddsPayload.games.find((o) => [o.home_team, o.away_team].some((t) => normalizeName(t) === normalizeName(game.home.name)) && [o.home_team, o.away_team].some((t) => normalizeName(t) === normalizeName(game.away.name))) || null; }
function americanToImplied(line) { const n = Number(line); if (!Number.isFinite(n) || n === 0) return null; return n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100); }

function offenseScore(hitting = {}) { const ops = num(hitting.ops, 0.700), avg = num(hitting.avg, 0.245), obp = num(hitting.obp, 0.315), slg = num(hitting.slg, 0.395); const rpg = num(hitting.runs, 650) / Math.max(num(hitting.gamesPlayed, 162), 1); return clamp(50 + (ops - 0.700) * 130 + (avg - 0.245) * 70 + (obp - 0.315) * 90 + (slg - 0.395) * 80 + (rpg - 4.4) * 4, 20, 85); }
function splitScore(splits = {}, fallback = 50) { if (!splits || !Object.keys(splits).length) return fallback; return offenseScore(splits); }
function pitcherScore(p = {}) { const era = num(p.era, 4.25), whip = num(p.whip, 1.30), so9 = num(p.strikeoutsPer9Inn, 8.2), bb9 = num(p.walksPer9Inn, 3.2), ip = num(p.inningsPitched, 0); const samplePenalty = ip > 0 && ip < 25 ? (25 - ip) * 0.35 : 0; return clamp(50 + (4.25 - era) * 5.2 + (1.30 - whip) * 20 + (so9 - 8.2) * 1.6 + (3.2 - bb9) * 2.8 - samplePenalty, 20, 90); }
function pitchingStaffScore(p = {}) { return clamp(50 + (4.25 - num(p.era, 4.25)) * 4 + (1.30 - num(p.whip, 1.30)) * 16, 25, 80); }
function labelFromEdge(edge) { const abs = Math.abs(edge); if (abs >= 10) return 'Strong Lean'; if (abs >= 6) return 'Lean'; if (abs >= 3) return 'Slight Edge'; if (abs >= 1.25) return 'Tiny Edge'; return 'Pass'; }
function confidenceFromEdge(edge) { return clamp(Math.round(50 + Math.abs(edge) * 3.4), 50, 90); }

async function getWeather(venueName, gameDate) {
  const venue = VENUES[venueName];
  if (!venue) return { available: false, reason: 'Venue coordinates not configured' };
  if (venue.indoor) return { available: true, indoor: true, note: 'Indoor/retractable-roof park; weather impact reduced.' };
  const start = String(gameDate || todayPacific()).slice(0, 10);
  const url = `${OPEN_METEO_BASE}?latitude=${venue.lat}&longitude=${venue.lon}&hourly=temperature_2m,wind_speed_10m,precipitation_probability&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&start_date=${start}&end_date=${start}`;
  const data = await fetchJson(url, { ttl: 1000 * 60 * 30 }).catch((error) => ({ error: error.message }));
  if (data.error) return { available: false, reason: data.error };
  const hours = data.hourly?.time || [];
  const target = new Date(gameDate || `${start}T19:00:00Z`).getTime();
  let idx = 0, best = Infinity;
  hours.forEach((h, i) => { const delta = Math.abs(new Date(h).getTime() - target); if (delta < best) { best = delta; idx = i; } });
  return { available: true, indoor: false, temperature: data.hourly?.temperature_2m?.[idx], windMph: data.hourly?.wind_speed_10m?.[idx], precipitationProbability: data.hourly?.precipitation_probability?.[idx] };
}
function weatherAdjustment(w) { if (!w?.available || w.indoor) return 0; let adj = 0; if (num(w.temperature, 70) >= 85) adj += 0.4; if (num(w.temperature, 70) <= 50) adj -= 0.4; if (num(w.windMph, 0) >= 15) adj += 0.3; if (num(w.precipitationProbability, 0) >= 40) adj -= 0.2; return adj; }

async function getBullpenUsage(teamIds, date) {
  const usage = Object.fromEntries(teamIds.filter(Boolean).map((id) => [id, { relieverInnings3d: 0, games3d: 0, note: 'Estimated from prior 3 days of boxscores.' }]));
  const startDate = addDays(date, -3), endDate = addDays(date, -1);
  const schedule = await fetchJson(`${MLB_BASE}/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}&hydrate=linescore`, { ttl: 1000 * 60 * 30 }).catch(() => ({ dates: [] }));
  const games = (schedule.dates || []).flatMap((d) => d.games || []).filter((g) => g.status?.abstractGameState === 'Final');
  await Promise.all(games.map(async (g) => {
    const box = await fetchJson(`${MLB_BASE}/game/${g.gamePk}/boxscore`, { ttl: 1000 * 60 * 60 * 24 }).catch(() => null);
    ['home', 'away'].forEach((side) => {
      const teamId = g.teams?.[side]?.team?.id;
      if (!usage[teamId]) return;
      const pitchers = box?.teams?.[side]?.pitchers || [];
      usage[teamId].games3d += 1;
      pitchers.slice(1).forEach((pid) => {
        const stat = box?.teams?.[side]?.players?.[`ID${pid}`]?.stats?.pitching || {};
        usage[teamId].relieverInnings3d += num(stat.inningsPitched, 0);
      });
    });
  }));
  return usage;
}
function bullpenScore(teamPitching, usage) { const staff = pitchingStaffScore(teamPitching); const fatigue = clamp(num(usage?.relieverInnings3d, 0) - 9, 0, 20) * 0.8; return clamp(staff - fatigue, 20, 85); }

function loadModel() { try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'model.json'), 'utf8')); } catch { return null; } }
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
function mlProbability(features) {
  const model = loadModel();
  if (!model?.weights) return null;
  const w = model.weights;
  const z = (w.bias || 0) + (w.homeWinPctDiff || 0) * features.homeWinPctDiff + (w.homeF5RunDiff || 0) * features.homeF5RunDiff + (w.homeRecentRunDiff || 0) * features.homeRecentRunDiff + (w.homePitchingRunDiff || 0) * features.homePitchingRunDiff + (w.homeParkFactor || 0) * features.homeParkFactor + (w.homeRestDiff || 0) * features.homeRestDiff;
  return sigmoid(z);
}

async function optionalExternal(name, url) { if (!url) return { available: false, reason: `${name} URL not configured` }; return fetchJson(url, { ttl: 1000 * 60 * 30 }).then((data) => ({ available: true, data })).catch((error) => ({ available: false, reason: error.message })); }

function calculateGamePrediction(game, inputs, oddsGame) {
  const homePitcher = pitcherScore(inputs.homePitcher), awayPitcher = pitcherScore(inputs.awayPitcher);
  const homeOffense = offenseScore(inputs.homeTeam.hitting), awayOffense = offenseScore(inputs.awayTeam.hitting);
  const homeStaff = pitchingStaffScore(inputs.homeTeam.pitching), awayStaff = pitchingStaffScore(inputs.awayTeam.pitching);
  const homeHandSplit = splitScore(inputs.homeSplits[inputs.awayBio.throws === 'L' ? 'vsLHP' : 'vsRHP'], homeOffense);
  const awayHandSplit = splitScore(inputs.awaySplits[inputs.homeBio.throws === 'L' ? 'vsLHP' : 'vsRHP'], awayOffense);
  const homeBullpen = bullpenScore(inputs.homeTeam.pitching, inputs.bullpen[game.home.id]);
  const awayBullpen = bullpenScore(inputs.awayTeam.pitching, inputs.bullpen[game.away.id]);
  const code = teamCode(game.home);
  const parkFactor = PARK_FACTORS[code] || 1;
  const parkAdj = (parkFactor - 1) * 12;
  const weatherAdj = weatherAdjustment(inputs.weather);

  const homeRating = clamp(homePitcher * 0.30 + homeHandSplit * 0.22 + homeOffense * 0.12 + homeBullpen * 0.11 + homeStaff * 0.05 + 3.0 + parkAdj + weatherAdj + awayPitcher * -0.05 + awayBullpen * -0.03 + 14, 1, 99);
  const awayRating = clamp(awayPitcher * 0.30 + awayHandSplit * 0.22 + awayOffense * 0.12 + awayBullpen * 0.11 + awayStaff * 0.05 + homePitcher * -0.05 + homeBullpen * -0.03 + 14, 1, 99);
  const edge = Number((homeRating - awayRating).toFixed(1));
  const pickSide = edge >= 0 ? 'home' : 'away';
  const pickTeam = pickSide === 'home' ? game.home : game.away;
  const opponent = pickSide === 'home' ? game.away : game.home;
  const homeLine = bestBookLine(oddsGame, game.home.name), awayLine = bestBookLine(oddsGame, game.away.name), pickLine = pickSide === 'home' ? homeLine : awayLine;
  const modelProbRule = clamp(0.5 + Math.abs(edge) / 100, 0.5, 0.70);
  const mlHome = mlProbability({ homeWinPctDiff: (homeOffense - awayOffense) / 50, homeF5RunDiff: edge / 25, homeRecentRunDiff: (homeHandSplit - awayHandSplit) / 50, homePitchingRunDiff: (homePitcher - awayPitcher) / 50, homeParkFactor: parkFactor - 1, homeRestDiff: (awayBullpen - homeBullpen) / 50 });
  const mlPickProb = mlHome === null ? null : (pickSide === 'home' ? mlHome : 1 - mlHome);
  const blendedProb = mlPickProb === null ? modelProbRule : clamp((modelProbRule * 0.55) + (mlPickProb * 0.45), 0.5, 0.74);
  const implied = americanToImplied(pickLine?.price);
  const ev = implied ? Number(((blendedProb - implied) * 100).toFixed(1)) : null;

  return {
    gamePk: game.gamePk, gameDate: game.gameDate, status: game.status, venue: game.venue,
    home: { ...game.home, rating: Number(homeRating.toFixed(1)), pitcherStats: inputs.homePitcher, pitcherBio: inputs.homeBio, teamStats: inputs.homeTeam, splits: inputs.homeSplits, bullpen: inputs.bullpen[game.home.id], moneyline: homeLine?.price ?? null, bestBook: homeLine?.book ?? null },
    away: { ...game.away, rating: Number(awayRating.toFixed(1)), pitcherStats: inputs.awayPitcher, pitcherBio: inputs.awayBio, teamStats: inputs.awayTeam, splits: inputs.awaySplits, bullpen: inputs.bullpen[game.away.id], moneyline: awayLine?.price ?? null, bestBook: awayLine?.book ?? null },
    market: { oddsAvailable: Boolean(oddsGame), total: bestTotal(oddsGame), firstFiveNote: 'F5-specific markets require an odds provider that exposes F5 markets. This app is wired for ODDS_MARKETS overrides.' },
    factors: { parkFactor, weather: inputs.weather, injuries: inputs.injuries, umpire: inputs.umpire },
    prediction: { pick: pickTeam.name, opponent: opponent.name, edge, confidence: confidenceFromEdge(edge), label: labelFromEdge(edge), modelProbability: Number((blendedProb * 100).toFixed(1)), ruleProbability: Number((modelProbRule * 100).toFixed(1)), mlProbability: mlPickProb === null ? null : Number((mlPickProb * 100).toFixed(1)), bestMoneyline: pickLine?.price ?? null, bestBook: pickLine?.book ?? null, estimatedEV: ev, note: pickLine ? 'EV compares blended model probability against the best available full-game moneyline. Configure F5 markets if your odds provider supports them.' : 'Odds unavailable. Add ODDS_API_KEY to show moneylines and estimated value.' },
  };
}

async function getPredictions(date = todayPacific()) {
  const season = seasonFromDate(date);
  const games = await getSchedule(date);
  const odds = await getOdds().catch((error) => ({ available: false, games: [], reason: error.message }));
  const bullpen = await getBullpenUsage([...new Set(games.flatMap((g) => [g.home.id, g.away.id]))], date);
  const [injuries, umpire] = await Promise.all([optionalExternal('Injuries', process.env.INJURY_API_URL), optionalExternal('Umpires', process.env.UMPIRE_API_URL)]);

  const predictions = await Promise.all(games.map(async (game) => {
    const [homeTeam, awayTeam, homePitcher, awayPitcher, homeBio, awayBio, homeSplits, awaySplits, weather] = await Promise.all([
      getTeamStats(game.home.id, season).catch(() => ({ hitting: {}, pitching: {} })), getTeamStats(game.away.id, season).catch(() => ({ hitting: {}, pitching: {} })),
      getPitcherStats(game.home.probablePitcher?.id, season).catch(() => ({})), getPitcherStats(game.away.probablePitcher?.id, season).catch(() => ({})),
      getPitcherBio(game.home.probablePitcher?.id), getPitcherBio(game.away.probablePitcher?.id), getTeamSplits(game.home.id, season), getTeamSplits(game.away.id, season), getWeather(game.venue, game.gameDate)
    ]);
    return calculateGamePrediction(game, { homeTeam, awayTeam, homePitcher, awayPitcher, homeBio, awayBio, homeSplits, awaySplits, bullpen, weather, injuries, umpire }, findOddsGame(odds, game));
  }));
  return { date, generatedAt: new Date().toISOString(), model: loadModel(), odds: { available: odds.available, reason: odds.reason || null, markets: odds.markets || null }, dataSources: { injuries, umpire }, games: predictions.sort((a, b) => Math.abs(b.prediction.edge) - Math.abs(a.prediction.edge)) };
}

module.exports = { todayPacific, addDays, getSchedule, getPredictions, fetchJson, num, clamp, pct };
