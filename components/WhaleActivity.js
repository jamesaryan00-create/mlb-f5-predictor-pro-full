import { useEffect, useState } from 'react';

const th = { textAlign: 'left', padding: '4px 8px', fontWeight: 600 };
const td = { padding: '4px 8px' };

const DIRECTION_LABEL = {
  agrees_with_pick: 'Large trades lean toward the pick',
  against_pick: 'Large trades lean against the pick',
  neutral: 'Large trades split evenly',
};

function fmtDollars(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function MarketBlock({ title, market }) {
  if (!market.available) return <div style={{ marginBottom: 20 }}><h3>{title}</h3><p className="muted">{market.warning}</p></div>;
  return (
    <div style={{ marginBottom: 20 }}>
      <h3>{title}</h3>
      <p className="muted">n={market.n} game{market.n === 1 ? '' : 's'} with captured trade data.</p>
      {market.n > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr><th style={th}>Game</th><th style={th}>Pick</th><th style={th}>Largest trade</th><th style={th}>Total volume</th><th style={th}>Block trades</th><th style={th}>Large trades ($)</th><th style={th}>vs. pick</th></tr></thead>
            <tbody>{market.games.slice(0, 25).map((g) => (
              <tr key={g.gamePk}>
                <td style={td}>{g.awayTeam} @ {g.homeTeam}</td>
                <td style={td}>{g.pickTeam}</td>
                <td style={td}>{g.hasTrades ? fmtDollars(g.largestDollars) : 'No trades'}</td>
                <td style={td}>{g.hasTrades ? fmtDollars(g.totalDollars) : '—'}</td>
                <td style={td}>{g.blockTradeCount}</td>
                <td style={td}>{g.largeTradeCount} ({fmtDollars(g.largeTradeDollars)})</td>
                <td style={td}>{DIRECTION_LABEL[g.largeTradeDirectionVsPick] || '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function WhaleActivity() {
  const [payload, setPayload] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let live = true;
    fetch('/api/whale-activity').then(async (r) => { const j = await r.json(); if (!live) return; if (r.ok) setPayload(j); else setErr(j.error || 'Failed to load whale-trade activity'); }).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, []);

  if (err) return <div className="panel"><h2>Whale / large-trade activity</h2><p className="muted">{err}</p></div>;
  if (!payload) return <div className="panel"><h2>Whale / large-trade activity</h2><p className="muted">Loading...</p></div>;

  return (
    <div className="panel">
      <h2>Whale / large-trade activity</h2>
      <p className="muted">
        <strong>NEW, UNPROVEN signal.</strong> Built from Kalshi's public trade feed (trade size plus Kalshi's own is_block_trade flag), captured alongside the existing quote history. This is exploratory only -- it has not been validated against outcomes and does not imply that large trades predict anything. Reported separately for the F5 market and the full-game market, never blended.
      </p>
      <MarketBlock title="F5 market" market={payload.f5} />
      <MarketBlock title="Full-game market" market={payload.fullGame} />
    </div>
  );
}
