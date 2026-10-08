const {readRecord}=require('../../lib/price-paper-record');
const path=require('path');
const {PLAN}=require('../../lib/world-series-window');
export default function handler(req,res){res.setHeader('Cache-Control','no-store');const cohort=req.query.cohort||'original';if(!['original',PLAN.cohort].includes(cohort))return res.status(400).json({error:'Unknown cohort'});try{res.status(200).json({...readRecord(path.join(process.cwd(),'data',cohort==='original'?'price-paper':PLAN.paperDirectory)),cohort});}catch{res.status(500).json({error:'Price-aware record unavailable'});}}
