const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { gradeDate, selectScheduleEntry } = require('../lib/model-forward');

function withTempCwd(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-sched-'));
  const prev = process.cwd();
  fs.mkdirSync(path.join(dir, 'data', 'model-forward'), { recursive: true });
  process.chdir(dir);
  return Promise.resolve().then(() => fn(dir)).finally(() => { process.chdir(prev); fs.rmSync(dir, { recursive: true, force: true }); });
}
const pick = (o) => ({ gamePk: 1, away: 'A', home: 'H', awayId: 10, homeId: 20, officialDate: '2026-09-23', gameDate: '2026-09-23T17:35:00Z', available: true, pickSide: 'HOME', pickTeam: 'H', confidence: 0.6, ...o });
const entry = (o) => ({ gamePk: 1, officialDate: '2026-09-23', gameDate: '2026-09-23T17:35:00Z', status: { detailedState: 'Final' }, teams: { home: { team: { id: 20 } }, away: { team: { id: 10 } } }, linescore: { teams: { home: { runs: 4 }, away: { runs: 2 } }, innings: [] }, ...o });

async function run(picks, games) {
  return withTempCwd(async () => {
    fs.writeFileSync(path.join('data', 'model-forward', 'picks-2026-09-23.json'), JSON.stringify({ trackedModel: 'full-game', picks }));
    const orig = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ dates: games.map((g) => ({ games: [g] })) }) });
    try { return (await gradeDate('2026-09-23')).results; } finally { global.fetch = orig; }
  });
}

test('postponed original slot + played makeup slot: makeup pick is graded, not Ambiguous', async () => {
  const post = entry({ gameDate: '2026-09-22T22:35:00Z', status: { detailedState: 'Postponed' }, rescheduleDate: '2026-09-23T17:35:00Z' });
  const [r] = await run([pick()], [post, entry()]);
  assert.equal(r.status, 'graded');
  assert.equal(r.finalHome, 4);
});

test('the postponed original-slot pick is excluded with a specific reason', async () => {
  const post = entry({ gameDate: '2026-09-22T22:35:00Z', status: { detailedState: 'Postponed' }, rescheduleDate: '2026-09-23T17:35:00Z' });
  const [r] = await run([pick({ gameDate: '2026-09-22T22:35:00Z', officialDate: '2026-09-22' })], [post, entry()]);
  assert.equal(r.status, 'excluded');
  assert.match(r.reason, /^Postponed -- not played/);
});

test('slot no longer exists: honest reschedule reason and no cross-slot grading', async () => {
  const [r] = await run([pick({ gameDate: '2026-09-22T22:35:00Z' })], [entry()]);
  assert.equal(r.status, 'excluded');
  assert.match(r.reason, /^Rescheduled/);
});

test('identity mismatch is still excluded (protection retained)', async () => {
  const [r] = await run([pick()], [entry({ teams: { home: { team: { id: 99 } }, away: { team: { id: 10 } } } })]);
  assert.equal(r.reason, 'Changed schedule or identity mismatch');
});

test('scheduled, not-final game stays pending', async () => {
  const [r] = await run([pick()], [entry({ status: { detailedState: 'Scheduled' } })]);
  assert.equal(r.status, 'pending');
});

test('selectScheduleEntry: suspended / cancelled / empty / duplicate', () => {
  const p = pick();
  assert.match(selectScheduleEntry([entry({ status: { detailedState: 'Suspended: Rain' } })], p).reason, /Suspended/);
  assert.match(selectScheduleEntry([entry({ status: { detailedState: 'Cancelled' } })], p).reason, /Cancelled/);
  assert.match(selectScheduleEntry([], p).reason, /not found/);
  assert.equal(selectScheduleEntry([entry(), entry()], p).reason, 'Ambiguous schedule');
});
