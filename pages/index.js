import { useEffect, useMemo, useRef, useState } from 'react';

import { liveTrade, cohortRate, portfolioProjection } from '../lib/trade-projection';
const dollars = (n) => n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

function todayPacific() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function shiftDate(d, n) { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function fmtTime(value) { return value ? new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : ''; }
function whole(v) { return v == null ? '—' : `${Math.round(v)}%`; }
// Win percentages are always shown to two decimals (e.g. 54.55%), never a long float.
function winPct(v) { return v == null || !Number.isFinite(Number(v)) ? '—' : `${Number(v).toFixed(2)}%`; }

function TeamLogo({ teamId, abbreviation }) {
  const [failed, setFailed] = useState(false);
  if (!teamId || failed) return <span className="logoFallback">{abbreviation || '—'}</span>;
  return <img className="logo" src={`https://www.mlbstatic.com/team-logos/${teamId}.svg`} alt={abbreviation || ''} width={28} height={28} loading="lazy" onError={() => setFailed(true)} />;
}

function Pill({ outcome }) {
  if (!outcome) return <span className="pill pill--pending">–</span>;
  return <span className={`pill pill--${outcome}`}>{outcome === 'win' ? 'W' : outcome === 'loss' ? 'L' : 'T'}</span>;
}
const outcomeOf = (win, tie) => (tie ? 'tie' : win === true ? 'win' : win === false ? 'loss' : null);

function RecordTile({ label, cohort, note }) {
  const has = cohort && (cohort.wins + cohort.losses + (cohort.ties || 0)) > 0;
  const pctVal = has ? cohort.winPct : null;
  return (
    <div className="tile">
      <span className="tileLabel">{label}</span>
      <strong className="tileValue">{winPct(pctVal)}</strong>
      <span className="tileSub">{has ? `${cohort.wins}W – ${cohort.losses}L${cohort.ties ? ` – ${cohort.ties}T` : ''}` : 'No graded picks yet'}{note && has ? ` · ${note}` : ''}</span>
    </div>
  );
}

// One row per game: full-game pick, F5 pick, and a W/L pill for each once the game is graded.
function rowFor(game) {
  const rp = game.recordedPick, rr = game.recordedResult;
  const live = !rp && game.prediction && game.prediction.pick;
  const legacy = rp?.trackedModel === 'f5-legacy';
  const fg = legacy ? null : rp?.pick ? { pick: rp.pick, conf: rp.confidence } : live ? { pick: game.prediction.pick, conf: game.prediction.confidence } : null;
  const f5src = legacy ? rp : rp ? (rp.f5Primary || rp.f5Pick) : (game.kalshiPrimaryF5 && game.kalshiPrimaryF5.available ? { pick: game.kalshiPrimaryF5.pick, confidence: game.kalshiPrimaryF5.confidence } : null);
  const f5 = f5src && f5src.pick ? { pick: f5src.pick, conf: f5src.confidence } : null;
  return {
    fg, f5,
    fgOutcome: !legacy && rr ? outcomeOf(rr.win, false) : null,
    f5Outcome: legacy && rr ? outcomeOf(rr.win, rr.tie) : rr && rr.f5Result != null ? outcomeOf(rr.f5Win, rr.f5Tie) : null,
    score: rr && rr.finalAway != null ? `${rr.finalAway}–${rr.finalHome}` : null,
    noPick: !fg && (game.noPickNote || game.exclusionNote),
    source: legacy ? "Recorded F5 model" : rp?.trackedModel === "full-game" ? "Recorded model" : "Kalshi market",
  };
}

function GameRow({ game, trade, selected, onSelect }) {
  const r = rowFor(game);
  return (
    <li className="row">
      <div className="matchup">
        <TeamLogo teamId={game.away.id} abbreviation={game.away.abbreviation} />
        <span>{game.away.abbreviation}</span><span className="at">@</span>
        <TeamLogo teamId={game.home.id} abbreviation={game.home.abbreviation} />
        <span>{game.home.abbreviation}</span>
        <span className="when">{r.score || fmtTime(game.gameDate)}</span><small>{r.source}</small>
      </div>
      <div className="cell">
        <span className="cellLabel">Full game</span>
        {trade && <label><input type="checkbox" checked={selected} onChange={onSelect} aria-label={`Include ${r.fg?.pick} in paper portfolio`} /> Include</label>}
        {r.fg ? <span className="pickText">{r.fg.pick} <em>{whole(r.fg.conf)}</em></span> : <span className="muted">{r.noPick ? 'Not captured' : 'No pick'}</span>}
        {r.fg && <Pill outcome={r.fgOutcome} />}
        {!r.fg && game.fullGamePrediction?.available && <small>Model only: {game.fullGamePrediction.pick} {whole(game.fullGamePrediction.confidence)} (not a captured Kalshi pick)</small>}
      </div>
      <div className="cell">
        <span className="cellLabel">Paper trade · full game</span>
        {trade ? <><strong>Win profit {dollars(trade.winProfit)}</strong><small>Return {dollars(trade.payout)} including stake · cost {dollars(trade.cost)}</small><small>{trade.contracts} contracts · fees {dollars(trade.fees)} · loss if wrong {dollars(trade.loss)}</small></> : <span className="muted">Requires a fresh pregame ask; unavailable for historical picks.</span>}
      </div>
      <div className="cell">
        <span className="cellLabel">F5</span>
        {r.f5 ? <span className="pickText">{r.f5.pick} <em>{whole(r.f5.conf)}</em></span> : <span className="muted">No pick</span>}
        {r.f5 && <Pill outcome={r.f5Outcome} />}
      </div>
    </li>
  );
}

export default function Home() {
  const [date, setDate] = useState(todayPacific());
  const requestId = useRef(0);
  const [data, setData] = useState(null);
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [budget, setBudget] = useState('1000');
  const [omitted, setOmitted] = useState({});
  const [clock, setClock] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 15000); return () => clearInterval(timer); }, []);
  useEffect(() => setOmitted({}), [date]);

  async function load(d) {
    const id = ++requestId.current;
    setLoading(true); setError('');
    try {
      const res = await fetch(`/api/predictions?date=${encodeURIComponent(d)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load games');
      if (id === requestId.current) setData(json);
    } catch (err) { if (id === requestId.current) { setError(err.message); setData(null); } }
    finally { if (id === requestId.current) setLoading(false); }
  }
  useEffect(() => { load(date); const timer = setInterval(() => load(date), 60000); return () => clearInterval(timer); }, [date]);
  useEffect(() => {
    let active = true;
    const refresh = () => fetch('/api/record', { cache: 'no-store' }).then((r) => { if (!r.ok) throw Error('Record unavailable'); return r.json(); }).then((j) => { if (active) setRecord(j); }).catch(() => { if (active) setRecord(null); });
    refresh(); const timer = setInterval(refresh, 60000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const go = (n) => { const d = shiftDate(date, n); setDate(d); };

  const games = useMemo(() => data?.games || [], [data]);
  const mf = (record && record.modelForward) || {};
  const rate = cohortRate(mf.kalshiPrimaryFullGame);
  const trades = games.map(g => ({ game: g, trade: liveTrade(g, Number(budget), clock) }));
  const selectedTrades = trades.filter(({ game, trade }) => trade && !omitted[`${date}:${game.gamePk}`]).map(r => r.trade);
  const portfolio = portfolioProjection(selectedTrades, rate?.rate);
  const invalidBudget = !Number.isFinite(Number(budget)) || Number(budget) <= 0 || Number(budget) > 1000000;

  return (
    <main className="shell">
      <header className="top">
        <h1>MLB Picks</h1>
        <div className="nav">
          <button onClick={() => go(-1)} disabled={loading} aria-label="Previous day">‹</button>
          <input type="date" value={date} onChange={(e) => { if (e.target.value) setDate(e.target.value); }} />
          <button onClick={() => go(1)} disabled={loading} aria-label="Next day">›</button>
        </div>
      </header>

      <p className="muted">Primary picks follow Kalshi prices. Our trained models are separate comparisons.</p>
      {!record && <p role="status">Performance record unavailable or loading.</p>}
      <section className="tiles">
        <RecordTile label="Kalshi full game" cohort={mf.kalshiPrimaryFullGame} />
        <RecordTile label="Kalshi first 5 innings" cohort={mf.kalshiPrimaryF5} note="ties count as losses" />
      </section>

      <section className="tile" aria-label="Paper portfolio">
        <h2>Paper portfolio · full game</h2>
        <label>Budget per trade (including fees) <input aria-label="Budget per trade" type="number" min="1" max="1000000" step="100" value={budget} onChange={e => setBudget(e.target.value)} /></label>
        {invalidBudget && <p role="alert">Enter a budget above $0 and no more than $1,000,000.</p>}
        <p>{selectedTrades.length} selected · total cost {dollars(portfolio.cost)} · profit if all win {dollars(portfolio.allWinProfit)}</p>
        <strong>Projected net P/L: {dollars(portfolio.expected)}</strong>
        <small>{rate ? `Scenario uses the recorded Kalshi full-game win rate: ${(100 * rate.rate).toFixed(2)}% over ${rate.n} graded picks. Applies that same rate to each selected trade; it is not a forecast for this subset.` : 'A graded Kalshi full-game record is required to project P/L.'}</small>
        <small>Fresh asks only. Hypothetical fills at displayed prices; available size is unverified. Estimated multiplier-1 taker fees rounded up per order. This is not settled P/L. F5 positions are separate and not included.</small>
        <small>{trades.filter(r => !r.trade).length} games unavailable for pricing. Select or deselect eligible picks below.</small>
      </section>
      {error && <div className="alert">{error}</div>}
      {loading && <p className="muted center">Loading…</p>}

      {!loading && data && (
        <>
          <h2>Games</h2>
          {games.length === 0 ? <p className="muted">No games found for {date}.</p> : <ul className="list">{games.map((g) => <GameRow key={g.gamePk} game={g} trade={liveTrade(g, Number(budget), clock)} selected={!omitted[`${date}:${g.gamePk}`]} onSelect={() => setOmitted(prev => ({ ...prev, [`${date}:${g.gamePk}`]: !prev[`${date}:${g.gamePk}`] }))} />)}</ul>}
        </>
      )}

      <footer className="foot">Paper tracking only. Win % = wins / (wins + losses + ties). Pending and excluded picks are not graded. F5 percentages beside picks are conditional on no tie.</footer>
    </main>
  );
}
