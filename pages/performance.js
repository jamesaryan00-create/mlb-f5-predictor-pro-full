import { useEffect, useState } from 'react';

const card = { background:'#111827', border:'1px solid #263244', borderRadius:14, padding:18 };
const th = { textAlign:'left', padding:'10px 12px', borderBottom:'1px solid #334155', color:'#94a3b8', fontSize:13 };
const td = { padding:'10px 12px', borderBottom:'1px solid #1f2937' };
function pct(v){ return v == null ? '—' : `${Number(v).toFixed(2)}%`; }

export default function Performance(){
  const [data,setData]=useState(null); const [error,setError]=useState('');
  useEffect(()=>{ fetch('/api/backtest').then(r=>r.json().then(j=>({ok:r.ok,j}))).then(({ok,j})=>{if(!ok)throw new Error(j.error||'Backtest unavailable');setData(j)}).catch(e=>setError(e.message)); },[]);
  const o=data?.overall;
  return <main style={{minHeight:'100vh',background:'#070b12',color:'#e5e7eb',padding:'28px',fontFamily:'Inter,system-ui,sans-serif'}}>
    <div style={{maxWidth:1100,margin:'0 auto'}}>
      <a href="/" style={{color:'#93c5fd',textDecoration:'none'}}>← Back to predictor</a>
      <h1 style={{fontSize:32,margin:'14px 0 6px'}}>F5 Historical Backtest</h1>
      <p style={{color:'#94a3b8',marginTop:0}}>Leakage-safe walk-forward results. F5 ties are pushes and are not counted as wins or losses.</p>
      {error && <div style={{...card,borderColor:'#7f1d1d',color:'#fecaca'}}>{error}</div>}
      {o && <>
        <section style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))',gap:12,margin:'22px 0'}}>
          {[['Win %',pct(o.winPct)],['Wins',o.wins],['Losses',o.losses],['Pushes',o.pushes],['Historical picks',o.picks]].map(([k,v])=><div key={k} style={card}><div style={{color:'#94a3b8',fontSize:13}}>{k}</div><div style={{fontSize:30,fontWeight:700,marginTop:5}}>{v}</div></div>)}
        </section>
        <div style={{...card,marginBottom:18}}><strong>Method:</strong> <span style={{color:'#cbd5e1'}}>{data.methodology}</span><br/><span style={{display:'inline-block',marginTop:8,color:'#93c5fd'}}>{data.scopeNote}</span><br/><span style={{display:'inline-block',marginTop:8,color:'#fbbf24'}}>{data.oddsNote}</span></div>
        <section style={{...card,overflowX:'auto',marginBottom:18}}><h2 style={{marginTop:0}}>By season</h2><table style={{width:'100%',borderCollapse:'collapse'}}><thead><tr>{['Season','Picks','Wins','Losses','Pushes','Win %'].map(x=><th key={x} style={th}>{x}</th>)}</tr></thead><tbody>{(data.bySeason||[]).map(r=><tr key={r.label}><td style={td}>{r.label}</td><td style={td}>{r.picks}</td><td style={td}>{r.wins}</td><td style={td}>{r.losses}</td><td style={td}>{r.pushes}</td><td style={{...td,fontWeight:700}}>{pct(r.winPct)}</td></tr>)}</tbody></table></section>
        <section style={{...card,overflowX:'auto'}}><h2 style={{marginTop:0}}>By model confidence</h2><table style={{width:'100%',borderCollapse:'collapse'}}><thead><tr>{['Confidence','Picks','Wins','Losses','Pushes','Win %'].map(x=><th key={x} style={th}>{x}</th>)}</tr></thead><tbody>{(data.byConfidence||[]).map(r=><tr key={r.label}><td style={td}>{r.label}</td><td style={td}>{r.picks}</td><td style={td}>{r.wins}</td><td style={td}>{r.losses}</td><td style={td}>{r.pushes}</td><td style={{...td,fontWeight:700}}>{pct(r.winPct)}</td></tr>)}</tbody></table></section>
      </>}
      {!data&&!error&&<div style={card}>Loading backtest…</div>}
    </div>
  </main>;
}
