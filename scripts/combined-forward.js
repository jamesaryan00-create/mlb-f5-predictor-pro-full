const {run,results,summary}=require('../lib/combined-record');
run().then(update=>console.log(JSON.stringify({...update,summary:summary(results())}))).catch(e=>{console.error(e.message);process.exitCode=1;});
