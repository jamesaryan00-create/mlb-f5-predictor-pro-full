const { getPredictions, todayPacific } = require('../../lib/mlb');

export default async function handler(req, res) {
  try {
    const date = req.query.date || todayPacific();
    const data = await getPredictions(date);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
