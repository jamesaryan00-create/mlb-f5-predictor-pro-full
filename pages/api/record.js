const fs = require('fs'), path = require('path');
const { summarize, dir } = require('../../lib/model-forward');
const { readResults: readF5Results } = require('../../lib/kalshi-results');
const { readResults: readFullGameResults } = require('../../lib/kalshi-results-fullgame');

function loadModelForwardReports() {
  const gradesDir = dir();
  if (!fs.existsSync(gradesDir)) return [];
  return fs.readdirSync(gradesDir)
    .filter((f) => /^grades-.*\.json$/.test(f))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(gradesDir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const reports = loadModelForwardReports();
    const modelForward = summarize(reports);
    const f5 = readF5Results();
    const fullGame = readFullGameResults();
    return res.status(200).json({
      modelForward,
      f5MarketTrust: f5.available ? f5.marketTrust : null,
      fullGameMarketTrust: fullGame.available ? fullGame.marketTrust : null,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
