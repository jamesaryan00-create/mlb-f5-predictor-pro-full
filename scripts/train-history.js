const fs = require('fs');
const path = require('path');
const { fetchSeasonGames, buildFeatureRows, clamp } = require('../lib/historical-f5');

const FEATURE_NAMES = ['homeWinPctDiff','homeF5RunDiff','homeRecentRunDiff','homePitchingRunDiff','homeParkFactor','homeRestDiff'];
const START_SEASON = Number(process.env.HISTORY_START_SEASON || 2010);
const CURRENT_SEASON = Number(process.env.HISTORY_END_SEASON || new Date().getFullYear());
const TODAY = process.env.HISTORY_THROUGH_DATE || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const EPOCHS = Number(process.env.HISTORY_EPOCHS || 650);
const LR = Number(process.env.HISTORY_LEARNING_RATE || 0.05);
const L2 = Number(process.env.HISTORY_L2 || 0.0025);

function sigmoid(z) { return 1 / (1 + Math.exp(-clamp(z, -30, 30))); }
function mean(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function std(arr, m) { if (arr.length < 2) return 1; const v = arr.reduce((s,x)=>s+(x-m)*(x-m),0)/arr.length; const out = Math.sqrt(v); return out > 1e-8 ? out : 1; }
function prepare(rows) {
  const decided = rows.filter((r) => r.target === 0 || r.target === 1);
  const means = {}, scales = {};
  for (const f of FEATURE_NAMES) {
    const vals = decided.map((r) => Number(r.features[f] || 0));
    means[f] = mean(vals);
    scales[f] = std(vals, means[f]);
  }
  return { decided, means, scales };
}
function xrow(row, means, scales) { return FEATURE_NAMES.map((f) => (Number(row.features[f] || 0) - means[f]) / scales[f]); }
function train(rows, opts={}) {
  const { decided, means, scales } = prepare(rows);
  const epochs = opts.epochs || EPOCHS;
  const lr = opts.lr || LR;
  const l2 = opts.l2 ?? L2;
  let bias = 0;
  const w = new Array(FEATURE_NAMES.length).fill(0);
  if (!decided.length) return { weights: Object.fromEntries(FEATURE_NAMES.map((f)=>[f,0])), bias: 0, means, scales, games: 0 };
  for (let epoch=0; epoch<epochs; epoch++) {
    let gb = 0;
    const gw = new Array(w.length).fill(0);
    for (const row of decided) {
      const x = xrow(row, means, scales);
      let z = bias;
      for (let j=0;j<w.length;j++) z += w[j]*x[j];
      const err = sigmoid(z) - row.target;
      gb += err;
      for (let j=0;j<w.length;j++) gw[j] += err*x[j];
    }
    const n = decided.length;
    bias -= lr * gb / n;
    for (let j=0;j<w.length;j++) w[j] -= lr * ((gw[j] / n) + l2*w[j]);
  }
  const weights = Object.fromEntries(FEATURE_NAMES.map((f,i)=>[f,w[i]]));
  return { weights, bias, means, scales, games: decided.length };
}
function predict(model, row) {
  let z = model.bias || 0;
  for (const f of FEATURE_NAMES) z += (model.weights[f] || 0) * ((Number(row.features[f] || 0) - (model.means[f] || 0)) / (model.scales[f] || 1));
  return sigmoid(z);
}
function logLoss(model, rows) {
  const decided = rows.filter((r)=>r.target===0||r.target===1);
  if (!decided.length) return null;
  return -mean(decided.map((r)=>{ const p=clamp(predict(model,r),1e-6,1-1e-6); return r.target*Math.log(p)+(1-r.target)*Math.log(1-p); }));
}
function confidenceBucket(pickProb) {
  const pct = pickProb*100;
  if (pct >= 70) return '70%+';
  if (pct >= 65) return '65–69.9%';
  if (pct >= 60) return '60–64.9%';
  if (pct >= 55) return '55–59.9%';
  return '50–54.9%';
}
function emptyStat(label) { return { label, picks:0, wins:0, losses:0, pushes:0, winPct:null }; }
function finalizeStat(s) { const decided=s.wins+s.losses; s.winPct=decided?Number((100*s.wins/decided).toFixed(2)):null; return s; }
function scoreRows(model, rows, sourceLabel) {
  const stat = emptyStat(sourceLabel);
  const buckets = new Map();
  const picks = [];
  for (const row of rows) {
    const pHome = predict(model,row);
    const pickSide = pHome >= 0.5 ? 'home' : 'away';
    const pickProb = pickSide === 'home' ? pHome : 1-pHome;
    const result = row.result === 'push' ? 'push' : (row.result === pickSide ? 'win' : 'loss');
    stat.picks++;
    stat[result==='win'?'wins':result==='loss'?'losses':'pushes']++;
    const bucketName = confidenceBucket(pickProb);
    if (!buckets.has(bucketName)) buckets.set(bucketName, emptyStat(bucketName));
    const b=buckets.get(bucketName); b.picks++; b[result==='win'?'wins':result==='loss'?'losses':'pushes']++;
    picks.push({ date:row.date, season:row.season, gamePk:row.gamePk, pick:pickSide==='home'?row.homeTeam:row.awayTeam, opponent:pickSide==='home'?row.awayTeam:row.homeTeam, side:pickSide, probability:Number((pickProb*100).toFixed(1)), result, homeF5:row.homeF5, awayF5:row.awayF5 });
  }
  return { stat:finalizeStat(stat), buckets:[...buckets.values()].map(finalizeStat), picks };
}

async function main() {
  const allRows=[];
  const seasonRows={};
  console.log(`Building leakage-safe F5 history ${START_SEASON}-${CURRENT_SEASON} through ${TODAY}...`);
  for (let season=START_SEASON; season<=CURRENT_SEASON; season++) {
    const through = season === CURRENT_SEASON ? TODAY : null;
    process.stdout.write(`  ${season}: fetching... `);
    const games = await fetchSeasonGames(season,{throughDate:through,ttl:0});
    const { rows } = buildFeatureRows(games);
    seasonRows[season]=rows;
    allRows.push(...rows);
    console.log(`${rows.length} usable games`);
  }

  const evalStart = Math.max(START_SEASON+3, Number(process.env.BACKTEST_START_SEASON || START_SEASON+3));
  const yearly=[]; const allBacktestPicks=[]; const bucketTotals=new Map();
  let overall=emptyStat('Overall walk-forward');
  for (let season=evalStart; season<=CURRENT_SEASON; season++) {
    const trainRows=allRows.filter((r)=>r.season<season);
    const testRows=seasonRows[season]||[];
    if (!trainRows.length || !testRows.length) continue;
    console.log(`Backtesting ${season}: train ${trainRows.length}, test ${testRows.length}`);
    const m=train(trainRows,{epochs:Math.max(350,Math.round(EPOCHS*0.75))});
    const scored=scoreRows(m,testRows,String(season));
    yearly.push(scored.stat);
    allBacktestPicks.push(...scored.picks);
    overall.picks+=scored.stat.picks; overall.wins+=scored.stat.wins; overall.losses+=scored.stat.losses; overall.pushes+=scored.stat.pushes;
    for (const b of scored.buckets) {
      if (!bucketTotals.has(b.label)) bucketTotals.set(b.label,emptyStat(b.label));
      const t=bucketTotals.get(b.label); t.picks+=b.picks;t.wins+=b.wins;t.losses+=b.losses;t.pushes+=b.pushes;
    }
  }
  overall=finalizeStat(overall);
  const confidenceBuckets=[...bucketTotals.values()].map(finalizeStat).sort((a,b)=>parseFloat(a.label)-parseFloat(b.label));

  console.log(`Training final model on ${allRows.length} historical games...`);
  const finalModel=train(allRows);
  const modelJson={
    version:`trained-history-${START_SEASON}-${CURRENT_SEASON}`,
    trainedAt:new Date().toISOString(),
    trainingSeasons:[START_SEASON,CURRENT_SEASON],
    throughDate:TODAY,
    type:'logistic-regression-standardized',
    target:'F5 moneyline winner; ties are pushes and excluded from binary training',
    featureNames:FEATURE_NAMES,
    featureMeans:finalModel.means,
    featureScales:finalModel.scales,
    weights:{ bias:finalModel.bias, ...finalModel.weights },
    overlayHomeF5RunWeight:0.671054,
    metrics:{ games:finalModel.games, trainingLogLoss:Number(logLoss(finalModel,allRows).toFixed(4)), walkForwardWins:overall.wins, walkForwardLosses:overall.losses, walkForwardPushes:overall.pushes, walkForwardWinPct:overall.winPct }
  };
  const backtest={
    generatedAt:new Date().toISOString(),
    historyStartSeason:START_SEASON,
    historyEndSeason:CURRENT_SEASON,
    throughDate:TODAY,
    methodology:'Season-by-season expanding-window walk-forward. Each season is predicted by a model trained only on earlier seasons. F5 ties are pushes and excluded from win percentage.',
    scopeNote:'Backtest percentage covers the leakage-safe historical ML component. The live TeamRankings overlay and today-specific pitcher/split rule inputs are not replayed historically because date-stamped snapshots are not available.',
    oddsNote:'This W/L backtest scores F5 direction only. Historical true F5 odds are not used; historical additional-market odds from The Odds API require separate historical-odds access.',
    overall,
    bySeason:yearly,
    byConfidence:confidenceBuckets,
    model:{ version:modelJson.version, trainingGames:finalModel.games, trainingLogLoss:modelJson.metrics.trainingLogLoss },
    picksFile:'data/backtest-picks.json'
  };
  const dataDir=path.join(process.cwd(),'data'); fs.mkdirSync(dataDir,{recursive:true});
  fs.writeFileSync(path.join(dataDir,'model.json'),JSON.stringify(modelJson,null,2));
  fs.writeFileSync(path.join(dataDir,'backtest-results.json'),JSON.stringify(backtest,null,2));
  fs.writeFileSync(path.join(dataDir,'backtest-picks.json'),JSON.stringify(allBacktestPicks));
  console.log(`DONE: ${overall.wins}-${overall.losses}-${overall.pushes}, win ${overall.winPct}%`);
  console.log(`Saved data/model.json, data/backtest-results.json, data/backtest-picks.json`);
}

main().catch((err)=>{ console.error(err); process.exit(1); });
