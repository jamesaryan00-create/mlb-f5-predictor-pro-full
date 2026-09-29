// Extended F5-vs-Kalshi comparison, following #18's methodology but over the FULL available
// Kalshi KXMLBF5 settled-market window (2026-07-23 onward) and joined against the PRODUCTION
// F5 model's walk-forward backtest picks (data/backtest-picks.json), NOT the v3c lineup late-
// fusion model #18 used -- because v3c's own predictions file
// (python-research/results/v3c_lineup_late_fusion_predictions.csv) is capped at 2026-09-07 (same
// date as python-research/data/f5_history.csv, which it's built from), so it cannot be extended
// without rebuilding the whole upstream feature pipeline (lineups/starters/statcast). The
// production model's backtest-picks.json extends 9 days further, through 2026-09-16, so it is
// used here instead. This is flagged explicitly in the report -- it is a different model from
// #18's, so the comparison is not a strict apples-to-apples extension of #18, just the closest
// achievable one with existing data.
//
// Read-only: GET requests to Kalshi's public market-data API and MLB's public schedule API.
// Does not modify any model/pipeline code.

const fs = require('fs');
const path = require('path');
const { selectLatestQuote, quoteSetQuality } = require('../lib/kalshi-quotes');

const BASE = 'https://external-api.kalshi.com/trade-api/v2';
const SERIES = 'KXMLBF5';
const MAX_SPREAD = 0.15;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url, { retries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'mlb-f5-vs-kalshi-extended/1.0' },
      signal: AbortSignal.timeout(15000)
    });
    if (r.status === 429 && attempt < retries) {
      const retryAfterSeconds = Number(r.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 750 * 2 ** attempt;
      await sleep(waitMs);
      continue;
    }
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${url}`);
    return r.json();
  }
}

async function mapWithConcurrency(items, limit, fn, staggerMs = 500) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      if (i > 0) await sleep(staggerMs);
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
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
  return { date: `20${yy}-${MONTHS[mon]}-${dd}`, awayCode, homeCode, awayTeam: TEAM_MAP[awayCode], homeTeam: TEAM_MAP[homeCode] };
}

async function getAllMarkets(status) {
  const markets = [];
  let cursor = null;
  while (true) {
    const params = new URLSearchParams({ series_ticker: SERIES, limit: '1000' });
    if (status) params.set('status', status);
    if (cursor) params.set('cursor', cursor);
    const data = await getJson(`${BASE}/markets?${params.toString()}`);
    markets.push(...(data.markets || []));
    cursor = data.cursor;
    if (!cursor) break;
  }
  return markets;
}

async function getSchedule(startDate, endDate) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}`;
  const data = await getJson(url);
  const rows = [];
  for (const dateBlock of data.dates || []) {
    for (const g of dateBlock.games || []) {
      if (g.gameType && g.gameType !== 'R' && g.gameType !== 'F' && g.gameType !== 'D' && g.gameType !== 'L' && g.gameType !== 'W') continue;
      const away = g?.teams?.away?.team?.name;
      const home = g?.teams?.home?.team?.name;
      rows.push({
        gamePk: g.gamePk,
        awayTeam: away,
        homeTeam: home,
        awayNorm: normTeam(away),
        homeNorm: normTeam(home),
        officialDate: g.officialDate,
        firstPitchUtc: g.gameDate,
        status: g?.status?.detailedState || null
      });
    }
  }
  return rows;
}

