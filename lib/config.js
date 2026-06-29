const TEAM_ABBR = {
  'Arizona Diamondbacks': 'ARI', 'Atlanta Braves': 'ATL', 'Baltimore Orioles': 'BAL', 'Boston Red Sox': 'BOS',
  'Chicago Cubs': 'CHC', 'Chicago White Sox': 'CWS', 'Cincinnati Reds': 'CIN', 'Cleveland Guardians': 'CLE',
  'Colorado Rockies': 'COL', 'Detroit Tigers': 'DET', 'Houston Astros': 'HOU', 'Kansas City Royals': 'KC',
  'Los Angeles Angels': 'LAA', 'Los Angeles Dodgers': 'LAD', 'Miami Marlins': 'MIA', 'Milwaukee Brewers': 'MIL',
  'Minnesota Twins': 'MIN', 'New York Mets': 'NYM', 'New York Yankees': 'NYY', 'Athletics': 'ATH',
  'Oakland Athletics': 'OAK', 'Philadelphia Phillies': 'PHI', 'Pittsburgh Pirates': 'PIT', 'San Diego Padres': 'SD',
  'San Francisco Giants': 'SF', 'Seattle Mariners': 'SEA', 'St. Louis Cardinals': 'STL', 'Tampa Bay Rays': 'TB',
  'Texas Rangers': 'TEX', 'Toronto Blue Jays': 'TOR', 'Washington Nationals': 'WSH'
};

const PARK_FACTORS = {
  ARI: 1.02, ATL: 1.01, BAL: 0.98, BOS: 1.04, CHC: 1.01, CWS: 1.00, CIN: 1.06, CLE: 0.98,
  COL: 1.12, DET: 0.99, HOU: 0.99, KC: 1.01, LAA: 0.99, LAD: 0.98, MIA: 0.96, MIL: 1.01,
  MIN: 0.99, NYM: 0.97, NYY: 1.03, OAK: 0.96, ATH: 0.98, PHI: 1.03, PIT: 0.97, SD: 0.96,
  SF: 0.95, SEA: 0.97, STL: 0.99, TB: 0.98, TEX: 1.02, TOR: 1.01, WSH: 1.00
};

const VENUES = {
  'Chase Field': { lat: 33.4455, lon: -112.0667, indoor: true },
  'Truist Park': { lat: 33.8908, lon: -84.4678 },
  'Oriole Park at Camden Yards': { lat: 39.2839, lon: -76.6217 },
  'Fenway Park': { lat: 42.3467, lon: -71.0972 },
  'Wrigley Field': { lat: 41.9484, lon: -87.6553 },
  'Rate Field': { lat: 41.83, lon: -87.6339 },
  'Great American Ball Park': { lat: 39.0979, lon: -84.5082 },
  'Progressive Field': { lat: 41.4962, lon: -81.6852 },
  'Coors Field': { lat: 39.7561, lon: -104.9942 },
  'Comerica Park': { lat: 42.339, lon: -83.0485 },
  'Daikin Park': { lat: 29.7573, lon: -95.3555, indoor: true },
  'Minute Maid Park': { lat: 29.7573, lon: -95.3555, indoor: true },
  'Kauffman Stadium': { lat: 39.0517, lon: -94.4803 },
  'Angel Stadium': { lat: 33.8003, lon: -117.8827 },
  'Dodger Stadium': { lat: 34.0739, lon: -118.24 },
  'loanDepot park': { lat: 25.7781, lon: -80.2197, indoor: true },
  'American Family Field': { lat: 43.028, lon: -87.9712, indoor: true },
  'Target Field': { lat: 44.9817, lon: -93.2776 },
  'Citi Field': { lat: 40.7571, lon: -73.8458 },
  'Yankee Stadium': { lat: 40.8296, lon: -73.9262 },
  'Sutter Health Park': { lat: 38.5802, lon: -121.5139 },
  'Oakland Coliseum': { lat: 37.7516, lon: -122.2005 },
  'Citizens Bank Park': { lat: 39.9057, lon: -75.1665 },
  'PNC Park': { lat: 40.4469, lon: -80.0057 },
  'Petco Park': { lat: 32.7073, lon: -117.1566 },
  'Oracle Park': { lat: 37.7786, lon: -122.3893 },
  'T-Mobile Park': { lat: 47.5914, lon: -122.3325, indoor: true },
  'Busch Stadium': { lat: 38.6226, lon: -90.1928 },
  'Tropicana Field': { lat: 27.7682, lon: -82.6534, indoor: true },
  'Globe Life Field': { lat: 32.7473, lon: -97.0842, indoor: true },
  'Rogers Centre': { lat: 43.6414, lon: -79.3894, indoor: true },
  'Nationals Park': { lat: 38.873, lon: -77.0074 }
};

module.exports = { TEAM_ABBR, PARK_FACTORS, VENUES };
