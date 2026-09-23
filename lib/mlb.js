const fs = require('fs');
const path = require('path');
const { TEAM_ABBR, PARK_FACTORS, VENUES } = require('./config');
const { getTeamRankingsF5 } = require('./teamrankings-f5');
const { getLiveHistoricalContext, liveFeatureVector, liveFullGameFeatureVector, liveFullGameSimulationInputs } = require('./historical-f5');
const { liveRollingPitcherQuality } = require('./pitcher-history');
const { loadFullGameModel, forecast: fullGameForecast } = require('./full-game-model');
const { forecast: fullGameMonteCarloForecast } = require('./full-game-monte-carlo');
const { forecastV2: fullGameMonteCarloV2Forecast } = require('./full-game-monte-carlo');
const { getLiveBullpens } = require('./live-bullpen-quality');

const MLB_BASE = 'https://statsapi.mlb.com/api/v1';
const SGO_BASE = 'https://api.sportsgameodds.com/v2';
const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';

const cache = new Map();
const CACHE_MS = 1000 * 60 * 5;

// Bumped from f5-history-v2-unique-prior-day when starting-pitcher rolling WHIP/FIP were
// added to the feature set (see lib/pitcher-history.js) -- a model.json/backtest-results.json
// pair from the old 6-feature pipeline must never be read as if it had the new 8-feature
// shape, so this gate is intentionally strict equality, not a prefix or "at least v2" check.
const PIPELINE_VERSION = 'f5-history-v3-pitcher-quality';
// Provenance for the LIVE actionable pick returned by getPredictions()/calculateGamePrediction(),
// distinct from PIPELINE_VERSION above (which only gates the F5 model.json artifact itself).
// Bumped because the actionable prediction.pick/confidence switched from F5-only to full-game-primary
// (see FEATURE-WISHLIST.md #26) -- a downstream consumer keying off this string can tell whether a
// captured prediction predates that switch instead of silently mixing F5-only and full-game-primary picks.
// This does NOT change data/model-forward/ forward tracking: that harness (lib/model-forward.js) calls
// mlProbability(features, model) directly against data/model.json and never reads calculateGamePrediction's
// `prediction` object, so it is untouched and keeps tracking the F5 model exactly as before; old
// picks-*.json/grades-*.json records grade under the same logic they always have.
const PICK_PIPELINE_VERSION = 'full-game-primary-v1';
// Margin (percentage points) by which F5's confidence edge (distance from 50%) must exceed the
// full-game model's edge before F5 is flagged as a possibly-better opportunity alongside the primary
// full-game pick. Chosen to match the existing tier-gap convention in this codebase rather than
// inventing a new number: lib/kalshi-board.js's decideTier() separates STRONG (>=62%) from PLAY
// (>=58%) by exactly 4 percentage points (STRONG_THRESHOLD - PLAY_THRESHOLD = 0.62 - 0.58 = 0.04),
// i.e. a 4pp confidence gap is this codebase's established threshold for "meaningfully stronger."
const F5_FLAG_MARGIN_PP = 4;

const F5_DECISION_RULES = {
  leanMinConfidence: Number(process.env.F5_LEAN_MIN_CONFIDENCE || 55),
  playMinConfidence: Number(process.env.F5_PLAY_MIN_CONFIDENCE || 60),
  strongMinConfidence: Number(process.env.F5_STRONG_MIN_CONFIDENCE || 65),
  minEstimatedEV: Number(process.env.F5_MIN_EV || 3),
  requireModelAgreement: String(process.env.F5_REQUIRE_MODEL_AGREEMENT || 'true').toLowerCase() !== 'false'
};

function historicalResults() {
  try {
    const results = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'backtest-results.json'), 'utf8'));
    return results.pipelineVersion === PIPELINE_VERSION ? results : null;
  } catch { return null; }
}


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

const SGO_BOOK_NAMES = {
  draftkings: 'DraftKings',
  fanduel: 'FanDuel',
  betmgm: 'BetMGM',
  caesars: 'Caesars',
  espnbet: 'ESPN BET',
  fanatics: 'Fanatics',
  bet365: 'bet365',
  pinnacle: 'Pinnacle',
  bovada: 'Bovada'
};

const SGO_F5_MARKETS = [
  {
    period: '1h',
    away: 'points-away-1h-ml-away',
    home: 'points-home-1h-ml-home',
    totalOver: 'points-all-1h-ou-over',
    totalUnder: 'points-all-1h-ou-under'
  },
  {
    period: '1ix5',
    away: 'points-away-1ix5-ml-away',
    home: 'points-home-1ix5-ml-home',
    totalOver: 'points-all-1ix5-ou-over',
    totalUnder: 'points-all-1ix5-ou-under'
  }
];

function sgoTeamName(event, side) {
  const team = event?.teams?.[side] || {};
  const names = team.names || {};
  return names.long || names.medium || names.short || team.name || null;
}

function sgoBookPrice(market, bookKey) {
  const row = market?.byBookmaker?.[bookKey];
  if (!row || row.available === false) return null;

  const price = optionalNumber(row.odds);
  return Number.isFinite(price) ? price : null;
}

