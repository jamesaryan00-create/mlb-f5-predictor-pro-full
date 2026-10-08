const {readRecord}=require('../../lib/price-paper-record');
export default function handler(req,res){res.setHeader('Cache-Control','no-store');try{res.status(200).json(readRecord());}catch{res.status(500).json({error:'Price-aware record unavailable'});}}
