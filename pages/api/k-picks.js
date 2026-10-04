// Paper strikeout picks for the dashboard. Reads data/k-picks/ (published from the research
// folder by scripts/publish-k-picks.sh -- never written by the site itself): picks-DATE.json,
// grades-DATE.json, record.json. Missing files are the normal case, never an error.
const fs = require('fs'), path = require('path');

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date=YYYY-MM-DD required' });
  const dir = path.join(process.cwd(), 'data', 'k-picks');
  const picksFile = readJson(path.join(dir, `picks-${date}.json`));
  const gradesFile = readJson(path.join(dir, `grades-${date}.json`));
  const record = readJson(path.join(dir, 'record.json'));
  const graded = new Map(((gradesFile && gradesFile.graded) || []).map((g) => [`${g.game_pk}-${g.player_id}`, g]));
  const picks = ((picksFile && picksFile.picks) || []).map((p) => {
    const g = graded.get(`${p.game_pk}-${p.player_id}`);
    return {
      pitcher: p.player_name, away: p.away_team, home: p.home_team, line: p.threshold, side: p.side,
      modelPct: Number.isFinite(p.model_p) ? Math.round(p.model_p * 100) : null,
      kalshiPct: Number.isFinite(p.kalshi_mid) ? Math.round(p.kalshi_mid * 100) : null,
      agrees: p.agree_with_market ?? null, firstPitchUtc: p.first_pitch_utc || null,
      result: g ? g.result : null, strikeouts: g && g.strikeouts != null ? g.strikeouts : (g && g.k != null ? g.k : null),
    };
  });
  const run = record && record.running && record.running.overall;
  res.status(200).json({ date, picks, record: run ? { wins: run.w, losses: run.l, n: run.n, winPct: run.n ? Math.round(run.win_pct * 10000) / 100 : null } : null });
}
