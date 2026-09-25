// Builds data/backtest-tiers.json: win% by model-confidence tier for ALL picks (not just qualified
// ones), F5 and full-game models kept separate, overall + per season, plus a RETROSPECTIVE
// marketTrust cross-tab. Read-only on inputs; writes only data/backtest-tiers.json.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const DATA = path.join(root, 'data');
const BUCKETS = [[45, 50], [50, 55], [55, 60], [60, 65], [65, 70], [70, 75], [75, 100.0001]];
const label = ([a, b]) => (b > 100 ? '75-100' : `${a}-${b}`);
const r2 = (x) => (x == null ? null : Number((x * 100).toFixed(2)));
const bucketOf = (conf) => BUCKETS.find(([a, b]) => conf >= a && conf < b);

function tiers(rows, f5) {
  return BUCKETS.map((bk) => {
    const rs = rows.filter((r) => bucketOf(r.conf) === bk);
    const wins = rs.filter((r) => r.result === 'win').length, pushes = rs.filter((r) => r.result === 'push').length;
    const losses = rs.filter((r) => r.result === 'loss').length, n = rs.length;
    const row = { tier: label(bk), n, wins, losses };
    if (f5) Object.assign(row, { pushes, winPctTiesAsLoss: n ? r2(wins / n) : null, winPctExclTies: n - pushes ? r2(wins / (n - pushes)) : null });
    else row.winPct = n ? r2(wins / n) : null;
    if (bk[0] === 45) row.note = 'Always 0: the model always picks its favored side, so its confidence is never below 50%.';
    if (n && n < 100) row.smallSample = true;
    return row;
  });
}
function totals(rows, f5) {
  const n = rows.length, wins = rows.filter((r) => r.result === 'win').length, pushes = rows.filter((r) => r.result === 'push').length;
  const t = { n, wins, losses: rows.filter((r) => r.result === 'loss').length };
  if (f5) Object.assign(t, { pushes, winPctTiesAsLoss: n ? r2(wins / n) : null, winPctExclTies: n - pushes ? r2(wins / (n - pushes)) : null });
  else t.winPct = n ? r2(wins / n) : null;
  return t;
}
function block(rows, f5) {
  const seasons = [...new Set(rows.map((r) => r.season))].sort();
  const scopes = { all: { totals: totals(rows, f5), tiers: tiers(rows, f5) } };
  for (const s of seasons) { const rs = rows.filter((r) => r.season === s); scopes[s] = { totals: totals(rs, f5), tiers: tiers(rs, f5) }; }
  return scopes;
}

