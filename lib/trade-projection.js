// Paper scenarios only: budget includes aggregate, conservatively rounded taker fees.
function fee(contracts, price) {
  return Math.ceil((0.07 * contracts * price * (1 - price) - 1e-10) * 100) / 100;
}
function tradeProjection(budget, ask) {
  if (!Number.isFinite(budget) || budget <= 0 || budget > 1000000 || !Number.isFinite(ask) || ask <= 0 || ask >= 1) return null;
  let contracts = Math.floor(budget / (ask + .07 * ask * (1 - ask)));
  while (contracts > 0 && contracts * ask + fee(contracts, ask) > budget + 1e-8) contracts--;
  if (!contracts) return null;
  const fees = fee(contracts, ask), cost = contracts * ask + fees;
  return { contracts, fees, cost, payout: contracts, winProfit: contracts - cost, loss: cost };
}
function cohortRate(cohort) {
  if (!cohort || ![cohort.wins, cohort.losses, cohort.ties ?? 0].every(n => Number.isFinite(n) && n >= 0)) return null;
  const n = cohort.wins + cohort.losses + (cohort.ties || 0);
  return n ? { rate: cohort.wins / n, n } : null;
}
function portfolioProjection(trades, rate) {
  const cost = trades.reduce((s, t) => s + t.cost, 0);
  const payout = trades.reduce((s, t) => s + t.payout, 0);
  return { cost, allWinProfit: payout - cost, expected: trades.length && Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate * payout - cost : null };
}
function liveTrade(game, budget, now = Date.now()) {
  const q = game.kalshiPrimaryFullGame;
  const age = now - Date.parse(q?.entryQuoteTime);
  if (game.recordedPick || !game.prediction?.pick || !q?.available || q.pick !== game.prediction.pick || !(Date.parse(game.gameDate) > now) || !Number.isFinite(age) || age < 0 || age > 300000) return null;
  return tradeProjection(budget, q.entryAsk);
}
module.exports = { fee, tradeProjection, cohortRate, portfolioProjection, liveTrade };
