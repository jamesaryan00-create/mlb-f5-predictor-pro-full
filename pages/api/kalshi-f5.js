const { getKalshiBoard } = require('../../lib/kalshi-board');
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try { return res.status(200).json(await getKalshiBoard()); }
  catch (error) { return res.status(500).json({ok:false,error:error.message || 'Kalshi F5 API failed'}); }
}
