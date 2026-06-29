/**
 * Vercel API Handler: GET /api/oddsshark-f5
 * 
 * Usage:
 * - Deploy scraper-oddsshark.js as a cron job on Vercel
 * - This endpoint serves the cached JSON data
 * 
 * Cron config (vercel.json):
 * {
 *   "crons": [{
 *     "path": "/api/scrape-oddsshark",
 *     "schedule": "0 0 * * *"
 *   }]
 * }
 */

const fs = require('fs');
const path = require('path');
const scrapeOddsShark = require('../../lib/scraper-oddsshark');

// GET endpoint: return cached data
export async function GET(req, res) {
  try {
    const dataFile = path.join(process.cwd(), 'public', 'data', 'oddsshark-f5.json');
    
    if (fs.existsSync(dataFile)) {
      const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      return res.status(200).json(data);
    } else {
      return res.status(404).json({ error: 'Data not yet cached. Run scraper first.' });
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// POST endpoint: trigger scrape immediately (for manual refresh)
export async function POST(req, res) {
  try {
    const data = await scrapeOddsShark();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// CRON endpoint: scheduled daily scrape (Vercel cron)
export async function SCRAPE(req, res) {
  try {
    const data = await scrapeOddsShark();
    return res.status(200).json({ success: true, message: 'Scrape completed', stats: data.stats });
  } catch (error) {
    console.error('Cron scrape failed:', error);
    return res.status(500).json({ error: error.message });
  }
}
