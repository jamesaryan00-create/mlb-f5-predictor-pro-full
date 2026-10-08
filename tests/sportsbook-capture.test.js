const test=require('node:test'),assert=require('node:assert/strict');
const {implied,matchEvent,bookPairs,kalshiPair}=require('../lib/sportsbook-capture');
const at='2026-10-08T20:00:00Z';
const event={status:{startsAt:'2026-10-08T21:00:00Z'},teams:{home:{names:{long:'Chicago White Sox'}},away:{names:{long:'Cleveland Guardians'}}},odds:{}};
const game={gameDate:event.status.startsAt,gamePk:1,teams:{home:{team:{name:'Chicago White Sox'}},away:{team:{name:'Cleveland Guardians'}}}};
test('matching requires teams, time and unique game; doubleheaders not guessed',()=>{
 assert.equal(matchEvent(event,[game]).gamePk,1);
 assert.equal(matchEvent(event,[game,game]),null);
 assert.equal(matchEvent(event,[{...game,gameDate:'2026-10-08T23:00:00Z'}]),null);
});
test('two-sided book quotes preserve timestamps, reject stale and missing data',()=>{
 const e=JSON.parse(JSON.stringify(event));
 for(const side of ['home','away'])e.odds[`points-${side}-game-ml-${side}`]={byBookmaker:{test:{odds:'-110',lastUpdatedAt:at,available:true}}};
 assert.equal(bookPairs(e,at)[0].noVigHomeProbability,.5);
 e.odds['points-home-game-ml-home'].byBookmaker.test.lastUpdatedAt='2026-10-08T19:00:00Z';
 assert.equal(bookPairs(e,at)[0].noVigHomeProbability,null);
 assert.equal(implied(null),null);assert.equal(implied(''),null);assert.equal(implied('x'),null);
 assert.equal(implied('+100'),.5);
});
test('Kalshi link rejects stale, future, postgame and malformed quotes',()=>{
 const q={bid:.49,ask:.51,time:at};
 const r={firstPitchUtc:event.status.startsAt,capturedAt:at,outcomeQuotes:{home:q,away:q}};
 assert.ok(kalshiPair(r,event,at));
 assert.equal(kalshiPair({...r,capturedAt:'2026-10-08T19:00:00Z'},event,at),null);
 assert.equal(kalshiPair({...r,capturedAt:'2026-10-08T20:01:00Z'},event,at),null);
 assert.equal(kalshiPair(r,event,'2026-10-08T22:00:00Z'),null);
 assert.equal(kalshiPair({...r,outcomeQuotes:{home:{...q,ask:null},away:q}},event,at),null);
});
