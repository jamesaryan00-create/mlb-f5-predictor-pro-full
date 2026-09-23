const fs = require('fs'), path = require('path');
const { generatePicks, gradeDate, summarize, summarizeForwardRecord, summarizeThreeWay, dir } = require('../lib/model-forward');
const { todayPacific } = require('../lib/mlb');

const planFile = path.join(dir(), 'plan.json');
function ensurePlan() {
  fs.mkdirSync(dir(), { recursive: true });
  if (fs.existsSync(planFile)) return;
  fs.writeFileSync(planFile, JSON.stringify({
    version: 1,
    start: new Date().toISOString(),
    rule: 'modelOnly',
    definition: 'Trained historical model (web-app/lib/mlb.js) pick, no Kalshi market dependency.',
    metric: 'Wins / (wins + losses + ties), overall and by confidence tier',
    policy: 'Picks for a date are generated and saved every morning before that day\'s games start (one file per date; after the first run, later runs may only fill in unstarted games that had no prediction -- see plan.json amendments) -- so grading later carries no look-ahead risk. Grading runs daily against all outstanding picks files. No manual edits to a picks file after it is written. No early conclusions before a meaningful sample size; a single day (e.g. the 2026-09-15 manual check) is noise, not signal.'
  }, null, 2), { flag: 'wx' });
}

async function main() {
  const cmd = process.argv[2];
  ensurePlan();

  if (cmd === 'pick') {
    const date = process.argv[3] || todayPacific();
    console.log(JSON.stringify({ at: new Date().toISOString(), ...(await generatePicks(date)) }));
  } else if (cmd === 'grade') {
    const dates = fs.readdirSync(dir()).filter((f) => /^picks-\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(6, 16)).sort();
    const reports = [];
    for (const date of dates) {
      const report = await gradeDate(date);
      if (report) reports.push(report);
    }
    // See FEATURE-WISHLIST.md #31: `record` is the clear, non-blended split -- fullGame is the
    // site's actual primary pick (graded against the real final score, no ties possible),
    // legacyF5Primary is every pre-fix date still graded under the original F5-primary convention,
    // f5Secondary is the F5 pick now recorded alongside new full-game picks. `overall` is kept for
    // backward compatibility only and blends both conventions -- prefer `record` for reporting.
    console.log(JSON.stringify({ at: new Date().toISOString(), gradedDates: dates, record: summarizeForwardRecord(reports), overall: summarize(reports), threeWayTop8:summarizeThreeWay(reports,'top8'), threeWayTop9:summarizeThreeWay(reports,'top9'), byModel: Object.fromEntries([...new Set(reports.flatMap(r=>r.results||[]).filter(r=>r.provenance==='verified').map(r=>r.modelSha256))].map(hash=>[hash,summarize(reports.map(r=>({...r,results:r.results.filter(p=>p.modelSha256===hash)})))])), legacyUnverified: summarize(reports,{cohort:'legacy-unverified'}), retrospective: summarize(reports,{cohort:'retrospective'}), byLean: summarizeForwardRecord(reports, { minConfidence: 0.55 }), strongerLean: summarizeForwardRecord(reports, { minConfidence: 0.6 }) }));
  } else {
    throw new Error('Use: node scripts/model-forward.js pick [date] | grade');
  }
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
