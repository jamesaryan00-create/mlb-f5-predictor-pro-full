# MLB F5 Predictor Pro

This is a rebuilt, Vercel-ready Next.js application for MLB First 5 inning predictions.

It replaces the old browser-side Claude call and OddsShark/Puppeteer scraper with server-side API routes and reliable data sources.

## Included features

- Live MLB schedule from MLB Stats data
- Probable starting pitchers when available
- Pitcher season stats
- Team hitting and pitching stats
- Team batting splits vs left/right-handed pitchers when MLB data returns them
- Pitcher handedness matchup support
- Bullpen usage estimate from the last 3 days of completed games
- Park factor adjustment
- Weather adjustment using Open-Meteo and ballpark coordinates
- Live moneyline, spread, and total support through The Odds API
- Estimated EV calculation
- Confidence score and recommendation label
- Deterministic game summary endpoint
- Saved picks using browser local storage
- Backtest API endpoint
- Machine learning model support using the last two completed MLB seasons
- Training script that writes `data/model.json`
- Legacy files preserved in `legacy-original-files/`

## What is not hardcoded

The app does not expose betting or AI keys in the browser. All provider keys belong in `.env.local` locally and Vercel Environment Variables in production.

## Install

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

## API endpoints

```text
/api/games?date=2026-06-28
/api/predictions?date=2026-06-28
/api/summary?date=2026-06-28
/api/backtest?season=2025
```

## Add odds

Create `.env.local`:

```bash
ODDS_API_KEY=your_key_here
ODDS_MARKETS=h2h,spreads,totals
ODDS_REGIONS=us
```

Then restart:

```bash
npm run dev
```

The free Odds API plan can show current MLB odds. Historical odds usually require a paid odds-data plan.

## Train the ML model from the last two MLB seasons

By default, the app ships with seed weights in `data/model.json`. To train from the last two completed seasons:

```bash
TRAIN_SEASONS=2024,2025 npm run train:ml
```

This fetches completed regular-season MLB games, creates rolling team features, trains a lightweight logistic regression model, and overwrites:

```text
data/model.json
```

Commit that file before deploying if you want Vercel to use the trained model.

## Deploy to Vercel

```bash
npm install -g vercel
vercel
```

Then add environment variables in Vercel:

```text
ODDS_API_KEY
ODDS_MARKETS
ODDS_REGIONS
INJURY_API_URL optional
UMPIRE_API_URL optional
```

## Notes on F5-specific odds

This app is wired for moneyline/spread/total markets. If your odds provider exposes true First 5 markets, set `ODDS_MARKETS` to include the provider's exact F5 market keys and adjust `bestBookLine()` in `lib/mlb.js` if the returned market shape differs.

## Notes on injuries and umpires

There is no dependable free official MLB injury/umpire endpoint included. The app has optional `INJURY_API_URL` and `UMPIRE_API_URL` hooks so you can plug in a paid or approved data feed without changing the frontend.

## Important betting note

This is a modeling and research tool. It does not guarantee betting profit. Use responsible bankroll management and verify odds before placing any wager.
