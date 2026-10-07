import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const root='/Users/carlos/Documents/ChatGPT/New project 2/NKU-study-resources-s2';
const require=createRequire(root+'/package.json'), Database=require('better-sqlite3');
const dir=await fs.mkdtemp('/private/tmp/nkustudy-s5-ui-'), data=dir+'/data', app=dir+'/app';
await fs.mkdir(data,{mode:0o700}); await fs.mkdir(app);
await fs.cp(root+'/server',app+'/server',{recursive:true}); await fs.symlink(root+'/node_modules',app+'/node_modules');
await fs.writeFile(app+'/package.json','{"type":"module"}');
for(const name of ['about','feedback','footer','guides','home','links','manifest','participate','reviews']) await fs.copyFile(`${root}/src/data/fixtures/${name}.json`,`${data}/${name}.json`);
await fs.writeFile(data+'/notify-settings.json','{"enabled":false}');
await fs.writeFile(data+'/backup-settings.json','{"autoEnabled":false,"r2DataBackup":false,"webdavEnabled":false}');
const reserve=http.createServer(); await new Promise(r=>reserve.listen(0,'127.0.0.1',r)); const apiPort=reserve.address().port; await new Promise(r=>reserve.close(r));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.json':'application/json','.woff2':'font/woff2'};
const proxy=http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(/^\/(api\/v1|admin-api|review-api|feedback-api|visit-api)(\/|$)/.test(pathname)||pathname==='/editor-settings'){
    if(req.method!=='GET') await fs.appendFile(dir+'/requests.jsonl',JSON.stringify({method:req.method,path:pathname})+'\n');
    try { const fault=JSON.parse(await fs.readFile(dir+'/fail-next.json')); if(fault.path===pathname){await fs.unlink(dir+'/fail-next.json');res.writeHead(500,{'content-type':'text/html'});res.end('<h1>Synthetic failure before request forwarding</h1>');return;} } catch{}
    const upstream=http.request({hostname:'127.0.0.1',port:apiPort,path:req.url,method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
    upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);return;
  }
  try {let relative=decodeURIComponent(pathname).replace(/^\/+/, '');if(relative.includes('..'))throw Error();if(!path.extname(relative))relative=path.join(relative,'index.html');const file=path.join(root,'dist-fixture',relative);const bytes=await fs.readFile(file);res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream','cache-control':'no-store'});res.end(bytes);}catch{res.writeHead(404);res.end('Not found');}
});
await new Promise(r=>proxy.listen(0,'127.0.0.1',r)); const base='http://127.0.0.1:'+proxy.address().port;
const child=spawn(process.execPath,['server/admin-server.mjs'],{cwd:app,env:{PATH:process.env.PATH,TMPDIR:'/private/tmp',NODE_ENV:'test',DATA_DIR:data,STATE_DB_PATH:dir+'/state.sqlite',ADMIN_SECRET_FILE:dir+'/secret',BACKUP_SECRET_FILE:data+'/backup-secrets.json',ADMIN_HOST:'127.0.0.1',ADMIN_PORT:String(apiPort),ADMIN_ORIGIN:base,ADMIN_INITIAL_PASSWORD:'S5-synthetic-only-123',PUBLIC_DIR:dir+'/public/current',PUBLIC_RELEASES_DIR:dir+'/public/releases'},stdio:['ignore','pipe','pipe']});
child.stdout.on('data',b=>fs.appendFile(dir+'/server.log',b));child.stderr.on('data',b=>fs.appendFile(dir+'/server.log',b));
let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/v1/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}if(!ready)throw Error('Synthetic service failed to start');
const accounts=[];
for(const nickname of ['S5浏览器正常','S5浏览器待清理','S5浏览器故障']){const r=await fetch(base+'/api/v1/auth/web-register',{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({nickname,password:'S5-synthetic-only-123'})});const result=await r.json();if(!r.ok)throw Error(JSON.stringify(result));accounts.push({nickname,id:result.data.user.id});}
const db=new Database(dir+'/state.sqlite');db.prepare("INSERT INTO avatars(id,user_id,status,bytes,created_at,upload_state) VALUES(?,?,'approved',128,?,'settled')").run('synthetic-pending-avatar',accounts[1].id,Date.now());db.close();
await fs.writeFile('/private/tmp/nkustudy-s5-browser-state.json',JSON.stringify({dir,data,base,apiPort,childPid:child.pid,accounts}));console.log(JSON.stringify({dir,base,accounts}));
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{child.kill('SIGTERM');proxy.close(()=>process.exit(0));});
