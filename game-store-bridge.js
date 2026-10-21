"use strict";
const crypto=require("crypto");
const scripts=require("./game-store-scripts.json");
const digest=x=>crypto.createHash("sha256").update(String(x)).digest();
function validateCommand(body,title) {
  if(!Array.isArray(body)||body.length<2||body.length>2048||
      body.some(v=>typeof v!=="string" && typeof v!=="number"))throw Error("INVALID_STORE_COMMAND");
  const cmd=body.map(String),kind=cmd[0];
  const keyType=key=>{
    for(const [name,prefix] of [["session","rr:session:v1:"],["lock","rr:combat:lock:v2:"],["theft","rr:theft:v1:"]]){
      const base=prefix+title+":";
      if(key.startsWith(base)&&/^[A-Fa-f0-9]{8,40}$/.test(key.slice(base.length)))return name;
    }
    throw Error("INVALID_STORE_KEY");
  };
  if(kind==="GET"){
    if(cmd.length!==2||keyType(cmd[1])!=="theft")throw Error("INVALID_STORE_COMMAND");
    return cmd;
  }
  if(kind!=="EVAL")throw Error("STORE_COMMAND_NOT_ALLOWED");
  const name=Object.keys(scripts).find(n=>scripts[n]===cmd[1]);
  if(!name)throw Error("STORE_SCRIPT_NOT_ALLOWED");
  const n=Number(cmd[2]);
  if(!Number.isInteger(n)||n<1||n>256||cmd.length<3+n)throw Error("INVALID_STORE_KEYS");
  const types=cmd.slice(3,3+n).map(keyType),args=cmd.slice(3+n);
  if(name==="session"){
    if(n!==1||types[0]!=="session"||args.length!==6||!['check','enter','heartbeat','leave','status','ticket'].includes(args[0]))throw Error("INVALID_SESSION_COMMAND");
  }else if(name==="acquire" || name==="release"){
    if(types.some(t=>t!=="lock")||args.length!==1)throw Error("INVALID_LOCK_COMMAND");
  }else if(name==="theftSave"){
    const locks=Number(args[1]);
    if(!Number.isInteger(locks)||locks<1||locks>=n||args.length!==2+n-locks||
        types.slice(0,locks).some(t=>t!=="lock")||types.slice(locks).some(t=>t!=="theft"))throw Error("INVALID_THEFT_COMMAND");
    for(const raw of args.slice(2)){const s=JSON.parse(raw);if(!s||typeof s!=="object"||Array.isArray(s))throw Error("INVALID_THEFT_STATE");}
  }else throw Error("STORE_SCRIPT_NOT_ALLOWED");
  return cmd;
}
function installBridge(app,{env=process.env,store}={}) {
  app.post("/internal/game-store",async(req,res)=>{
    res.set("Cache-Control","no-store");
    const secret=String(env.GAME_STORE_BRIDGE_TOKEN||"");
    const token=String(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
    if(!/^[a-f0-9]{64}$/i.test(secret))return res.status(503).json({error:"GAME_STORE_NOT_CONFIGURED"});
    if(token.length>128||!crypto.timingSafeEqual(digest(secret),digest(token)))
      return res.status(401).json({error:"STORE_UNAUTHORIZED"});
    if(env.GAME_STORE_MAINTENANCE==="true")return res.status(503).json({error:"GAME_STORE_MAINTENANCE"});
    let command;
    try{command=validateCommand(req.body,String(env.PLAYFAB_TITLE_ID||""));}
    catch{return res.status(400).json({error:"STORE_COMMAND_REJECTED"});}
    try{return res.json({result:await (store||require("./game-store").sharedStore()).execute(command)});}
    catch{return res.status(503).json({error:"GAME_STORE_UNAVAILABLE"});}
  });
}
module.exports=installBridge;
module.exports.validateCommand=validateCommand;
