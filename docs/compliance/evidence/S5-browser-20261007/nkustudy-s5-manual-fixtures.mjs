import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const state=JSON.parse(await fs.readFile('/private/tmp/nkustudy-s5-browser-state.json'));
const require=createRequire('/Users/carlos/Documents/ChatGPT/New project 2/NKU-study-resources-s2/package.json'),Database=require('better-sqlite3');
state.manualAccounts=[];
for(const nickname of ['S5手动正常','S5手动待清理','S5手动故障']){
 const r=await fetch(state.base+'/api/v1/auth/web-register',{method:'POST',headers:{'content-type':'application/json',origin:state.base},body:JSON.stringify({nickname,password:'S5-synthetic-only-123'})});
 const j=await r.json(); if(!r.ok)throw Error(JSON.stringify(j));state.manualAccounts.push({nickname,id:j.data.user.id});
}
const db=new Database(state.dir+'/state.sqlite');
db.prepare("INSERT INTO avatars(id,user_id,status,bytes,created_at,upload_state) VALUES(?,?,'approved',128,?,'settled')").run('manual-pending-avatar',state.manualAccounts[1].id,Date.now());
const normalIds=[state.accounts[0].id,state.manualAccounts[0].id];
const reviews=JSON.parse(await fs.readFile(state.data+'/reviews.json'));reviews.reviews??=[];
const feedback=JSON.parse(await fs.readFile(state.data+'/feedback.json'));feedback.items??=[];
for(const user_id of normalIds){
 reviews.reviews.push({id:'s5-synthetic-public-'+user_id,courseTitle:'示例课程',teacher:'合成教师',rating:5,tags:[],content:'S5合成公开评价：注销后原文保留，仅清理账号身份关联。',status:'approved',hidden:false,user_id,helpfulBy:[],helpfulCount:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
 feedback.items.push({id:'s5-synthetic-private-'+user_id,title:'S5合成私密举报',content:'S5合成私密内容：注销后仍保持私密，原文保留。',type:'report',private:true,hidden:false,status:'pending',handlingStatus:'open',publicationState:'pending',contact:'synthetic@example.invalid',user_id,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
}
await fs.writeFile(state.data+'/reviews.json',JSON.stringify(reviews));await fs.writeFile(state.data+'/feedback.json',JSON.stringify(feedback));
await fs.mkdir(state.dir+'/before',{mode:0o700});
await fs.cp(state.data,state.dir+'/before/data',{recursive:true});
await db.backup(state.dir+'/before/state.sqlite');db.close();
await fs.writeFile('/private/tmp/nkustudy-s5-browser-state.json',JSON.stringify(state));
console.log(JSON.stringify({base:state.base,manualAccounts:state.manualAccounts,fixtureIds:['s5-synthetic-public-'+state.manualAccounts[0].id,'s5-synthetic-private-'+state.manualAccounts[0].id]}));
