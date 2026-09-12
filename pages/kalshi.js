import { useEffect, useState } from 'react';

function pct(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

function num(x, digits = 1) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function time(value) {
  if (!value) return '—';

  return new Date(value).toLocaleTimeString(
    'en-US',
    {
      timeZone: 'America/Los_Angeles',
      hour: 'numeric',
      minute: '2-digit'
    }
  );
}

function tierColor(tier) {
  if (tier === 'STRONG') return '#16a34a';
  if (tier === 'PLAY') return '#2563eb';
  return '#6b7280';
}

export default function KalshiF5Page() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError('');

    try {
      const r = await fetch(
        '/api/kalshi-f5',
        { cache: 'no-store' }
      );

      const j = await r.json();

      if (!r.ok || !j.ok) {
        throw new Error(
          j.error || 'Failed to load Kalshi F5 board'
        );
      }

      setData(j);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const board = data?.board || [];

  return (
    <main style={{
      maxWidth: 1180,
      margin: '0 auto',
      padding: 24,
      fontFamily:
        'Inter, system-ui, -apple-system, sans-serif'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 20,
        alignItems: 'center',
        marginBottom: 24
      }}>
        <div>
          <div style={{
            color: '#6b7280',
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: '.08em'
          }}>
            MLB FIRST 5 · KALSHI KXMLBF5
          </div>

          <h1 style={{ margin: '6px 0' }}>
            Kalshi F5 V5 Selector
          </h1>

          <p style={{
            margin: 0,
            color: '#6b7280'
          }}>
            PASS &lt; 58% · PLAY ≥ 58% ·
            STRONG ≥ 62%
          </p>
        </div>

        <button
          onClick={load}
          disabled={loading}
          style={{
            padding: '10px 16px',
            borderRadius: 8,
            border: '1px solid #d1d5db',
            cursor: 'pointer'
          }}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <p>
        <a href="/">← Main F5 Predictor</a>
      </p>

      {error && (
        <div style={{
          padding: 16,
          background: '#fee2e2',
          borderRadius: 8,
          marginBottom: 20
        }}>
          {error}
        </div>
      )}

      {data && (
        <div style={{
          display: 'flex',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 22
        }}>
          <Stat
            label="Kalshi markets"
            value={data.marketsLoaded}
          />
          <Stat
            label="Matched candidates"
            value={data.candidateEvents}
          />
          <Stat
            label="Board games"
            value={board.length}
          />
        </div>
      )}

      {!loading && data && board.length === 0 && (
        <div style={{
          padding: 22,
          border: '1px solid #e5e7eb',
          borderRadius: 12
        }}>
          No complete upcoming F5 markets with usable
          pregame quotes are available right now.
        </div>
      )}

      <div style={{
        display: 'grid',
        gap: 16
      }}>
        {board.map((g) => (
          <article
            key={g.eventTicker}
            style={{
              border: '1px solid #e5e7eb',
              borderRadius: 14,
              padding: 20
            }}
          >
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 16,
              alignItems: 'flex-start'
            }}>
              <div>
                <h2 style={{
                  margin: '0 0 4px'
                }}>
                  {g.awayTeam} @ {g.homeTeam}
                </h2>

                <div style={{
                  color: '#6b7280'
                }}>
                  First pitch {time(g.firstPitchUtc)}
                  {' · '}
                  {num(g.minutesToPitch, 0)} min away
                </div>
              </div>

              <div style={{
                background: tierColor(g.tier),
                color: 'white',
                fontWeight: 800,
                borderRadius: 999,
                padding: '7px 13px'
              }}>
                {g.tier}
              </div>
            </div>

            <div style={{
              marginTop: 18,
              fontSize: 22,
              fontWeight: 800
            }}>
              {g.kalshiPickTeam}
              {' '}
              {pct(g.kalshiConfidence)}
            </div>

            <div style={{
              display: 'grid',
              gridTemplateColumns:
                'repeat(auto-fit,minmax(150px,1fr))',
              gap: 10,
              marginTop: 16
            }}>
              <Stat
                label="Away 3-way"
                value={pct(g.kalshiAway3Way)}
              />
              <Stat
                label="Home 3-way"
                value={pct(g.kalshiHome3Way)}
              />
              <Stat
                label="Tie"
                value={pct(g.kalshiTieProb)}
              />
              <Stat
                label="Away no-tie"
                value={pct(g.kalshiAwayProbNoTie)}
              />
              <Stat
                label="Home no-tie"
                value={pct(g.kalshiHomeProbNoTie)}
              />
              <Stat
                label="Quote age"
                value={`${num(g.quoteAgeMinutes)} min`}
              />
            </div>

            <div style={{
              marginTop: 14,
              color: '#6b7280',
              fontSize: 13
            }}>
              Spreads — Away {num(g.awaySpread, 3)}
              {' · '}
              Home {num(g.homeSpread, 3)}
              {' · '}
              Tie {num(g.tieSpread, 3)}
            </div>
          </article>
        ))}
      </div>

      {data && (
        <div style={{
          marginTop: 24,
          color: '#6b7280',
          fontSize: 12
        }}>
          Generated {new Date(
            data.generatedAt
          ).toLocaleString()}
        </div>
      )}
    </main>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{
      background: '#f8fafc',
      borderRadius: 8,
      padding: '10px 12px'
    }}>
      <div style={{
        color: '#6b7280',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '.05em'
      }}>
        {label}
      </div>

      <div style={{
        fontWeight: 700,
        marginTop: 3
      }}>
        {value}
      </div>
    </div>
  );
}
