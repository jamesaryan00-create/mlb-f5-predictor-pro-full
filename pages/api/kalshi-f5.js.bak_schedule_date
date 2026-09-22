const BASE = 'https://external-api.kalshi.com/trade-api/v2';
const SERIES = 'KXMLBF5';

const PLAY_THRESHOLD = 0.58;
const STRONG_THRESHOLD = 0.62;
const MAX_SPREAD = 0.15;

const TEAM_MAP = {
  AZ: 'Arizona Diamondbacks',
  ATL: 'Atlanta Braves',
  BAL: 'Baltimore Orioles',
  BOS: 'Boston Red Sox',
  CHC: 'Chicago Cubs',
  CWS: 'Chicago White Sox',
  CIN: 'Cincinnati Reds',
  CLE: 'Cleveland Guardians',
  COL: 'Colorado Rockies',
  DET: 'Detroit Tigers',
  HOU: 'Houston Astros',
  KC: 'Kansas City Royals',
  LAA: 'Los Angeles Angels',
  LAD: 'Los Angeles Dodgers',
  MIA: 'Miami Marlins',
  MIL: 'Milwaukee Brewers',
  MIN: 'Minnesota Twins',
  NYM: 'New York Mets',
  NYY: 'New York Yankees',
  ATH: 'Athletics',
  OAK: 'Athletics',
  PHI: 'Philadelphia Phillies',
  PIT: 'Pittsburgh Pirates',
  SD: 'San Diego Padres',
  SEA: 'Seattle Mariners',
  SF: 'San Francisco Giants',
  STL: 'St. Louis Cardinals',
  TB: 'Tampa Bay Rays',
  TEX: 'Texas Rangers',
  TOR: 'Toronto Blue Jays',
  WSH: 'Washington Nationals'
};

const MONTHS = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04',
  MAY: '05', JUN: '06', JUL: '07', AUG: '08',
  SEP: '09', OCT: '10', NOV: '11', DEC: '12'
};

function normTeam(value) {
  let x = String(value || '')
    .toLowerCase()
    .replace(/[.,'’\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (x === 'oakland athletics') x = 'athletics';

  return x;
}

const ALIASES = Object.keys(TEAM_MAP)
  .sort((a, b) => b.length - a.length);

function parseEvent(eventTicker) {
  const tail = String(eventTicker || '').split('-').pop();

  const m = tail.match(
    /^(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})([A-Z]+)$/
  );

  if (!m) return null;

  const [, yy, mon, dd, hh, mm, blob] = m;

  let awayCode = null;
  let homeCode = null;

  for (const away of ALIASES) {
    if (!blob.startsWith(away)) continue;

    const home = blob.slice(away.length);

    if (TEAM_MAP[home]) {
      awayCode = away;
      homeCode = home;
      break;
    }
  }

  if (!awayCode || !homeCode || !MONTHS[mon]) return null;

  return {
    date: `20${yy}-${MONTHS[mon]}-${dd}`,
    awayCode,
    homeCode,
    awayTeam: TEAM_MAP[awayCode],
    homeTeam: TEAM_MAP[homeCode],
    eventHour: hh,
    eventMinute: mm
  };
}

async function getJson(url) {
  const r = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'mlb-f5-predictor/5.0'
    }
  });

  if (!r.ok) {
    throw new Error(`${r.status} ${r.statusText}: ${url}`);
  }

  return r.json();
}

async function getSchedule(date) {
  const url =
    'https://statsapi.mlb.com/api/v1/schedule' +
    `?sportId=1&date=${encodeURIComponent(date)}`;

  const data = await getJson(url);

  const rows = [];

  for (const dateBlock of data.dates || []) {
    for (const g of dateBlock.games || []) {
      const away = g?.teams?.away?.team?.name;
      const home = g?.teams?.home?.team?.name;

      rows.push({
        gamePk: g.gamePk,
        awayTeam: away,
        homeTeam: home,
        awayNorm: normTeam(away),
        homeNorm: normTeam(home),
        firstPitchUtc: g.gameDate,
        status: g?.status?.detailedState || null
      });
    }
  }

  return rows;
}