function sgoToLegacyOddsGame(event) {
  const homeTeam = sgoTeamName(event, 'home');
  const awayTeam = sgoTeamName(event, 'away');

  if (!homeTeam || !awayTeam) return null;

  const rawOdds = event?.odds || {};
  let selected = null;

  // Prefer the newer 1h baseball period, but fall back to legacy 1ix5.
  for (const config of SGO_F5_MARKETS) {
    const awayMarket = rawOdds[config.away];
    const homeMarket = rawOdds[config.home];
    const overMarket = rawOdds[config.totalOver];
    const underMarket = rawOdds[config.totalUnder];

    if ((awayMarket && homeMarket) || (overMarket && underMarket)) {
      selected = {
        ...config,
        awayMarket,
        homeMarket,
        overMarket,
        underMarket
      };
      break;
    }
  }

  if (!selected) {
    return {
      id: event.eventID || event.id || null,
      home_team: homeTeam,
      away_team: awayTeam,
      commence_time: event?.status?.startsAt || event.startTime || event.startsAt || null,
      bookmakers: [],
      sgo_period: null
    };
  }

  const allBookKeys = new Set();

  for (const market of [
    selected.awayMarket,
    selected.homeMarket,
    selected.overMarket,
    selected.underMarket
  ]) {
    for (const key of Object.keys(market?.byBookmaker || {})) {
      allBookKeys.add(key);
    }
  }

  const bookmakers = [];

  for (const bookKey of allBookKeys) {
    const markets = [];

    // F5 moneyline
    const awayPrice = sgoBookPrice(selected.awayMarket, bookKey);
    const homePrice = sgoBookPrice(selected.homeMarket, bookKey);

    if (Number.isFinite(awayPrice) && Number.isFinite(homePrice)) {
      const outcomes = [
        { name: awayTeam, price: awayPrice },
        { name: homeTeam, price: homePrice }
      ];

      // Native F5 key plus compatibility alias for older dashboard code.
      markets.push({ key: 'h2h_1st_5_innings', outcomes });
      markets.push({ key: 'h2h', outcomes });
    }

    // F5 total
    const overRow = selected.overMarket?.byBookmaker?.[bookKey];
    const underRow = selected.underMarket?.byBookmaker?.[bookKey];

    const overPrice =
      overRow && overRow.available !== false ? optionalNumber(overRow.odds) : null;
    const underPrice =
      underRow && underRow.available !== false ? optionalNumber(underRow.odds) : null;

    const overPoint =
      overRow && overRow.available !== false ? optionalNumber(overRow.overUnder) : null;
    const underPoint =
      underRow && underRow.available !== false ? optionalNumber(underRow.overUnder) : null;

    if (
      Number.isFinite(overPrice) &&
      Number.isFinite(underPrice) &&
      Number.isFinite(overPoint) &&
      Number.isFinite(underPoint) &&
      Math.abs(overPoint - underPoint) < 0.001
    ) {
      // A line must actually be offered by the bookmaker on both sides.
      const point = overPoint;

      const totalOutcomes = [
        { name: 'Over', price: overPrice, point },
        { name: 'Under', price: underPrice, point }
      ];

      // Native F5 key plus compatibility alias used by market.total.
      markets.push({
        key: 'totals_1st_5_innings',
        outcomes: totalOutcomes
      });
      markets.push({
        key: 'totals',
        outcomes: totalOutcomes
      });
    }

    if (markets.length) {
      bookmakers.push({
        key: bookKey,
        title: SGO_BOOK_NAMES[bookKey] || bookKey,
        markets
      });
    }
  }

  // Consensus fallbacks if no individual bookmaker is currently available.
  if (!bookmakers.length) {
    const fallbackMarkets = [];

    const awayConsensus = optionalNumber(selected.awayMarket?.bookOdds);
    const homeConsensus = optionalNumber(selected.homeMarket?.bookOdds);

    if (Number.isFinite(awayConsensus) && Number.isFinite(homeConsensus)) {
      const outcomes = [
        { name: awayTeam, price: awayConsensus },
        { name: homeTeam, price: homeConsensus }
      ];
      fallbackMarkets.push({ key: 'h2h_1st_5_innings', outcomes });
      fallbackMarkets.push({ key: 'h2h', outcomes });
    }

    const overConsensus = optionalNumber(selected.overMarket?.bookOdds);
    const underConsensus = optionalNumber(selected.underMarket?.bookOdds);
    const totalConsensus = optionalNumber(
      selected.overMarket?.bookOverUnder ??
      selected.underMarket?.bookOverUnder
    );

    if (
      Number.isFinite(overConsensus) &&
      Number.isFinite(underConsensus) &&
      Number.isFinite(totalConsensus)
    ) {
      const outcomes = [
        { name: 'Over', price: overConsensus, point: totalConsensus },
        { name: 'Under', price: underConsensus, point: totalConsensus }
      ];
      fallbackMarkets.push({
        key: 'totals_1st_5_innings',
        outcomes
      });
      fallbackMarkets.push({
        key: 'totals',
        outcomes
      });
    }

    if (fallbackMarkets.length) {
      bookmakers.push({
        key: 'sportsgameodds',
        title: 'SportsGameOdds Consensus',
        markets: fallbackMarkets
      });
    }
  }

  return {
    id: event.eventID || event.id || null,
    home_team: homeTeam,
    away_team: awayTeam,
    commence_time: event?.status?.startsAt || event.startTime || event.startsAt || null,
    bookmakers,
    sgo_period: selected.period
  };
}

