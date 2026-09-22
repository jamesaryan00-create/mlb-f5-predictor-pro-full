const test = require('node:test');
const assert = require('node:assert/strict');
const { selectLatestQuote, quoteSetQuality } = require('../lib/kalshi-quotes');
const now = new Date('2026-09-14T18:00:00Z'), pitch = '2026-09-14T19:00:00Z';
const candle = (minutes, bid = '0.40', ask = '0.42') => ({ end_period_ts: Number(now)/1000-minutes*60, yes_bid: { close_dollars: bid }, yes_ask: { close_dollars: ask } });
test('newest bad candle cannot be replaced with older narrow quote', () => {
 assert.equal(selectLatestQuote([candle(2), candle(1, '.20', '.60')], pitch, now).quote, null);
 assert.equal(selectLatestQuote([candle(2), candle(1, null, '.42')], pitch, now).quote, null);
});
test('stale, future-only, and started-game candles rejected', () => {
 assert.equal(selectLatestQuote([candle(6)], pitch, now).quote, null);
 assert.equal(selectLatestQuote([candle(-1)], pitch, now).quote, null);
 assert.equal(selectLatestQuote([candle(1)], now.toISOString(), now).quote, null);
});
test('fresh quote accepted and age reflects oldest outcome', () => {
 const q1 = selectLatestQuote([candle(1)], pitch, now).quote;
 const q2 = selectLatestQuote([candle(2)], pitch, now).quote;
 assert.ok(Math.abs(q1.mid - .41) < 1e-12);
 const quality = quoteSetQuality([q1,q1,q2], now);
 assert.equal(quality.available, true); assert.equal(quality.quoteAgeMinutes, 2);
 const q4 = selectLatestQuote([candle(4)], pitch, now).quote;
 assert.equal(quoteSetQuality([q1,q1,q4], now).available, false);
});
