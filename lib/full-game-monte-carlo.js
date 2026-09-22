function mulberry32(seed) {
  return function random() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const CALIBRATION = require('../data/full-game-mc-calibration.json');
function poisson(lambda, random) {
  const limit = Math.exp(-lambda); let product = 1, k = 0;
  do { k++; product *= random(); } while (product > limit);
  return k - 1;
}
function simulate(inputs, { simulations = 4000, seed = 7 } = {}) {
  const values = ['homeEarlyRuns', 'awayEarlyRuns', 'homeLateRuns', 'awayLateRuns'];
  if (!inputs || !values.every((key) => Number.isFinite(inputs[key]) && inputs[key] >= 0)) return null;
  const random = mulberry32(Number(seed) >>> 0); let homeWins = 0, awayWins = 0, extraInnings = 0;
  let homeRuns = 0, awayRuns = 0;
  for (let i = 0; i < simulations; i++) {
    let home = poisson(inputs.homeEarlyRuns, random) + poisson(inputs.homeLateRuns, random);
    let away = poisson(inputs.awayEarlyRuns, random) + poisson(inputs.awayLateRuns, random);
    if (home === away) {
      extraInnings++;
      // Extra innings must resolve a full-game winner. Home field retains a small empirical edge.
      if (random() < CALIBRATION.extraInningHomeWinProbability) home++; else away++;
    }
    if (home > away) homeWins++; else awayWins++;
    homeRuns += home; awayRuns += away;
  }
  return {
    simulations, seed, homeProbability: homeWins / simulations, awayProbability: awayWins / simulations,
    extraInningsProbability: extraInnings / simulations,
    projectedHomeRuns: homeRuns / simulations, projectedAwayRuns: awayRuns / simulations,
    methodology: 'Independent Poisson early/late run components; venue and extra-inning rates measured from 2023–2025 MLB games.'
  };
}
function forecast(game, inputs, options) {
  const result = simulate(inputs, options);
  if (!result) return { available: false, pick: null, confidence: null };
  const side = result.homeProbability >= result.awayProbability ? 'home' : 'away';
  return { available: true, ...result, side, pick: game[side].name, opponent: game[side === 'home' ? 'away' : 'home'].name, confidence: Number((100 * Math.max(result.homeProbability, result.awayProbability)).toFixed(1)) };
}

function inningArm(snapshot, inning, margin) {
  const available = (snapshot?.tiers || []).filter((arm) => arm.available);
  if (!available.length) return Number.isFinite(snapshot?.runMultiplier) ? snapshot.runMultiplier : 1;
  const close = Math.abs(margin) <= 3;
  const preferred = close ? Math.max(0, 9 - inning) : Math.min(available.length - 1, 4);
  return available[Math.min(preferred, available.length - 1)]?.runMultiplier || snapshot.runMultiplier || 1;
}
function simulateV2(inputs, bullpens, { simulations = 4000, seed = 7, bullpenStrength = 1 } = {}) {
  const values = ['homeEarlyRuns', 'awayEarlyRuns', 'homeLateRuns', 'awayLateRuns'];
  if (!inputs || !values.every((key) => Number.isFinite(inputs[key]) && inputs[key] >= 0)) return null;
  const random = mulberry32(Number(seed) >>> 0); let homeWins=0, awayWins=0, extraInnings=0, homeRuns=0, awayRuns=0;
  for (let i=0;i<simulations;i++) {
    let home=poisson(inputs.homeEarlyRuns,random), away=poisson(inputs.awayEarlyRuns,random);
    for (let inning=6;inning<=9;inning++) {
      const margin=home-away;
      // Away bullpen faces the home offense; home bullpen faces the away offense.
      home += poisson((inputs.homeLateRuns/4) * Math.pow(inningArm(bullpens?.away,inning,margin),bullpenStrength),random);
      away += poisson((inputs.awayLateRuns/4) * Math.pow(inningArm(bullpens?.home,inning,-margin),bullpenStrength),random);
    }
    if(home===away){extraInnings++;if(random()<CALIBRATION.extraInningHomeWinProbability)home++;else away++;}
    if(home>away)homeWins++;else awayWins++; homeRuns+=home;awayRuns+=away;
  }
  return { simulations,seed,homeProbability:homeWins/simulations,awayProbability:awayWins/simulations,extraInningsProbability:extraInnings/simulations,projectedHomeRuns:homeRuns/simulations,projectedAwayRuns:awayRuns/simulations,methodology:'Poisson F5 component plus inning-by-inning relief selection using pregame rolling reliever quality and availability.' };
}

function forecastV2(game, inputs, bullpens, options = {}) {
  if (!bullpens?.home?.available || !bullpens?.away?.available) return { available: false, pick: null, confidence: null, reason: 'Current bullpen evidence unavailable for both teams' };
  const result = simulateV2(inputs, bullpens, { bullpenStrength: .25, ...options });
  if (!result) return { available: false, pick: null, confidence: null, reason: 'Simulation inputs unavailable' };
  const side = result.homeProbability >= result.awayProbability ? 'home' : 'away';
  return { available: true, ...result, side, pick: game[side].name, opponent: game[side === 'home' ? 'away' : 'home'].name, confidence: Number((100 * Math.max(result.homeProbability, result.awayProbability)).toFixed(1)), version: 'bullpen-v2', bullpenThroughDate: bullpens.home.throughDate, rosterVerified: false };
}

module.exports = { mulberry32, poisson, simulate, simulateV2, forecast, forecastV2, inningArm };
