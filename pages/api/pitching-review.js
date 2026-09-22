const {review}=require('../../lib/pitching-review');
export default async function handler(req,res){res.setHeader('Cache-Control','no-store');try{return res.status(200).json(await review(Number(req.query.id),String(req.query.date||'')));}catch(e){return res.status(400).json({error:e.message});}}
