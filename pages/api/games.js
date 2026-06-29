const { getSchedule, todayPacific } = require('../../lib/mlb');

export default async function handler(req, res) {
  try {
    const date = req.query.date || todayPacific();
    const games = await getSchedule(date);
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.status(200).json({ date, count: games.length, games });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
