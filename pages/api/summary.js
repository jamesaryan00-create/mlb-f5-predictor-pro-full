const { getPredictions, todayPacific } = require('../../lib/mlb');

export default async function handler(req, res) {
  try {
    const date = req.query.date || todayPacific();
    const data = await getPredictions(date);
    const top = data.games.slice(0, 5).map((g, i) => `${i + 1}. ${g.prediction.pick} over ${g.prediction.opponent}: ${g.prediction.label}, edge ${g.prediction.edge}, confidence ${g.prediction.confidence}%, EV ${g.prediction.estimatedEV ?? 'N/A'}%`).join('\n');
    return res.status(200).json({ date, summary: top || 'No games found.', aiAvailable: false, note: 'This endpoint creates a deterministic summary. Add your own server-side AI provider here if desired; never call AI APIs directly from the browser.' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
