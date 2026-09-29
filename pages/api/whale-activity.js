// New, exploratory whale/large-trade signal -- see FEATURE-WISHLIST.md and lib/whale-trades.js /
// lib/whale-board.js. Reported separately for the F5 market (data/kalshi-forward/) and the
// full-game market (data/kalshi-forward-fullgame/), same convention as pages/api/line-movement.js.
// Never blended.
const path = require('path');
const { summarizeWhaleBoard } = require('../../lib/whale-board');

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const f5Dir = path.join(process.cwd(), 'data', 'kalshi-forward');
    const fullGameDir = path.join(process.cwd(), 'data', 'kalshi-forward-fullgame');
    return res.status(200).json({
      f5: summarizeWhaleBoard(f5Dir),
      fullGame: summarizeWhaleBoard(fullGameDir),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
