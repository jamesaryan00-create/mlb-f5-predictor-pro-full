// Retrospective backtest of the marketTrust rule (trained model agrees with a confident Kalshi
// price; model itself confident) against already-fetched historical price+outcome data, for both
// the F5 market and the full-game market. This does NOT touch the live forward-tracking window
// (data/kalshi-forward*/model-agreement-plan.json, which starts at 0/100 picks and is unbiased
// going forward) -- it retroactively applies the same rule to data that was already collected for
// other purposes (#18's 791-game F5 vs Kalshi comparison, #29's 682-game full-game comparison), so
// the sample is not a random forward sample and the result is descriptive, not a clean test.
//
// F5 side: joins python-research/data/kalshi_f5_market_2026_full.csv (791 archived Kalshi F5
// quotes, 2026-07-05..09-07) with python-research/results/v3c_lineup_late_fusion_predictions.csv
// (the fusion model's per-game home-win probability on the same games) on game_pk. Note: the v3c
// predictions file only carries decided (HOME/AWAY) outcomes -- no F5 ties are present in it, so
// this F5 backtest is decided-games-only, unlike the live forward tracker where a tie counts as a
// loss in the denominator.
//
// Full-game side: reads the most recent data/kalshi-forward/fullgame-vs-kalshi-market-*.json
// (written by scripts/test-fullgame-vs-kalshi-market.js for #29), which already carries
// kalshiHomeProb, modelHomeProb and homeWon per game (extra innings always produce a winner, so no
// tie case here at all).
//
// Rule under test (matches lib/kalshi-board.js / lib/kalshi-forward.js's live marketTrust):
//   model side agrees with Kalshi side, Kalshi confidence >= STRONG_KALSHI_CONFIDENCE (0.62),
//   model confidence >= MODEL_MIN_CONFIDENCE (0.55).
//
// Read-only. Writes one dated report to data/kalshi-forward/backtest-market-trust-<ts>.json and
// prints a summary. Rerunnable as more data accumulates.

const fs = require('fs');
const path = require('path');

const STRONG_KALSHI_CONFIDENCE = 0.62;
const MODEL_MIN_CONFIDENCE = 0.55;

function parseCsv(text) {
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
}

function winPct(rows, isWin) {
  const n = rows.length;
  if (!n) return { n, wins: 0, winPct: null };
  const wins = rows.filter(isWin).length;
  return { n, wins, losses: n - wins, winPct: 100 * wins / n };
}

function backtestF5() {
  const root = path.join(__dirname, '..', '..');
  const kalPath = path.join(root, 'python-research', 'data', 'kalshi_f5_market_2026_full.csv');
  const modelPath = path.join(root, 'python-research', 'results', 'v3c_lineup_late_fusion_predictions.csv');

  if (!fs.existsSync(kalPath) || !fs.existsSync(modelPath)) {
    return { available: false, reason: 'F5 source CSVs not found (python-research/data or results)' };
  }

  const kal = parseCsv(fs.readFileSync(kalPath, 'utf8'))
    .filter((r) => {
      const sum = Number(r.kalshi_raw_sum);
      return Number.isFinite(sum) && sum >= 0.95 && sum <= 1.05;
    });
  const model = parseCsv(fs.readFileSync(modelPath, 'utf8'));

  const modelByGame = new Map();
  for (const r of model) {
    const pk = Number(r.game_pk);
    if (Number.isFinite(pk) && !modelByGame.has(pk)) modelByGame.set(pk, r);
  }

  const rows = [];
  for (const k of kal) {
    const pk = Number(k.game_pk);
    const m = modelByGame.get(pk);
    if (!m) continue;
    if (m.f5_result !== 'HOME' && m.f5_result !== 'AWAY') continue; // decided-only in v3c file

    const kalshiPickSide = k.kalshi_pick;
    const kalshiConfidence = Number(k.kalshi_confidence);
    const modelPickSide = m.fusion_predicted_side;
    const modelConfidence = Number(m.fusion_confidence);
    if (!Number.isFinite(kalshiConfidence) || !Number.isFinite(modelConfidence)) continue;

    const agree = modelPickSide === kalshiPickSide;
    const marketTrust = agree && kalshiConfidence >= STRONG_KALSHI_CONFIDENCE && modelConfidence >= MODEL_MIN_CONFIDENCE;
    const kalshiWin = kalshiPickSide === m.f5_result;
    const modelWin = modelPickSide === m.f5_result;

    rows.push({ gamePk: pk, date: k.game_date, kalshiPickSide, kalshiConfidence, modelPickSide, modelConfidence, agree, marketTrust, result: m.f5_result, kalshiWin, modelWin });
  }

  const marketTrustRows = rows.filter((r) => r.marketTrust);

  return {
    available: true,
    market: 'F5 (KXMLBF5)',
    note: 'Decided games only -- the joined model-predictions file (v3c fusion) carries no F5 tie outcomes, so this differs from the live forward tracker where a tie counts as a loss.',
    totalGames: rows.length,
    overallKalshi: winPct(rows, (r) => r.kalshiWin),
    overallModel: winPct(rows, (r) => r.modelWin),
    marketTrust: {
      selectionRate: rows.length ? marketTrustRows.length / rows.length : null,
      ...winPct(marketTrustRows, (r) => r.kalshiWin)
    }
  };
}

