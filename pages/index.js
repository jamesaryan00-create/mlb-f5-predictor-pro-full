import { useEffect, useMemo, useState } from 'react';

function todayPacific() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function fmtTime(value) { if (!value) return 'TBD'; return new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(value)); }
function moneyline(value) { if (value === null || value === undefined) return 'N/A'; const n = Number(value); if (!Number.isFinite(n)) return 'N/A'; return n > 0 ? `+${n}` : `${n}`; }
function stat(value, fallback = 'N/A') { if (value === undefined || value === null || value === '') return fallback; return value; }
function pct(value) { return value === null || value === undefined ? 'N/A' : `${value}%`; }
function ResultBadge({ label }) { return <span className={`badge ${String(label || 'Pass').replace(/\s+/g, '-').toLowerCase()}`}>{label}</span>; }

function FactorGrid({ game }) {
  const w = game.factors?.weather || {};
  const indoor = w.indoor ? 'Indoor/roof' : w.available ? `${stat(w.temperature)}°F · wind ${stat(w.windMph)} mph · rain ${stat(w.precipitationProbability)}%` : 'N/A';
  return (
    <div className="factorGrid">
      <div><span>Park factor</span><strong>{game.factors?.parkFactor || 'N/A'}</strong></div>
      <div><span>Weather</span><strong>{indoor}</strong></div>
      <div><span>ML probability</span><strong>{pct(game.prediction.mlProbability)}</strong></div>
      <div><span>Best book</span><strong>{game.prediction.bestBook || 'N/A'}</strong></div>
    </div>
  );
}

function GameCard({ game, onSave, saved }) {
  const pickHome = game.prediction.pick === game.home.name;
  return (
    <article className="card">
      <div className="cardTop">
        <div>
          <p className="eyebrow">{fmtTime(game.gameDate)} · {game.status}</p>
          <h2>{game.away.name} @ {game.home.name}</h2>
          <p className="muted">{game.venue}</p>
        </div>
        <div className="badgeStack">
          <ResultBadge label={game.prediction.label} />
          <button className="ghost" onClick={() => onSave(game)}>{saved ? 'Saved' : 'Save pick'}</button>
        </div>
      </div>

      <div className="teamGrid">
        <div className={`teamBox ${!pickHome ? 'picked' : ''}`}>
          <div className="teamHeader"><strong>{game.away.abbreviation}</strong><span>{game.away.rating}</span></div>
          <p>{game.away.name}</p>
          <small>SP: {game.away.probablePitcher?.fullName || 'TBD'} {game.away.pitcherBio?.throws ? `(${game.away.pitcherBio.throws})` : ''}</small>
          <small>ERA {stat(game.away.pitcherStats?.era)} · WHIP {stat(game.away.pitcherStats?.whip)} · K/9 {stat(game.away.pitcherStats?.strikeoutsPer9Inn)}</small>
          <small>ML: {moneyline(game.away.moneyline)} {game.away.bestBook ? `at ${game.away.bestBook}` : ''}</small>
          <small>BP last 3 days: {stat(game.away.bullpen?.relieverInnings3d)} IP</small>
        </div>

        <div className={`teamBox ${pickHome ? 'picked' : ''}`}>
          <div className="teamHeader"><strong>{game.home.abbreviation}</strong><span>{game.home.rating}</span></div>
          <p>{game.home.name}</p>
          <small>SP: {game.home.probablePitcher?.fullName || 'TBD'} {game.home.pitcherBio?.throws ? `(${game.home.pitcherBio.throws})` : ''}</small>
          <small>ERA {stat(game.home.pitcherStats?.era)} · WHIP {stat(game.home.pitcherStats?.whip)} · K/9 {stat(game.home.pitcherStats?.strikeoutsPer9Inn)}</small>
          <small>ML: {moneyline(game.home.moneyline)} {game.home.bestBook ? `at ${game.home.bestBook}` : ''}</small>
          <small>BP last 3 days: {stat(game.home.bullpen?.relieverInnings3d)} IP</small>
        </div>
      </div>

      <div className="prediction">
        <div>
          <p className="eyebrow">F5 model pick</p>
          <h3>{game.prediction.pick}</h3>
          <p className="muted">Edge {game.prediction.edge > 0 ? '+' : ''}{game.prediction.edge} · Confidence {game.prediction.confidence}% · Blended win probability {game.prediction.modelProbability}%</p>
        </div>
        <div className="evBox">
          <span>Total</span><strong>{game.market.total?.point || 'N/A'}</strong>
          <span>Best ML</span><strong>{moneyline(game.prediction.bestMoneyline)}</strong>
          <span>Est. EV</span><strong>{game.prediction.estimatedEV === null ? 'N/A' : `${game.prediction.estimatedEV > 0 ? '+' : ''}${game.prediction.estimatedEV}%`}</strong>
        </div>
      </div>
      <FactorGrid game={game} />
      <p className="note">{game.prediction.note}</p>
    </article>
  );
}

