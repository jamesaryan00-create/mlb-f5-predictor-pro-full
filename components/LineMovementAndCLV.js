import { useEffect, useState } from 'react';

const f = (v, digits = 3) => (v == null ? '—' : v.toFixed(digits));
const pctf = (v) => (v == null ? '—' : `${v.toFixed(1)}%`);
const th = { textAlign: 'left', padding: '4px 8px', fontWeight: 600 };
const td = { padding: '4px 8px' };

function MarketBlock({ title, market }) {
  const lm = market.lineMovement, clv = market.clv;
  return (
    <div style={{ marginBottom: 20 }}>
      <h3>{title}</h3>
      {!lm.available ? <p className="muted">{lm.warning}</p> : (
        <>
          <p className="muted">
            Line movement (opening vs. closing price on the side the model picked): n={lm.n} game{lm.n === 1 ? '' : 's'} with enough captures to measure{lm.excluded ? ` (${lm.excluded} excluded -- see reasons below)` : ''}.
            {lm.n > 0 && <> Average net movement <strong>{f(lm.avgMovement)}</strong> (positive = price rose in favor of the picked side). Moved away from the pick: {lm.movedAwayCount}/{lm.n} ({pctf(lm.movedAwayPct)}); moved toward: {lm.movedTowardCount}/{lm.n}.</>}
          </p>
          <p className="note">{lm.note}</p>
          {lm.n > 0 && (
            <div style={{ overflowX: 'auto', marginBottom: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr><th style={th}>Game</th><th style={th}>Pick</th><th style={th}>Captures</th><th style={th}>Open</th><th style={th}>Close</th><th style={th}>Net move</th></tr></thead>
                <tbody>{lm.games.filter((g) => g.included).slice(0, 25).map((g) => (
                  <tr key={g.gamePk}>
                    <td style={td}>{g.awayTeam} @ {g.homeTeam}</td>
                    <td style={td}>{g.pickTeam}</td>
                    <td style={td}>{g.captureCount}</td>
                    <td style={td}>{f(g.openingPrice)}</td>
                    <td style={td}>{f(g.closingPrice)}</td>
                    <td style={td}>{g.netMovement > 0 ? '+' : ''}{f(g.netMovement)}{g.movedAway ? ' (away)' : g.movedToward ? ' (toward)' : ''}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </>
      )}

      {!clv.available ? <p className="muted">{clv.warning}</p> : (
        <>
          <p className="muted">
            CLV (marketTrust picks only): n={clv.n} graded pick{clv.n === 1 ? '' : 's'} with a measurable closing price{clv.excluded ? ` (${clv.excluded} excluded)` : ''}.
            {clv.n > 0 && <> Average CLV <strong>{f(clv.avgCLV)}</strong>, positive in {clv.positiveCount}/{clv.n} ({pctf(clv.positivePct)}).</>}
            {clv.n > 0 && clv.positiveCLVSampleSize > 0 && clv.nonPositiveCLVSampleSize > 0 && (
              <> Win rate with positive CLV: {pctf(clv.winRateGivenPositiveCLV)} (n={clv.positiveCLVSampleSize}); with non-positive CLV: {pctf(clv.winRateGivenNonPositiveCLV)} (n={clv.nonPositiveCLVSampleSize}).</>
            )}
          </p>
          <p className="note">{clv.note}</p>
          {clv.n > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr><th style={th}>Game</th><th style={th}>Pick</th><th style={th}>Entry</th><th style={th}>Close</th><th style={th}>CLV</th><th style={th}>Result</th></tr></thead>
                <tbody>{clv.games.filter((g) => g.included).slice(0, 25).map((g) => (
                  <tr key={g.gamePk}>
                    <td style={td}>{g.awayTeam} @ {g.homeTeam}</td>
                    <td style={td}>{g.pickTeam}</td>
                    <td style={td}>{f(g.entryPrice)}</td>
                    <td style={td}>{f(g.closingPrice)}</td>
                    <td style={td}>{g.clv > 0 ? '+' : ''}{f(g.clv)}</td>
                    <td style={td}>{g.win ? 'Win' : 'Loss'}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function LineMovementAndCLV() {
  const [payload, setPayload] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let live = true;
    fetch('/api/line-movement').then(async (r) => { const j = await r.json(); if (!live) return; if (r.ok) setPayload(j); else setErr(j.error || 'Failed to load line movement/CLV'); }).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, []);

  if (err) return <div className="panel"><h2>Line movement &amp; CLV</h2><p className="muted">{err}</p></div>;
  if (!payload) return <div className="panel"><h2>Line movement &amp; CLV</h2><p className="muted">Loading...</p></div>;

  return (
    <div className="panel">
      <h2>Line movement &amp; Closing Line Value</h2>
      <p className="muted">
        Built from Kalshi's own captured price history (every 20 minutes pregame). Reported separately for the F5 market and the full-game market -- never blended. These trackers have only been running a few weeks; every number below is a real n, not a percentage that implies confidence the sample doesn't support.
      </p>
      <MarketBlock title="F5 market" market={payload.f5} />
      <MarketBlock title="Full-game market" market={payload.fullGame} />
    </div>
  );
}
