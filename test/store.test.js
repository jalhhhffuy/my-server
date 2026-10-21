"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {createStore,markerKey}=require('../game-store');
const {validateCommand}=require('../game-store-bridge');
const scripts=require('../game-store-scripts.json');
const crypto=require('crypto');
const title='TITLE',id='ABCDEF123456',lock='rr:combat:lock:v2:'+title+':'+id,theft='rr:theft:v1:'+title+':'+id;
const env={PLAYFAB_TITLE_ID:title,GAME_STORE_REDIS_URL:'redis://localhost:6379'};
function fake(){
 const calls=[];let connects=0,destroyed=0;const map=new Map([[markerKey(title),JSON.stringify({format:1,titleId:title,complete:true})]]);
 const client={isReady:false,on(){},async connect(){connects++;this.isReady=true;},async sendCommand(c){calls.push(c);if(c[0]==='GET')return map.get(c[1])||null;if(c[0]==='PING')return 'PONG';return 1;},destroy(){destroyed++;this.isReady=false;}};
 return {client,calls,map,get connects(){return connects;},get destroyed(){return destroyed;},factory:()=>client};
}
test('concurrent requests share a connection and verify the migration marker',async()=>{
 const f=fake(),s=createStore({env,createClient:f.factory});
 const replies=await Promise.all(Array.from({length:10},()=>s.execute(['PING'])));
 assert(replies.every(x=>x==='PONG'));assert.equal(f.connects,1);
 await s.execute(['PING']);assert(s.stats.commands>=12);await s.close();
});
test('missing/invalid migration blocks all application writes',async()=>{
 for(const raw of [null,'bad',JSON.stringify({format:1,titleId:'OTHER',complete:true})]){
  const f=fake();f.map.set(markerKey(title),raw);const s=createStore({env,createClient:f.factory});
  await assert.rejects(s.execute(['SET','critical','value']),{code:'GAME_STORE_MIGRATION_REQUIRED'});
  assert(!f.calls.some(c=>c[0]==='SET'));await s.close();
 }
});
test('maintenance prevents opening a connection',async()=>{
 const f=fake(),s=createStore({env:{...env,GAME_STORE_MAINTENANCE:'true'},createClient:f.factory});
 await assert.rejects(s.execute(['PING']),{code:'GAME_STORE_MAINTENANCE'});assert.equal(f.connects,0);
});
test('timed-out stateful command is not retried automatically',async()=>{
 const f=fake();f.client.sendCommand=async c=>{f.calls.push(c);if(c[0]==='GET')return f.map.get(c[1]);return new Promise(()=>{});};
 const s=createStore({env,createClient:f.factory,timeoutMs:15});
 await assert.rejects(s.execute(['EVAL','stateful','0']),{code:'GAME_STORE_TIMEOUT'});
 assert.equal(f.calls.filter(c=>c[0]==='EVAL').length,1);assert.equal(f.destroyed,1);await s.close();
});
test('store errors never fall back to ephemeral memory',async()=>{
 const s=createStore({env:{...env,GAME_STORE_REDIS_URL:''},createClient:()=>{throw Error('should not run');}});
 await assert.rejects(s.execute(['GET',theft]),{code:'GAME_STORE_CONFIG_MISSING'});
});
test('bridge accepts only exact registered scripts and title-owned keys',()=>{
 assert.deepEqual(validateCommand(['GET',theft],title),['GET',theft]);
 assert(validateCommand(['EVAL',scripts.session,'1','rr:session:v1:TITLE:'+id,'check','','','','',id+'.'+'a'.repeat(64)],title));
 assert(validateCommand(['EVAL',scripts.acquire,'1',lock,'lease'],title));
 assert(validateCommand(['EVAL',scripts.release,'1',lock,'lease'],title));
 assert(validateCommand(['EVAL',scripts.theftSave,'2',lock,theft,'lease','1','{}'],title));
 for(const cmd of [ ['FLUSHALL'],['GET','rr:session:v1:TITLE:'+id],['GET','rr:theft:v1:OTHER:'+id],['SET',theft,'{}'],['EVAL','return 1','1',lock],['EVAL',scripts.acquire,'1',theft,'lease'],['EVAL',scripts.theftSave,'2',theft,lock,'lease','1','{}']])assert.throws(()=>validateCommand(cmd,title));
});
function appMock(){const routes={};return {routes,locals:{},get(path,fn){routes['GET '+path]=fn;},post(path,fn){routes['POST '+path]=fn;}};}
function reply(){return {statusCode:200,set(){return this;},status(c){this.statusCode=c;return this;},json(b){this.body=b;return this;}};}
test('bridge rejects unauthenticated calls before touching storage',async()=>{
 const app=appMock();let calls=0;require('../game-store-bridge')(app,{env:{...env,GAME_STORE_BRIDGE_TOKEN:'a'.repeat(64)},store:{execute(){calls++;return 1;}}});
 const res=reply();await app.routes['POST /internal/game-store']({headers:{},body:['GET',theft]},res);
 assert.equal(res.statusCode,401);assert.equal(calls,0);
 const ok=reply();await app.routes['POST /internal/game-store']({headers:{authorization:'Bearer '+'a'.repeat(64)},body:['GET',theft]},ok);assert.equal(ok.body.result,1);
});
test('legacy session routes preserve request/response fields and ticket hashing',async()=>{
 const oldTitle=process.env.PLAYFAB_TITLE_ID;process.env.PLAYFAB_TITLE_ID=title;
 const moduleStore=require('../game-store'),saved=moduleStore.sharedStore;
 const calls=[];moduleStore.sharedStore=()=>({execute:async c=>{calls.push(c);return JSON.stringify({ok:true,success:true,code:'OK',sessionToken:id+'.'+'b'.repeat(64),ready:true,leaseUntil:100});}});
 try{
  const app=appMock();require('../game-session-guard')(app,async ticket=>({success:ticket==='ticket',playFabId:id}));
  const res=reply();await app.routes['POST /session/enter']({headers:{'x-authorization':'ticket'},body:{deviceId:'d'.repeat(20),operationId:'o'.repeat(20)}},res);
  assert.equal(res.statusCode,200);assert(res.body.ready);assert.match(res.body.sessionToken,/^[A-F0-9]+\.[a-f0-9]{64}$/);
  const command=calls[0];assert.equal(command[4],'enter');assert.equal(command[6],crypto.createHash('sha256').update('ticket').digest('hex'));
  await app.locals.gameSessionGuard.assertTicket(id,'ticket');assert.equal(calls[1][4],'ticket');
  const heart=reply();await app.routes['POST /session/heartbeat']({headers:{},body:{sessionToken:res.body.sessionToken}},heart);assert.equal(calls[2][4],'heartbeat');
 }finally{moduleStore.sharedStore=saved;if(oldTitle===undefined)delete process.env.PLAYFAB_TITLE_ID;else process.env.PLAYFAB_TITLE_ID=oldTitle;}
});
test('migration validates checksum, namespace and duplicates without erasing data',()=>{
 const {validate}=require('../scripts/import-store');
 const data={format:1,titleId:title,writersStopped:true,entries:[{key:theft,value:'{"history":{"unpaid":{}}}'}]};
 data.sha256=crypto.createHash('sha256').update(JSON.stringify(data.entries)).digest('hex');assert.equal(validate(data,title),data);
 assert.throws(()=>validate({...data,sha256:'bad'},title));assert.throws(()=>validate(data,'OTHER'));
});
test('import resumes identical records and writes readiness only after all records succeed',async()=>{
 const {run,IMPORT_SCRIPT}=require('../scripts/import-store'),fs=require('fs'),os=require('os'),path=require('path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rr-migrate-')),file=path.join(dir,'data.json');
 const entries=[{key:theft,value:'{"history":{"owed":5}}'}];
 const data={format:1,titleId:title,writersStopped:true,entries,sha256:crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex')};fs.writeFileSync(file,JSON.stringify(data));
 const calls=[],store={async execute(c){calls.push(c);return c[0]==='GET'?null:1;},async close(){}};
 try{await run({env:{...env,GAME_STORE_MAINTENANCE:'true',GAME_STORE_MIGRATION_CONFIRMED:'WRITERS_STOPPED',GAME_STORE_EXPORT_FILE:file},store});assert.equal(calls[1][1],IMPORT_SCRIPT);assert.equal(calls.at(-1)[1],markerKey(title));}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
});
