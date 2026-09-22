#!/usr/bin/env python3
from pathlib import Path
from datetime import datetime
import re
import sys

target = Path("lib/mlb.js")
if not target.exists():
    raise SystemExit("ERROR: lib/mlb.js not found. Run this from the root of mlb-f5-predictor-pro-full.")

text = target.read_text()
stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backup = target.with_name(f"mlb.js.pre-sgo-totals-{stamp}.bak")
backup.write_text(text)

new_markets = r"""const SGO_F5_MARKETS = [
  {
    period: '1h',
    away: 'points-away-1h-ml-away',
    home: 'points-home-1h-ml-home',
    totalOver: 'points-all-1h-ou-over',
    totalUnder: 'points-all-1h-ou-under'
  },
  {
    period: '1ix5',
    away: 'points-away-1ix5-ml-away',
    home: 'points-home-1ix5-ml-home',
    totalOver: 'points-all-1ix5-ou-over',
    totalUnder: 'points-all-1ix5-ou-under'
  }
];

"""

text, n1 = re.subn(
    r"const SGO_F5_MARKETS = \[.*?\];\s*\n",
    new_markets,
    text,
    count=1,
    flags=re.S,
)

new_converter = r"""function sgoToLegacyOddsGame(event) {
  const homeTeam = sgoTeamName(event, 'home');
  const awayTeam = sgoTeamName(event, 'away');

  if (!homeTeam || !awayTeam) return null;

  const rawOdds = event?.odds || {};
  let selected = null;

  // Prefer the newer 1h baseball period, but fall back to legacy 1ix5.
  for (const config of SGO_F5_MARKETS) {
    const awayMarket = rawOdds[config.away];
    const homeMarket = rawOdds[config.home];
    const overMarket = rawOdds[config.totalOver];
    const underMarket = rawOdds[config.totalUnder];

    if ((awayMarket && homeMarket) || (overMarket && underMarket)) {
      selected = {
        ...config,
        awayMarket,
        homeMarket,
        overMarket,
        underMarket
      };
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

  const allBookKeys = new Set();

  for (const market of [
    selected.awayMarket,
    selected.homeMarket,
    selected.overMarket,
    selected.underMarket
  ]) {
    for (const key of Object.keys(market?.byBookmaker || {})) {
      allBookKeys.add(key);
    }
  }

  const bookmakers = [];

  for (const bookKey of allBookKeys) {
    const markets = [];

    // F5 moneyline
    const awayPrice = sgoBookPrice(selected.awayMarket, bookKey);
    const homePrice = sgoBookPrice(selected.homeMarket, bookKey);

    if (Number.isFinite(awayPrice) && Number.isFinite(homePrice)) {
      const outcomes = [
        { name: awayTeam, price: awayPrice },
        { name: homeTeam, price: homePrice }
      ];

      // Native F5 key plus compatibility alias for older dashboard code.
      markets.push({ key: 'h2h_1st_5_innings', outcomes });
      markets.push({ key: 'h2h', outcomes });
    }

    // F5 total
    const overRow = selected.overMarket?.byBookmaker?.[bookKey];
    const underRow = selected.underMarket?.byBookmaker?.[bookKey];

    const overPrice =
      overRow && overRow.available !== false ? Number(overRow.odds) : null;
    const underPrice =
      underRow && underRow.available !== false ? Number(underRow.odds) : null;

    const overPoint =
      overRow && overRow.available !== false ? Number(overRow.overUnder) : null;
    const underPoint =
      underRow && underRow.available !== false ? Number(underRow.overUnder) : null;

    if (
      Number.isFinite(overPrice) &&
      Number.isFinite(underPrice) &&
      Number.isFinite(overPoint) &&
      Number.isFinite(underPoint)
    ) {
      // Main O/U sides should refer to the same total. If a book returns
      // slightly different values, use the midpoint rather than dropping it.
      const point =
        Math.abs(overPoint - underPoint) < 0.001
          ? overPoint
          : (overPoint + underPoint) / 2;

      const totalOutcomes = [
        { name: 'Over', price: overPrice, point },
        { name: 'Under', price: underPrice, point }
      ];

      // Native F5 key plus compatibility alias used by market.total.
      markets.push({
        key: 'totals_1st_5_innings',
        outcomes: totalOutcomes
      });
      markets.push({
        key: 'totals',
        outcomes: totalOutcomes
      });
    }

    if (markets.length) {
      bookmakers.push({
        key: bookKey,
        title: SGO_BOOK_NAMES[bookKey] || bookKey,
        markets
      });
    }
  }

  // Consensus fallbacks if no individual bookmaker is currently available.
  if (!bookmakers.length) {
    const fallbackMarkets = [];

    const awayConsensus = Number(selected.awayMarket?.bookOdds);
    const homeConsensus = Number(selected.homeMarket?.bookOdds);

    if (Number.isFinite(awayConsensus) && Number.isFinite(homeConsensus)) {
      const outcomes = [
        { name: awayTeam, price: awayConsensus },
        { name: homeTeam, price: homeConsensus }
      ];
      fallbackMarkets.push({ key: 'h2h_1st_5_innings', outcomes });
      fallbackMarkets.push({ key: 'h2h', outcomes });
    }

    const overConsensus = Number(selected.overMarket?.bookOdds);
    const underConsensus = Number(selected.underMarket?.bookOdds);
    const totalConsensus = Number(
      selected.overMarket?.bookOverUnder ??
      selected.underMarket?.bookOverUnder
    );

    if (
      Number.isFinite(overConsensus) &&
      Number.isFinite(underConsensus) &&
      Number.isFinite(totalConsensus)
    ) {
      const outcomes = [
        { name: 'Over', price: overConsensus, point: totalConsensus },
        { name: 'Under', price: underConsensus, point: totalConsensus }
      ];
      fallbackMarkets.push({
        key: 'totals_1st_5_innings',
        outcomes
      });
      fallbackMarkets.push({
        key: 'totals',
        outcomes
      });
    }

    if (fallbackMarkets.length) {
      bookmakers.push({
        key: 'sportsgameodds',
        title: 'SportsGameOdds Consensus',
        markets: fallbackMarkets
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

"""