async function getLiveMarkets() {
  const markets = [];
  let cursor = null;

  while (true) {
    const params = new URLSearchParams({
      series_ticker: SERIES,
      limit: '1000'
    });

    if (cursor) params.set('cursor', cursor);

    const data = await getJson(
      `${BASE}/markets?${params.toString()}`
    );

    markets.push(...(data.markets || []));

    cursor = data.cursor;

    if (!cursor) break;
  }

  const byTicker = new Map();

  for (const m of markets) {
    if (m?.ticker) byTicker.set(m.ticker, m);
  }

  return [...byTicker.values()];
}

async function latestQuote(ticker, firstPitchUtc, now) {
  const firstPitch = new Date(firstPitchUtc);

  if (now >= firstPitch) return null;

  const cutoff = new Date(
    Math.min(
      now.getTime(),
      firstPitch.getTime() - 1000
    )
  );

  const start = new Date(
    cutoff.getTime() - 6 * 60 * 60 * 1000
  );

  const params = new URLSearchParams({
    start_ts: String(Math.floor(start.getTime() / 1000)),
    end_ts: String(Math.floor(cutoff.getTime() / 1000)),
    period_interval: '1'
  });

  const url =
    `${BASE}/series/${SERIES}/markets/` +
    `${encodeURIComponent(ticker)}/candlesticks?` +
    params.toString();

  let data;

  try {
    data = await getJson(url);
  } catch {
    return null;
  }

  const usable = [];

  for (const c of data.candlesticks || []) {
    const ts = Number(c.end_period_ts);

    if (!Number.isFinite(ts)) continue;

    const dt = new Date(ts * 1000);

    if (dt >= firstPitch) continue;

    const bid = Number(
      c?.yes_bid?.close_dollars
    );

    const ask = Number(
      c?.yes_ask?.close_dollars
    );

    if (
      !Number.isFinite(bid) ||
      !Number.isFinite(ask) ||
      bid < 0 ||
      ask > 1 ||
      ask <= bid
    ) {
      continue;
    }

    const spread = ask - bid;

    if (spread > MAX_SPREAD) continue;

    usable.push({
      time: dt.toISOString(),
      bid,
      ask,
      mid: (bid + ask) / 2,
      spread,
      ageMinutes:
        (now.getTime() - dt.getTime()) / 60000,
      trade: c?.price?.close_dollars ?? null,
      volume: c?.volume_fp ?? null
    });
  }

  usable.sort(
    (a, b) =>
      new Date(a.time) - new Date(b.time)
  );

  return usable.length
    ? usable[usable.length - 1]
    : null;
}

function pacificDate(offsetDays = 0) {
  const now = new Date();

  const parts = new Intl.DateTimeFormat(
    'en-US',
    {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }
  ).formatToParts(
    new Date(
      now.getTime() +
      offsetDays * 24 * 60 * 60 * 1000
    )
  );

  const map = {};

  for (const p of parts) {
    if (p.type !== 'literal') {
      map[p.type] = p.value;
    }
  }

  return `${map.year}-${map.month}-${map.day}`;
}

