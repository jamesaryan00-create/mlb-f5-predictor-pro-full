const { tradeProjection } = require('./trade-projection');
const POLICY = Object.freeze({ version: 'price-paper-v1', budget: 1000, adverseCents: 1, maxQuoteAgeMs: 300000, maxSkewMs: 60000, dailyCap: 8 });
// The existing model is an unvalidated probability estimate, not a certified edge.
function decide({ homeProbability, quotes, firstPitch, now = Date.now(), budget = POLICY.budget }) {
  const result = { policy: POLICY.version, action: 'PASS', side: null, reason: '', sides: [] };
  if (!Number.isFinite(homeProbability) || homeProbability <= 0 || homeProbability >= 1) return { ...result, reason: 'Model probability unavailable' };
  if (!(Date.parse(firstPitch) > now)) return { ...result, reason: 'Game already started or start time unavailable' };
  const times = ['home','away'].map(s => Date.parse(quotes?.[s]?.time));
  if (times.some(t => !Number.isFinite(t) || now-t < 0 || now-t > POLICY.maxQuoteAgeMs) || Math.abs(times[0]-times[1])>POLICY.maxSkewMs) return { ...result, reason: 'Waiting for two fresh, synchronized quotes' };
  if (['home','away'].some(s => {
    const q=quotes?.[s];
    return !q || !Number.isFinite(q.ask) || !Number.isFinite(q.bid) || q.bid < 0 || q.bid > q.ask || q.ask <= 0 || q.ask >= 1;
  })) return { ...result, reason: 'Two valid purchase prices required' };
  const mids = ['home','away'].map(s => (quotes[s].ask + quotes[s].bid)/2);
  result.sides = ['home','away'].map((side,i) => {
    const probability = side==='home' ? homeProbability : 1-homeProbability;
    const trade = tradeProjection(budget,quotes[side].ask);
    const stress = tradeProjection(budget,quotes[side].ask + POLICY.adverseCents/100);
    return { side, probability, ask:quotes[side].ask, quoteTime:quotes[side].time,
      marketRole: mids[i]===mids[1-i] ? 'EVEN' : mids[i]>mids[1-i] ? 'FAVORITE' : 'UNDERDOG',
      trade, expected:trade ? probability*trade.payout-trade.cost : null,
      stressExpected:stress ? probability*stress.payout-stress.cost : null,
      breakEven:trade ? trade.cost/trade.payout : null };
  });
  const eligible=result.sides.filter(s=>s.trade && s.expected>0 && s.stressExpected>0).sort((a,b)=>b.stressExpected-a.stressExpected || a.side.localeCompare(b.side));
  if(!eligible.length)return {...result,reason:'Neither side has positive model-estimated return after fees and a 1¢ worse entry'};
  const best=eligible[0];
  return {...result,action:best.marketRole,side:best.side,selected:best,
    reason:'Highest model-estimated return after fees; remains positive at a 1¢ worse entry. Paper candidate only.'};
}
function fromGame(game,budget,now=Date.now()) {
  return decide({homeProbability:game.fullGamePrediction?.available ? game.fullGamePrediction.homeProbability/100 : null,
    quotes:game.fullGameQuotes,firstPitch:game.gameDate,budget,now});
}
function selectedPortfolio(decisions) {
  const rows=decisions.filter(d=>d.selected).map(d=>d.selected);
  return { count:rows.length,cost:rows.reduce((s,r)=>s+r.trade.cost,0),
    expected:rows.length ? rows.reduce((s,r)=>s+r.expected,0) : null,
    winProfit:rows.reduce((s,r)=>s+r.trade.winProfit,0) };
}
module.exports={POLICY,decide,fromGame,selectedPortfolio};
