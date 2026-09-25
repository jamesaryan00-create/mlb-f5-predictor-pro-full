const fs = require('fs'), path = require('path');
const { summarizeForwardRecord, dir } = require('../../lib/model-forward');

// Static backtest (data/backtest-tiers.json, built by scripts/build-backtest-tiers.js) plus LIVE
// forward-tracker numbers read at request time. Kept in separate keys: backtest != forward.
export default function handler(req, res) {
  try {
    const file = path.join(process.cwd(), 'data', 'backtest-tiers.json');
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'backtest-tiers.json not generated. Run node scripts/build-backtest-tiers.js.' });
    const backtest = JSON.parse(fs.readFileSync(file, 'utf8'));
    let forward = null;
    try {
      const d = dir();
      const reports = fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^grades-.*\.json$/.test(f)).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { return null; } }).filter(Boolean) : [];
      forward = summarizeForwardRecord(reports);
    } catch { forward = null; }
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ backtest, forward, forwardNote: 'Forward = live, graded picks recorded before first pitch. Backtest = historical walk-forward. Never blended.' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
