/**
 * Vercel Serverless Function: /api/scrape-oddsshark
 * 
 * Place this file in: /api/scrape-oddsshark.js
 * 
 * Triggers:
 * - Manual: curl https://your-app.vercel.app/api/scrape-oddsshark
 * - Cron: Set in vercel.json
 * 
 * Returns cached data or triggers fresh scrape
 */

const puppeteer = require('puppeteer-core');
const chrome = require('@sparticuz/chromium');

// In-memory cache (resets on redeploy, but scrapes are fast)
let CACHED_DATA = null;
let CACHE_TIME = null;
const CACHE_TTL = 86400000; // 24 hours

async function scrapeOddsShark() {
  const ODDSSHARK_URL = 'https://www.oddsshark.com/mlb/first-five-inning-betting';
  
  let browser;
  try {
    // Use chromium from Lambda layer (Vercel serverless)
    browser = await puppeteer.launch({
      args: chrome.args,
      defaultViewport: chrome.defaultViewport,
      executablePath: await chrome.executablePath(),
      headless: chrome.headless,
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);
    
    await page.goto(ODDSSHARK_URL, { waitUntil: 'networkidle2' });
    
    const html = await page.content();
    const data = parseOddsShark(html);
    
    await browser.close();
    
    // Update cache
    CACHED_DATA = data;
    CACHE_TIME = Date.now();
    
    return data;
  } catch (error) {
    if (browser) await browser.close();
    throw new Error(`Scrape failed: ${error.message}`);
  }
}

function parseOddsShark(html) {
  // Parse profitable pitchers
  const profitableMatch = html.match(/Most Profitable[\s\S]{0,2000}?<\/table>/i);
  const profitablePitchers = profitableMatch ? parsePitcherTable(profitableMatch[0]) : [];

  // Parse unprofitable pitchers
  const unprofitableMatch = html.match(/Least Profitable[\s\S]{0,2000}?<\/table>/i);
  const unprofitablePitchers = unprofitableMatch ? parsePitcherTable(unprofitableMatch[0]) : [];

  // Parse team records from moneyline table
  const teamMatch = html.match(/F5 Moneyline Records[\s\S]{0,5000}?<\/table>/i);
  const teams = teamMatch ? parseTeamTable(teamMatch[0]) : {};

  return {
    scraped_at: new Date().toISOString(),
    source: 'OddsShark MLB F5 Betting',
    pitchers: {
      profitable: profitablePitchers.slice(0, 15),
      unprofitable: unprofitablePitchers.slice(0, 15)
    },
    teams,
    stats: {
      pitchers_count: profitablePitchers.length + unprofitablePitchers.length,
      teams_count: Object.keys(teams).length
    }
  };
}

function parsePitcherTable(tableHtml) {
  const pitchers = [];
  // Match: Name | Profit | Record
  const regex = /<tr[^>]*>[\s\S]*?<td[^>]*>([^<]+)<\/td>[\s\S]*?<td[^>]*>([\+\-\$\d,.]+)<\/td>[\s\S]*?<td[^>]*>(\d+-\d+-\d+)/g;
  
  let match;
  while ((match = regex.exec(tableHtml)) !== null) {
    const name = match[1].trim();
    const profit = parseFloat(match[2].replace(/[$,\+]/g, '')) || 0;
    const record = match[3].trim();
    
    const [w, l] = record.split('-').map(x => parseInt(x) || 0);
    const total = w + l;
    const winPct = total > 0 ? (w / total) : 0;

    if (name && name.length > 2 && name.length < 30) {
      pitchers.push({ name, profit, record, wins: w, losses: l, winPct });
    }
  }
  return pitchers;
}

function parseTeamTable(tableHtml) {
  const teams = {};
  // Match: Team | W-L-P | Profit
  const regex = /<tr[^>]*>[\s\S]*?<td[^>]*>([A-Z][^<]{2,25}?)<\/td>[\s\S]*?<td[^>]*>(\d+)-(\d+)-(\d+)[\s\S]*?\(([\+\-\$\d,.]+)\)/g;
  
  let match;
  while ((match = regex.exec(tableHtml)) !== null) {
    const team = match[1].trim();
    const wins = parseInt(match[2]) || 0;
    const losses = parseInt(match[3]) || 0;
    const pushes = parseInt(match[4]) || 0;
    const profit = parseFloat(match[5].replace(/[$,\+]/g, '')) || 0;

    const total = wins + losses;
    const winPct = total > 0 ? (wins / total) : 0;

    if (team.length > 2 && team.length < 30 && wins > 0) {
      teams[team] = {
        wins, losses, pushes, profit, winPct,
        record: `${wins}-${losses}-${pushes}`
      };
    }
  }
  return teams;
}

export default async function handler(req, res) {
  try {
    // Check if cache is still fresh
    if (CACHED_DATA && CACHE_TIME && (Date.now() - CACHE_TIME) < CACHE_TTL) {
      console.log('Serving cached OddsShark data');
      return res.status(200).json({
        ...CACHED_DATA,
        cached: true,
        cache_age_minutes: Math.round((Date.now() - CACHE_TIME) / 60000)
      });
    }

    // Cache expired or doesn't exist — scrape fresh
    console.log('Cache expired or missing, scraping fresh...');
    const data = await scrapeOddsShark();

    return res.status(200).json({
      ...data,
      cached: false,
      message: 'Fresh scrape completed'
    });

  } catch (error) {
    console.error('Scrape error:', error);
    
    // Fallback: return cached data even if expired
    if (CACHED_DATA) {
      console.log('Returning stale cache due to scrape failure');
      return res.status(200).json({
        ...CACHED_DATA,
        cached: true,
        stale: true,
        error: error.message,
        cache_age_minutes: Math.round((Date.now() - CACHE_TIME) / 60000)
      });
    }

    return res.status(500).json({ 
      error: error.message,
      message: 'Scraper failed and no cached data available'
    });
  }
}
