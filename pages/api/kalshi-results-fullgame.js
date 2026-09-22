const {readResults}=require('../../lib/kalshi-results-fullgame');
export default function handler(req,res){res.setHeader('Cache-Control','no-store');try{return res.status(200).json(readResults());}catch{return res.status(500).json({error:'Kalshi full-game results could not be read.'});}}
