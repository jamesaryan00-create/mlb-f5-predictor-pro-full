const { review } = require('./pitching-review');
const { getLiveHistoricalContext } = require('./historical-f5');
const VERSION = 'pitching-batting-evidence-v1';
function combine(home, away) {
  const signals = [];
  function add(group, label, h, a, lower = false) {
    const available = Number.isFinite(h) && Number.isFinite(a);
    signals.push({group,label,home:h??null,away:a??null,available,vote:available?Math.sign((h-a)*(lower?-1:1)):null});
  }
  for (const [label,key] of [['Season FIP','fip'],['Season WHIP','whip'],['Season K/BB','kbb']]) add('Pitching',label,home.pitching?.season?.[key],away.pitching?.season?.[key],key!=='kbb');
  add('Pitching','Last-five FIP',home.pitching?.last5?.fip,away.pitching?.last5?.fip,true);
  add('Pitching','First-inning ERA (complete innings)',home.pitching?.firstInning?.era,away.pitching?.firstInning?.era,true);
  add('Pitching','First-inning run frequency',home.pitching?.firstInning?.runAllowedPct,away.pitching?.firstInning?.runAllowedPct,true);
  add('Pitching','Innings 2–5 ERA (complete innings)',home.pitching?.innings2to5?.era,away.pitching?.innings2to5?.era,true);
  for(const key of ['ops','obp','slg']) add('Batting',key.toUpperCase(),home.batting?.[key],away.batting?.[key]);
  add('F5 history','Season F5 runs/game',home.f5?.runs,away.f5?.runs);
  add('F5 history','Recent-ten F5 run differential',home.f5?.recent,away.f5?.recent);
  const groups=['Pitching','Batting','F5 history'].map(name=>{const rows=signals.filter(s=>s.group===name&&s.available);return {name,available:rows.length,total:signals.filter(s=>s.group===name).length,score:rows.length?rows.reduce((n,s)=>n+s.vote,0)/rows.length:null};});
  const available=groups.every(g=>g.score!==null);
  const score=available?groups.reduce((n,g)=>n+g.score,0)/groups.length:null;
  return {version:VERSION,available,side:score===null||score===0?null:score>0?'home':'away',score,signals,groups,probability:null,method:'Experimental rule: average directional comparisons within each group, then equally weight pitching, batting and F5 history. Weights are assumptions, not trained. A zero score means conflicting evidence, not a predicted tie. No confidence threshold filters games.',limitations:['Correlated statistics are not independent votes or calibrated probabilities.','Team batting rates are not confirmed-lineup projections or pitcher-handedness splits.','Complete-inning samples exclude early exits and may be biased.','Weather, injuries and pitch velocity are not included.','No validated improvement in win rate; evaluate wins / (wins + losses + ties) on the same games.']};
}
async function assess(game,date) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)throw Error('Invalid date');
  const end=new Date(Date.parse(date+'T12:00:00Z')-86400000).toISOString().slice(0,10);
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles'}).format(new Date());
  if(date>today)throw Error('Future analysis unavailable');
  const context=await getLiveHistoricalContext(date).catch(()=>null);
  const out={};
  for(const side of ['home','away']) {
    const team=game[side], errors=[];
    const pitching=await review(team.probablePitcher?.id,date).catch(e=>{errors.push(e.message);return null;});
    const url=`https://statsapi.mlb.com/api/v1/teams/${team.id}/stats?stats=byDateRange&group=hitting&gameType=R&startDate=${date.slice(0,4)}-01-01&endDate=${end}`;
    let batting=null;
    try{const r=await fetch(url,{signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error(`Batting HTTP ${r.status}`);const d=await r.json(),splits=d.stats?.[0]?.splits;if(splits?.length!==1||splits[0].team?.id!==team.id)throw Error('Batting team mismatch');const s=splits[0].stat;batting={games:s.gamesPlayed,plateAppearances:s.plateAppearances};for(const k of ['ops','obp','slg'])batting[k]=s[k]!==null&&s[k]!==undefined&&s[k]!==''&&Number.isFinite(Number(s[k]))?Number(s[k]):null;}catch(e){errors.push(e.message);}
    const state=context?.states?.get(team.id);
    out[side]={name:team.name,pitching,batting,battingSource:url,f5:state?.games?{games:state.games,runs:state.f5For/state.games,recent:state.recent.length?state.recent.reduce((a,b)=>a+b,0)/state.recent.length:null}:null,errors};
  }
  return {...combine(out.home,out.away),teams:out,gamePk:game.gamePk,throughDate:end,observedAt:new Date().toISOString(),historical:!['Scheduled','Pre-Game'].includes(game.status)||Date.parse(game.gameDate)<=Date.now(),source:'Current MLB historical records through the preceding day; not an archived pregame observation.'};
}
module.exports={combine,assess};
