// Research collection only. Does not select picks or place orders.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const normalize = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function implied(odds) {
  if (odds == null || odds === '') return null;
  const n = Number(odds);
  return !Number.isFinite(n) || Math.abs(n) < 100 ? null : n > 0 ? 100 / (100 + n) : -n / (100 - n);
}
function matchEvent(event, games) {
  const matches = games.filter(g => Date.parse(g.gameDate) === Date.parse(event.status?.startsAt)
    && normalize(g.teams?.home?.team?.name) === normalize(event.teams?.home?.names?.long)
    && normalize(g.teams?.away?.team?.name) === normalize(event.teams?.away?.names?.long));
  return matches.length === 1 ? matches[0] : null;
}
function bookPairs(event, observedAt) {
  const home = event.odds?.['points-home-game-ml-home']?.byBookmaker || {};
  const away = event.odds?.['points-away-game-ml-away']?.byBookmaker || {};
  return [...new Set([...Object.keys(home), ...Object.keys(away)])].map(book => {
    const h = home[book], a = away[book], hp = implied(h?.odds), ap = implied(a?.odds);
    const ht = Date.parse(h?.lastUpdatedAt), at = Date.parse(a?.lastUpdatedAt), now = Date.parse(observedAt);
    const valid = h?.available === true && a?.available === true && hp !== null && ap !== null
      && [ht,at].every(t => Number.isFinite(t) && now-t >= 0 && now-t <= 300000) && Math.abs(ht-at) <= 60000;
    return { bookmaker: book, home: h || null, away: a || null, validForComparison: valid,
      noVigHomeProbability: valid ? hp/(hp+ap) : null };
  });
}
function kalshiPair(record, event, observedAt) {
  if (!record || Date.parse(record.firstPitchUtc) !== Date.parse(event.status?.startsAt)) return null;
  const now = Date.parse(observedAt), captured = Date.parse(record.capturedAt);
  const quotes = ['home','away'].map(s => record.outcomeQuotes?.[s]);
  if (!Number.isFinite(captured) || now-captured < 0 || now-captured > 300000
      || Date.parse(record.firstPitchUtc) <= now
      || quotes.some(q => !q || !Number.isFinite(q.ask) || !Number.isFinite(q.bid) || q.bid < 0 || q.ask <= 0 || q.ask >= 1 || q.bid > q.ask
        || !Number.isFinite(Date.parse(q.time)) || now-Date.parse(q.time) < 0 || now-Date.parse(q.time) > 300000)) return null;
  return { capturedAt: record.capturedAt, outcomeQuotes: record.outcomeQuotes, marketTickers: record.marketTickers,
    modelPickSide: record.modelPickSide ?? null, modelConfidence: record.modelConfidence ?? null };
}
async function request(url, key) {
  const r = await fetch(url, { headers: key ? { 'x-api-key': key, accept:'application/json' } : {}, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`Provider HTTP ${r.status}`); // Never log request headers or secrets.
  const d = await r.json();
  if (d.success === false) throw new Error('Provider returned unsuccessful response');
  return d;
}
function latestKalshi(dir) {
  const records = new Map();
  if (!fs.existsSync(dir)) return records;
  // Capture filenames begin with Unix milliseconds, so only recent files need inspection.
  const files = fs.readdirSync(dir).filter(f => /^capture-\d+.*\.json$/.test(f)).sort().slice(-12);
  for (const file of files) {
    const d = JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));
    for (const r of d.allRecords || d.records || []) if (!records.has(r.gamePk) || Date.parse(r.capturedAt)>Date.parse(records.get(r.gamePk).capturedAt)) records.set(r.gamePk,r);
  }
  return records;
}
async function capture({ dir, keyFile, tracker, audit = false }) {
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const lock = path.join(dir,'capture.lock');
  let handle;
  try { handle=fs.openSync(lock,'wx',0o600); } catch(e) { if(e.code==='EEXIST') return { status:'locked' }; throw e; }
  try {
    const now = Date.now(), before = now + (audit ? 24*60 : 70)*60000;
    const date = t => new Date(t).toISOString().slice(0,10);
    const schedule = await request(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${date(now)}&endDate=${date(before)}`);
    const games = (schedule.dates || []).flatMap(d=>d.games || []).filter(g => Date.parse(g.gameDate)>now && Date.parse(g.gameDate)<=before && g.status?.abstractGameState==='Preview');
    if (!games.length) return { status:'no_upcoming_games' };
    const statePath=path.join(dir,'state.json');
    const state=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):{ counts:{},lastAt:{},month:date(now).slice(0,7),entities:0 };
    if(state.month!==date(now).slice(0,7)){state.month=date(now).slice(0,7);state.entities=0;}
    const wanted=games.filter(g=>audit || ((state.counts[g.gamePk]||0)<4 && now-(state.lastAt[g.gamePk]||0)>=19*60000));
    if(!wanted.length)return {status:'game_capture_budget_reached'};
    if(state.entities+30>1800)return {status:'monthly_collector_budget_reached'};
    const key=fs.readFileSync(keyFile,'utf8').trim();
    const usage=await request('https://api.sportsgameodds.com/v2/account/usage/',key);
    const month=usage.data?.rateLimits?.['per-month'];
    const max=Number(month?.['max-entities']),used=Number(month?.['current-entities']);
    if(!Number.isFinite(max)||!Number.isFinite(used)||max-used<530)return {status:'quota_reserve_or_unknown',remaining:Number.isFinite(max-used)?max-used:null};
    const params=new URLSearchParams({leagueID:'MLB',started:'false',oddsAvailable:'true',startsAfter:new Date(now).toISOString(),startsBefore:new Date(before).toISOString(),oddID:'points-home-game-ml-home,points-away-game-ml-away',limit:'30'});
    const payload=await request(`https://api.sportsgameodds.com/v2/events/?${params}`,key);
    const observedAt=new Date().toISOString(), kalshi=latestKalshi(path.join(tracker,'data',require('./world-series-window').isOpen(now)?require('./world-series-window').PLAN.captureDirectory:'kalshi-forward-fullgame'));
    const records=(payload.data||[]).map(event=>{
      const game=matchEvent(event,games);
      const pairs=bookPairs(event,observedAt);
      const candidate=game?kalshi.get(game.gamePk):null;
      const identityOk=candidate && candidate.homeId===game.teams.home.team.id && candidate.awayId===game.teams.away.team.id;
      return {eventID:event.eventID,gamePk:game?.gamePk??null,matchStatus:game?'matched':'unmatched',observedAt,
        books:pairs,kalshi:identityOk?kalshiPair(candidate,event,observedAt):null,rawEvent:event};
    });
    const file=`snapshot-${Date.now()}-${crypto.randomUUID()}.json`;
    fs.writeFileSync(path.join(dir,file),JSON.stringify({schemaVersion:1,observedAt,audit,windowMinutes:audit?1440:70,
      nextCursorPresent:Boolean(payload.nextCursor),records},null,2),{flag:'wx',mode:0o600});
    state.entities+=(payload.data||[]).length;
    if(!audit)for(const g of wanted){state.counts[g.gamePk]=(state.counts[g.gamePk]||0)+1;state.lastAt[g.gamePk]=now;}
    fs.writeFileSync(statePath+'.tmp',JSON.stringify(state),{mode:0o600});fs.renameSync(statePath+'.tmp',statePath);
    return {status:'captured',file,events:records.length,matched:records.filter(r=>r.gamePk).length,
      validBookPairs:records.reduce((s,r)=>s+r.books.filter(b=>b.validForComparison).length,0),pairedKalshi:records.filter(r=>r.kalshi).length};
  } finally { fs.closeSync(handle);fs.unlinkSync(lock); }
}
module.exports={implied,matchEvent,bookPairs,kalshiPair,capture};