export default function Home() {
  const [date, setDate] = useState(todayPacific());
  const [data, setData] = useState(null);
  const [summary, setSummary] = useState('');
  const [backtest, setBacktest] = useState(null);
  const [season, setSeason] = useState(new Date().getFullYear() - 1);
  const [saved, setSaved] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => { setSaved(JSON.parse(localStorage.getItem('saved-picks') || '[]')); }, []);
  function persist(items) { setSaved(items); localStorage.setItem('saved-picks', JSON.stringify(items)); }
  function savePick(game) {
    const id = `${game.gamePk}-${game.prediction.pick}`;
    const exists = saved.some((x) => x.id === id);
    persist(exists ? saved.filter((x) => x.id !== id) : [{ id, date, pick: game.prediction.pick, opponent: game.prediction.opponent, confidence: game.prediction.confidence, ev: game.prediction.estimatedEV, line: game.prediction.bestMoneyline }, ...saved]);
  }

  async function load(selectedDate = date) {
    setLoading(true); setError(''); setSummary('');
    try {
      const res = await fetch(`/api/predictions?date=${encodeURIComponent(selectedDate)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load predictions');
      setData(json);
      const sres = await fetch(`/api/summary?date=${encodeURIComponent(selectedDate)}`);
      const sjson = await sres.json();
      if (sres.ok) setSummary(sjson.summary);
    } catch (err) { setError(err.message); setData(null); }
    finally { setLoading(false); }
  }
  async function loadBacktest() {
    setBacktest({ loading: true });
    const res = await fetch(`/api/backtest?season=${season}`);
    const json = await res.json();
    setBacktest(res.ok ? json : { error: json.error || 'Failed to backtest' });
  }
  useEffect(() => { load(date); /* eslint-disable-next-line */ }, []);

  const games = useMemo(() => data?.games || [], [data]);
  const strongest = games[0];
  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Live MLB data · First 5 model · ML + EV</p>
          <h1>MLB F5 Predictor Pro</h1>
          <p className="heroText">Official MLB schedule, probable pitchers, team/pitcher stats, batter handedness splits, bullpen usage, park/weather factors, optional injuries/umpires, live moneylines, EV, saved picks, backtesting, and a trainable model using the last two MLB seasons.</p>
        </div>
        <div className="controls">
          <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <button onClick={() => load(date)} disabled={loading}>{loading ? 'Loading...' : 'Refresh'}</button>
        </div>
      </section>

      {error && <div className="alert">{error}</div>}
      {loading && <div className="loading"><div className="spinner" /><p>Loading live MLB data, odds, weather, splits, and bullpen usage...</p></div>}

      {!loading && data && <>
        <section className="summary">
          <div><span>Games</span><strong>{games.length}</strong></div>
          <div><span>Odds feed</span><strong>{data.odds.available ? 'Connected' : 'Not connected'}</strong></div>
          <div><span>Strongest edge</span><strong>{strongest ? strongest.prediction.pick : 'None'}</strong></div>
          <div><span>ML model</span><strong>{data.model?.version || 'Missing'}</strong></div>
        </section>
        <section className="panel">
          <h2>Model summary</h2>
          <pre>{summary || 'No summary available.'}</pre>
          <p className="note">Training seasons: {data.model?.trainingSeasons?.join(', ') || 'N/A'} · Accuracy: {data.model?.metrics?.accuracy ? `${(data.model.metrics.accuracy * 100).toFixed(1)}%` : 'Run npm run train:ml'} · Odds markets: {data.odds.markets || 'N/A'}</p>
        </section>
        {!data.odds.available && <div className="info">Add <code>ODDS_API_KEY</code> to enable live moneylines, totals, spreads, and EV. Historical odds usually require a paid odds-data plan.</div>}
        <section className="tools">
          <div className="panel"><h2>Backtest</h2><div className="inline"><input type="number" value={season} onChange={(e) => setSeason(e.target.value)} /><button onClick={loadBacktest}>Run</button></div>{backtest?.loading ? <p>Loading...</p> : backtest ? <pre>{JSON.stringify(backtest, null, 2)}</pre> : <p className="muted">Run a quick historical F5 result check by season.</p>}</div>
          <div className="panel"><h2>Saved picks</h2>{saved.length ? <ul>{saved.map((p) => <li key={p.id}>{p.date}: {p.pick} vs {p.opponent} · {p.confidence}% · EV {p.ev ?? 'N/A'} · ML {moneyline(p.line)}</li>)}</ul> : <p className="muted">No saved picks yet.</p>}</div>
        </section>
        {games.length === 0 ? <div className="empty">No MLB games found for {date}.</div> : <section className="cards">{games.map((game) => <GameCard key={game.gamePk} game={game} onSave={savePick} saved={saved.some((x) => x.id === `${game.gamePk}-${game.prediction.pick}`)} />)}</section>}
      </>}
    </main>
  );
}
