const { fetchJson, num } = require('../../lib/mlb');

function f5(game) {
  const innings = game.linescore?.innings || [];
  let h = 0, a = 0;
  innings.slice(0, 5).forEach((inn) => { h += num(inn.home?.runs, 0); a += num(inn.away?.runs, 0); });
  return { h, a };
}

export default async function handler(req, res) {
  try {
    const season = Number(req.query.season || new Date().getFullYear() - 1);
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&season=${season}&gameType=R&hydrate=linescore`;
    const data = await fetchJson(url, { ttl: 1000 * 60 * 60 * 24 });
    const games = (data.dates || []).flatMap((d) => d.games || []).filter((g) => g.status?.abstractGameState === 'Final');
    let homeF5 = 0, awayF5 = 0, ties = 0, total = 0;
    games.forEach((g) => {
      const score = f5(g); total += 1;
      if (score.h > score.a) homeF5 += 1;
      else if (score.a > score.h) awayF5 += 1;
      else ties += 1;
    });
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json({ season, games: total, homeF5Wins: homeF5, awayF5Wins: awayF5, f5Ties: ties, homeF5WinPct: total ? Number((homeF5 / total).toFixed(4)) : 0, tiePct: total ? Number((ties / total).toFixed(4)) : 0 });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
