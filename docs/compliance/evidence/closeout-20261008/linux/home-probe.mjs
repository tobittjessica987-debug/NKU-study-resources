import os from 'node:os';
import { existsSync, writeFileSync } from 'node:fs';
const result={uid:process.getuid(),gid:process.getgid(),HOME:process.env.HOME??null,osHomedir:os.homedir(),homeExists:existsSync(os.homedir()),scope:'Synthetic container account only'};
writeFileSync('/work/home-probe.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(result));
if(result.HOME!==null || result.uid!==501 || result.osHomedir!=='/work/home' || !result.homeExists) process.exitCode=1;
