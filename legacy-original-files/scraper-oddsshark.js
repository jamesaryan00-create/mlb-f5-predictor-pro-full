/**
 * OddsShark F5 Daily Scraper
 * Runs daily via cron (Vercel, AWS Lambda, etc.)
 * Extracts F5 pitcher profitability + team records
 * Saves to a JSON file in /api/data/oddsshark-f5.json
 */

const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

const ODDSSHARK_URL = 'https://www.oddsshark.com/mlb/first-five-inning-betting';
const OUTPUT_DIR = path.join(process.cwd(), 'public', 'data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'oddsshark-f5.json');

/**
 * Parse pitcher profitability table from HTML
 */
function parsePitcherTable(html, selector, isProfitable = true) {
  const regex = new RegExp(
    selector + '.*?<tr[^>]*>\\s*<td[^>]*>([^<]+)<\\/td>.*?' +
    '<td[^>]*>([\\$\\-\\d,.]+)<\\/td>.*?' +
    '<td[^>]*>([^<]+)<\\/td>.*?<\\/tr>',
    'gi'
  );

  const pitchers = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    const name = match[1].trim();
    const profit = parseFloat(match[2].replace(/[$,]/g, '')) || 0;
    const record = match[3].trim();
    
    // Parse win-loss-push from record (e.g., "17-9-3")
    const parts = record.split('-');
    const wins = parseInt(parts[0]) || 0;
    const losses = parseInt(parts[1]) || 0;
    const total = wins + losses;
    const winPct = total > 0 ? (wins / total) : 0;

    if (name && name.length > 2) {
      pitchers.push({ name, profit, record, wins, losses, winPct });
    }
  }
  return pitchers;
}

/**
 * Parse team F5 records from HTML
 */
function parseTeamRecords(html) {
  // Match team rows from moneyline table
  // Format: Team | W-L-P (+/-$profit)
  const regex = /<tr[^>]*>.*?<td[^>]*>([^<]+)<\/td>.*?<td[^>]*>(\d+)-(\d+)-(\d+).*?\(([\+\-\$\d,.]+)\)/gi;
  
  const teams = {};
  let match;
  while ((match = regex.exec(html)) !== null) {
    const team = match[1].trim();
    const wins = parseInt(match[2]) || 0;
    const losses = parseInt(match[3]) || 0;
    const pushes = parseInt(match[4]) || 0;
    const profit = parseFloat(match[5].replace(/[$,]/g, '')) || 0;
    const total = wins + losses;
    const winPct = total > 0 ? (wins / total) : 0;

    if (team && team.length > 2 && team.length < 30) {
      teams[team] = { wins, losses, pushes, profit, winPct, record: `${wins}-${losses}-${pushes}` };
    }
  }
  return teams;
}

/**
 * Main scraper function
 */
async function scrapeOddsShark() {
  let browser;
  try {
    console.log('[OddsShark Scraper] Launching browser...');
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.goto(ODDSSHARK_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    
    console.log('[OddsShark Scraper] Page loaded, extracting content...');
    const html = await page.content();

    // Parse profitable pitchers
    const profitablePitchers = parsePitcherTable(html, 'Most Profitable', true);
    
    // Parse unprofitable pitchers
    const unprofitablePitchers = parsePitcherTable(html, 'Least Profitable', false);

    // Parse team records
    const teamRecords = parseTeamRecords(html);

    const data = {
      scraped_at: new Date().toISOString(),
      source: 'OddsShark MLB F5 Betting',
      url: ODDSSHARK_URL,
      pitchers: {
        profitable: profitablePitchers.slice(0, 20),
        unprofitable: unprofitablePitchers.slice(0, 20)
      },
      teams: teamRecords,
      stats: {
        total_pitchers: profitablePitchers.length + unprofitablePitchers.length,
        total_teams: Object.keys(teamRecords).length
      }
    };

    // Ensure output directory exists
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    // Write to JSON file
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(data, null, 2));
    
    console.log(`[OddsShark Scraper] ✓ Successfully scraped ${data.stats.total_pitchers} pitchers and ${data.stats.total_teams} teams`);
    console.log(`[OddsShark Scraper] Saved to: ${OUTPUT_FILE}`);

    await browser.close();
    return data;

  } catch (error) {
    console.error('[OddsShark Scraper] Error:', error);
    if (browser) await browser.close();
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  scrapeOddsShark()
    .then(data => {
      console.log('[OddsShark Scraper] Complete:', JSON.stringify(data.stats));
      process.exit(0);
    })
    .catch(err => {
      console.error('[OddsShark Scraper] Failed:', err);
      process.exit(1);
    });
}

module.exports = scrapeOddsShark;
