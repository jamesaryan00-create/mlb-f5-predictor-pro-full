const DEFAULT_URL = 'https://www.teamrankings.com/mlb/stat/first-5-innings-runs-per-game';
const CACHE_MS = Number(process.env.TEAMRANKINGS_F5_CACHE_MS || 30 * 60 * 1000);
const OVERLAY_STRENGTH = Number(process.env.TEAMRANKINGS_F5_OVERLAY_STRENGTH || 0.35);
const MAX_LOGIT_ADJUSTMENT = Number(process.env.TEAMRANKINGS_F5_MAX_LOGIT || 0.14);

let cache = { at: 0, rows: null, error: null };

const TEAM_ALIASES = {
  'Washington': 'WSH',
  'Minnesota': 'MIN',
  'Chi Sox': 'CWS',
  'Chicago White Sox': 'CWS',
  'Pittsburgh': 'PIT',
  'LA Dodgers': 'LAD',
  'Los Angeles Dodgers': 'LAD',
  'Chi Cubs': 'CHC',
  'Chicago Cubs': 'CHC',
  'Colorado': 'COL',
  'Milwaukee': 'MIL',
  'Detroit': 'DET',
  'Houston': 'HOU',
  'Atlanta': 'ATL',
  'Miami': 'MIA',
  'Boston': 'BOS',
  'Tampa Bay': 'TB',
  'LA Angels': 'LAA',
  'Los Angeles Angels': 'LAA',
  'Cincinnati': 'CIN',
  'Baltimore': 'BAL',
  'Philadelphia': 'PHI',
  'St. Louis': 'STL',
  'Arizona': 'AZ',
  'Texas': 'TEX',
  'Sacramento': 'ATH',
  'Athletics': 'ATH',
  'Oakland': 'ATH',
  'NY Yankees': 'NYY',
  'New York Yankees': 'NYY',
  'Cleveland': 'CLE',
  'NY Mets': 'NYM',
  'New York Mets': 'NYM',
  'San Diego': 'SD',
  'Kansas City': 'KC',
  'SF Giants': 'SF',
  'San Francisco Giants': 'SF',
  'Seattle': 'SEA',
  'Toronto': 'TOR'
};

const ABBR_ALIASES = {
  WSH: 'WSH', WAS: 'WSH', MIN: 'MIN', CWS: 'CWS', CHW: 'CWS', PIT: 'PIT',
  LAD: 'LAD', CHC: 'CHC', COL: 'COL', MIL: 'MIL', DET: 'DET', HOU: 'HOU',
  ATL: 'ATL', MIA: 'MIA', BOS: 'BOS', TB: 'TB', TBR: 'TB', LAA: 'LAA',
  CIN: 'CIN', BAL: 'BAL', PHI: 'PHI', STL: 'STL', AZ: 'AZ', ARI: 'AZ',
  TEX: 'TEX', ATH: 'ATH', OAK: 'ATH', SAC: 'ATH', NYY: 'NYY', CLE: 'CLE',
  NYM: 'NYM', SD: 'SD', SDP: 'SD', KC: 'KC', KCR: 'KC', SF: 'SF', SFG: 'SF',
  SEA: 'SEA', TOR: 'TOR'
};

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

function logit(p) {
  const x = clamp(p, 0.001, 0.999);
  return Math.log(x / (1 - x));
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function textFromHtml(s) {
  return decodeHtml(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function toNumber(value) {
  const n = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function normalizeAbbr(abbr) {
  const key = String(abbr || '').toUpperCase().trim();
  return ABBR_ALIASES[key] || key;
}

function parseTeamRankingsF5Html(html) {
  const rows = {};
  const trMatches = String(html || '').match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];

  for (const tr of trMatches) {
    const cellMatches = tr.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi) || [];
    const cells = cellMatches.map(textFromHtml);
    if (cells.length < 8) continue;

    // Rank | Team | Season | Last 3 | Last 1 | Home | Away | Prior season
    const rank = toNumber(cells[0]);
    const teamName = cells[1];
    const abbr = TEAM_ALIASES[teamName];
    const season = toNumber(cells[2]);
    const last3 = toNumber(cells[3]);
    const last1 = toNumber(cells[4]);
    const home = toNumber(cells[5]);
    const away = toNumber(cells[6]);
    const priorSeason = toNumber(cells[7]);

    if (!rank || !abbr || season == null) continue;
    rows[abbr] = { rank, teamName, season, last3, last1, home, away, priorSeason };
  }

  if (Object.keys(rows).length < 25) {
    throw new Error(`TeamRankings parse returned only ${Object.keys(rows).length} MLB teams`);
  }
  return rows;
}

async function getTeamRankingsF5({ force = false, url = process.env.TEAMRANKINGS_F5_URL || DEFAULT_URL } = {}) {
  if (!force && cache.rows && Date.now() - cache.at < CACHE_MS) {
    return { available: true, rows: cache.rows, cached: true, fetchedAt: new Date(cache.at).toISOString(), source: url };
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MLB-F5-Predictor/1.0)',
        'Accept': 'text/html,application/xhtml+xml'
      },
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`TeamRankings HTTP ${response.status}`);
    const html = await response.text();
    const rows = parseTeamRankingsF5Html(html);
    cache = { at: Date.now(), rows, error: null };
    return { available: true, rows, cached: false, fetchedAt: new Date(cache.at).toISOString(), source: url };
  } catch (error) {
    cache.error = String(error?.message || error);
    return { available: false, rows: cache.rows, cached: Boolean(cache.rows), reason: cache.error, source: url };
  }
}

