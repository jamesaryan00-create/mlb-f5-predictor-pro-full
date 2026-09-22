const fs = require('fs');
const path = require('path');

const MLB_BASE = 'https://statsapi.mlb.com/api/v1';
const cache = new Map();
const DEFAULT_TTL = 30 * 60 * 1000;

async function fetchJson(url, ttl = DEFAULT_TTL) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'mlb-f5-predictor-pitcher-history/1.0' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`MLB Stats API ${res.status}: ${url}`);
  const data = await res.json();
  cache.set(url, { at: Date.now(), data });
  return data;
}

// ---------------------------------------------------------------------------
// Historical (training/backtest) lookup: precomputed by python-research's boxscore backfill
// (build_starter_history_full.py) for every game in the 2010-2026 training set, keyed by
// gamePk+side. Loaded once per process and cached in memory.
// ---------------------------------------------------------------------------

let historicalLookup = null;
function loadHistoricalLookup() {
  if (historicalLookup) return historicalLookup;
  const file = process.env.PITCHER_HISTORY_FILE || path.join(process.cwd(), 'data', 'pitcher-quality-history-2010-2026.json');
  historicalLookup = new Map();
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const r of rows) historicalLookup.set(`${r.gamePk}:${r.side}`, r);
  } catch {
    // Unavailable is fine -- callers treat a missing entry as a missing feature, not an error.
  }
  return historicalLookup;
}

function historicalPitcherQuality(gamePk, side) {
  const lookup = loadHistoricalLookup();
  const row = lookup.get(`${gamePk}:${String(side).toUpperCase()}`);
  if (!row || row.starts < 1) return null;
  return { whipLast10: row.whipLast10, fipLast10: row.fipLast10, starts: row.starts };
}

// ---------------------------------------------------------------------------
// Live lookup: for a probable starter, fetch his own season game log and compute rolling
// WHIP/FIP over his last 10 starts STRICTLY before `beforeDate` -- same leakage-safe
// convention as everywhere else in this project. Note: MLB's stat objects carry both
// "hitByPitch" (the pitcher's own BATTING hit-by-pitch count, relevant pre-2022 in the NL when
// pitchers batted) and "hitBatsmen" (batters this pitcher hit) as separate fields -- FIP needs
// hitBatsmen. Confirmed against a live sample; do not swap these back.
// ---------------------------------------------------------------------------

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function ipToOuts(ipRaw) {
  if (ipRaw == null || !/^\d+(?:\.[012])?$/.test(String(ipRaw))) return null;
  const s = String(ipRaw);
  const [whole, frac = '0'] = s.split('.');
  const w = Number(whole), f = Number(frac);
  if (!Number.isFinite(w) || !Number.isFinite(f)) return null;
  return w * 3 + f;
}

async function liveRollingPitcherQuality(pitcherId, beforeDate, windowStarts = 10) {
  if (!Number.isSafeInteger(Number(pitcherId)) || Number(pitcherId) <= 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(beforeDate))) return null;
  const season = Number(String(beforeDate).slice(0, 4));

  // Match the training lookup: last ten starts across seasons back to 2010.
  let all=[];
  for(let year=season;year>=2010;year--) {
    let data;
    try { data=await fetchJson(`${MLB_BASE}/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=${year}`); }
    catch { return null; }
    all.push(...(data.stats||[]).filter(s=>s.type?.displayName==='gameLog').flatMap(s=>s.splits||[]).filter(s=>s.date<beforeDate&&s.gameType==='R'&&s.stat?.gamesStarted===1));
    if(all.length>=windowStarts)break;
  }
  const ids=all.map(s=>s.game?.gamePk);
  if(ids.some(id=>!Number.isSafeInteger(id))||new Set(ids).size!==ids.length)return null;
  const priorStarts=all.sort((a,b)=>a.date.localeCompare(b.date)||a.game.gamePk-b.game.gamePk).slice(-windowStarts);

  if (!priorStarts.length) return null;

  let outs = 0, hits = 0, bb = 0, hitBatsmen = 0, k = 0, hr = 0;
  for (const split of priorStarts) {
    const o = ipToOuts(split.stat?.inningsPitched);
    if (o == null) return null;
    if(['hits','baseOnBalls','hitBatsmen','strikeOuts','homeRuns'].some(k=>!Number.isInteger(split.stat?.[k])||split.stat[k]<0))return null;
    outs += o;
    hits += num(split.stat?.hits);
    bb += num(split.stat?.baseOnBalls);
    hitBatsmen += num(split.stat?.hitBatsmen);
    k += num(split.stat?.strikeOuts);
    hr += num(split.stat?.homeRuns);
  }

  const ip = outs / 3;
  if (!(ip > 0)) return null;

  return {
    whipLast10: (hits + bb) / ip,
    fipLast10: (13 * hr + 3 * (bb + hitBatsmen) - 2 * k) / ip,
    starts: priorStarts.length
  };
}

module.exports = { historicalPitcherQuality, liveRollingPitcherQuality, loadHistoricalLookup };
