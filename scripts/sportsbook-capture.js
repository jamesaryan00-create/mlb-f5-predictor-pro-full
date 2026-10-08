const path=require('path');
const os=require('os');
const {capture}=require('../lib/sportsbook-capture');
capture({dir:process.env.SPORTSBOOK_DATA_DIR||path.join(os.homedir(),'sportsbook-data'),
  keyFile:process.env.SGO_KEY_FILE||path.join(os.homedir(),'.config/mlb/sgo-key'),
  tracker:process.cwd(),audit:process.argv.includes('--audit')})
  .then(r=>console.log(JSON.stringify({at:new Date().toISOString(),...r})))
  .catch(e=>{console.error(JSON.stringify({at:new Date().toISOString(),status:'failed',error:e.message}));process.exitCode=1;});
