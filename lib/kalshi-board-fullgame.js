// Full-game analogue of lib/kalshi-board.js: same schedule fetch / quote-quality / rate-limit
// pacing patterns, but against Kalshi's KXMLBGAME series (full-game moneyline) instead of
// KXMLBF5, and scored against the full-game model (lib/full-game-model.js / prediction.pick from
// lib/mlb.js) instead of the F5 model.
//
// KXMLBGAME is 2-way (HOME/AWAY only -- extra innings force a winner, no TIE contract), so there
// is no tie leg to fetch or reconcile: this file uses quoteSetQuality2 (lib/kalshi-quotes.js) and
// a simpler pickSide/confidence computation than kalshi-board.js's 3-way version. Rate-limit
// retry/backoff (getJson) and concurrency pacing (mapWithConcurrency) are shared with
// kalshi-board.js via lib/kalshi-http.js rather than reimplemented here. Event-ticker parsing
// (TEAM_MAP/parseEvent, including the doubleheader G1/G2 suffix) follows the pattern already
// proven in scripts/test-fullgame-vs-kalshi-market.js for #29.
const { selectLatestQuote, quoteSetQuality2, MAX_QUOTE_AGE_MINUTES, MAX_QUOTE_SKEW_MINUTES } = require('./kalshi-quotes');
const { getJson, mapWithConcurrency, pacificDate } = require('./kalshi-http');
const { loadFullGameModel, probability: fullGameProbability } = require('./full-game-model');
const { getLiveHistoricalContext, liveFullGameFeatureVector } = require('./historical-f5');
const { liveRollingPitcherQuality } = require('./pitcher-history');
const { PARK_FACTORS, TEAM_ABBR } = require('./config');

const BASE = 'https://external-api.kalshi.com/trade-api/v2';
const SERIES = 'KXMLBGAME';

const PLAY_THRESHOLD = 0.58;
const STRONG_THRESHOLD = 0.62;
const MAX_SPREAD = 0.15;

// Same retrospective-finding rationale as lib/kalshi-board.js's F5 marketTrust rule (see that
// file's comments and FEATURE-WISHLIST.md #18/#27/#29): requiring the trained full-game model to
// independently agree with a confident Kalshi price is tracked forward before being trusted, in
// data/kalshi-forward-fullgame/model-agreement-plan.json.
const MODEL_MIN_CONFIDENCE = 0.55;
const AGREEMENT_MAX_SPREAD = 0.05;

// Pure so it can be unit-tested without network access. Same signature/behavior as
// lib/kalshi-board.js's decideTier -- the 2-way market drops the tie leg, not the tier rule.
function decideTier({ kalshiConfidence }) {
  if (!Number.isFinite(kalshiConfidence)) return 'PASS';
  if (kalshiConfidence >= STRONG_THRESHOLD) return 'STRONG';
  if (kalshiConfidence >= PLAY_THRESHOLD) return 'PLAY';
  return 'PASS';
}

async function modelSignalForGame(game, contextByDate) {
  const context = contextByDate.get(game.scheduleDate);
  if (!context) return { available: false };
  const parkFactor = PARK_FACTORS[TEAM_ABBR[game.homeTeam]] ?? 1;
  const [homePitcherQuality, awayPitcherQuality] = await Promise.all([
    liveRollingPitcherQuality(game.homeProbablePitcherId, game.scheduleDate).catch(() => null),
    liveRollingPitcherQuality(game.awayProbablePitcherId, game.scheduleDate).catch(() => null)
  ]);
  const features = liveFullGameFeatureVector(
    { home: { id: game.homeId, name: game.homeTeam }, away: { id: game.awayId, name: game.awayTeam }, officialDate: game.scheduleDate },
    context,
    parkFactor,
    { home: homePitcherQuality, away: awayPitcherQuality }
  );
  const model = loadFullGameModel();
  const homeProbability = features ? fullGameProbability(features, model) : null;
  if (homeProbability === null || homeProbability === undefined) return { available: false };
  const side = homeProbability >= 0.5 ? 'HOME' : 'AWAY';
  return { available: true, side, confidence: side === 'HOME' ? homeProbability : 1 - homeProbability };
}

