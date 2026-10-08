import { useEffect, useMemo, useRef, useState } from 'react';

import { fromGame, selectedPortfolio } from '../lib/price-decision';
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

function GameRow({ game, decision, selected, onSelect }) {
  const trade = decision.selected?.trade;
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
        <span className="cellLabel">Kalshi benchmark · full game</span>
        {trade && <label><input type="checkbox" checked={selected} onChange={onSelect} aria-label={`Include ${game[decision.side]?.name} in paper portfolio`} /> Include</label>}
        {r.fg ? <span className="pickText">{r.fg.pick} <em>{whole(r.fg.conf)}</em></span> : <span className="muted">{r.noPick ? 'Not captured' : 'No pick'}</span>}
        {r.fg && <Pill outcome={r.fgOutcome} />}
        {!r.fg && game.fullGamePrediction?.available && <small>Model only: {game.fullGamePrediction.pick} {whole(game.fullGamePrediction.confidence)} (not a captured Kalshi pick)</small>}
      </div>
      <div className="cell">
        <span className="cellLabel">Price-aware paper decision</span>
        <strong>{decision.action}{decision.side ? ` · ${game[decision.side].name}` : ''}</strong>
        <small>{decision.reason}</small>
        {decision.sides.map(s => <div key={s.side} className="priceSide"><strong>{game[s.side].name}</strong><small>Model {(100*s.probability).toFixed(1)}% · ask {(100*s.ask).toFixed(1)}¢ at {fmtTime(s.quoteTime)} · break-even {s.breakEven == null ? '—' : `${(100*s.breakEven).toFixed(1)}%`}</small><small>Win profit {dollars(s.trade?.winProfit)} · loss {dollars(s.trade?.loss)} · estimated net {dollars(s.expected)} · at 1¢ worse {dollars(s.stressExpected)}</small></div>)}
        {trade && <small>Selected: {trade.contracts} contracts · cost {dollars(trade.cost)} · estimated fees {dollars(trade.fees)}</small>}

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
  const [priceRecord, setPriceRecord] = useState(null);
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
  useEffect(() => { let active=true; const load=()=>fetch('/api/price-record').then(r=>{if(!r.ok)throw Error('Unavailable');return r.json();}).then(d=>{if(active)setPriceRecord(d);}).catch(()=>{if(active)setPriceRecord(null);}); load(); const timer=setInterval(load,60000); return ()=>{active=false;clearInterval(timer);}; }, []);
  const go = (n) => { const d = shiftDate(date, n); setDate(d); };

  const games = useMemo(() => data?.games || [], [data]);
  const mf = (record && record.modelForward) || {};
  const decisions = games.map(game => ({ game, decision: fromGame(game, Number(budget), clock) }));
  const included = decisions.filter(({ game, decision }) => decision.selected && !omitted[`${date}:${game.gamePk}`]).map(r => r.decision);
  const portfolio = selectedPortfolio(included);
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

      <p className="muted">Price-aware paper research compares both teams using our existing model, purchase prices and fees. Kalshi picks and their historical record remain separate benchmarks.</p>
      {!record && <p role="status">Performance record unavailable or loading.</p>}
      <section className="tile" aria-label="Price-aware results">
        <h2>Price-aware paper record</h2>
        {priceRecord ? <><strong>{priceRecord.wins}W – {priceRecord.losses}L · net {dollars(priceRecord.net)}</strong><small>{priceRecord.pending} pending · {priceRecord.passes} passes · {priceRecord.picks} selected · ROI {priceRecord.roi == null ? '—' : `${priceRecord.roi.toFixed(2)}%`}</small><small>Market favorites on the same graded games: {dollars(priceRecord.benchmarkNet)}.</small><small>Only new, locked pregame paper selections. Hypothetical fills and fees; no actual trades. Old Kalshi results are not included.</small><ul>{priceRecord.rows?.filter(r => r.decision.selected).sort((a,b) => b.lockedAt.localeCompare(a.lockedAt)).slice(0,10).map(r => <li key={r.gamePk}>{r.date} · {r.decision.side === 'home' ? r.home : r.away} · {r.decision.action} · {(r.decision.selected.ask*100).toFixed(1)}¢ · {r.grade?.status === 'graded' ? `${r.grade.win ? 'Win' : 'Loss'} · ${dollars(r.grade.net)}` : 'Pending'}</li>)}</ul></> : <p>Price-aware record unavailable or loading.</p>}
      </section>
      <section className="tiles">
        <RecordTile label="Kalshi full game" cohort={mf.kalshiPrimaryFullGame} />
        <RecordTile label="Kalshi first 5 innings" cohort={mf.kalshiPrimaryF5} note="ties count as losses" />
      </section>

      <section className="tile" aria-label="Paper portfolio">
        <h2>Paper portfolio · full game</h2>
        <label>Budget per trade (including fees) <input aria-label="Budget per trade" type="number" min="1" max="1000000" step="100" value={budget} onChange={e => setBudget(e.target.value)} /></label>
        {invalidBudget && <p role="alert">Enter a budget above $0 and no more than $1,000,000.</p>}
        <p>{portfolio.count} selected · total cost {dollars(portfolio.cost)} · profit if all win {dollars(portfolio.winProfit)}</p>
        <strong>Projected net P/L: {dollars(portfolio.expected)}</strong>
        <small>Projected net is the sum of each selected side’s model probability × payout minus its cost and estimated fees. It does not use the old Kalshi win rate and is not realized profit.</small>
        <small>Only fresh quotes (within 5 minutes) can produce a candidate. The paper rule requires positive estimated return even at a 1¢ worse entry. Available size and calibrated profitability are unverified.</small>
        <small>{decisions.filter(r => !r.decision.selected).length} passes or unavailable. Checkboxes change this preview only. Automatic paper tracking locks the first valid decision in the final hour, up to eight selections daily, at a fixed $1,000 budget.</small>
      </section>
      {error && <div className="alert">{error}</div>}
      {loading && <p className="muted center">Loading…</p>}

      {!loading && data && (
        <>
          <h2>Games</h2>
          {games.length === 0 ? <p className="muted">No games found for {date}.</p> : <ul className="list">{games.map((g) => <GameRow key={g.gamePk} game={g} decision={fromGame(g, Number(budget), clock)} selected={!omitted[`${date}:${g.gamePk}`]} onSelect={() => setOmitted(prev => ({ ...prev, [`${date}:${g.gamePk}`]: !prev[`${date}:${g.gamePk}`] }))} />)}</ul>}
        </>
      )}

      <footer className="foot">Paper tracking only. Win % = wins / (wins + losses + ties). Pending and excluded picks are not graded. F5 percentages beside picks are conditional on no tie.</footer>
    </main>
  );
}
