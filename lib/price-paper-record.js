const fs=require('fs'),path=require('path');
function readRecord(dir=path.join(process.cwd(),'data/price-paper')) {
  if(!fs.existsSync(dir))return {picks:0,wins:0,losses:0,pending:0,passes:0,cost:0,net:0,roi:null,rows:[]};
  const files=fs.readdirSync(dir),rows=[];
  for(const f of files.filter(f=>/^decision-\d+\.json$/.test(f))){
    const d=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));
    const grade=path.join(dir,`grade-${d.gamePk}.json`);
    rows.push({...d,grade:fs.existsSync(grade)?JSON.parse(fs.readFileSync(grade,'utf8')):null});
  }
  const picks=rows.filter(r=>r.decision.selected),graded=picks.filter(r=>r.grade?.status==='graded');
  const cost=graded.reduce((s,r)=>s+r.decision.selected.trade.cost,0),net=graded.reduce((s,r)=>s+r.grade.net,0);
  return {picks:picks.length,wins:graded.filter(r=>r.grade.win).length,losses:graded.filter(r=>!r.grade.win).length,
    pending:picks.length-graded.length,passes:rows.length-picks.length,cost,net,roi:cost?100*net/cost:null,rows};
}
module.exports={readRecord};
