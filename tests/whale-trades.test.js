const test = require('node:test'), assert = require('node:assert/strict');
const { fetchRecentTrades, summarizeWhaleActivity, whaleActivityForRecord } = require('../lib/whale-trades');

function withMockFetch(handler, fn) {
  const original = global.fetch;
  global.fetch = handler;
  return Promise.resolve().then(fn).finally(() => { global.fetch = original; });
}

test('fetchRecentTrades parses a trades response into records and computes dollar notional', async () => {
  await withMockFetch(async (url) => {
    assert.ok(String(url).includes('/markets/trades?'));
    assert.ok(String(url).includes('ticker=KXMLBGAME-TEST'));
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({
        trades: [
          { trade_id: 't1', count_fp: 50, yes_price_dollars: 0.6, no_price_dollars: 0.4, taker_side: 'yes', taker_outcome_side: 'yes', taker_book_side: 'yes', created_time: '2026-09-29T00:00:00Z', is_block_trade: false },
          { trade_id: 't2', count_fp: 900, yes_price_dollars: 0.62, no_price_dollars: 0.38, taker_side: 'no', taker_outcome_side: 'no', taker_book_side: 'no', created_time: '2026-09-29T00:05:00Z', is_block_trade: true }
        ]
      })
    };
  }, async () => {
    const r = await fetchRecentTrades('KXMLBGAME-TEST');
    assert.equal(r.available, true);
    assert.equal(r.trades.length, 2);
    assert.equal(r.trades[0].size, 50);
    assert.equal(r.trades[0].dollars, 50 * 0.6); // yes trade priced at yes_price_dollars
    assert.equal(r.trades[1].dollars, 900 * 0.38); // no trade priced at no_price_dollars
    assert.equal(r.trades[1].isBlockTrade, true);
    assert.equal(r.trades[1].takerOutcomeSide, 'no');
  });
});

test('fetchRecentTrades drops a trade it cannot price (no resolvable taker side)', async () => {
  await withMockFetch(async () => ({
    ok: true, status: 200, headers: new Map(),
    json: async () => ({ trades: [
      { trade_id: 't1', count_fp: 50, yes_price_dollars: 0.6, no_price_dollars: 0.4, taker_outcome_side: null, is_block_trade: false }
    ] })
  }), async () => {
    const r = await fetchRecentTrades('KXMLBGAME-TEST');
    assert.equal(r.available, true);
    assert.deepEqual(r.trades, []); // unpriceable trade filtered out, not a crash or a bogus $0 entry
  });
});

test('fetchRecentTrades never throws on a request failure -- returns available:false', async () => {
  await withMockFetch(async () => { throw new Error('network down'); }, async () => {
    const r = await fetchRecentTrades('KXMLBGAME-TEST');
    assert.equal(r.available, false);
    assert.deepEqual(r.trades, []);
    assert.match(r.reason, /network down/);
  });
});

test('fetchRecentTrades handles a market with zero trades without crashing', async () => {
  await withMockFetch(async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ trades: [] }) }), async () => {
    const r = await fetchRecentTrades('KXMLBGAME-QUIET');
    assert.equal(r.available, true);
    assert.deepEqual(r.trades, []);
  });
});

test('summarizeWhaleActivity handles a market with zero trades gracefully', () => {
  const s = summarizeWhaleActivity([]);
  assert.equal(s.available, false);
  assert.equal(s.n, 0);
  assert.equal(s.largestDollars, null);
});

test('summarizeWhaleActivity threshold/imbalance math in dollar terms on a small synthetic trade list', () => {
  const trades = [
    { size: 10, dollars: 6, isBlockTrade: false, takerOutcomeSide: 'yes' },
    { size: 20, dollars: 12, isBlockTrade: false, takerOutcomeSide: 'yes' },
    { size: 30, dollars: 18, isBlockTrade: false, takerOutcomeSide: 'no' },
    { size: 1000, dollars: 1500, isBlockTrade: false, takerOutcomeSide: 'yes' }, // above the $1,000 floor -> "large"
  ];
  const s = summarizeWhaleActivity(trades);
  assert.equal(s.available, true);
  assert.equal(s.n, 4);
  assert.equal(s.largestDollars, 1500);
  assert.equal(s.totalDollars, 6 + 12 + 18 + 1500);
  assert.equal(s.largeTradeCount, 1); // only the $1,500 trade clears the $1,000 floor
  assert.equal(s.yesDollars, 1500);
  assert.equal(s.noDollars, 0);
  assert.equal(s.netImbalanceDollars, 1500);
  assert.equal(s.direction, 'yes');
});

test('summarizeWhaleActivity: is_block_trade trades are counted separately from the dollar threshold', () => {
  const trades = [
    { size: 5, dollars: 3, isBlockTrade: true, takerOutcomeSide: 'no' },   // tiny dollars but flagged as a block trade -> still "large"
    { size: 10, dollars: 6, isBlockTrade: false, takerOutcomeSide: 'yes' }, // tiny, not a block trade -> not "large"
  ];
  const s = summarizeWhaleActivity(trades, { dollarThreshold: 1000 });
  assert.equal(s.blockTradeCount, 1);
  assert.equal(s.blockTradeDollars, 3);
  assert.equal(s.largeTradeCount, 1); // the block trade counts as large even though it's under the dollar threshold
  assert.equal(s.noDollars, 3);
  assert.equal(s.direction, 'no');
});

test('summarizeWhaleActivity respects an explicit dollarThreshold override', () => {
  const trades = [{ size: 100, dollars: 60, isBlockTrade: false, takerOutcomeSide: 'yes' }];
  assert.equal(summarizeWhaleActivity(trades, { dollarThreshold: 50 }).largeTradeCount, 1);
  assert.equal(summarizeWhaleActivity(trades, { dollarThreshold: 5000 }).largeTradeCount, 0);
});

test('whaleActivityForRecord fetches trades for each market ticker and compares dollar-weighted direction to the pick', async () => {
  await withMockFetch(async (url) => {
    const ticker = new URL(url).searchParams.get('ticker');
    const trades = ticker === 'AWAY-TICK'
      ? [{ trade_id: 'a1', count_fp: 20, yes_price_dollars: 0.5, no_price_dollars: 0.5, taker_outcome_side: 'no', is_block_trade: false, created_time: 'x' }]
      : [{ trade_id: 'h1', count_fp: 3000, yes_price_dollars: 0.7, no_price_dollars: 0.3, taker_outcome_side: 'yes', is_block_trade: false, created_time: 'x' }];
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ trades }) };
  }, async () => {
    const record = { kalshiPickSide: 'HOME', marketTickers: { away: 'AWAY-TICK', home: 'HOME-TICK' } };
    const wa = await whaleActivityForRecord(record);
    assert.equal(wa.pickSide, 'home');
    assert.ok(wa.bySide.away.available);
    assert.ok(wa.bySide.home.available);
    // home market has a large "yes" trade (3,000 x $0.70 = $2,100, above the $1,000 floor) -> favors the home pick directly.
    assert.equal(wa.largeTradeDirectionVsPick, 'agrees_with_pick');
  });
});

test('whaleActivityForRecord handles a record with no trade data (quiet markets) without crashing', async () => {
  await withMockFetch(async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ trades: [] }) }), async () => {
    const record = { kalshiPickSide: 'AWAY', marketTickers: { away: 'AWAY-TICK', home: 'HOME-TICK' } };
    const wa = await whaleActivityForRecord(record);
    assert.equal(wa.bySide.away.available, false);
    assert.equal(wa.largeTradeDirectionVsPick, null);
  });
});
