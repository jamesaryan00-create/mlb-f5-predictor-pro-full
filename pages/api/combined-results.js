const {results,summary,run}=require('../../lib/combined-record');
let running=null;
export default async function handler(req,res){res.setHeader('Cache-Control','no-store');if(!['GET','POST'].includes(req.method))return res.status(405).end();try{let update=null;if(req.method==='POST'){if(!running)running=run().finally(()=>{running=null;});update=await running;}const rows=results();return res.status(200).json({rows,summary:summary(rows),update});}catch(e){res.status(500).json({error:e.message});}}
