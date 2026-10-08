const PLAN=Object.freeze({version:1,cohort:'world-series-2026',label:'World Series 2026 extension',start:'2026-10-23T07:00:00.000Z',end:'2026-11-08T08:00:00.000Z',gameType:'W',captureDirectory:'kalshi-forward-world-series-2026',paperDirectory:'price-paper-world-series-2026',policy:'Separate research cohort; unchanged price-paper-v1. November buffer allows postponements. Grading continues after collection ends. Never merge into the original evaluation.'});
function isOpen(now=Date.now()){return now>=Date.parse(PLAN.start)&&now<Date.parse(PLAN.end);}
function accepts(row){const t=Date.parse(row.firstPitchUtc);return row.gameType===PLAN.gameType&&t>=Date.parse(PLAN.start)&&t<Date.parse(PLAN.end);}
module.exports={PLAN,isOpen,accepts};
