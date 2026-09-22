const { quoteSetQuality } = require('./kalshi-quotes');
const { firstFiveRuns } = require('./historical-f5');
function capture(row, at) {
 const now=Date.parse(at), start=Date.parse(row.firstPitchUtc);
 if(!Number.isFinite(now)||!Number.isFinite(start)||start<=now||!['Scheduled','Pre-Game'].includes(row.gameStatus))return null;
 const qs=['away','home','tie'].map(s=>row.outcomeQuotes?.[s]);
 if(!quoteSetQuality(qs,now).available || qs.some(q=>!Number.isFinite(q?.mid)||q.mid<=0||q.mid>=1))return null;
 const home=qs[1].mid/(qs[0].mid+qs[1].mid),confidence=Math.max(home,1-home);
 const kalshiPickSide=home>=.5?'HOME':'AWAY';
 const modelAgrees=row.modelAvailable&&row.modelPickSide===kalshiPickSide;
 const maxSpread=Math.max(qs[0].spread,qs[1].spread,qs[2].spread);
 // marketTrust is a separate, later-registered rule (see data/kalshi-forward/model-agreement-plan.json);
 // baseline/candidate are untouched so the original pre-registered experiment stays intact.
 const marketTrust=Boolean(modelAgrees&&confidence>=.62&&Number(row.modelConfidence)>=.55);
 return {...row,capturedAt:at,kalshiConfidence:confidence,kalshiPickSide,baseline:confidence>=.58,candidate:confidence>=.62,modelAvailable:Boolean(row.modelAvailable),modelPickSide:row.modelPickSide??null,modelConfidence:row.modelConfidence??null,modelAgreesWithKalshi:row.modelAvailable?modelAgrees:null,maxSpread,marketTrust};
}
function grade(r,g) {
 if(g?.gamePk!==r.gamePk||g.teams?.home?.team?.id!==r.homeId||g.teams?.away?.team?.id!==r.awayId)return {status:'excluded',reason:'Identity mismatch'};
 if(g.officialDate!==r.officialDate||Date.parse(g.gameDate)!==Date.parse(r.firstPitchUtc)||Object.keys(g).some(k=>/^resum/i.test(k)&&g[k]))return {status:'excluded',reason:'Changed schedule or resumed game'};
 if(!/^(Final|Game Over|Completed Early)(:|$)/.test(g.status?.detailedState||''))return {status:'pending'};
 const runs=firstFiveRuns(g);if(!runs)return {status:'excluded',reason:'Incomplete F5'};
 const result=runs.home===runs.away?'TIE':runs.home>runs.away?'HOME':'AWAY';
 return {status:'graded',...runs,result,win:result===r.kalshiPickSide,tie:result==='TIE'};
}
function summarize(rows,key) {
 const selected=rows.filter(r=>r[key]), graded=selected.filter(r=>r.status==='graded');
 const wins=graded.filter(r=>r.win).length,ties=graded.filter(r=>r.tie).length;
 return {selected:selected.length,graded:graded.length,wins,losses:graded.length-wins-ties,ties,pending:selected.filter(r=>r.status==='pending').length,excluded:selected.filter(r=>r.status==='excluded').length,winPct:graded.length?100*wins/graded.length:null,decided:graded.length-ties,winPctDecided:graded.length-ties?100*wins/(graded.length-ties):null};
}
module.exports={capture,grade,summarize};
