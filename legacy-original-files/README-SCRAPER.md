# OddsShark F5 Daily Scraper Setup

This scraper automatically pulls OddsShark's F5 pitcher profitability data and team records daily, making it available as a JSON API for your React app.

## Files

- **scraper-oddsshark.js** — Puppeteer-based scraper. Extracts pitcher profit data + team F5 records from OddsShark
- **api-handler.js** — Vercel API endpoint. Serves cached data and triggers scrapes
- **vercel.json** — Cron config. Runs scraper daily at midnight UTC
- **package.json** — Dependencies (Next.js, Puppeteer)

## Setup (Vercel)

### 1. Create a Next.js project

```bash
npx create-next-app@latest mlb-f5-tracker
cd mlb-f5-tracker
```

### 2. Install dependencies

```bash
npm install puppeteer
```

### 3. Add files to your project

```
mlb-f5-tracker/
├── api/
│   ├── oddsshark-f5.js          (copy api-handler.js here)
│   └── scrape-oddsshark.js      (copy api-handler.js POST/SCRAPE endpoints)
├── lib/
│   └── scraper-oddsshark.js     (copy scraper-oddsshark.js here)
├── public/
│   └── data/                     (auto-created, stores JSON cache)
├── pages/
│   └── index.js                  (your React F5 tool)
├── vercel.json                   (copy from this package)
└── package.json                  (copy from this package)
```

### 4. Deploy to Vercel

```bash
npm install -g vercel
vercel
```

Vercel will read `vercel.json` and automatically set up the cron job.

### 5. Test the scraper

Manually trigger via API:
```bash
curl -X POST https://your-app.vercel.app/api/scrape-oddsshark
```

Or run locally:
```bash
npm run scrape
```

## How It Works

1. **Cron job runs daily at 00:00 UTC** (edit `vercel.json` schedule if needed)
2. **Scraper launches Puppeteer**, visits OddsShark F5 page
3. **Parses pitcher profit tables** → Extracts name, profit, record, win%
4. **Parses team F5 records** → Extracts W-L-P, profit, team record
5. **Saves to `public/data/oddsshark-f5.json`** (cached for 24h)
6. **React app fetches** via `GET /api/oddsshark-f5`

## API Response Format

```json
{
  "scraped_at": "2026-06-15T00:15:32.123Z",
  "source": "OddsShark MLB F5 Betting",
  "pitchers": {
    "profitable": [
      {
        "name": "Jack Leiter",
        "profit": 794.36,
        "record": "17-9-3",
        "wins": 17,
        "losses": 9,
        "winPct": 0.654
      }
    ],
    "unprofitable": [
      {
        "name": "Andre Pallante",
        "profit": -1500.35,
        "record": "7-22-2",
        "wins": 7,
        "losses": 22,
        "winPct": 0.241
      }
    ]
  },
  "teams": {
    "Yankees": {
      "wins": 91,
      "losses": 50,
      "pushes": 21,
      "profit": 1036.18,
      "winPct": 0.645,
      "record": "91-50-21"
    }
  },
  "stats": {
    "total_pitchers": 60,
    "total_teams": 30
  }
}
```

## Update Your React App

Replace the hardcoded `ODDSSHARK_F5_PITCHERS` and `ODDSSHARK_TEAM_F5` in `mlb-f5-standalone.jsx`:

```javascript
// Before (hardcoded):
const ODDSSHARK_F5_PITCHERS = { ... };
const ODDSSHARK_TEAM_F5 = { ... };

// After (fetch live):
const [oddssharkData, setOddssharkData] = useState(null);

useEffect(() => {
  fetch('/api/oddsshark-f5')
    .then(r => r.json())
    .then(data => setOddssharkData(data))
    .catch(e => console.error('Failed to load OddsShark data:', e));
}, []);

// Then use: oddssharkData.pitchers.profitable, oddssharkData.teams, etc.
```

## Troubleshooting

**Scraper times out:**
- Increase `timeout: 30000` in scraper-oddsshark.js
- OddsShark may be rate-limiting; add a delay: `await page.waitForTimeout(5000)`

**Puppeteer won't install:**
- Vercel Serverless Functions don't support Chromium by default
- Use **Browserless.io** instead (free tier available):
  ```javascript
  const browserless = require('browserless');
  const browser = await browserless.launchChrome();
  ```

**Data not updating:**
- Check Vercel cron logs: Dashboard → Project → Cron Jobs
- Manually trigger: `curl -X POST https://your-app.vercel.app/api/scrape-oddsshark`

## Scheduling

Edit `vercel.json` to change cron time:
```json
"schedule": "0 12 * * *"  // 12:00 UTC (8 AM ET)
```

Cron syntax: `minute hour day month day-of-week`

## Cost

- **Vercel free tier**: ✓ (includes serverless functions + cron)
- **Puppeteer**: ✓ (included)
- **No additional cost** if you stay under Vercel's free limits

---

Once deployed and running, your React app can fetch live F5 data daily. The scraper runs silently in the background, and your tool always has fresh OddsShark numbers.
