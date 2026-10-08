const test=require('node:test'),assert=require('node:assert/strict');
const {assessDepth,captureDepth}=require('../lib/price-depth');
test('YES liquidity uses same-contract NO bids; fractional quantity cannot inflate coverage',()=>{
 const raw={orderbook_fp:{yes_dollars:[['0.50','100000']],no_dollars:[['0.49','5000'],['0.50','1932.99']]}};
 const d=assessDepth(raw,.5);
 assert.equal(d.bestAsk,.5);assert.equal(d.atQuotedAsk.requiredContracts,1932);
 assert.equal(d.atQuotedAsk.sufficient,true);
 raw.orderbook_fp.no_dollars[1][1]='1931.99';
 assert.equal(assessDepth(raw,.5).atQuotedAsk.sufficient,false);
 assert.equal(assessDepth(raw,.5).atOneCentWorse.sufficient,true);
});
test('empty book is insufficient; missing or malformed book is unavailable',()=>{
 assert.equal(assessDepth({orderbook_fp:{no_dollars:[]}},.5).atQuotedAsk.sufficient,false);
 assert.equal(assessDepth({},.5).status,'unavailable');
 assert.equal(assessDepth({orderbook_fp:{no_dollars:[['bad','20']]}},.5).status,'unavailable');
});
test('public book failure is diagnostic and does not change decisions',async()=>{
 const r=await captureDepth({gamePk:1,marketTickers:{home:'KXMLBGAME-TEST'}},{fetchFn:async()=>({ok:false,status:503})});
 assert.equal(r.sides.home.reason,'Order book HTTP 503');assert.equal(r.diagnosticOnly,true);
});