const TEAM_MAP = {
  AZ: 'Arizona Diamondbacks', ATL: 'Atlanta Braves', BAL: 'Baltimore Orioles', BOS: 'Boston Red Sox',
  CHC: 'Chicago Cubs', CWS: 'Chicago White Sox', CIN: 'Cincinnati Reds', CLE: 'Cleveland Guardians',
  COL: 'Colorado Rockies', DET: 'Detroit Tigers', HOU: 'Houston Astros', KC: 'Kansas City Royals',
  LAA: 'Los Angeles Angels', LAD: 'Los Angeles Dodgers', MIA: 'Miami Marlins', MIL: 'Milwaukee Brewers',
  MIN: 'Minnesota Twins', NYM: 'New York Mets', NYY: 'New York Yankees', ATH: 'Athletics', OAK: 'Athletics',
  PHI: 'Philadelphia Phillies', PIT: 'Pittsburgh Pirates', SD: 'San Diego Padres', SEA: 'Seattle Mariners',
  SF: 'San Francisco Giants', STL: 'St. Louis Cardinals', TB: 'Tampa Bay Rays', TEX: 'Texas Rangers',
  TOR: 'Toronto Blue Jays', WSH: 'Washington Nationals'
};
const MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
const ALIASES = Object.keys(TEAM_MAP).sort((a, b) => b.length - a.length);

function normTeam(value) {
  let x = String(value || '').toLowerCase().replace(/[.,'’\-]/g, '').replace(/\s+/g, ' ').trim();
  if (x === 'oakland athletics') x = 'athletics';
  return x;
}

// KXMLBGAME event tickers can carry a trailing G1/G2 doubleheader suffix that KXMLBF5's do not.
function parseEvent(eventTicker) {
  const tail = String(eventTicker || '').split('-').pop().replace(/G\d$/, '');
  const m = tail.match(/^(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})([A-Z]+)$/);
  if (!m) return null;
  const [, yy, mon, dd, hh, mm, blob] = m;
  let awayCode = null, homeCode = null;
  for (const away of ALIASES) {
    if (!blob.startsWith(away)) continue;
    const home = blob.slice(away.length);
    if (TEAM_MAP[home]) { awayCode = away; homeCode = home; break; }
  }
  if (!awayCode || !homeCode || !MONTHS[mon]) return null;
  return { date: `20${yy}-${MONTHS[mon]}-${dd}`, awayCode, homeCode, awayTeam: TEAM_MAP[awayCode], homeTeam: TEAM_MAP[homeCode], eventHour: hh, eventMinute: mm };
}

async function getSchedule(date) {
  const url = 'https://statsapi.mlb.com/api/v1/schedule' + `?sportId=1&date=${encodeURIComponent(date)}&hydrate=probablePitcher`;
  const data = await getJson(url);
  const rows = [];
  for (const dateBlock of data.dates || []) {
    for (const g of dateBlock.games || []) {
      const away = g?.teams?.away?.team?.name;
      const home = g?.teams?.home?.team?.name;
      rows.push({
        gamePk: g.gamePk,
        homeId: g.teams?.home?.team?.id, awayId: g.teams?.away?.team?.id,
        awayTeam: away, homeTeam: home,
        awayNorm: normTeam(away), homeNorm: normTeam(home),
        scheduleDate: date,
        firstPitchUtc: g.gameDate,
        status: g?.status?.detailedState || null,
        homeProbablePitcherId: g.teams?.home?.probablePitcher?.id || null,
        awayProbablePitcherId: g.teams?.away?.probablePitcher?.id || null
      });
    }
  }
  return rows;
}

async function getLiveMarkets() {
  const markets = [];
  let cursor = null;
  while (true) {
    const params = new URLSearchParams({ series_ticker: SERIES, limit: '1000' });
    if (cursor) params.set('cursor', cursor);
    const data = await getJson(`${BASE}/markets?${params.toString()}`);
    markets.push(...(data.markets || []));
    cursor = data.cursor;
    if (!cursor) break;
  }
  const byTicker = new Map();
  for (const m of markets) if (m?.ticker) byTicker.set(m.ticker, m);
  return [...byTicker.values()];
}

async function latestQuote(ticker, firstPitchUtc, now) {
  const firstPitch = new Date(firstPitchUtc);
  if (now >= firstPitch) return { quote: null, reason: 'Game is not upcoming' };
  const cutoff = new Date(Math.min(now.getTime(), firstPitch.getTime() - 1000));
  const start = new Date(cutoff.getTime() - 6 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    start_ts: String(Math.floor(start.getTime() / 1000)),
    end_ts: String(Math.floor(cutoff.getTime() / 1000)),
    period_interval: '1'
  });
  const url = `${BASE}/series/${SERIES}/markets/${encodeURIComponent(ticker)}/candlesticks?${params.toString()}`;
  let data;
  try {
    data = await getJson(url);
  } catch (error) {
    return { quote: null, reason: `Quote request failed: ${error.message}` };
  }
  return selectLatestQuote(data.candlesticks, firstPitchUtc, now, MAX_SPREAD);
}

