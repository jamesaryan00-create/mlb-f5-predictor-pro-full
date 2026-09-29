// FEATURE-WISHLIST.md #7 and #8: line movement and CLV, reported separately for the F5 market
// (data/kalshi-forward/) and the full-game market (data/kalshi-forward-fullgame/). Never blended.
const path = require('path');
const { summarizeLineMovement } = require('../../lib/line-movement');
const { computeCLV } = require('../../lib/clv');

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const f5Dir = path.join(process.cwd(), 'data', 'kalshi-forward');
    const fullGameDir = path.join(process.cwd(), 'data', 'kalshi-forward-fullgame');
    return res.status(200).json({
      f5: {
        lineMovement: summarizeLineMovement(f5Dir, { sideField: 'modelPickSide' }),
        clv: computeCLV(f5Dir, { key: 'marketTrust' }),
      },
      fullGame: {
        lineMovement: summarizeLineMovement(fullGameDir, { sideField: 'modelPickSide' }),
        clv: computeCLV(fullGameDir, { key: 'marketTrust' }),
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
