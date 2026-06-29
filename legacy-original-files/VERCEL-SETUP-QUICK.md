# Vercel OddsShark Scraper - Quick Setup

## Problem: 404 error
The scraper endpoint wasn't properly configured for Vercel's serverless functions. This fixed version:
- **In-memory caching** (no file I/O issues)
- **Uses `@sparticuz/chromium`** (works on Vercel Lambda)
- **Single API file** (easier deployment)
- **Fallback to stale cache** (graceful degradation)

## Setup (5 minutes)

### 1. Create Next.js app
```bash
npx create-next-app@latest mlb-f5 --typescript=no --eslint=no
cd mlb-f5
```

### 2. Install dependencies
```bash
npm install puppeteer-core @sparticuz/chromium
```

### 3. Add the API file
Create file: `api/scrape-oddsshark.js`

Copy contents from: **api-scrape-oddsshark.js**

### 4. Update config
Replace `vercel.json` with: **vercel-updated.json**

Replace `package.json` with: **package-updated.json**

### 5. Add your React app
Copy your F5 tool (`mlb-f5-standalone.jsx`) into `pages/index.js`

Update the fetch call to use the new endpoint:
```javascript
useEffect(() => {
  fetch('/api/scrape-oddsshark')
    .then(r => r.json())
    .then(data => {
      setOddssharkData({
        pitchers: data.pitchers,
        teams: data.teams
      });
    })
    .catch(e => console.error('Failed to load OddsShark data:', e));
}, []);
```

### 6. Deploy
```bash
npm install -g vercel
vercel
```

## How it works

- **First request**: Scrapes OddsShark (takes ~10-15 seconds)
- **Subsequent requests** (within 24h): Returns cached data instantly
- **24h expires**: Next request triggers fresh scrape
- **If scrape fails**: Returns stale cache (graceful degradation)

## Test locally

Create `test-scraper-local.js`:
```javascript
const fetch = require('node-fetch');

async function test() {
  console.log('Testing scraper...');
  const res = await fetch('http://localhost:3000/api/scrape-oddsshark');
  const data = await res.json();
  console.log('Pitchers:', data.pitchers.profitable.length);
  console.log('Teams:', data.stats.teams_count);
  console.log('Cached:', data.cached);
}

test();
```

Run: `npm run dev` then `node test-scraper-local.js`

## API Response

```json
{
  "scraped_at": "2026-06-15T00:00:00.000Z",
  "cached": true,
  "cache_age_minutes": 45,
  "pitchers": {
    "profitable": [
      { "name": "Jack Leiter", "profit": 794.36, "record": "17-9-3", "wins": 17, "losses": 9, "winPct": 0.654 }
    ],
    "unprofitable": [...]
  },
  "teams": {
    "Yankees": { "wins": 91, "losses": 50, "pushes": 21, "profit": 1036.18, "winPct": 0.645 },
    ...
  },
  "stats": {
    "pitchers_count": 60,
    "teams_count": 30
  }
}
```

## Troubleshooting

**Still getting 404?**
- Check that file is at `/api/scrape-oddsshark.js` (not `/api/scrape/oddsshark.js`)
- Run `npm run build` locally to check for syntax errors
- Deploy again: `vercel --prod`

**Scraper times out?**
- OddsShark may be blocking automated requests
- Add delay: `await page.waitForTimeout(3000);` before content extraction

**Chromium won't download?**
- Vercel installs it automatically; no local action needed
- If still failing, try: `npm install --save-dev @sparticuz/chromium`

**Want to test cron?**
- Vercel cron logs: Dashboard → Project → Cron Jobs
- Manually trigger: `curl https://your-app.vercel.app/api/scrape-oddsshark`

---

Once deployed, your React app fetches fresh OddsShark data automatically every 24h. No more hardcoded data!