async function getKalshiFullGameBoard({ maxMinutesToPitch = Infinity } = {}) {
  const now = new Date();
  const today = pacificDate(0);
  const tomorrow = pacificDate(1);

  const [todaySchedule, tomorrowSchedule, markets, todayContext, tomorrowContext] = await Promise.all([
    getSchedule(today),
    getSchedule(tomorrow),
    getLiveMarkets(),
    getLiveHistoricalContext(today).catch(() => null),
    getLiveHistoricalContext(tomorrow).catch(() => null)
  ]);

  const contextByDate = new Map([[today, todayContext], [tomorrow, tomorrowContext]]);
  const schedule = [...todaySchedule, ...tomorrowSchedule];

  const byEvent = new Map();
  for (const m of markets) {
    const e = m?.event_ticker;
    if (!e) continue;
    if (!byEvent.has(e)) byEvent.set(e, []);
    byEvent.get(e).push(m);
  }

  const candidates = [];
  const rejected = [];

  for (const [eventTicker, eventMarkets] of byEvent) {
    if (eventMarkets.length < 2) continue;
    const parsed = parseEvent(eventTicker);
    if (!parsed) continue;
    if (parsed.date !== today && parsed.date !== tomorrow) continue;

    const matches = schedule.filter(
      (g) => g.awayNorm === normTeam(parsed.awayTeam) && g.homeNorm === normTeam(parsed.homeTeam) && g.scheduleDate === parsed.date
    );
    if (matches.length !== 1) { rejected.push({ eventTicker, reason: 'Missing or ambiguous MLB schedule match' }); continue; }

    const game = matches[0];
    const firstPitch = new Date(game.firstPitchUtc);
    if (now >= firstPitch || !/^(Scheduled|Pre-Game)$/i.test(game.status || '')) continue;
    if ((firstPitch - now) / 60000 > maxMinutesToPitch) continue;

    const marketByOutcome = {};
    for (const m of eventMarkets) {
      const suffix = String(m.ticker || '').split('-').pop();
      if (suffix === parsed.awayCode) marketByOutcome.AWAY = m;
      else if (suffix === parsed.homeCode) marketByOutcome.HOME = m;
    }
    if (!marketByOutcome.AWAY || !marketByOutcome.HOME) continue;
    if (Object.values(marketByOutcome).some((m) => m.status !== 'active')) { rejected.push({ eventTicker, reason: 'Market is not active' }); continue; }

    candidates.push({ eventTicker, parsed, game, markets: marketByOutcome });
  }

  const rows = await mapWithConcurrency(candidates, 2, async (item) => {
    const { eventTicker, parsed, game, markets } = item;

    const results = await Promise.all([
      latestQuote(markets.AWAY.ticker, game.firstPitchUtc, now),
      latestQuote(markets.HOME.ticker, game.firstPitchUtc, now)
    ]);

    if (results.some((r) => !r.quote)) { rejected.push({ eventTicker, reason: results.filter((r) => !r.quote).map((r) => r.reason).join('; ') }); return null; }
    const [awayQ, homeQ] = results.map((r) => r.quote);
    const quality = quoteSetQuality2([awayQ, homeQ], new Date());
    if (!quality.available) { rejected.push({ eventTicker, reason: quality.reason }); return null; }
    if (Date.now() >= Date.parse(game.firstPitchUtc)) return null;

    const away = awayQ.mid, home = homeQ.mid;
    const sum = away + home;
    if (!(sum > 0)) return null;

    const awayProb = away / sum;
    const homeProb = home / sum;

    let pickSide, pickTeam, confidence;
    if (homeProb >= awayProb) { pickSide = 'HOME'; pickTeam = parsed.homeTeam; confidence = homeProb; }
    else { pickSide = 'AWAY'; pickTeam = parsed.awayTeam; confidence = awayProb; }

    const modelSignal = await modelSignalForGame(game, contextByDate);
    const modelAgreesWithKalshi = modelSignal.available ? modelSignal.side === pickSide : null;
    const maxSpread = Math.max(awayQ.spread, homeQ.spread);

    const tier = decideTier({ kalshiConfidence: confidence });

    return {
      gamePk: game.gamePk,
      officialDate: game.scheduleDate, homeId: game.homeId, awayId: game.awayId,
      outcomeQuotes: { away: awayQ, home: homeQ },
      marketTickers: { away: markets.AWAY.ticker, home: markets.HOME.ticker },
      eventTicker,

      awayTeam: parsed.awayTeam,
      homeTeam: parsed.homeTeam,

      firstPitchUtc: game.firstPitchUtc,
      minutesToPitch: (new Date(game.firstPitchUtc) - now) / 60000,

      kalshiAwayRaw: away,
      kalshiHomeRaw: home,
      kalshiRawSum: sum,

      kalshiAwayProb: awayProb,
      kalshiHomeProb: homeProb,

      kalshiPickSide: pickSide,
      kalshiPickTeam: pickTeam,
      kalshiConfidence: confidence,

      modelAvailable: modelSignal.available,
      modelPickSide: modelSignal.available ? modelSignal.side : null,
      modelConfidence: modelSignal.available ? modelSignal.confidence : null,
      modelAgreesWithKalshi,

      tier,

      quoteTime: quality.quoteTime,
      quoteAgeMinutes: quality.quoteAgeMinutes,

      awaySpread: awayQ.spread,
      homeSpread: homeQ.spread,

      quoteSkewMinutes: quality.quoteSkewMinutes,
      outcomeQuoteTimes: { away: awayQ.time, home: homeQ.time },
      marketStatus: 'active',
      gameStatus: game.status
    };
  });

  const board = rows.filter(Boolean);

  const rank = { STRONG: 0, PLAY: 1, PASS: 2 };
  board.sort((a, b) => {
    if (rank[a.tier] !== rank[b.tier]) return rank[a.tier] - rank[b.tier];
    if (b.kalshiConfidence !== a.kalshiConfidence) return b.kalshiConfidence - a.kalshiConfidence;
    return new Date(a.firstPitchUtc) - new Date(b.firstPitchUtc);
  });

  return {
    ok: true,
    version: 'Kalshi Full-Game V1',
    generatedAt: now.toISOString(),
    thresholds: {
      play: PLAY_THRESHOLD,
      strong: STRONG_THRESHOLD,
      maxSpread: MAX_SPREAD,
      maxQuoteAgeMinutes: MAX_QUOTE_AGE_MINUTES,
      maxQuoteSkewMinutes: MAX_QUOTE_SKEW_MINUTES,
      modelMinConfidence: MODEL_MIN_CONFIDENCE,
      agreementMaxSpread: AGREEMENT_MAX_SPREAD
    },
    methodologyNote: 'Full-game analogue of the F5 V5 board: selects all 58%+ Kalshi favorites on KXMLBGAME, with 62%+ labeled STRONG. No TIE contract (2-way market). Model agreement is diagnostic only and never removes a selection.',
    marketsLoaded: markets.length,
    candidateEvents: candidates.length,
    rejected,
    board
  };
}

module.exports = { getKalshiFullGameBoard, parseEvent, normTeam, getLiveMarkets, decideTier, MODEL_MIN_CONFIDENCE, AGREEMENT_MAX_SPREAD, PLAY_THRESHOLD, STRONG_THRESHOLD };
