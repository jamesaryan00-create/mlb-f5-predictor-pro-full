const test = require('node:test'), assert = require('node:assert/strict');
const { validateBacktest } = require('../lib/backtest-integrity');
const { PIPELINE_VERSION } = require('../lib/mlb');
const picks = [{ gamePk: 1, homeF5: 2, awayF5: 1, homeProbability: .6, side: 'home', result: 'win' }];
const results = { pipelineVersion: PIPELINE_VERSION, overall: { picks: 1, wins: 1, losses: 0, pushes: 0, winPct: 100 } };
test('evaluation independently validates grading and totals', () => {
 assert.equal(validateBacktest(results, picks).uniqueGames,1);
 assert.throws(()=>validateBacktest(results,[...picks,...picks]),/Duplicate/);
 assert.throws(()=>validateBacktest(results,[{...picks[0],result:'loss'}]),/grading/);
 assert.throws(()=>validateBacktest({...results,overall:{...results.overall,wins:2}},picks),/mismatch/);
 assert.throws(()=>validateBacktest({...results,pipelineVersion:null},picks),/corrected/);
});
