const { getPredictions, todayPacific } = require('../../lib/mlb');
const { getRecordedDay } = require('../../lib/recorded-day');

export default async function handler(req, res) {
  try {
    const date = req.query.date || todayPacific();
    if (date < todayPacific()) {
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
      return res.status(200).json(getRecordedDay(date));
    }
    const data = await getPredictions(date);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