function logLoss3(p, outcome) {
  // outcome in {AWAY, HOME, TIE}; p = {away, home, tie}
  const v = Math.min(Math.max(p[outcome.toLowerCase()], 1e-9), 1 - 1e-9);
  return -Math.log(v);
}
function brier3(p, outcome) {
  const keys = ['away', 'home', 'tie'];
  let s = 0;
  for (const k of keys) {
    const actual = k === outcome.toLowerCase() ? 1 : 0;
    s += (p[k] - actual) ** 2;
  }
  return s;
}
function decidedAccuracy(pHomeNoTie, outcome) {
  // only called on decided (non-tie) games
  const pickedHome = pHomeNoTie >= 0.5;
  const homeWon = outcome === 'HOME';
  return pickedHome === homeWon ? 1 : 0;
}
function summarize3way(rows, probKey) {
  const n = rows.length;
  const ll = rows.reduce((s, r) => s + logLoss3(r[probKey], r.outcome), 0) / n;
  const br = rows.reduce((s, r) => s + brier3(r[probKey], r.outcome), 0) / n;
  return { n, logLoss: ll, brier: br };
}
function summarizeDecidedAccuracy(decidedRows, probKeyNoTieHome) {
  const n = decidedRows.length;
  const acc = decidedRows.reduce((s, r) => s + decidedAccuracy(r[probKeyNoTieHome], r.outcome), 0) / n;
  return { n, accuracy: acc * 100 };
}
function bootstrapLogLossGap3(rows, probKeyA, probKeyB, iterations = 10000) {
  const n = rows.length;
  const gaps = [];
  for (let i = 0; i < iterations; i++) {
    let sumA = 0, sumB = 0;
    for (let k = 0; k < n; k++) {
      const idx = Math.floor(Math.random() * n);
      const r = rows[idx];
      sumA += logLoss3(r[probKeyA], r.outcome);
      sumB += logLoss3(r[probKeyB], r.outcome);
    }
    gaps.push(sumA / n - sumB / n);
  }
  gaps.sort((a, b) => a - b);
  const lo = gaps[Math.floor(0.025 * iterations)];
  const hi = gaps[Math.floor(0.975 * iterations)];
  const mean = gaps.reduce((s, x) => s + x, 0) / iterations;
  return { mean, ci95: [lo, hi] };
}

