const fs = require('fs');
const path = require('path');

export default function handler(req, res) {
  try {
    const resultsPath = path.join(process.cwd(), 'data', 'backtest-results.json');
    const picksPath = path.join(process.cwd(), 'data', 'backtest-picks.json');
    if (!fs.existsSync(resultsPath)) return res.status(404).json({ error: 'Backtest not generated. Run npm run train:history locally and push the generated data files.' });
    const data = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
    const season = req.query.season ? Number(req.query.season) : null;
    const includePicks = String(req.query.includePicks || '') === '1';
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 1000);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    if (season) data.selectedSeason = data.bySeason?.find((x) => Number(x.label) === season) || null;
    if (includePicks && fs.existsSync(picksPath)) {
      const picks = JSON.parse(fs.readFileSync(picksPath, 'utf8'));
      const filtered = season ? picks.filter((p) => p.season === season) : picks;
      data.picks = filtered.slice(offset, offset + limit);
      data.picksPagination = { total: filtered.length, offset, limit };
    }
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
