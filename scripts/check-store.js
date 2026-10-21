"use strict";
const {sharedStore}=require("../game-store");
(async()=>{
  const s=sharedStore();
  try{if(await s.execute(["PING"])!=="PONG")throw Error("bad response");console.log("Game store connected; migration marker verified.");}
  catch(e){console.error("Game store check failed:",e.code||"UNAVAILABLE");process.exitCode=1;}
  finally{await s.close();}
})();
