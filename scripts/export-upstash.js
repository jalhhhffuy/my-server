"use strict";
// OFFLINE migration only. Never imported by the running web service.
const fs=require("fs"),crypto=require("crypto");
async function run({env=process.env,request=fetch}={}) {
  const title=String(env.PLAYFAB_TITLE_ID||"");
  const url=String(env.MIGRATION_UPSTASH_REST_URL||"");
  const token=String(env.MIGRATION_UPSTASH_REST_TOKEN||"");
  const file=String(env.GAME_STORE_EXPORT_FILE||"game-store-export.json");
  if(env.GAME_STORE_MIGRATION_CONFIRMED!=="WRITERS_STOPPED")throw Error("Stop all old/new writers and confirm maintenance first");
  if(!/^https:\/\/[a-z0-9.-]+\.upstash\.io$/i.test(url)||!token||!/^[A-Za-z0-9_-]{1,64}$/.test(title))throw Error("Migration configuration missing");
  async function command(body){
    const res=await request(url,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+token},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    const r=await res.json();if(!res.ok||r.error)throw Error("Source unavailable; export stopped, no data deleted");return r.result;
  }
  const entries=[];
  for(const namespace of ["rr:session:v1:","rr:theft:v1:"]){
    let cursor="0";const seen=new Set();
    do {
      const page=await command(["SCAN",cursor,"MATCH",namespace+title+":*","COUNT","100"]);
      if(!Array.isArray(page)||page.length!==2||!Array.isArray(page[1]))throw Error("Invalid source scan reply");
      cursor=String(page[0]);
      for(const key of page[1]){
        if(typeof key!=="string"||seen.has(key))continue;seen.add(key);
        if(!key.startsWith(namespace+title+":"))throw Error("Source namespace mismatch");
        const value=await command(["GET",key]);
        if(typeof value!=="string")throw Error("Record changed during export; keep maintenance enabled");
        const state=JSON.parse(value);if(!state||typeof state!=="object"||Array.isArray(state))throw Error("Corrupt source record");
        entries.push({key,value});
      }
    }while(cursor!=="0");
  }
  const data={format:1,titleId:title,exportedAt:new Date().toISOString(),writersStopped:true,entries};
  data.sha256=crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  // Exclusive creation avoids replacing a previous good backup with an accidental export.
  fs.writeFileSync(file,JSON.stringify(data,null,2)+"\n",{mode:0o600,flag:"wx"});
  console.log("Export completed:",entries.length,"records. Keep this file private.");
  return data;
}
if(require.main===module)run().catch(()=>{console.error("Export failed; source was not modified. Check quota/configuration and maintenance.");process.exitCode=1;});
module.exports={run};
