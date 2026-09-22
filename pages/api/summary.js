const { getPredictions, todayPacific } = require('../../lib/mlb');

export default async function handler(req, res) {
  try {
    const date = req.query.date || todayPacific();
    const data = await getPredictions(date);
    const top = data.games.filter((g) => g.fullGamePrediction?.pick).slice(0, 5).map((g, i) => `${i + 1}. ${g.fullGamePrediction.pick} over ${g.fullGamePrediction.opponent}: logistic ${g.fullGamePrediction.confidence}%; Monte Carlo ${g.fullGameMonteCarlo?.pick || 'unavailable'} ${g.fullGameMonteCarlo?.confidence == null ? '' : `${g.fullGameMonteCarlo.confidence}%`}; F5 ${g.prediction.pick || 'unavailable'} ${g.prediction.confidence == null ? '' : `${g.prediction.confidence}%`}; no betting recommendation`).join('\n');
    return res.status(200).json({ date, summary: top || 'No predictions available for this date.', aiAvailable: false, note: 'This endpoint creates a deterministic summary. Add your own server-side AI provider here if desired; never call AI APIs directly from the browser.' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
