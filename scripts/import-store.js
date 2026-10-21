"use strict";
const fs=require("fs"),crypto=require("crypto");
const {createStore,markerKey}=require("../game-store");
const IMPORT_SCRIPT="local old=redis.call('GET',KEYS[1]);if old then if old==ARGV[1] then return 0 else return redis.error_reply('DESTINATION_CONFLICT') end end;redis.call('SET',KEYS[1],ARGV[1]);return 1";
function validate(data,title){
  if(!data||data.format!==1||data.titleId!==title||data.writersStopped!==true||!Array.isArray(data.entries)||!data.entries.length)throw Error("Incomplete or empty migration export");
  const hash=crypto.createHash("sha256").update(JSON.stringify(data.entries)).digest("hex");
  if(hash!==data.sha256)throw Error("Export checksum mismatch");
  const seen=new Set();
  for(const entry of data.entries){
    const allowed=["rr:session:v1:","rr:theft:v1:"].some(p=>typeof entry.key==="string"&&entry.key.startsWith(p+title+":")&&/^[A-Fa-f0-9]{8,40}$/.test(entry.key.slice((p+title+":").length)));
    if(!allowed||seen.has(entry.key)||typeof entry.value!=="string")throw Error("Invalid/duplicate migration record");
    seen.add(entry.key);const state=JSON.parse(entry.value);
    if(!state||typeof state!=="object"||Array.isArray(state))throw Error("Invalid record payload");
  }
  return data;
}
async function run({env=process.env,store}={}){
  if(env.GAME_STORE_MAINTENANCE!=="true"||env.GAME_STORE_MIGRATION_CONFIRMED!=="WRITERS_STOPPED")throw Error("Maintenance confirmation required");
  const title=String(env.PLAYFAB_TITLE_ID||"");
  const data=validate(JSON.parse(fs.readFileSync(env.GAME_STORE_EXPORT_FILE||"game-store-export.json","utf8")),title);
  store=store||createStore({env,requireMigration:false});
  try{
    // Marker is written last. Partial failure keeps production routes unavailable;
    // re-importing the identical backup is safe and resumes already-copied values.
    const marker=await store.execute(["GET",markerKey(title)]);
    if(marker){const m=JSON.parse(marker);if(m.sourceSha256!==data.sha256)throw Error("Different migration already completed");}
    for(const entry of data.entries)
      await store.execute(["EVAL",IMPORT_SCRIPT,"1",entry.key,entry.value]);
    const completed=JSON.stringify({format:1,titleId:title,complete:true,records:data.entries.length,sourceSha256:data.sha256,at:new Date().toISOString()});
    await store.execute(["SET",markerKey(title),completed]);
    console.log("Import verified:",data.entries.length,"records; cutover can now be completed.");
  }finally{await store.close();}
}
if(require.main===module)run().catch(()=>{console.error("Import failed. Keep maintenance on; no existing record was overwritten. Check export and destination.");process.exitCode=1;});
module.exports={run,validate,IMPORT_SCRIPT};