async function main() {
  const startDate = process.argv[2] || '2026-07-23';
  const endDate = process.argv[3] || '2026-09-16';

  console.error(`Fetching settled KXMLBF5 markets...`);
  const settledMarkets = await getAllMarkets('settled');
  console.error(`Got ${settledMarkets.length} settled markets`);

  const byEvent = new Map();
  for (const m of settledMarkets) {
    if (!m?.event_ticker) continue;
    if (!byEvent.has(m.event_ticker)) byEvent.set(m.event_ticker, []);
    byEvent.get(m.event_ticker).push(m);
  }
  console.error(`${byEvent.size} unique events`);

  console.error(`Fetching MLB schedule ${startDate}..${endDate}...`);
  const schedule = await getSchedule(startDate, endDate);
  console.error(`${schedule.length} scheduled games`);

  const picksPath = path.join(__dirname, '..', 'data', 'backtest-picks.json');
  const picks = JSON.parse(fs.readFileSync(picksPath, 'utf8'));
  const picksByGamePk = new Map(picks.map((p) => [p.gamePk, p]));
  console.error(`${picks.length} production F5 model backtest picks loaded`);

  const candidates = [];
  const rejected = [];

  for (const [eventTicker, eventMarkets] of byEvent) {
    if (eventMarkets.length !== 3) { rejected.push({ eventTicker, reason: `Expected 3 markets, got ${eventMarkets.length}` }); continue; }
    const parsed = parseEvent(eventTicker);
    if (!parsed) { rejected.push({ eventTicker, reason: 'Could not parse event ticker' }); continue; }
    if (parsed.date < startDate || parsed.date > endDate) continue;

    const matches = schedule.filter(
      (g) => g.awayNorm === normTeam(parsed.awayTeam) && g.homeNorm === normTeam(parsed.homeTeam) && g.officialDate === parsed.date
    );
    if (matches.length !== 1) { rejected.push({ eventTicker, reason: `Missing or ambiguous MLB schedule match (${matches.length})` }); continue; }
    const game = matches[0];

    if (!/^(Final|Game Over|Completed Early)/i.test(game.status || '')) { rejected.push({ eventTicker, reason: `Game not final: ${game.status}` }); continue; }

    const marketByOutcome = {};
    for (const m of eventMarkets) {
      const suffix = String(m.ticker || '').split('-').pop();
      const title = String(m.title || '').toLowerCase();
      if (suffix === parsed.awayCode) marketByOutcome.AWAY = m;
      else if (suffix === parsed.homeCode) marketByOutcome.HOME = m;
      else if (suffix === 'TIE' || title.includes('tie')) marketByOutcome.TIE = m;
    }
    if (!marketByOutcome.AWAY || !marketByOutcome.HOME || !marketByOutcome.TIE) { rejected.push({ eventTicker, reason: 'Could not map AWAY/HOME/TIE markets' }); continue; }

    const pick = picksByGamePk.get(game.gamePk);
    if (!pick) { rejected.push({ eventTicker, reason: `No production-model pick for gamePk ${game.gamePk}` }); continue; }
    if (pick.homeF5 == null || pick.awayF5 == null) { rejected.push({ eventTicker, reason: 'Missing F5 runs on pick' }); continue; }

    candidates.push({ eventTicker, parsed, game, markets: marketByOutcome, pick });
  }

  console.error(`${candidates.length} candidates with schedule + model-pick match; fetching candlesticks...`);

  const rows = await mapWithConcurrency(candidates, 2, async (item) => {
    const { eventTicker, game, markets, pick } = item;
    const cutoff = Date.parse(game.firstPitchUtc) - 1000;
    const windowStart = cutoff - 6 * 60 * 60 * 1000;

    async function fetchCandle(ticker) {
      const params = new URLSearchParams({
        start_ts: String(Math.floor(windowStart / 1000)),
        end_ts: String(Math.floor(cutoff / 1000)),
        period_interval: '1'
      });
      const url = `${BASE}/series/${SERIES}/markets/${encodeURIComponent(ticker)}/candlesticks?${params}`;
      let data;
      try {
        data = await getJson(url);
      } catch (error) {
        return { quote: null, reason: `Quote request failed: ${error.message}` };
      }
      return selectLatestQuote(data.candlesticks, game.firstPitchUtc, cutoff, MAX_SPREAD);
    }

    const [awayR, homeR, tieR] = await Promise.all([
      fetchCandle(markets.AWAY.ticker),
      fetchCandle(markets.HOME.ticker),
      fetchCandle(markets.TIE.ticker)
    ]);
    if (!awayR.quote || !homeR.quote || !tieR.quote) {
      rejected.push({ eventTicker, reason: [awayR.reason, homeR.reason, tieR.reason].filter(Boolean).join('; ') });
      return null;
    }
    const quality = quoteSetQuality([awayR.quote, homeR.quote, tieR.quote], cutoff);
    if (!quality.available) { rejected.push({ eventTicker, reason: quality.reason }); return null; }

    const away = awayR.quote.mid, home = homeR.quote.mid, tie = tieR.quote.mid;
    const rawSum = away + home + tie;
    if (!(rawSum > 0)) { rejected.push({ eventTicker, reason: 'Non-positive quote sum' }); return null; }
    // Same quality bound convention as v4g's downstream analysis: keep only reasonably-calibrated
    // raw sums (not enforced by v4g itself at fetch time, but applied here as a sanity filter).
    if (rawSum < 0.85 || rawSum > 1.15) { rejected.push({ eventTicker, reason: `kalshi_raw_sum out of bounds: ${rawSum.toFixed(3)}` }); return null; }

    const kalshiProb = { away: away / rawSum, home: home / rawSum, tie: tie / rawSum };
    const ntSum = away + home;
    const kalshiHomeNoTie = home / ntSum;

    const modelHomeProb = pick.homeProbability;
    if (!Number.isFinite(modelHomeProb)) { rejected.push({ eventTicker, reason: 'Model probability missing' }); return null; }
    // Production model has no tie probability; treat it as a decided-only (2-way) model prob,
    // scaled into 3-way space by allocating zero probability mass to tie so it's scoreable
    // against the same 3-way log loss/Brier as Kalshi (matches #18's treatment of non-tie-aware
    // models: it also only had a home/away probability from the fusion model, no model tie output).
    const modelProb = { away: 1 - modelHomeProb, home: modelHomeProb, tie: 0 };

    let outcome;
    if (pick.homeF5 > pick.awayF5) outcome = 'HOME';
    else if (pick.awayF5 > pick.homeF5) outcome = 'AWAY';
    else outcome = 'TIE';

    const blendHomeNoTie = 0.5 * kalshiHomeNoTie + 0.5 * modelHomeProb;
    // Blend in 3-way space: average the two 3-way distributions (model's tie mass is 0).
    const blendProb = {
      away: 0.5 * kalshiProb.away + 0.5 * modelProb.away,
      home: 0.5 * kalshiProb.home + 0.5 * modelProb.home,
      tie: 0.5 * kalshiProb.tie + 0.5 * modelProb.tie
    };

    return {
      eventTicker,
      gamePk: game.gamePk,
      date: game.officialDate,
      awayTeam: item.parsed.awayTeam,
      homeTeam: game.homeTeam,
      firstPitchUtc: game.firstPitchUtc,
      kalshiProb,
      modelProb,
      blendProb,
      kalshiHomeNoTie,
      modelHomeNoTie: modelHomeProb,
      blendHomeNoTie,
      outcome,
      kalshiRawSum: rawSum,
      quoteTime: quality.quoteTime
    };
  });

  const matched = rows.filter(Boolean);
  console.error(`${matched.length} clean matched games after quality filters`);

  const decided = matched.filter((r) => r.outcome !== 'TIE');
  console.error(`${decided.length} decided (non-tie) games among matched`);

  const kalshiMetrics = summarize3way(matched, 'kalshiProb');
  const modelMetrics = summarize3way(matched, 'modelProb');
  const blendMetrics = summarize3way(matched, 'blendProb');

  const kalshiAccDecided = summarizeDecidedAccuracy(decided, 'kalshiHomeNoTie');
  const modelAccDecided = summarizeDecidedAccuracy(decided, 'modelHomeNoTie');
  const blendAccDecided = summarizeDecidedAccuracy(decided, 'blendHomeNoTie');

  const bootstrapKalshiVsModel = bootstrapLogLossGap3(matched, 'kalshiProb', 'modelProb');
  const bootstrapKalshiVsBlend = bootstrapLogLossGap3(matched, 'kalshiProb', 'blendProb');
  const bootstrapModelVsBlend = bootstrapLogLossGap3(matched, 'modelProb', 'blendProb');

  const dates = matched.map((r) => r.date).sort();
  const tieRateActual = matched.length ? matched.filter((r) => r.outcome === 'TIE').length / matched.length : null;
  const tieRateKalshiMean = matched.length ? matched.reduce((s, r) => s + r.kalshiProb.tie, 0) / matched.length : null;

  const report = {
    generatedAt: new Date().toISOString(),
    method: 'Latest completed one-minute KXMLBF5 candle strictly before scheduled first pitch for AWAY/HOME/TIE markets; quoteSetQuality (synchronized within 1 min, fresh within 5 min of cutoff); max spread 0.15; kalshi_raw_sum kept in [0.85,1.15]. Model = PRODUCTION F5 model walk-forward backtest (data/backtest-picks.json), NOT the v3c lineup late-fusion model used in wishlist #18 (v3c predictions are capped at 2026-09-07 and could not be extended without rebuilding the upstream lineup/starter/statcast feature pipeline). Production model has no tie probability; scored in 3-way space with modelProb.tie=0.',
    modelUsed: 'production (data/backtest-picks.json) -- NOT v3c fusion',
    requestedRange: [startDate, endDate],
    counts: {
      settledMarkets: settledMarkets.length,
      uniqueEvents: byEvent.size,
      candidatesWithScheduleAndModelMatch: candidates.length,
      cleanMatchedGames: matched.length,
      decidedGames: decided.length,
      rejected: rejected.length
    },
    dateRangeOfMatchedGames: matched.length ? [dates[0], dates[dates.length - 1]] : null,
    tieRates: { actual: tieRateActual, kalshiMean: tieRateKalshiMean },
    metrics3way: { kalshi: kalshiMetrics, model: modelMetrics, blend: blendMetrics },
    decidedAccuracy: { kalshi: kalshiAccDecided, model: modelAccDecided, blend: blendAccDecided },
    bootstrap: {
      iterations: 10000,
      kalshiMinusModelLogLossGap: bootstrapKalshiVsModel,
      kalshiMinusBlendLogLossGap: bootstrapKalshiVsBlend,
      modelMinusBlendLogLossGap: bootstrapModelVsBlend
    },
    rows: matched,
    rejectedSample: rejected.slice(0, 50)
  };

  const outDir = path.join(__dirname, '..', 'data', 'kalshi-forward');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `f5-vs-kalshi-market-extended-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log(JSON.stringify({
    outFile,
    modelUsed: report.modelUsed,
    counts: report.counts,
    dateRangeOfMatchedGames: report.dateRangeOfMatchedGames,
    tieRates: report.tieRates,
    metrics3way: report.metrics3way,
    decidedAccuracy: report.decidedAccuracy,
    bootstrap: report.bootstrap
  }, null, 2));
}

main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
