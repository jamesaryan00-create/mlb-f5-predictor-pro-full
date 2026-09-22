const {getSchedule}=require('../../lib/mlb');
const {assess}=require('../../lib/matchup-logic');
export default async function handler(req,res){res.setHeader('Cache-Control','no-store');try{const date=String(req.query.date||''),id=Number(req.query.gamePk);if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isSafeInteger(id))throw Error('Invalid game/date');const games=(await getSchedule(date)).filter(g=>g.gamePk===id);if(games.length!==1)throw Error('Game/date mismatch');res.status(200).json(await assess(games[0],date));}catch(e){res.status(400).json({error:e.message});}}
