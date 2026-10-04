import { useEffect, useMemo, useState } from 'react';

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
  const pctVal = has ? (cohort.ties ? cohort.winPctDecided : cohort.winPct) : null;
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
  const fg = rp ? { pick: rp.pick, conf: rp.confidence } : live ? { pick: game.prediction.pick, conf: game.prediction.confidence } : null;
  const f5src = rp ? rp.f5Primary : (game.kalshiPrimaryF5 && game.kalshiPrimaryF5.available ? { pick: game.kalshiPrimaryF5.pick, confidence: game.kalshiPrimaryF5.confidence } : null);
  const f5 = f5src && f5src.pick ? { pick: f5src.pick, conf: f5src.confidence } : null;
  return {
    fg, f5,
    fgOutcome: rr ? outcomeOf(rr.win, false) : null,
    f5Outcome: rr && rr.f5Result !== undefined ? outcomeOf(rr.f5Win, rr.f5Tie) : null,
    score: rr && rr.finalAway != null ? `${rr.finalAway}–${rr.finalHome}` : null,
    noPick: !fg && game.noPickNote,
  };
}

function GameRow({ game }) {
  const r = rowFor(game);
  return (
    <li className="row">
      <div className="matchup">
        <TeamLogo teamId={game.away.id} abbreviation={game.away.abbreviation} />
        <span>{game.away.abbreviation}</span><span className="at">@</span>
        <TeamLogo teamId={game.home.id} abbreviation={game.home.abbreviation} />
        <span>{game.home.abbreviation}</span>
        <span className="when">{r.score || fmtTime(game.gameDate)}</span>
      </div>
      <div className="cell">
        <span className="cellLabel">Full game</span>
        {r.fg ? <span className="pickText">{r.fg.pick} <em>{whole(r.fg.conf)}</em></span> : <span className="muted">{r.noPick ? 'Not captured' : 'No pick'}</span>}
        {r.fg && <Pill outcome={r.fgOutcome} />}
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
  const [data, setData] = useState(null);
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load(d) {
    setLoading(true); setError('');
    try {
      const res = await fetch(`/api/predictions?date=${encodeURIComponent(d)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load games');
      setData(json);
    } catch (err) { setError(err.message); setData(null); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(date); /* eslint-disable-next-line */ }, []);
  useEffect(() => {
    let active = true;
    fetch('/api/record', { cache: 'no-store' }).then((r) => r.json()).then((j) => { if (active) setRecord(j); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const go = (n) => { const d = shiftDate(date, n); setDate(d); load(d); };

  const games = useMemo(() => data?.games || [], [data]);
  const mf = (record && record.modelForward) || {};

  return (
    <main className="shell">
      <header className="top">
        <h1>MLB Picks</h1>
        <div className="nav">
          <button onClick={() => go(-1)} disabled={loading} aria-label="Previous day">‹</button>
          <input type="date" value={date} onChange={(e) => { setDate(e.target.value); load(e.target.value); }} />
          <button onClick={() => go(1)} disabled={loading} aria-label="Next day">›</button>
        </div>
      </header>

      <section className="tiles">
        <RecordTile label="Full game" cohort={mf.kalshiPrimaryFullGame} />
        <RecordTile label="First 5 innings" cohort={mf.kalshiPrimaryF5} note="ties are pushes" />
      </section>

      {error && <div className="alert">{error}</div>}
      {loading && <p className="muted center">Loading…</p>}

      {!loading && data && (
        <>
          <h2>Games</h2>
          {games.length === 0 ? <p className="muted">No games found for {date}.</p> : <ul className="list">{games.map((g) => <GameRow key={g.gamePk} game={g} />)}</ul>}
        </>
      )}

      <footer className="foot">Paper tracking only. Win % excludes ties and voided picks.</footer>
    </main>
  );
}
