const { getKalshiFullGameBoard } = require('../../lib/kalshi-board-fullgame');
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try { return res.status(200).json(await getKalshiFullGameBoard()); }
  catch (error) { return res.status(500).json({ok:false,error:error.message || 'Kalshi full-game API failed'}); }
}
