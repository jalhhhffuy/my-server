"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('crypto');
const scripts=require('../game-store-scripts.json');
const {createStore}=require('../game-store');
test('live Redis/Valkey: concurrent account decisions and atomic fenced writes',
 {skip:!process.env.GAME_STORE_TEST_REDIS_URL},async()=>{
  const title='TEST_'+crypto.randomBytes(8).toString('hex'),id='ABCDEF123456';
  const s=createStore({env:{PLAYFAB_TITLE_ID:title,GAME_STORE_REDIS_URL:process.env.GAME_STORE_TEST_REDIS_URL},requireMigration:false});
  const session='rr:session:v1:'+title+':'+id,lock='rr:combat:lock:v2:'+title+':'+id,theft='rr:theft:v1:'+title+':'+id;
  try{
   const command=(device,ticket,fresh)=>['EVAL',scripts.session,'1',session,'enter',device,ticket,'operation',fresh,''];
   const decisions=await Promise.all([s.execute(command('device-A','ticket-A','token-A')),s.execute(command('device-B','ticket-B','token-B'))]);
   const replies=decisions.map(JSON.parse);assert.equal(replies.filter(r=>r.ok).length,1);assert.equal(replies.filter(r=>r.code==='MULTI_DEVICE_WARNING').length,1);
   assert.equal(await s.execute(['EVAL',scripts.acquire,'1',lock,'old']),1);
   assert.equal(await s.execute(['EVAL',scripts.acquire,'1',lock,'new']),0);
   assert.equal(await s.execute(['EVAL',scripts.theftSave,'2',lock,theft,'old','1','{"cargo":7}']),1);
   await s.execute(['EVAL',scripts.release,'1',lock,'old']);await s.execute(['EVAL',scripts.acquire,'1',lock,'new']);
   assert.equal(await s.execute(['EVAL',scripts.theftSave,'2',lock,theft,'old','1','{"cargo":0}']),0);
   assert.equal(await s.execute(['GET',theft]),'{"cargo":7}');
  }finally{try{await s.execute(['DEL',session,lock,theft]);}finally{await s.close();}}
 });
