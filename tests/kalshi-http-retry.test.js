const test=require('node:test'),assert=require('node:assert/strict');
const {getJson}=require('../lib/kalshi-http');
test('429 without Retry-After waits before retrying',async()=>{
 const oldFetch=global.fetch,oldTimer=global.setTimeout;let calls=0;const waits=[];
 global.fetch=async()=>++calls===1?{status:429,headers:{get:()=>null}}:{ok:true,json:async()=>({ok:true})};
 global.setTimeout=(fn,ms)=>{waits.push(ms);fn();return 0;};
 try{assert.deepEqual(await getJson('https://example.invalid'),{ok:true});assert.deepEqual(waits,[750]);}finally{global.fetch=oldFetch;global.setTimeout=oldTimer;}
});