// ---- marketTrust cross-tab (retrospective) ----
const STRONG = 0.62, MODEL_MIN = 0.55;
function parseCsv(text) { const l = text.trim().split('\n'), h = l[0].split(','); return l.slice(1).map((x) => { const c = x.split(','), o = {}; h.forEach((k, i) => { o[k] = c[i]; }); return o; }); }
function f5Source() {
  const pr = path.join(root, '..', 'python-research');
  const kp = path.join(pr, 'data', 'kalshi_f5_market_2026_full.csv'), mp = path.join(pr, 'results', 'v3c_lineup_late_fusion_predictions.csv');
  if (!fs.existsSync(kp) || !fs.existsSync(mp)) return null;
  const mb = new Map(); for (const r of parseCsv(fs.readFileSync(mp, 'utf8'))) { const pk = Number(r.game_pk); if (!mb.has(pk)) mb.set(pk, r); }
  const rows = [];
  for (const k of parseCsv(fs.readFileSync(kp, 'utf8'))) {
    const s = Number(k.kalshi_raw_sum); if (!(s >= 0.95 && s <= 1.05)) continue;
    const m = mb.get(Number(k.game_pk)); if (!m || (m.f5_result !== 'HOME' && m.f5_result !== 'AWAY')) continue;
    const kc = Number(k.kalshi_confidence), mc = Number(m.fusion_confidence); if (!Number.isFinite(kc) || !Number.isFinite(mc)) continue;
    rows.push({ conf: mc * 100, win: m.fusion_predicted_side === m.f5_result, mt: m.fusion_predicted_side === k.kalshi_pick && kc >= STRONG && mc >= MODEL_MIN });
  }
  return rows.length ? rows : null;
}
function fullSource() {
  const d = path.join(DATA, 'kalshi-forward');
  if (!fs.existsSync(d)) return null;
  const f = fs.readdirSync(d).filter((x) => /^fullgame-vs-kalshi-market-.*\.json$/.test(x)).sort().pop();
  if (!f) return null;
  const rows = [];
  for (const g of JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')).rows || []) {
    const kh = Number(g.kalshiHomeProb), mh = Number(g.modelHomeProb);
    if (!Number.isFinite(kh) || !Number.isFinite(mh) || typeof g.homeWon !== 'boolean') continue;
    const kSide = kh >= 0.5 ? 'HOME' : 'AWAY', mSide = mh >= 0.5 ? 'HOME' : 'AWAY';
    const kc = Math.max(kh, 1 - kh), mc = Math.max(mh, 1 - mh);
    rows.push({ conf: mc * 100, win: mSide === (g.homeWon ? 'HOME' : 'AWAY'), mt: kSide === mSide && kc >= STRONG && mc >= MODEL_MIN });
  }
  return rows.length ? rows : null;
}
const cell = (rs) => { const n = rs.length, w = rs.filter((r) => r.win).length; return { n, wins: w, winPct: n ? r2(w / n) : null, smallSample: n < 30 }; };
function cross(rows) {
  return BUCKETS.slice(1).map((bk) => { const rs = rows.filter((r) => bucketOf(r.conf) === bk); return { tier: label(bk), all: cell(rs), marketTrust: cell(rs.filter((r) => r.mt)) }; });
}
// Numbers computed earlier in chat; used only when the source files are absent at build time.
const EMB = ([n, pct]) => ({ n, wins: pct == null ? 0 : Math.round(n * pct / 100), winPct: pct, smallSample: n < 30 });
const embedded = {
  f5: { '50-55': [[452, 52.4], [0, null]], '55-60': [[193, 61.1], [72, 69.4]], '60-65': [[24, 75.0], [17, 76.5]] },
  fullGame: { '50-55': [[378, 56.1], [0, null]], '55-60': [[224, 58.9], [62, 71.0]], '60-65': [[68, 73.5], [49, 73.5]], '65-70': [[10, 80.0], [9, 88.9]], '70-75': [[2, 0.0], [2, 0.0]] }
};
function embeddedCross(m) { return BUCKETS.slice(1).map((bk) => { const e = embedded[m][label(bk)] || [[0, null], [0, null]]; return { tier: label(bk), all: EMB(e[0]), marketTrust: EMB(e[1]) }; }); }

function main() {
  const f5 = JSON.parse(fs.readFileSync(path.join(DATA, 'backtest-picks.json'), 'utf8')).map((r) => ({ season: r.season, conf: Number(r.probability), result: r.result }));
  const fg = JSON.parse(fs.readFileSync(path.join(DATA, 'full-game-backtest-picks.json'), 'utf8')).map((r) => ({ season: Number(r.date.slice(0, 4)), conf: Number(r.probability) * 100, result: r.result }));
  const f5x = f5Source(), fgx = fullSource();
  const mtMeta = (src, win) => ({ retrospective: true, notATrueForwardTest: true, source: src ? 'recomputed from source files at build time' : 'embedded numbers computed earlier (source files not present at build time)', sampleWindow: win, rule: 'model agrees with Kalshi side, Kalshi confidence >= 0.62, model confidence >= 0.55', caveat: 'Applied retroactively to already-collected data. Not a clean forward test; small samples (cells with n<30 flagged).' });
  const out = {
    generatedAt: new Date().toISOString(),
    note: 'ALL picks (not just qualified ones). The model always picks its favored side, so confidence is always >= 50%; the 45-50 tier is n=0 by construction.',
    f5: { convention: 'push = F5 tie. winPctTiesAsLoss applies to Kalshi (ties lose). winPctExclTies applies to books that push on ties.', scopes: block(f5, true),
      marketTrust: { ...mtMeta(f5x, '2026-07-05..2026-09-07, decided games only (no ties)'), rows: f5x ? cross(f5x) : embeddedCross('f5') } },
    fullGame: { convention: 'Full games cannot tie.', scopes: block(fg, false),
      marketTrust: { ...mtMeta(fgx, '2026-08-01..2026-09-21, 682 games'), rows: fgx ? cross(fgx) : embeddedCross('fullGame') } }
  };
  fs.writeFileSync(path.join(DATA, 'backtest-tiers.json'), JSON.stringify(out));
  console.log('F5 all', out.f5.scopes.all.totals, '\nFG all', out.fullGame.scopes.all.totals, '\nmarketTrust sources: f5:', out.f5.marketTrust.source, '| fg:', out.fullGame.marketTrust.source);
}
if (require.main === module) main();
module.exports = { tiers, totals, bucketOf };
