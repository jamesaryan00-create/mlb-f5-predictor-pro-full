// Shared Kalshi/MLB fetch helpers used by both the F5 board (lib/kalshi-board.js) and the
// full-game board (lib/kalshi-board-fullgame.js). Extracted so the rate-limit retry/backoff and
// pacing logic exists in exactly one place instead of being copy-pasted per market.

// Kalshi rate-limits the candlesticks endpoint; a full game slate (each event issuing several
// concurrent candlestick requests) can still trip it. Retry with backoff rather than let every
// quote in the batch fail with 429.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url, { retries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'mlb-f5-predictor/5.0'
      },
      signal: AbortSignal.timeout(15000)
    });

    if (r.status === 429 && attempt < retries) {
      const retryAfterSeconds = Number(r.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 750 * 2 ** attempt;
      await sleep(waitMs);
      continue;
    }

    if (!r.ok) {
      throw new Error(`${r.status} ${r.statusText}: ${url}`);
    }

    return r.json();
  }
}

// Bounds concurrent candidates AND paces how fast new ones start, so their quote requests don't
// fan out into enough simultaneous or rapid-fire Kalshi requests to trip the candlesticks
// endpoint's rate limit even after the retry above. Runs on a timer in the background, not
// interactively, so trading latency for reliability is fine.
async function mapWithConcurrency(items, limit, fn, staggerMs = 500) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      if (i > 0) await sleep(staggerMs);
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function pacificDate(offsetDays = 0) {
  const now = new Date();

  const parts = new Intl.DateTimeFormat(
    'en-US',
    {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }
  ).formatToParts(
    new Date(
      now.getTime() +
      offsetDays * 24 * 60 * 60 * 1000
    )
  );

  const map = {};

  for (const p of parts) {
    if (p.type !== 'literal') {
      map[p.type] = p.value;
    }
  }

  return `${map.year}-${map.month}-${map.day}`;
}

module.exports = { sleep, getJson, mapWithConcurrency, pacificDate };
