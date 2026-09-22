import MatchupLogic from '../components/MatchupLogic';
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
  const indoor = w.indoor ? 'Indoor/roof' : w.available ? `${stat(w.temperature)}°F · wind ${stat(w.windMph)} mph · rain ${stat(w.precipitationProbability)}%` : (w.reason || 'N/A');
  return (
    <div className="factorGrid">
      <div><span>Fixed park input</span><strong>{game.factors?.parkFactor || 'N/A'}</strong></div>
      <div><span>Weather forecast</span><strong>{indoor}</strong></div>
      <div><span>F5 identifier (no tie)</span><strong>{pct(game.f5Prediction?.modelProbability)}</strong></div>
      <div><span>Best book</span><strong>{game.f5Prediction?.bestBook || 'N/A'}</strong></div>
    </div>
  );
}

function GameCard({ game, onSave, saved }) {
  const primary = game.fullGamePrediction || {};
  const pickHome = primary.pick === game.home.name;
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
          <button className="ghost" disabled={!primary.pick} onClick={() => onSave(game)}>{saved ? 'Saved' : 'Save pick'}</button>
        </div>
      </div>

      <div className="teamGrid">
        <div className={`teamBox ${primary.pick && !pickHome ? 'picked' : ''}`}>
          <div className="teamHeader"><strong>{game.away.abbreviation}</strong><span>{pct(primary.awayProbability)}</span></div>
          <p>{game.away.name}</p>
          <small>SP: {game.away.probablePitcher?.fullName || 'TBD'} {game.away.pitcherBio?.throws ? `(${game.away.pitcherBio.throws})` : ''}</small>
          <small>ERA {stat(game.away.pitcherStats?.era)} · WHIP {stat(game.away.pitcherStats?.whip)} · K/9 {stat(game.away.pitcherStats?.strikeoutsPer9Inn)}</small>
          <small>ML: {moneyline(game.away.moneyline)} {game.away.bestBook ? `at ${game.away.bestBook}` : ''}</small>
          <small>BP last 3 days: {stat(game.away.bullpen?.relieverInnings3d)} IP</small>
        </div>

        <div className={`teamBox ${pickHome ? 'picked' : ''}`}>
          <div className="teamHeader"><strong>{game.home.abbreviation}</strong><span>{pct(primary.homeProbability)}</span></div>
          <p>{game.home.name}</p>
          <small>SP: {game.home.probablePitcher?.fullName || 'TBD'} {game.home.pitcherBio?.throws ? `(${game.home.pitcherBio.throws})` : ''}</small>
          <small>ERA {stat(game.home.pitcherStats?.era)} · WHIP {stat(game.home.pitcherStats?.whip)} · K/9 {stat(game.home.pitcherStats?.strikeoutsPer9Inn)}</small>
          <small>ML: {moneyline(game.home.moneyline)} {game.home.bestBook ? `at ${game.home.bestBook}` : ''}</small>
          <small>BP last 3 days: {stat(game.home.bullpen?.relieverInnings3d)} IP</small>
        </div>
      </div>

      <div className="prediction">
        <div>
          <p className="eyebrow">Primary pick (full-game model)</p>
          <h3>{game.prediction.pick || 'Unavailable'}</h3>
          <p className="muted">Model probability {pct(game.prediction.confidence)} · Historical walk-forward accuracy {pct(primary.historicalAccuracy)}</p>
          {game.flaggedF5Alternative && <p className="muted">F5 flagged: {game.flaggedF5Alternative.pick} {pct(game.flaggedF5Alternative.confidence)} (edge +{game.flaggedF5Alternative.edge}pp vs full-game +{game.flaggedF5Alternative.fullGameEdge}pp)</p>}
        </div>
        <div className="evBox">
          <span>Monte Carlo agrees</span><strong>{primary.pick && game.fullGameMonteCarlo?.pick ? (primary.pick === game.fullGameMonteCarlo.pick ? 'Yes' : 'No') : 'N/A'}</strong>
          <span>F5 agrees</span><strong>{primary.pick && game.f5Prediction?.pick ? (primary.pick === game.f5Prediction.pick ? 'Yes' : 'No') : 'N/A'}</strong>
        </div>
      </div>
      <div className="prediction">
        <div><p className="eyebrow">Full-game Monte Carlo diagnostic</p><h3>{game.fullGameMonteCarlo?.pick || 'Unavailable'}</h3><p className="muted">{pct(game.fullGameMonteCarlo?.confidence)} · projected score {game.fullGameMonteCarlo?.projectedAwayRuns?.toFixed(1) ?? '—'}–{game.fullGameMonteCarlo?.projectedHomeRuns?.toFixed(1) ?? '—'} · 10,000 simulations</p></div>
        <div className="evBox"><span>2026 holdout</span><strong>53.65%</strong><span>Primary model</span><strong>54.85%</strong></div>
      </div>
      <div className="prediction">
        <div><p className="eyebrow">Bullpen Monte Carlo V2 diagnostic</p><h3>{game.fullGameMonteCarloV2?.pick || 'Unavailable'}</h3><p className="muted">{game.fullGameMonteCarloV2?.available ? `${pct(game.fullGameMonteCarloV2.confidence)} · bullpen through ${game.fullGameMonteCarloV2.bullpenThroughDate} · likely arms from prior appearances; roster unverified` : game.fullGameMonteCarloV2?.reason || 'Current bullpen data unavailable'}</p></div>
      </div>
      <div className="prediction">
        <div><p className="eyebrow">F5 identifier</p><h3>{game.f5Prediction?.pick || 'Unavailable'}</h3><p className="muted">{pct(game.f5Prediction?.modelProbability)} conditional on a decided F5 result · identifies the early-game lean</p></div>
        <div className="evBox"><span>F5 total</span><strong>{game.market.f5Total?.point ?? 'N/A'}</strong><span>F5 ML</span><strong>{moneyline(game.f5Prediction?.bestMoneyline)}</strong></div>
      </div>
      <FactorGrid game={game} />
      <p className="note">{game.prediction.note}</p><MatchupLogic key={`${game.gamePk}-${game.officialDate}`} gamePk={game.gamePk} date={game.officialDate}/>
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
    const primary = game.fullGamePrediction || {};
    const id = `${game.gamePk}-full-${primary.pick}`;
    const exists = saved.some((x) => x.id === id);
    persist(exists ? saved.filter((x) => x.id !== id) : [{ id, date, schemaVersion: 3, capturedAt: new Date().toISOString(), modelVersion: primary.modelVersion, probabilityBasis: primary.probabilityBasis, pick: primary.pick, opponent: primary.opponent, confidence: primary.confidence, f5Identifier: game.f5Prediction?.pick, f5Confidence: game.f5Prediction?.confidence, flaggedF5Alternative: game.flaggedF5Alternative, ev: null, line: game[primary.side]?.moneyline ?? null }, ...saved]);
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
          <p className="eyebrow">MLB data · Full game plus F5 identifier</p>
          <h1>MLB Winner Predictor</h1>
          <p className="heroText">The primary model forecasts the full-game winner. A separate F5 identifier isolates starting-pitcher and early-lineup strength so you can see whether the two time horizons agree.</p>
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
          <div><span>Top full-game pick</span><strong>{strongest?.fullGamePrediction?.pick || 'None'}</strong></div>
          <div><span>Full-game model</span><strong>{data.fullGameModel?.version || 'Missing'}</strong></div>
        </section>
        <section className="panel">
          <h2>Model summary</h2>
          <pre>{summary || 'No summary available.'}</pre>
          <p className="note">Full-game model trained through {data.fullGameModel?.throughDate || 'N/A'} · Walk-forward accuracy: {data.fullGameModel?.metrics?.walkForwardAccuracy == null ? 'Unavailable' : `${(100 * data.fullGameModel.metrics.walkForwardAccuracy).toFixed(2)}%`} across {data.fullGameModel?.metrics?.walkForwardGames || 0} games. This does not establish betting profitability.</p>
        </section>
        {!data.odds.available && <div className="info">Add <code>SGO_API_KEY</code> to enable sportsbook moneyline, total and spread snapshots. Historical odds usually require a paid odds-data plan.</div>}
        <section className="tools">
          <div className="panel"><h2>Backtest</h2><div className="inline"><input type="number" value={season} onChange={(e) => setSeason(e.target.value)} /><button onClick={loadBacktest}>Run</button></div>{backtest?.loading ? <p>Loading...</p> : backtest ? <pre>{JSON.stringify(backtest, null, 2)}</pre> : <p className="muted">Run a quick historical F5 result check by season.</p>}</div>
          <div className="panel"><h2>Saved picks</h2>{saved.length ? <ul>{saved.map((p) => <li key={p.id}>{p.date}: {p.pick} vs {p.opponent} · {p.schemaVersion === 3 ? `${p.confidence}% full game · F5 ${p.f5Identifier} ${p.f5Confidence}%` : 'Legacy forecast'} · ML {moneyline(p.line)}</li>)}</ul> : <p className="muted">No saved picks yet.</p>}</div>
        </section>
        {games.length === 0 ? <div className="empty">No MLB games found for {date}.</div> : <section className="cards">{games.map((game) => <GameCard key={game.gamePk} game={game} onSave={savePick} saved={saved.some((x) => x.id === `${game.gamePk}-full-${game.fullGamePrediction?.pick}`)} />)}</section>}
      </>}
    </main>
  );
}