function backtestFullGame() {
  const dir = path.join(__dirname, '..', 'data', 'kalshi-forward');
  if (!fs.existsSync(dir)) return { available: false, reason: 'data/kalshi-forward not found' };
  const files = fs.readdirSync(dir).filter((f) => /^fullgame-vs-kalshi-market-.*\.json$/.test(f)).sort();
  if (!files.length) return { available: false, reason: 'No fullgame-vs-kalshi-market-*.json report found; run scripts/test-fullgame-vs-kalshi-market.js first' };
  const file = files[files.length - 1];
  const report = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const source = report.rows || [];

  const rows = source.map((r) => {
    const kalshiPickSide = r.kalshiHomeProb >= 0.5 ? 'HOME' : 'AWAY';
    const modelPickSide = r.modelHomeProb >= 0.5 ? 'HOME' : 'AWAY';
    const kalshiConfidence = Math.max(r.kalshiHomeProb, 1 - r.kalshiHomeProb);
    const modelConfidence = Math.max(r.modelHomeProb, 1 - r.modelHomeProb);
    const agree = kalshiPickSide === modelPickSide;
    const marketTrust = agree && kalshiConfidence >= STRONG_KALSHI_CONFIDENCE && modelConfidence >= MODEL_MIN_CONFIDENCE;
    const actual = r.homeWon ? 'HOME' : 'AWAY';
    const kalshiWin = kalshiPickSide === actual;
    const modelWin = modelPickSide === actual;
    return { gamePk: r.gamePk, date: r.date, kalshiPickSide, kalshiConfidence, modelPickSide, modelConfidence, agree, marketTrust, result: actual, kalshiWin, modelWin };
  });

  const marketTrustRows = rows.filter((r) => r.marketTrust);

  return {
    available: true,
    market: 'Full game (KXMLBGAME)',
    note: 'No tie contract in full-game markets (extra innings force a winner), so no ties-excluded/ties-as-loss distinction is needed here.',
    sourceFile: file,
    totalGames: rows.length,
    overallKalshi: winPct(rows, (r) => r.kalshiWin),
    overallModel: winPct(rows, (r) => r.modelWin),
    marketTrust: {
      selectionRate: rows.length ? marketTrustRows.length / rows.length : null,
      ...winPct(marketTrustRows, (r) => r.kalshiWin)
    }
  };
}

function main() {
  const f5 = backtestF5();
  const fullGame = backtestFullGame();

  const report = {
    generatedAt: new Date().toISOString(),
    rule: { agree: 'model side === Kalshi side', kalshiConfidenceMin: STRONG_KALSHI_CONFIDENCE, modelConfidenceMin: MODEL_MIN_CONFIDENCE },
    caveat: 'RETROSPECTIVE only. These datasets were fetched/kept for earlier, different comparisons (#18, #29), not drawn fresh for this test, so this is a descriptive backtest, not a clean forward evaluation. The live forward-tracking window in data/kalshi-forward*/model-agreement-plan.json is the unbiased test and starts at 0 picks.',
    f5,
    fullGame
  };

  const outDir = path.join(__dirname, '..', 'data', 'kalshi-forward');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `backtest-market-trust-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log(JSON.stringify({ outFile, ...report }, null, 2));
}

main();
