const crypto = require('crypto');
const { mlProbability } = require('./mlb');
const { firstFiveRuns } = require('./historical-f5');
function snapshot(game, model, capturedAt = new Date().toISOString()) {
  const now = Date.parse(capturedAt), start = Date.parse(game.gameDate);
  if (!Number.isFinite(now) || !Number.isFinite(start) || now >= start || !['Scheduled','Pre-Game'].includes(game.status)) return null;
  if (!Number.isSafeInteger(game.gamePk) || !game.prediction?.pick || !Number.isFinite(game.home.modelProbability)) return null;
  if (!(game.home.modelProbability > 0 && game.home.modelProbability < 100)) return null;
  // A future-trained artifact cannot be a prospective forecast for this game.
  if (!model?.throughDate || model.throughDate >= game.officialDate || Date.parse(model.trainedAt) > now || !Number.isFinite(Date.parse(model.trainedAt))) return null;
  const exactProbability = mlProbability(game.factors?.historicalF5Features, model);
  if (exactProbability === null) return null;
  const quote = game.market?.quoteSnapshot;
  const matched = quote && quote.homeTeam === game.home.name && quote.awayTeam === game.away.name && Date.parse(quote.scheduledAt) === start && Date.parse(quote.observedAt) <= now;
  return { schemaVersion: 1, capturedAt, gamePk: game.gamePk, officialDate: game.officialDate, scheduledAt: game.gameDate,
    home: { id:game.home.id, name:game.home.name }, away:{ id:game.away.id,name:game.away.name },
    model, modelSha256: crypto.createHash('sha256').update(JSON.stringify(model)).digest('hex'),
    features:game.factors?.historicalF5Features, prediction:game.prediction,
    homeProbability:exactProbability,
    quote: matched ? quote : null, quoteReason: matched ? 'Observation time is not provider update time; settlement and execution unverified' : 'Matching quote unavailable',
    evEligible:false };
}
function grade(record, game) {
  if (game?.gamePk !== record.gamePk || game.teams?.home?.team?.id !== record.home.id || game.teams?.away?.team?.id !== record.away.id) return {status:'excluded',reason:'Game/team identity mismatch'};
  if (game.officialDate !== record.officialDate || Date.parse(game.gameDate) !== Date.parse(record.scheduledAt) || Object.keys(game).some(k=>/^resum/i.test(k)&&game[k])) return {status:'excluded',reason:'Rescheduled or resumed game'};
  if (!/^(Final|Game Over|Completed Early)(:|$)/.test(game.status?.detailedState || '')) return {status:'pending',reason:'Game not final'};
  const runs = firstFiveRuns(game);
  if (!runs) return {status:'excluded',reason:'Incomplete F5 innings'};
  const tie = runs.home === runs.away, y = Number(runs.home > runs.away), p = record.homeProbability;
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return {status:'excluded',reason:'Invalid forecast probability'};
  return {status:'graded',homeF5:runs.home,awayF5:runs.away,tie,result:tie?'tie':y?'home':'away',brier:tie?null:(p-y)**2,logLoss:tie?null:-(y*Math.log(p)+(1-y)*Math.log(1-p)),realizedProfit:null,reason:'Directional grade only; no assumed execution or settlement'};
}
module.exports = {snapshot,grade};