export default async function handler(req, res) {
  try {
    const now = new Date();

    const today = pacificDate(0);
    const tomorrow = pacificDate(1);

    const [todaySchedule, tomorrowSchedule, markets] =
      await Promise.all([
        getSchedule(today),
        getSchedule(tomorrow),
        getLiveMarkets()
      ]);

    const schedule = [
      ...todaySchedule,
      ...tomorrowSchedule
    ];

    const byEvent = new Map();

    for (const m of markets) {
      const e = m?.event_ticker;

      if (!e) continue;

      if (!byEvent.has(e)) byEvent.set(e, []);

      byEvent.get(e).push(m);
    }

    const candidates = [];

    for (const [eventTicker, eventMarkets] of byEvent) {
      if (eventMarkets.length < 3) continue;

      const parsed = parseEvent(eventTicker);

      if (!parsed) continue;

      if (
        parsed.date !== today &&
        parsed.date !== tomorrow
      ) {
        continue;
      }

      const matches = schedule.filter(
        (g) =>
          g.awayNorm === normTeam(parsed.awayTeam) &&
          g.homeNorm === normTeam(parsed.homeTeam) &&
          String(g.firstPitchUtc || '').slice(0, 10) ===
            parsed.date
      );

      if (matches.length !== 1) continue;

      const game = matches[0];
      const firstPitch = new Date(game.firstPitchUtc);

      if (now >= firstPitch) continue;

      const marketByOutcome = {};

      for (const m of eventMarkets) {
        const suffix =
          String(m.ticker || '').split('-').pop();

        if (suffix === 'TIE') {
          marketByOutcome.TIE = m;
        } else if (suffix === parsed.awayCode) {
          marketByOutcome.AWAY = m;
        } else if (suffix === parsed.homeCode) {
          marketByOutcome.HOME = m;
        }
      }

      if (
        !marketByOutcome.AWAY ||
        !marketByOutcome.HOME ||
        !marketByOutcome.TIE
      ) {
        continue;
      }

      candidates.push({
        eventTicker,
        parsed,
        game,
        markets: marketByOutcome
      });
    }

    const rows = await Promise.all(
      candidates.map(async (item) => {
        const { eventTicker, parsed, game, markets } = item;

        const [awayQ, homeQ, tieQ] =
          await Promise.all([
            latestQuote(
              markets.AWAY.ticker,
              game.firstPitchUtc,
              now
            ),
            latestQuote(
              markets.HOME.ticker,
              game.firstPitchUtc,
              now
            ),
            latestQuote(
              markets.TIE.ticker,
              game.firstPitchUtc,
              now
            )
          ]);

        if (!awayQ || !homeQ || !tieQ) {
          return null;
        }

        const away = awayQ.mid;
        const home = homeQ.mid;
        const tie = tieQ.mid;

        const rawSum = away + home + tie;

        if (!(rawSum > 0)) return null;

        const away3 = away / rawSum;
        const home3 = home / rawSum;
        const tie3 = tie / rawSum;

        const noTie = away + home;

        if (!(noTie > 0)) return null;

        const awayNoTie = away / noTie;
        const homeNoTie = home / noTie;

        let pickSide;
        let pickTeam;
        let confidence;

        if (homeNoTie >= awayNoTie) {
          pickSide = 'HOME';
          pickTeam = parsed.homeTeam;
          confidence = homeNoTie;
        } else {
          pickSide = 'AWAY';
          pickTeam = parsed.awayTeam;
          confidence = awayNoTie;
        }

        let tier = 'PASS';

        if (confidence >= STRONG_THRESHOLD) {
          tier = 'STRONG';
        } else if (confidence >= PLAY_THRESHOLD) {
          tier = 'PLAY';
        }

        const quoteTime = [
          awayQ.time,
          homeQ.time,
          tieQ.time
        ].sort().pop();

        return {
          gamePk: game.gamePk,
          eventTicker,

          awayTeam: parsed.awayTeam,
          homeTeam: parsed.homeTeam,

          firstPitchUtc: game.firstPitchUtc,
          minutesToPitch:
            (new Date(game.firstPitchUtc) - now) / 60000,

          kalshiAwayRaw: away,
          kalshiHomeRaw: home,
          kalshiTieRaw: tie,
          kalshiRawSum: rawSum,

          kalshiAway3Way: away3,
          kalshiHome3Way: home3,
          kalshiTieProb: tie3,

          kalshiAwayProbNoTie: awayNoTie,
          kalshiHomeProbNoTie: homeNoTie,

          kalshiPickSide: pickSide,
          kalshiPickTeam: pickTeam,
          kalshiConfidence: confidence,

          tier,

          quoteTime,
          quoteAgeMinutes:
            (now - new Date(quoteTime)) / 60000,

          awaySpread: awayQ.spread,
          homeSpread: homeQ.spread,
          tieSpread: tieQ.spread,

          marketStatus: game.status
        };
      })
    );

    const board = rows.filter(Boolean);

    const rank = {
      STRONG: 0,
      PLAY: 1,
      PASS: 2
    };

    board.sort((a, b) => {
      if (rank[a.tier] !== rank[b.tier]) {
        return rank[a.tier] - rank[b.tier];
      }

      if (b.kalshiConfidence !== a.kalshiConfidence) {
        return b.kalshiConfidence - a.kalshiConfidence;
      }

      return (
        new Date(a.firstPitchUtc) -
        new Date(b.firstPitchUtc)
      );
    });

    res.setHeader(
      'Cache-Control',
      's-maxage=30, stale-while-revalidate=30'
    );

    return res.status(200).json({
      ok: true,
      version: 'Kalshi F5 V5',
      generatedAt: now.toISOString(),
      thresholds: {
        play: PLAY_THRESHOLD,
        strong: STRONG_THRESHOLD,
        maxSpread: MAX_SPREAD
      },
      marketsLoaded: markets.length,
      candidateEvents: candidates.length,
      board
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      ok: false,
      error: error.message || 'Kalshi F5 API failed'
    });
  }
}