text, n2 = re.subn(
    r"function sgoToLegacyOddsGame\(event\) \{.*?\n\}\s*\n(?=async function getOdds)",
    new_converter,
    text,
    count=1,
    flags=re.S,
)

# Make the API request include both moneyline and total oddIDs.
old_flatmap = ".flatMap((market) => [market.away, market.home])"
new_flatmap = ".flatMap((market) => [market.away, market.home, market.totalOver, market.totalUnder])"
if old_flatmap in text:
    text = text.replace(old_flatmap, new_flatmap, 1)
    n3 = 1
elif new_flatmap in text:
    n3 = 1
else:
    n3 = 0

# Ensure the generic total field prefers F5 totals on this F5 dashboard.
text, n4 = re.subn(
    r"function bestTotal\(oddsGame\) \{\s*return bestTotalForMarket\(oddsGame, 'totals'\);\s*\}",
    "function bestTotal(oddsGame) { return bestTotalForMarket(oddsGame, 'totals_1st_5_innings') || bestTotalForMarket(oddsGame, 'totals'); }",
    text,
    count=1,
)

if not (n1 == 1 and n2 == 1 and n3 == 1):
    print("ERROR: The expected SportsGameOdds patch structure was not found.")
    print(f"Backup created: {backup}")
    print(f"Matches: markets={n1}, converter={n2}, request={n3}, bestTotal={n4}")
    print("No changes were written.")
    sys.exit(1)

target.write_text(text)

print("SUCCESS: SportsGameOdds F5 totals added.")
print(f"Backup: {backup}")
print("Added:")
print("  - F5 Over/Under market IDs (1h + 1ix5 fallback)")
print("  - bookmaker overUnder lines")
print("  - totals_1st_5_innings mapping")
print("  - totals compatibility mapping")
print("  - F5 total preference for dashboard Total field")
print("")
print("Next:")
print("  npm run build")
print("  npm run dev")