function contextualRuns(row, isHome) {
  if (!row) return null;
  const season = row.season;
  const venue = isHome ? row.home : row.away;
  const last3 = row.last3;
  const last1 = row.last1;
  if (![season, venue].every(Number.isFinite)) return null;

  // Venue split carries most of the live context; recent samples are intentionally shrunk.
  const v3 = Number.isFinite(last3) ? last3 : season;
  const v1 = Number.isFinite(last1) ? last1 : season;
  return 0.55 * venue + 0.20 * v3 + 0.05 * v1 + 0.20 * season;
}

function adjustMlProbabilityWithTeamRankings({
  baseMlProbability,
  homeAbbr,
  awayAbbr,
  rows,
  homeF5RunWeight = 0.671054,
  strength = OVERLAY_STRENGTH,
  maxLogitAdjustment = MAX_LOGIT_ADJUSTMENT
}) {
  const p0 = Number(baseMlProbability) > 1 ? Number(baseMlProbability) / 100 : Number(baseMlProbability);
  const hKey = normalizeAbbr(homeAbbr);
  const aKey = normalizeAbbr(awayAbbr);
  const homeRow = rows?.[hKey];
  const awayRow = rows?.[aKey];

  if (!Number.isFinite(p0) || !homeRow || !awayRow) {
    return { available: false, adjustedProbability: p0, reason: 'Missing base probability or TeamRankings team row' };
  }

  const homeContext = contextualRuns(homeRow, true);
  const awayContext = contextualRuns(awayRow, false);
  if (!Number.isFinite(homeContext) || !Number.isFinite(awayContext)) {
    return { available: false, adjustedProbability: p0, reason: 'Missing TeamRankings venue split' };
  }

  // The trained model already contains season-level homeF5RunDiff. Only add the
  // venue/recent deviation from season baseline, avoiding duplicate counting.
  const homeDeltaFromSeason = homeContext - homeRow.season;
  const awayDeltaFromSeason = awayContext - awayRow.season;
  const contextualRunDiff = homeDeltaFromSeason - awayDeltaFromSeason;

  const rawLogitAdjustment = strength * Number(homeF5RunWeight || 0) * contextualRunDiff;
  const logitAdjustment = clamp(rawLogitAdjustment, -Math.abs(maxLogitAdjustment), Math.abs(maxLogitAdjustment));
  const p1 = sigmoid(logit(p0) + logitAdjustment);

  return {
    available: true,
    adjustedProbability: p1,
    baseProbability: p0,
    probabilityDelta: p1 - p0,
    logitAdjustment,
    contextualRunDiff,
    home: { abbr: hKey, ...homeRow, contextualRuns: homeContext, deltaFromSeason: homeDeltaFromSeason },
    away: { abbr: aKey, ...awayRow, contextualRuns: awayContext, deltaFromSeason: awayDeltaFromSeason },
    methodology: {
      contextualRuns: '55% venue split + 20% last 3 + 5% last 1 + 20% season',
      overlay: 'Applies only venue/recent deviation from season baseline in logit space',
      strength,
      maxLogitAdjustment,
      homeF5RunWeight
    }
  };
}

async function getAdjustedMlProbability(args) {
  const feed = await getTeamRankingsF5();
  if (!feed.rows) {
    return { available: false, adjustedProbability: Number(args.baseMlProbability), reason: feed.reason, source: feed.source };
  }
  const result = adjustMlProbabilityWithTeamRankings({ ...args, rows: feed.rows });
  return { ...result, source: feed.source, fetchedAt: feed.fetchedAt, cached: feed.cached };
}

module.exports = { parseTeamRankingsF5Html, getTeamRankingsF5, adjustMlProbabilityWithTeamRankings, getAdjustedMlProbability };
