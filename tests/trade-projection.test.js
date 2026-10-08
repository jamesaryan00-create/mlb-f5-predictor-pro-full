const test = require('node:test');
const assert = require('node:assert/strict');
const { fee, tradeProjection, cohortRate, portfolioProjection, liveTrade } = require('../lib/trade-projection');
test('fees aggregate per order and budget includes fees', () => {
  assert.equal(fee(100, .5), 1.75);
  for (const ask of [.01, .42, .5, .66, .99]) {
    const t = tradeProjection(1000, ask);
    assert.ok(t.cost <= 1000);
    assert.ok((t.contracts + 1) * ask + fee(t.contracts + 1, ask) > 1000);
    assert.ok(Math.abs(t.winProfit - (t.payout - t.cost)) < 1e-8);
  }
  assert.equal(tradeProjection(0, .5), null);
  assert.equal(tradeProjection(1000, null), null);
  assert.equal(tradeProjection(1000, 1), null);
});
test('portfolio respects price differences, missing rate and empty selections', () => {
  const ts = [tradeProjection(1000, .4), tradeProjection(1000, .8)];
  const p = portfolioProjection(ts, .6);
  assert.ok(Math.abs(p.expected - ts.reduce((s,t) => s + .6*t.winProfit - .4*t.loss, 0)) < 1e-8);
  assert.equal(portfolioProjection(ts, null).expected, null);
  assert.equal(portfolioProjection([], .6).expected, null);
  assert.deepEqual(cohortRate({ wins: 6, losses: 3, ties: 1 }), { rate: .6, n: 10 });
  assert.equal(cohortRate({ wins: 0, losses: 0 }), null);
});
test('never substitutes confidence or later prices for an entry ask', () => {
  const now = Date.parse('2026-10-08T20:00:00Z');
  const g = { gameDate: '2026-10-08T21:00:00Z', prediction: { pick: 'A' }, kalshiPrimaryFullGame: { available: true, pick: 'A', entryAsk: .5, entryQuoteTime: '2026-10-08T19:59:00Z' } };
  assert.ok(liveTrade(g,1000,now));
  assert.equal(liveTrade({...g, recordedPick: {pick:'A'}},1000,now),null);
  assert.equal(liveTrade(g,1000,now+3600000),null);
  assert.equal(liveTrade(g,1000,now+301000),null);
  assert.equal(liveTrade({...g,kalshiPrimaryFullGame:{...g.kalshiPrimaryFullGame,entryAsk:null,confidence:60}},1000,now),null);
});
