#!/usr/bin/env python3
from pathlib import Path
import re
import sys
from datetime import datetime

target = Path("lib/mlb.js")

if not target.exists():
    raise SystemExit("ERROR: lib/mlb.js not found. Run this from the root of mlb-f5-predictor-pro-full.")

text = target.read_text()

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backup = target.with_name(f"mlb.js.pre-sgo-{stamp}.bak")
backup.write_text(text)

text = re.sub(
    r"const\s+ODDS_BASE\s*=\s*['\"]https://api\.the-odds-api\.com/v4['\"]\s*;",
    "const SGO_BASE = 'https://api.sportsgameodds.com/v2';",
    text,
    count=1,
)

replacement = r'''const SGO_BOOK_NAMES = {
  draftkings: 'DraftKings',
  fanduel: 'FanDuel',
  betmgm: 'BetMGM',
  caesars: 'Caesars',
  espnbet: 'ESPN BET',
  fanatics: 'Fanatics',
  bet365: 'bet365',
  pinnacle: 'Pinnacle',
  bovada: 'Bovada'
};

const SGO_F5_MARKETS = [
  {
    period: '1h',
    away: 'points-away-1h-ml-away',
    home: 'points-home-1h-ml-home'
  },
  {
    period: '1ix5',
    away: 'points-away-1ix5-ml-away',
    home: 'points-home-1ix5-ml-home'
  }
];

function sgoTeamName(event, side) {
  const team = event?.teams?.[side] || {};
  const names = team.names || {};
  return names.long || names.medium || names.short || team.name || null;
}

function sgoBookPrice(market, bookKey) {
  const row = market?.byBookmaker?.[bookKey];
  if (!row || row.available === false) return null;

  const price = Number(row.odds);
  return Number.isFinite(price) ? price : null;
}

function sgoToLegacyOddsGame(event) {
  const homeTeam = sgoTeamName(event, 'home');
  const awayTeam = sgoTeamName(event, 'away');

  if (!homeTeam || !awayTeam) return null;

  const rawOdds = event?.odds || {};
  let selected = null;

  for (const config of SGO_F5_MARKETS) {
    const awayMarket = rawOdds[config.away];
    const homeMarket = rawOdds[config.home];

    if (awayMarket && homeMarket) {
      selected = { ...config, awayMarket, homeMarket };
      break;
    }
  }

  if (!selected) {
    return {
      id: event.eventID || event.id || null,
      home_team: homeTeam,
      away_team: awayTeam,
      commence_time: event?.status?.startsAt || event.startTime || event.startsAt || null,
      bookmakers: [],
      sgo_period: null
    };
  }

  const awayBooks = Object.keys(selected.awayMarket?.byBookmaker || {});
  const homeBooks = new Set(Object.keys(selected.homeMarket?.byBookmaker || {}));
  const commonBooks = awayBooks.filter((key) => homeBooks.has(key));

  const bookmakers = commonBooks.flatMap((bookKey) => {
    const awayPrice = sgoBookPrice(selected.awayMarket, bookKey);
    const homePrice = sgoBookPrice(selected.homeMarket, bookKey);

    if (!Number.isFinite(awayPrice) || !Number.isFinite(homePrice)) return [];

    const outcomes = [
      { name: awayTeam, price: awayPrice },
      { name: homeTeam, price: homePrice }
    ];

    return [{
      key: bookKey,
      title: SGO_BOOK_NAMES[bookKey] || bookKey,
      markets: [
        { key: 'h2h_1st_5_innings', outcomes }
      ]
    }];
  });

  if (!bookmakers.length) {
    const awayConsensus = Number(selected.awayMarket?.bookOdds);
    const homeConsensus = Number(selected.homeMarket?.bookOdds);

    if (Number.isFinite(awayConsensus) && Number.isFinite(homeConsensus)) {
      bookmakers.push({
        key: 'sportsgameodds',
        title: 'SportsGameOdds Consensus',
        markets: [{
          key: 'h2h_1st_5_innings',
          outcomes: [
            { name: awayTeam, price: awayConsensus },
            { name: homeTeam, price: homeConsensus }
          ]
        }]
      });
    }
  }

  return {
    id: event.eventID || event.id || null,
    home_team: homeTeam,
    away_team: awayTeam,
    commence_time: event?.status?.startsAt || event.startTime || event.startsAt || null,
    bookmakers,
    sgo_period: selected.period
  };
}

async function getOdds() {
  const apiKey = process.env.SGO_API_KEY;

  if (!apiKey) {
    return {
      available: false,
      games: [],
      reason: 'SGO_API_KEY is not set'
    };
  }

  const oddIDs = SGO_F5_MARKETS
    .flatMap((market) => [market.away, market.home])
    .join(',');

  const params = new URLSearchParams({
    leagueID: 'MLB',
    type: 'match',
    oddsAvailable: 'true',
    started: 'false',
    oddID: oddIDs,
    limit: '100'
  });

  const url = `${SGO_BASE}/events?${params.toString()}`;
  const cacheKey = `sgo:${url}`;
  const hit = cache.get(cacheKey);

  if (hit && Date.now() - hit.time < 1000 * 60 * 5) {
    return hit.data;
  }

  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'x-api-key': apiKey,
      'user-agent': 'mlb-f5-predictor/4.0'
    }
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SportsGameOdds request failed ${res.status}: ${body.slice(0, 240)}`);
  }

  const payload = await res.json();

  if (payload?.success === false) {
    throw new Error(`SportsGameOdds request failed: ${JSON.stringify(payload.error || payload).slice(0, 240)}`);
  }

  const games = (payload?.data || [])
    .map(sgoToLegacyOddsGame)
    .filter(Boolean);

  const result = {
    available: games.some((game) => (game.bookmakers || []).length > 0),
    games,
    markets: 'h2h_1st_5_innings',
    provider: 'SportsGameOdds',
    reason: games.length ? null : 'No upcoming MLB events returned by SportsGameOdds'
  };

  cache.set(cacheKey, { time: Date.now(), data: result });
  return result;
}

async function getF5OddsForEvent(oddsGame) {
  if (!process.env.SGO_API_KEY) {
    return {
      available: false,
      game: null,
      reason: 'SGO_API_KEY is not set'
    };
  }

  if (String(process.env.ODDS_F5_ENABLED || 'true').toLowerCase() === 'false') {
    return {
      available: false,
      game: null,
      reason: 'ODDS_F5_ENABLED=false'
    };
  }

  if (!oddsGame) {
    return {
      available: false,
      game: null,
      reason: 'SportsGameOdds event unavailable'
    };
  }

  const hasF5 = marketOutcomes(oddsGame, 'h2h_1st_5_innings').length > 0;

  return {
    available: hasF5,
    game: hasF5 ? oddsGame : null,
    markets: 'h2h_1st_5_innings',
    provider: 'SportsGameOdds',
    period: oddsGame.sgo_period || null,
    reason: hasF5 ? null : 'F5 moneyline is not currently available for this game'
  };
}

'''

pattern = re.compile(
    r"async function getOdds\(\)\s*\{.*?\n\}\s*\n\s*"
    r"async function getF5OddsForEvent\(oddsGame\)\s*\{.*?\n\}\s*\n\s*"
    r"(?=function marketOutcomes)",
    re.S,
)

new_text, count = pattern.subn(replacement, text, count=1)

if count != 1:
    print("ERROR: Could not find the current getOdds/getF5OddsForEvent block.")
    print(f"Backup created at: {backup}")
    print("No changes were written.")
    sys.exit(1)

if "const SGO_BASE = 'https://api.sportsgameodds.com/v2';" not in new_text:
    new_text = new_text.replace(
        "const MLB_BASE = 'https://statsapi.mlb.com/api/v1';",
        "const MLB_BASE = 'https://statsapi.mlb.com/api/v1';\nconst SGO_BASE = 'https://api.sportsgameodds.com/v2';",
        1,
    )

target.write_text(new_text)

print("SUCCESS: SportsGameOdds provider installed.")
print(f"Backup: {backup}")
print("Changed: lib/mlb.js")
print("")
print("Next:")
print("  1) Set SGO_API_KEY in .env.local")
print("  2) npm run build")
print("  3) npm run dev")
