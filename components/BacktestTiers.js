import { useEffect, useState } from 'react';

const f = (v) => (v == null ? '—' : `${v.toFixed(1)}%`);
const Bar = ({ v }) => (
  <span style={{ display: 'inline-block', width: 80, height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.12)', verticalAlign: 'middle' }}>
    <span style={{ display: 'block', width: `${Math.max(0, Math.min(100, v || 0))}%`, height: '100%', borderRadius: 4, background: '#5eead4' }} />
  </span>
);
const th = { textAlign: 'left', padding: '4px 8px', fontWeight: 600 };
const td = { padding: '4px 8px' };

function fwdRow(label, c) {
  if (!c || !c.picks) return null;
  return <p className="muted" key={label}>{label}: {c.wins}W–{c.losses}L{c.ties ? `–${c.ties}T` : ''} of {c.picks} graded · {f(c.winPct)}{c.ties ? ` (${f(c.winPctDecided)} excl. ties)` : ''}</p>;
}

export default function BacktestTiers() {
  const [payload, setPayload] = useState(null);
  const [err, setErr] = useState('');
  const [model, setModel] = useState('fullGame');
  const [scope, setScope] = useState('all');

  useEffect(() => {
    let live = true;
    fetch('/api/backtest-tiers').then(async (r) => { const j = await r.json(); if (!live) return; if (r.ok) setPayload(j); else setErr(j.error || 'Failed to load backtest'); }).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, []);

  if (err) return <div className="panel"><h2>Backtest</h2><p className="muted">{err}</p></div>;
  if (!payload) return <div className="panel"><h2>Backtest</h2><p className="muted">Loading...</p></div>;
  const bt = payload.backtest, m = bt[model], isF5 = model === 'f5';
  const seasons = Object.keys(m.scopes).filter((k) => k !== 'all');
  const sc = m.scopes[scope] || m.scopes.all, t = sc.totals, mt = m.marketTrust;
  const fw = payload.forward;
  const btn = (on) => ({ opacity: on ? 1 : 0.55 });

  return (
    <div className="panel">
      <h2>Backtest: win rate by model confidence</h2>
      <p className="muted">Historical walk-forward results for ALL picks (not just qualified ones). The model always picks its favored side, so confidence is never below 50% and the 45–50% tier is empty by construction.</p>
      <div className="inline" style={{ flexWrap: 'wrap', gap: 8 }}>
        <button style={btn(model === 'fullGame')} onClick={() => setModel('fullGame')}>Full game</button>
        <button style={btn(model === 'f5')} onClick={() => setModel('f5')}>F5</button>
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="all">All seasons</option>
          {seasons.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <p className="muted">
        {isF5
          ? <>Total {t.n.toLocaleString()} picks: {t.wins.toLocaleString()}W / {t.losses.toLocaleString()}L / {t.pushes.toLocaleString()} ties. <strong>{f(t.winPctTiesAsLoss)} with ties counted as losses (this is the one that applies to Kalshi, where a tie loses)</strong>; {f(t.winPctExclTies)} excluding ties (applies to books that push on a tie).</>
          : <>Total {t.n.toLocaleString()} picks: {t.wins.toLocaleString()}W / {t.losses.toLocaleString()}L · <strong>{f(t.winPct)}</strong>. Full games cannot tie.</>}
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead><tr><th style={th}>Confidence</th><th style={th}>n</th><th style={th}>W</th><th style={th}>L</th>{isF5 && <th style={th}>Ties</th>}
            <th style={th}>{isF5 ? 'Win % (ties lose)' : 'Win %'}</th>{isF5 && <th style={th}>Win % (excl. ties)</th>}<th style={th} /></tr></thead>
          <tbody>{sc.tiers.map((r) => {
            const v = isF5 ? r.winPctTiesAsLoss : r.winPct;
            return (
              <tr key={r.tier} title={r.note || (r.smallSample ? 'Small sample (n<100): wide error' : '')}>
                <td style={td}>{r.tier}%</td><td style={td}>{r.n.toLocaleString()}{r.smallSample ? ' *' : ''}</td><td style={td}>{r.wins}</td><td style={td}>{r.losses}</td>{isF5 && <td style={td}>{r.pushes}</td>}
                <td style={td}>{f(v)}</td>{isF5 && <td style={td}>{f(r.winPctExclTies)}</td>}<td style={td}>{r.n ? <Bar v={isF5 ? r.winPctExclTies : v} /> : null}</td>
              </tr>);
          })}</tbody>
        </table>
      </div>
      <p className="muted">45–50%: n=0 because the model always picks its favored side. * = n&lt;100. Higher confidence has historically won more often, but with wide error at n&lt;100. The bar shows {isF5 ? 'win % excluding ties' : 'win %'}. Past results do not establish future profit.</p>

      <h3>marketTrust cross-tab — retrospective, small sample</h3>
      <p className="muted">Retrospective on already-collected data ({mt.sampleWindow}); not a clean forward test. Rule: {mt.rule}. Cells with n&lt;30 are flagged. Win % is the model’s pick{isF5 ? ' (decided games only, no ties)' : ''}.</p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead><tr><th style={th}>Confidence</th><th style={th}>All: n</th><th style={th}>All: win %</th><th style={th}>marketTrust: n</th><th style={th}>marketTrust: win %</th></tr></thead>
          <tbody>{mt.rows.map((r) => (
            <tr key={r.tier}><td style={td}>{r.tier}%</td><td style={td}>{r.all.n}</td><td style={td}>{f(r.all.winPct)}{r.all.n && r.all.smallSample ? ' ⚠ n<30' : ''}</td>
              <td style={td}>{r.marketTrust.n}</td><td style={td}>{f(r.marketTrust.winPct)}{r.marketTrust.n && r.marketTrust.smallSample ? ' ⚠ n<30' : ''}</td></tr>))}</tbody>
        </table>
      </div>

      <h3>Live forward record (separate from the backtest above)</h3>
      {fw ? (isF5
        ? <>{fwdRow('F5 pick, legacy dates (ties lose)', fw.legacyF5Primary)}{fwdRow('F5 secondary pick', fw.f5Secondary)}</>
        : fwdRow('Full-game pick', fw.fullGame)) : <p className="muted">Forward data unavailable.</p>}
      <p className="muted">{payload.forwardNote}</p>
    </div>
  );
}
