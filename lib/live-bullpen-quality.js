const MLB_BASE = 'https://statsapi.mlb.com/api/v1';
const CACHE_MS = 30 * 60 * 1000;
const cache = new Map();
const isoDay = (value) => String(value || '').slice(0, 10);
const dayNumber = (value) => Math.floor(Date.parse(`${isoDay(value)}T12:00:00Z`) / 86400000);
const addDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const number = (value) => { const n = Number(value); return Number.isFinite(n) ? n : 0; };

async function json(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`MLB Stats API ${response.status}`);
  return response.json();
}

function reliefAppearance(box, side, teamId, day) {
  const team = box?.teams?.[side];
  if (Number(team?.team?.id) !== Number(teamId) || !Array.isArray(team.pitchers)) return null;
  const rows = [];
  for (const pitcher of team.pitchers) {
    const stats = team.players?.[`ID${pitcher}`]?.stats?.pitching;
    if (!stats || Number(stats.gamesStarted) === 1) continue;
    const outs = number(stats.outs), pitches = number(stats.numberOfPitches ?? stats.pitchesThrown);
    if (!outs && !pitches) continue;
    rows.push({ pitcher: Number(pitcher), day, outs, pitches, h: number(stats.hits), bb: number(stats.baseOnBalls), hbp: number(stats.hitBatsmen), hr: number(stats.homeRuns), k: number(stats.strikeOuts) });
  }
  return rows;
}

function snapshot(appearances, date) {
  const target = dayNumber(date), byPitcher = new Map();
  for (const row of appearances) {
    if (!(target - row.day > 0 && target - row.day <= 45)) continue;
    if (!byPitcher.has(row.pitcher)) byPitcher.set(row.pitcher, []);
    byPitcher.get(row.pitcher).push(row);
  }
  const arms = [];
  for (const [pitcher, history] of byPitcher) {
    const recent = history.sort((a, b) => a.day - b.day).slice(-12);
    const ip = recent.reduce((s, r) => s + r.outs, 0) / 3;
    const fipNumerator = recent.reduce((s, r) => s + 13 * r.hr + 3 * (r.bb + r.hbp) - 2 * r.k, 0);
    const fip = (fipNumerator + 12 * (4.2 - 3.2)) / (ip + 12) + 3.2;
    const whip = (recent.reduce((s, r) => s + r.h + r.bb, 0) + 12 * 1.3) / (ip + 12);
    const pitches3 = recent.filter((r) => target - r.day <= 3).reduce((s, r) => s + r.pitches, 0);
    const days = new Set(recent.map((r) => r.day));
    const yesterday = recent.filter((r) => r.day === target - 1).reduce((s, r) => s + r.pitches, 0);
    const available = !(days.has(target - 1) && days.has(target - 2)) && yesterday < 25;
    const score = fip + .7 * (whip - 1.3) + Math.min(.35, pitches3 / 180);
    const runMultiplier = Math.exp(Math.max(-.45, Math.min(.55, (fip - 4.2) * .08 + (whip - 1.3) * .15 + Math.min(.3, pitches3 / 220))));
    arms.push({ pitcher, available, pitchesLast3: pitches3, score, runMultiplier });
  }
  arms.sort((a, b) => a.score - b.score);
  const tiers = arms.slice(0, 6).map(({ pitcher, available, pitchesLast3, runMultiplier }) => ({ pitcher, available, pitchesLast3, runMultiplier }));
  return { available: tiers.length > 0, source: 'MLB Stats API prior-game box scores', throughDate: addDays(date, -1), rosterVerified: false, statcastAvailable: false, tiers };
}

async function getLiveBullpens(teamIds, date) {
  const ids = [...new Set(teamIds.filter(Boolean).map(Number))];
  const key = `${date}:${ids.slice().sort().join(',')}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.time < CACHE_MS) return cached.value;
  const start = addDays(date, -45), end = addDays(date, -1);
  const schedule = await json(`${MLB_BASE}/schedule?sportId=1&gameType=R&startDate=${start}&endDate=${end}`);
  const games = [...new Map((schedule.dates || []).flatMap((d) => d.games || []).filter((g) =>
    /^Final/.test(g.status?.detailedState || '') && ids.some((id) => id === g.teams?.home?.team?.id || id === g.teams?.away?.team?.id)
  ).map((g) => [g.gamePk, g])).values()];
  const appearances = Object.fromEntries(ids.map((id) => [id, []]));
  let cursor = 0;
  async function worker() {
    while (cursor < games.length) {
      const game = games[cursor++];
      const box = await json(`${MLB_BASE}/game/${game.gamePk}/boxscore`);
      const day = dayNumber(game.officialDate || game.gameDate);
      for (const side of ['home', 'away']) {
        const id = game.teams?.[side]?.team?.id;
        if (!appearances[id]) continue;
        const rows = reliefAppearance(box, side, id, day);
        if (!rows) throw new Error(`Incomplete box score ${game.gamePk}`);
        appearances[id].push(...rows);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, games.length) }, worker));
  const value = Object.fromEntries(ids.map((id) => [id, snapshot(appearances[id], date)]));
  cache.set(key, { time: Date.now(), value });
  return value;
}

module.exports = { reliefAppearance, snapshot, getLiveBullpens };