async function getOdds() {
  const apiKey = process.env.SGO_API_KEY;

  if (!apiKey) {
    return {
      available: false,
      games: [],
      reason: 'SGO_API_KEY is not set'
    };
  }

  const oddIDs = SGO_F5_MARKETS
    .flatMap((market) => [market.away, market.home, market.totalOver, market.totalUnder])
    .join(',');

  const params = new URLSearchParams({
    leagueID: 'MLB',
    type: 'match',
    oddsAvailable: 'true',
    started: 'false',
    oddID: oddIDs,
    limit: '100'
  });

  const url = `${SGO_BASE}/events?${params.toString()}`;
  const cacheKey = `sgo:${url}`;
  const hit = cache.get(cacheKey);

  if (hit && Date.now() - hit.time < 1000 * 60 * 5) {
    return hit.data;
  }

  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'x-api-key': apiKey,
      'user-agent': 'mlb-f5-predictor/4.0'
    }
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SportsGameOdds request failed ${res.status}: ${body.slice(0, 240)}`);
  }

  const payload = await res.json();

  if (payload?.success === false) {
    throw new Error(`SportsGameOdds request failed: ${JSON.stringify(payload.error || payload).slice(0, 240)}`);
  }

  const games = (payload?.data || [])
    .map((event) => { const game = sgoToLegacyOddsGame(event); return game ? { ...game, sourceObservedAt: new Date().toISOString(), sourceStatus: event.status || null, sourceOdds: event.odds || null } : null; })
    .filter(Boolean);

  const result = {
    available: games.some((game) => (game.bookmakers || []).length > 0),
    games,
    markets: 'h2h_1st_5_innings',
    provider: 'SportsGameOdds',
    reason: games.length ? null : 'No upcoming MLB events returned by SportsGameOdds'
  };

  cache.set(cacheKey, { time: Date.now(), data: result });
  return result;
}

async function getF5OddsForEvent(oddsGame) {
  if (!process.env.SGO_API_KEY) {
    return {
      available: false,
      game: null,
      reason: 'SGO_API_KEY is not set'
    };
  }

  if (String(process.env.ODDS_F5_ENABLED || 'true').toLowerCase() === 'false') {
    return {
      available: false,
      game: null,
      reason: 'ODDS_F5_ENABLED=false'
    };
  }

  if (!oddsGame) {
    return {
      available: false,
      game: null,
      reason: 'SportsGameOdds event unavailable'
    };
  }

  const hasF5 = marketOutcomes(oddsGame, 'h2h_1st_5_innings').length > 0;

  return {
    available: hasF5,
    game: hasF5 ? oddsGame : null,
    markets: 'h2h_1st_5_innings',
    provider: 'SportsGameOdds',
    period: oddsGame.sgo_period || null,
    reason: hasF5 ? null : 'F5 moneyline is not currently available for this game'
  };
}

function marketOutcomes(oddsGame, key) { return (oddsGame?.bookmakers || []).flatMap((book) => (book.markets || []).filter((m) => m.key === key).map((m) => ({ book: book.title, outcomes: m.outcomes || [] }))); }
function bestBookLine(oddsGame, teamName, market = 'h2h') { const prices = marketOutcomes(oddsGame, market).flatMap((m) => m.outcomes.filter((o) => normalizeName(o.name) === normalizeName(teamName)).map((o) => ({ book: m.book, price: Number(o.price), point: o.point }))).filter((x) => Number.isFinite(x.price)); if (!prices.length) return null; return prices.sort((a, b) => b.price - a.price)[0]; }
function bestTotalForMarket(oddsGame, market = 'totals') { const totals = marketOutcomes(oddsGame, market).flatMap((m) => m.outcomes.map((o) => ({ book: m.book, name: o.name, price: Number(o.price), point: Number(o.point) }))).filter((x) => Number.isFinite(x.point)); if (!totals.length) return null; totals.sort((a, b) => a.point - b.point); return totals[Math.floor(totals.length / 2)]; }
function bestTotal(oddsGame) { return bestTotalForMarket(oddsGame, 'totals_1st_5_innings') || bestTotalForMarket(oddsGame, 'totals'); }
function findOddsGame(oddsPayload, game) {
  if (!oddsPayload?.available) return null;
  const start = Date.parse(game.gameDate);
  if (!Number.isFinite(start)) return null;
  // Exact scheduled instants deliberately fail closed on provider disagreement.
  const matches = oddsPayload.games.filter((o) =>
    normalizeName(o.home_team) === normalizeName(game.home.name) &&
    normalizeName(o.away_team) === normalizeName(game.away.name) &&
    Date.parse(o.commence_time) === start);
  return matches.length === 1 ? matches[0] : null;
}
function optionalNumber(value) {
  if (value == null || String(value).trim() === '') return NaN;
  return Number(value);
}

function americanToImplied(line) { const n = Number(line); if (!Number.isFinite(n) || n === 0) return null; return n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100); }
function americanNetProfit(line) { const n = Number(line); if (!Number.isFinite(n) || n === 0) return null; return n > 0 ? n / 100 : 100 / Math.abs(n); }
function expectedValuePct(probability, line) { const profit = americanNetProfit(line); if (!Number.isFinite(probability) || profit == null) return null; return Number(((probability * profit - (1 - probability)) * 100).toFixed(1)); }

function offenseScore(hitting = {}) { const ops = num(hitting.ops, 0.700), avg = num(hitting.avg, 0.245), obp = num(hitting.obp, 0.315), slg = num(hitting.slg, 0.395); const rpg = num(hitting.runs, 650) / Math.max(num(hitting.gamesPlayed, 162), 1); return clamp(50 + (ops - 0.700) * 130 + (avg - 0.245) * 70 + (obp - 0.315) * 90 + (slg - 0.395) * 80 + (rpg - 4.4) * 4, 20, 85); }
function splitScore(splits = {}, fallback = 50) { if (!splits || !Object.keys(splits).length) return fallback; return offenseScore(splits); }
function pitcherScore(p = {}) { const era = num(p.era, 4.25), whip = num(p.whip, 1.30), so9 = num(p.strikeoutsPer9Inn, 8.2), bb9 = num(p.walksPer9Inn, 3.2), ip = num(p.inningsPitched, 0); const samplePenalty = ip > 0 && ip < 25 ? (25 - ip) * 0.35 : 0; return clamp(50 + (4.25 - era) * 5.2 + (1.30 - whip) * 20 + (so9 - 8.2) * 1.6 + (3.2 - bb9) * 2.8 - samplePenalty, 20, 90); }
function pitchingStaffScore(p = {}) { return clamp(50 + (4.25 - num(p.era, 4.25)) * 4 + (1.30 - num(p.whip, 1.30)) * 16, 25, 80); }
function historicalBucketForConfidence(confidence) {
  const c = optionalNumber(confidence);
  if (!Number.isFinite(c)) return null;
  return (historicalResults()?.byConfidence || []).slice().sort((a, b) => parseFloat(b.label) - parseFloat(a.label)).find((bucket) => c >= parseFloat(bucket.label)) || null;
}

function gameHasStarted(status) {
  return /in progress|live|final|game over|completed/i.test(String(status || ''));
}

function classifyF5Decision({ confidence, estimatedEV, f5Line, status, modelAgreement = true } = {}) {
  const c = optionalNumber(confidence);
  const ev = optionalNumber(estimatedEV);
  const bucket = historicalBucketForConfidence(c);
  const base = {
    confidence: Number.isFinite(c) ? Number(c.toFixed(1)) : null,
    historicalBucket: bucket?.label || null,
    historicalBucketWinPct: bucket?.winPct ?? null,
    historicalBucketPicks: bucket?.picks ?? null,
    minimumEV: F5_DECISION_RULES.minEstimatedEV,
    modelAgreement: Boolean(modelAgreement),
    playable: false
  };

  if (!Number.isFinite(c)) {
    return { ...base, action: 'PASS', reason: 'Historical ML confidence is unavailable.' };
  }
  if (c < F5_DECISION_RULES.leanMinConfidence) {
    return { ...base, action: 'PASS', reason: `Historical ML confidence ${c.toFixed(1)}% is below the ${F5_DECISION_RULES.leanMinConfidence}% lean threshold.` };
  }
  if (F5_DECISION_RULES.requireModelAgreement && !modelAgreement) {
    return { ...base, action: 'NO BET', reason: 'The historical ML model and the live rule model disagree on the side.' };
  }
  if (c < F5_DECISION_RULES.playMinConfidence) {
    return { ...base, action: 'LEAN', reason: `Historical ML confidence is ${c.toFixed(1)}%; the backtest-based PLAY threshold is ${F5_DECISION_RULES.playMinConfidence}%.` };
  }
  if (gameHasStarted(status)) {
    return { ...base, action: 'NO BET', reason: 'Game has already started or is final; the decision system is pregame-only.' };
  }
  if (!f5Line || !Number.isFinite(Number(f5Line.price)) || !Number.isFinite(ev)) {
    return { ...base, action: 'NO BET', reason: 'True F5 moneyline/EV is unavailable, so the price cannot be validated.' };
  }
  if (ev < F5_DECISION_RULES.minEstimatedEV) {
    return { ...base, action: 'NO BET', reason: `Estimated F5 EV ${ev.toFixed(1)}% is below the required +${F5_DECISION_RULES.minEstimatedEV}% cushion.` };
  }

  const action = c >= F5_DECISION_RULES.strongMinConfidence ? 'STRONG PLAY' : 'PLAY';
  return {
    ...base,
    action,
    playable: true,
    reason: `${action}: historical ML confidence ${c.toFixed(1)}% with estimated true F5 EV +${ev.toFixed(1)}%.`
  };
}

function selectWeatherHourly(hourly, gameDate) {
  const target = new Date(gameDate).getTime() / 1000;
  if (!Number.isFinite(target) || !Array.isArray(hourly?.time)) return { available: false, reason: 'Forecast time unavailable' };
  let idx = -1, distance = Infinity;
  hourly.time.forEach((time, i) => { const delta = Number.isFinite(time) ? Math.abs(time - target) : Infinity; if (delta < distance) { idx = i; distance = delta; } });
  const fields = ['temperature_2m', 'wind_speed_10m', 'precipitation_probability'];
  if (idx < 0 || distance > 1800 || !fields.every((key) => Number.isFinite(hourly[key]?.[idx]))) return { available: false, reason: 'Complete forecast near first pitch unavailable' };
  return { available: true, indoor: false, forecastTime: new Date(hourly.time[idx] * 1000).toISOString(), temperature: hourly.temperature_2m[idx], windMph: hourly.wind_speed_10m[idx], precipitationProbability: hourly.precipitation_probability[idx] };
}
async function getWeather(venueName, gameDate) {
  const venue = VENUES[venueName];
  if (!venue) return { available: false, reason: 'Venue coordinates not configured' };
  if (venue.indoor) return { available: false, reason: 'Roof status is not verified' };
  const target = new Date(gameDate);
  if (!Number.isFinite(target.getTime())) return { available: false, reason: 'First pitch unavailable' };
  const start = target.toISOString().slice(0, 10);
  const url = `${OPEN_METEO_BASE}?latitude=${venue.lat}&longitude=${venue.lon}&hourly=temperature_2m,wind_speed_10m,precipitation_probability&temperature_unit=fahrenheit&wind_speed_unit=mph&timeformat=unixtime&timezone=GMT&start_date=${start}&end_date=${addDays(start, 1)}`;
  const data = await fetchJson(url, { ttl: 1000 * 60 * 30 }).catch((error) => ({ error: error.message }));
  return data.error ? { available: false, reason: data.error } : selectWeatherHourly(data.hourly, gameDate);
}

function weatherAdjustment(w) { if (!w?.available || w.indoor) return 0; let adj = 0; if (num(w.temperature, 70) >= 85) adj += 0.4; if (num(w.temperature, 70) <= 50) adj -= 0.4; if (num(w.windMph, 0) >= 15) adj += 0.3; if (num(w.precipitationProbability, 0) >= 40) adj -= 0.2; return adj; }

function inningsToDecimal(value) {
  if (value == null || !/^\d+(?:\.[012])?$/.test(String(value))) return null;
  const [whole, outs = '0'] = String(value).split('.');
  return (Number(whole) * 3 + Number(outs)) / 3;
}
async function getBullpenUsage(teamIds, date) {
  const usage = Object.fromEntries(teamIds.filter(Boolean).map((id) => [id, { available: true, relieverInnings3d: 0, games3d: 0, note: 'Prior three calendar days; innings calculated from outs.' }]));
  const fail = (u) => { u.available = false; u.relieverInnings3d = null; u.note = 'Bullpen workload unavailable: incomplete source data.'; };
  let schedule;
  try {
    schedule = await fetchJson(`${MLB_BASE}/schedule?sportId=1&startDate=${addDays(date, -3)}&endDate=${addDays(date, -1)}&hydrate=linescore`, { ttl: 1000 * 60 * 30 });
    if (!Array.isArray(schedule.dates)) throw new Error('Invalid schedule');
  } catch {
    Object.values(usage).forEach(fail);
    return usage;
  }
  const games = [...new Map(schedule.dates.flatMap((d) => d.games || []).map((g) => [g.gamePk, g])).values()]
    .filter((g) => g.status?.abstractGameState === 'Final');
  await Promise.all(games.map(async (g) => {
    const box = await fetchJson(`${MLB_BASE}/game/${g.gamePk}/boxscore`, { ttl: 86400000 }).catch(() => null);
    for (const side of ['home', 'away']) {
      const u = usage[g.teams?.[side]?.team?.id];
      if (!u || !u.available) continue;
      const pitchers = box?.teams?.[side]?.pitchers;
      if (!Array.isArray(pitchers) || !pitchers.length) { fail(u); continue; }
      const innings = pitchers.slice(1).map((pid) => inningsToDecimal(box.teams[side].players?.[`ID${pid}`]?.stats?.pitching?.inningsPitched));
      if (innings.some((v) => v === null)) { fail(u); continue; }
      u.games3d += 1;
      u.relieverInnings3d += innings.reduce((a, b) => a + b, 0);
    }
  }));
  for (const u of Object.values(usage)) if (u.available) u.relieverInnings3d = Number(u.relieverInnings3d.toFixed(2));
  return usage;
}

function bullpenScore(teamPitching, usage) { const staff = pitchingStaffScore(teamPitching); const fatigue = clamp(num(usage?.relieverInnings3d, 0) - 9, 0, 20) * 0.8; return clamp(staff - fatigue, 20, 85); }

function loadModel() { try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'model.json'), 'utf8')); } catch { return null; } }
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
function mlProbability(features, model = loadModel()) {
  // Reads the feature list model.json itself declares, rather than a hardcoded duplicate --
  // otherwise a future feature-set change here silently has no effect until this copy is
  // remembered too. train-history.js writes featureNames to match FEATURE_NAMES exactly.
  const names = model?.featureNames;
  if (features) features = {...features};
  for (const key of ['homePitcherWhipDiff','homePitcherFipDiff']) {
    if (features && features[key] === null) features[key] = 0; // Training uses neutral pitcher DIFFERENCE when history is absent; not a fabricated pitcher stat.
  }
  if (!Array.isArray(names) || !names.length || model?.pipelineVersion !== PIPELINE_VERSION || !features || !Number.isFinite(model.weights?.bias)) return null;
  if (!names.every((name) => Number.isFinite(features[name]) && Number.isFinite(model.weights[name]) && Number.isFinite(model.featureMeans?.[name]) && Number.isFinite(model.featureScales?.[name]) && model.featureScales[name] > 0)) return null;
  const z = names.reduce((sum, name) => sum + model.weights[name] * (features[name] - model.featureMeans[name]) / model.featureScales[name], model.weights.bias);
  const result = sigmoid(z);
  return Number.isFinite(result) && result > 0 && result < 1 ? result : null;
}

async function optionalExternal(name, url) { if (!url) return { available: false, reason: `${name} URL not configured` }; return fetchJson(url, { ttl: 1000 * 60 * 30 }).then((data) => ({ available: true, data })).catch((error) => ({ available: false, reason: error.message })); }

// Once a game is no longer eligible for a live forecast (started or finished), fall back to
// whatever pick was actually recorded pregame by the forward-tracking system in
// lib/model-forward.js (data/model-forward/picks-<date>.json, written before first pitch) plus
// its graded outcome (data/model-forward/grades-<date>.json), if grading has run. Missing files
// are the normal case (future dates, dates before tracking started) -- never an error.
function readJsonSafe(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function getRecordedPickAndResult(gamePk, date) {
  if (!gamePk || !date) return { recordedPick: null, recordedResult: null };
  const dir = path.join(process.cwd(), 'data', 'model-forward');
  const picks = readJsonSafe(path.join(dir, `picks-${date}.json`));
  const pick = Array.isArray(picks?.picks) ? picks.picks.find((p) => p.gamePk === gamePk && p.available) : null;
  if (!pick) return { recordedPick: null, recordedResult: null };
  const recordedPick = { pick: pick.pickTeam ?? null, side: pick.pickSide ?? null,
    confidence: Number.isFinite(pick.confidence) ? Number((pick.confidence * 100).toFixed(1)) : null,
    capturedAt: pick.capturedAt || pick.filledAt || null, modelVersion: pick.model?.version ?? null };
  const grades = readJsonSafe(path.join(dir, `grades-${date}.json`));
  const grade = Array.isArray(grades?.results) ? grades.results.find((r) => r.gamePk === gamePk) : null;
  const recordedResult = grade && grade.status === 'graded' ? { result: grade.result, win: grade.win, tie: grade.tie } : null;
  return { recordedPick, recordedResult };
}

function calculateGamePrediction(game, inputs, oddsGame, f5OddsPayload) {
  const model = loadModel();
  const homeProbability = mlProbability(inputs.historicalFeatures, model);
  const eligible = ['Scheduled', 'Pre-Game'].includes(game.status) && new Date(game.gameDate).getTime() > Date.now();
  const available = homeProbability !== null && eligible;
  const { recordedPick, recordedResult } = eligible ? { recordedPick: null, recordedResult: null }
    : getRecordedPickAndResult(game.gamePk, String(game.officialDate || String(game.gameDate || '').slice(0, 10)));
  const side = available ? (homeProbability >= 0.5 ? 'home' : 'away') : null;
  const probability = available ? (side === 'home' ? homeProbability : 1 - homeProbability) * 100 : null;
  const confidence = probability === null ? null : Number(probability.toFixed(1));
  const f5Game = f5OddsPayload?.available ? f5OddsPayload.game : null;
  const line = side ? bestBookLine(f5Game, game[side].name, 'h2h_1st_5_innings') : null;
  const total = bestTotalForMarket(f5Game, 'totals_1st_5_innings');
  const team = (key) => ({ ...game[key], rating: null,
    modelProbability: available ? Number(((key === 'home' ? homeProbability : 1 - homeProbability) * 100).toFixed(1)) : null,
    pitcherStats: inputs[`${key}Pitcher`], pitcherBio: inputs[`${key}Bio`], teamStats: inputs[`${key}Team`], splits: inputs[`${key}Splits`],
    bullpen: inputs.bullpen?.[game[key].id], moneyline: bestBookLine(oddsGame, game[key].name)?.price ?? null, bestBook: bestBookLine(oddsGame, game[key].name)?.book ?? null });
  const note = !eligible ? 'Pregame forecast unavailable: game is not scheduled in the future.' : !available ? 'Prediction unavailable: historical model inputs or artifact are incomplete.' : 'Historical model probability conditional on no F5 tie. Pitcher statistics, weather and market prices are context only. EV and betting recommendations are disabled pending calibration, tie treatment and executable-price validation.';
  const fullGamePrediction = fullGameForecast(game, inputs.historicalFullGameFeatures, eligible);
  const fullGameMonteCarlo = eligible ? fullGameMonteCarloForecast(game, inputs.fullGameSimulationInputs, { simulations: 10000, seed: Number(game.gamePk) }) : { available: false, pick: null, confidence: null };
  const fullGameMonteCarloV2 = eligible ? fullGameMonteCarloV2Forecast(game, inputs.fullGameSimulationInputs, { home: inputs.liveBullpens?.[game.home.id], away: inputs.liveBullpens?.[game.away.id] }, { simulations: 10000, seed: Number(game.gamePk) }) : { available: false, pick: null, confidence: null };

  // F5-specific pick/confidence, kept intact for comparison and exposed under f5Prediction so it
  // no longer overwrites the actionable prediction.pick (see PICK_PIPELINE_VERSION above).
  const f5Prediction = { available, pick: side ? game[side].name : null, opponent: side ? game[side === 'home' ? 'away' : 'home'].name : null,
    confidence, modelProbability: confidence, modelVersion: model?.version ?? null,
    probabilityBasis: 'Conditional on no F5 tie', bestMoneyline: line?.price ?? null, bestBook: line?.book ?? null, f5Total: total, note };

  // Flag F5 as a possibly-better opportunity when its confidence edge from 50% beats the full-game
  // model's edge by more than F5_FLAG_MARGIN_PP (see rationale above, precedent: kalshi-board.js
  // decideTier's 4pp STRONG/PLAY gap). Requires both signals to be available and on opposite or
  // same side alike -- this is purely an edge-size comparison, not a side-agreement filter.
  const f5Edge = available && Number.isFinite(confidence) ? Math.abs(confidence - 50) : null;
  const fgEdge = fullGamePrediction.available && Number.isFinite(fullGamePrediction.confidence) ? Math.abs(fullGamePrediction.confidence - 50) : null;
  const flaggedF5Alternative = (f5Edge !== null && fgEdge !== null && f5Edge >= fgEdge + F5_FLAG_MARGIN_PP)
    ? { pick: f5Prediction.pick, confidence: f5Prediction.confidence, edge: Number(f5Edge.toFixed(1)), fullGameEdge: Number(fgEdge.toFixed(1)), marginPp: F5_FLAG_MARGIN_PP,
        reason: `F5 confidence edge ${f5Edge.toFixed(1)}pp exceeds full-game edge ${fgEdge.toFixed(1)}pp by at least ${F5_FLAG_MARGIN_PP}pp.` }
    : null;

  const primaryAvailable = fullGamePrediction.available;
  const primaryNote = !eligible ? 'Pregame forecast unavailable: game is not scheduled in the future.' : !primaryAvailable ? 'Prediction unavailable: full-game model inputs or artifact are incomplete.' : 'Full-game historical model probability is now the primary actionable pick. F5 pick/confidence is retained under f5Prediction, and flagged as flaggedF5Alternative when its confidence edge clears the full-game edge by the documented margin. No betting or profitability claim.';

  return { ...game, home: team('home'), away: team('away'), fullGamePrediction, fullGameMonteCarlo, fullGameMonteCarloV2, f5Prediction, flaggedF5Alternative, recordedPick, recordedResult,
    market: { quoteSnapshot: f5Game ? { provider: 'SportsGameOdds', eventId: f5Game.id, homeTeam: f5Game.home_team, awayTeam: f5Game.away_team, scheduledAt: f5Game.commence_time, observedAt: f5Game.sourceObservedAt, status: f5Game.sourceStatus, rawOdds: f5Game.sourceOdds, bookmakers: f5Game.bookmakers, period: f5Game.sgo_period, settlementVerified: false, executable: false } : null, f5Total: total, f5Moneyline: line, f5OddsAvailable: Boolean(f5Game), firstFiveNote: 'SportsGameOdds snapshot; executable price freshness and settlement terms are unverified.' },
    factors: { parkFactor: Number.isFinite(inputs.historicalFeatures?.homeParkFactor) ? 1 + inputs.historicalFeatures.homeParkFactor : null, parkFactorSource: 'Fixed model assumption', weather: inputs.weather, injuries: inputs.injuries, umpire: inputs.umpire, historicalF5Features: inputs.historicalFeatures },
    prediction: { pick: primaryAvailable ? fullGamePrediction.pick : null, opponent: primaryAvailable ? fullGamePrediction.opponent : null,
      confidence: primaryAvailable ? fullGamePrediction.confidence : null, backtestConfidence: primaryAvailable ? fullGamePrediction.confidence : null,
      modelProbability: primaryAvailable ? fullGamePrediction.confidence : null, mlProbability: primaryAvailable ? fullGamePrediction.confidence : null, mlProbabilityBase: primaryAvailable ? fullGamePrediction.confidence : null,
      probabilityBasis: 'Full-game winner (primary pick)', modelVersion: fullGamePrediction.modelVersion ?? null, pipelineVersion: PICK_PIPELINE_VERSION,
      edge: null, ruleProbability: null, estimatedEV: null, playable: false, label: primaryAvailable ? 'MODEL ONLY' : 'UNAVAILABLE', action: primaryAvailable ? 'MODEL ONLY' : 'UNAVAILABLE',
      bestMoneyline: line?.price ?? null, bestBook: line?.book ?? null, f5Total: total, note: primaryNote,
      flaggedF5Alternative }
  };
}

async function getPredictions(date = todayPacific()) {
  if (date < todayPacific()) throw new Error('Historical live predictions are unavailable. Use the historical evaluation page; current stats and odds cannot replay a past date.');
  const season = seasonFromDate(date);
  const games = await getSchedule(date);
  const [odds, teamRankingsF5, historicalF5] = await Promise.all([
    getOdds().catch((error) => ({ available: false, games: [], reason: error.message })),
    getTeamRankingsF5().catch((error) => ({ available: false, rows: null, reason: error.message, source: 'https://www.teamrankings.com/mlb/stat/first-5-innings-runs-per-game' })),
    getLiveHistoricalContext(date).catch((error) => ({ available: false, states: null, reason: error.message }))
  ]);
  const bullpen = await getBullpenUsage([...new Set(games.flatMap((g) => [g.home.id, g.away.id]))], date);
  const liveBullpens = await getLiveBullpens([...new Set(games.flatMap((g) => [g.home.id, g.away.id]))], date).catch(() => null);
  const [injuries, umpire] = await Promise.all([optionalExternal('Injuries', process.env.INJURY_API_URL), optionalExternal('Umpires', process.env.UMPIRE_API_URL)]);

  const predictions = await Promise.all(games.map(async (game) => {
    const [homeTeam, awayTeam, homePitcher, awayPitcher, homeBio, awayBio, homeSplits, awaySplits, weather] = await Promise.all([
      getTeamStats(game.home.id, season).catch(() => ({ hitting: {}, pitching: {} })), getTeamStats(game.away.id, season).catch(() => ({ hitting: {}, pitching: {} })),
      getPitcherStats(game.home.probablePitcher?.id, season).catch(() => ({})), getPitcherStats(game.away.probablePitcher?.id, season).catch(() => ({})),
      getPitcherBio(game.home.probablePitcher?.id), getPitcherBio(game.away.probablePitcher?.id), getTeamSplits(game.home.id, season), getTeamSplits(game.away.id, season), getWeather(game.venue, game.gameDate)
    ]);
    const oddsGame = findOddsGame(odds, game);
    const asOfDate = String(game.officialDate || game.gameDate).slice(0, 10);
    const [homePitcherQuality, awayPitcherQuality] = await Promise.all([
      liveRollingPitcherQuality(game.home.probablePitcher?.id, asOfDate).catch(() => null),
      liveRollingPitcherQuality(game.away.probablePitcher?.id, asOfDate).catch(() => null)
    ]);
    const pitcherQuality = { home: homePitcherQuality, away: awayPitcherQuality };
    const parkFactor = PARK_FACTORS[teamCode(game.home)] || 1;
    const historicalFeatures = liveFeatureVector(game, historicalF5, parkFactor, pitcherQuality);
    const historicalFullGameFeatures = liveFullGameFeatureVector(game, historicalF5, parkFactor, pitcherQuality);
    const fullGameSimulationInputs = liveFullGameSimulationInputs(game, historicalF5, parkFactor, pitcherQuality);
    const started = gameHasStarted(game.status);
    const f5OddsPayload = started ? { available: false, game: null, reason: 'Game has already started or is final' } : await getF5OddsForEvent(oddsGame);
    return calculateGamePrediction(game, { homeTeam, awayTeam, homePitcher, awayPitcher, homeBio, awayBio, homeSplits, awaySplits, bullpen, liveBullpens, weather, injuries, umpire, teamRankingsF5, historicalFeatures, historicalFullGameFeatures, fullGameSimulationInputs }, oddsGame, f5OddsPayload);
  }));
  return {
    date,
    generatedAt: new Date().toISOString(),
    pickPipelineVersion: PICK_PIPELINE_VERSION,
    model: loadModel(),
    fullGameModel: loadFullGameModel(),
    decisionRules: {
      playable: false,
      confidenceBasis: 'Full-game historical model probability is the primary pick; F5 model probability (conditional on no F5 tie) is retained per-game as f5Prediction and flagged as flaggedF5Alternative when its edge clears the documented margin',
      evBasis: 'Disabled: calibration, tie treatment and executable prices are unvalidated',
      backtestReference: { allPicksWinPct: historicalResults()?.overall?.winPct ?? null, scope: 'Historical model only; does not establish betting profitability.' }
    },
    odds: { available: odds.available, reason: odds.reason || null, markets: odds.markets || null, f5Markets: process.env.ODDS_F5_MARKETS || 'h2h_1st_5_innings,spreads_1st_5_innings,totals_1st_5_innings' },
    dataSources: {
      injuries,
      umpire,
      historicalF5: { available: Boolean(historicalF5.available), throughDate: historicalF5.throughDate || null, games: historicalF5.games || null, reason: historicalF5.reason || null },
      liveBullpens: { available: Boolean(liveBullpens), throughDate: addDays(date, -1), source: 'MLB Stats API prior-game box scores', rosterVerified: false },
      teamRankingsF5: { available: Boolean(teamRankingsF5.available), source: teamRankingsF5.source || null, fetchedAt: teamRankingsF5.fetchedAt || null, cached: Boolean(teamRankingsF5.cached), reason: teamRankingsF5.reason || null }
    },
    games: predictions.sort((a, b) => {
      const rank = { 'STRONG PLAY': 0, 'PLAY': 1, 'LEAN': 2, 'NO BET': 3, 'PASS': 4 };
      const ra = rank[a.prediction.action] ?? 9;
      const rb = rank[b.prediction.action] ?? 9;
      if (ra !== rb) return ra - rb;
      return (b.fullGamePrediction?.confidence || 0) - (a.fullGamePrediction?.confidence || 0);
    })
  };
}

module.exports = { mlProbability, selectWeatherHourly, inningsToDecimal, getBullpenUsage, calculateGamePrediction, sgoToLegacyOddsGame, findOddsGame, todayPacific, addDays, getSchedule, getPredictions, fetchJson, num, clamp, pct, classifyF5Decision, historicalBucketForConfidence, F5_DECISION_RULES, PIPELINE_VERSION, PICK_PIPELINE_VERSION, F5_FLAG_MARGIN_PP, getRecordedPickAndResult };
