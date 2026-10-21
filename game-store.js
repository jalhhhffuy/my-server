"use strict";
// Shared native Redis/Valkey connection. Never replay a command after an ambiguous
// transport error: session decisions and currency-related operations are stateful.
const markerKey = title => "rr:migration:v1:" + title;
const failure = code => Object.assign(new Error(code), {code});
function createStore({env=process.env, createClient, timeoutMs=6000, requireMigration=true}={}) {
  let client=null, connecting=null, markerClient=null, inFlight=0;
  const stats={commands:0,failures:0,timeouts:0};
  const title=String(env.PLAYFAB_TITLE_ID||"").trim();
  function drop(c) {
    if(client===c){client=null;markerClient=null;}
    try {c.destroy();} catch {}
  }
  async function bounded(promise,c) {
    let timer;
    try {
      return await Promise.race([promise,new Promise((_,reject)=>{
        timer=setTimeout(()=>{stats.timeouts++;drop(c);reject(failure("GAME_STORE_TIMEOUT"));},timeoutMs);
      })]);
    } finally {clearTimeout(timer);}
  }
  async function connection() {
    if(connecting)return connecting;
    if(client && client.isReady)return client;
    connecting=(async()=>{
      const url=String(env.GAME_STORE_REDIS_URL||"");
      let parsed;try{parsed=new URL(url);}catch{throw failure("GAME_STORE_CONFIG_MISSING");}
      if(!["redis:","rediss:"].includes(parsed.protocol) || !/^[A-Za-z0-9_-]{1,64}$/.test(title))
        throw failure("GAME_STORE_CONFIG_MISSING");
      // No silent fallback to Upstash or process memory.
      const factory=createClient||require("redis").createClient;
      const c=factory({url,disableOfflineQueue:true,socket:{connectTimeout:4000,reconnectStrategy:false}});
      client=c;
      c.on("error",()=>{markerClient=null;});
      try {await bounded(c.connect(),c);return c;}
      catch {drop(c);throw failure("GAME_STORE_UNAVAILABLE");}
    })();
    try{return await connecting;}finally{connecting=null;}
  }
  async function raw(c,command){stats.commands++;return bounded(c.sendCommand(command),c);}
  async function ready(c) {
    if(!requireMigration || markerClient===c)return;
    const marker=await raw(c,["GET",markerKey(title)]);
    let state;try{state=JSON.parse(marker);}catch{}
    if(!state || state.format!==1 || state.titleId!==title || !state.complete)
      throw failure("GAME_STORE_MIGRATION_REQUIRED");
    markerClient=c;
  }
  return {
    stats,
    async execute(command) {
      if(inFlight>=256)throw failure("GAME_STORE_BUSY");
      if(requireMigration && env.GAME_STORE_MAINTENANCE === "true")throw failure("GAME_STORE_MAINTENANCE");
      inFlight++;
      try {const c=await connection();await ready(c);return await raw(c,command);}
      catch(e){stats.failures++;throw failure(e.code||"GAME_STORE_UNAVAILABLE");}
      finally{inFlight--;}
    },
    async close(){const c=client;client=null;markerClient=null;if(c)try{c.destroy();}catch{}},
    title
  };
}
let shared;
function sharedStore(){return shared||(shared=createStore());}
module.exports={createStore,sharedStore,markerKey};
