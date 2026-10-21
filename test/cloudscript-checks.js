const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(require('path').join(__dirname,'../cloudscript/RedRevenge_CloudScript_SelfHosted.txt'),'utf8');
let count=0;
function test(name,fn){fn();count++;console.log('PASS '+name);}
function setup(){
 const calls=[];
 const server=new Proxy({}, {get(o,k){return o[k]||(o[k]=(a)=>{calls.push([k,a]);throw Error('Unexpected API '+k);});}});
 const c={handlers:{},server,currentPlayerId:'ABCDEF123456',http:{request(){throw Error('Unexpected HTTP');}},log:{error(){},info(){},debug(){}},console};
 vm.createContext(c);vm.runInContext(source,c);c.calls=calls;return c;
}
function clean(c){assert.equal(c.RRPerf_scope,null);assert.equal(c.RRT_CACHE,null);assert.equal(c.SG_handlerDepth,0);}
test('balance display has no external session call; each poll reads fresh currency',()=>{
 const c=setup();let n=0;c.server.GetUserInventory=()=>({VirtualCurrency:{GD:++n}});
 c.SG_authorize=()=>{throw Error('display performed session check');};
 assert.equal(c.handlers.GetGold({}).gold,1);assert.equal(c.handlers.GetGold({}).gold,2);clean(c);
});
test('sensitive handlers reject before any gameplay API when session is invalid',()=>{
 const c=setup();let n=0;c.SG_authorize=()=>{n++;return {success:false,code:'SESSION_REVOKED'};};
 for(const name of ['BuyMissiles','BuyShip','StartShipTheft','ClaimShipFishing','SellWarehouseFish','SpendGold','AttackVisitedFleetWithBomb','AttackVisitedShipWithMissile','UseCrewOnShip'])
  assert.equal(c.handlers[name]({}).code,'SESSION_REVOKED');
 assert.equal(n,9);assert.equal(c.calls.length,0);clean(c);
});
test('crew polling cleans expired entries without writing player data',()=>{
 const c=setup();c.server.GetUserData=()=>({Data:{active_crews:{Value:'{}'},crew_inventory:{Value:'{}'}}});
 assert(c.handlers.GetCrewInventory({}).success);assert.equal(c.calls.length,0);clean(c);
});
test('title memoization lasts one request; protects cached response from caller mutation',()=>{
 const c=setup();let n=0;c.server.GetTitleData=()=>({Data:{A:String(++n)}});
 c.RRPerf_scope={titles:{}};let first=c.RRPerfTitleData({Keys:['A']});first.Data.A='mutated';
 assert.equal(c.RRPerfTitleData({Keys:['A']}).Data.A,'1');assert.equal(n,1);
 c.RRPerf_scope=null;assert.equal(c.RRPerfTitleData({Keys:['A']}).Data.A,'2');
 c.RRPerf_scope={titles:{}};assert.equal(c.RRPerfTitleData({Keys:['A']}).Data.A,'3');
});
test('title errors are retried and nonstandard options bypass memoization',()=>{
 const c=setup();let n=0;c.RRPerf_scope={titles:{}};
 c.server.GetTitleData=()=>{if(++n===1)throw Error('offline');return {Data:{A:'ok'}};};
 assert.throws(()=>c.RRPerfTitleData({Keys:['A']}));assert.equal(c.RRPerfTitleData({Keys:['A']}).Data.A,'ok');assert.equal(n,2);
 c.RRPerfTitleData({Keys:['A'],OverrideLabel:'X'});assert.equal(n,3);
});
test('complete existing fleet loads without session Redis; incomplete migration stays guarded',()=>{
 const c=setup();c.RRTReadConfirmedFleet=()=>({success:true,ownedShips:['Ship1']});
 c.SG_authorize=()=>{throw Error('unexpected guard');};assert(c.handlers.EnsureShipState({}).success);clean(c);
 c.RRTReadConfirmedFleet=()=>null;c.SG_authorize=()=>({code:'SESSION_AUTH_REQUIRED'});
 assert.equal(c.handlers.EnsureShipState({}).code,'SESSION_AUTH_REQUIRED');clean(c);
});
function lockSetup(c){
 const metrics={checks:0,dependencies:0,ticks:0,locks:0,unlocks:0};
 c.SG_authorize=()=>{metrics.checks++;return null;};
 c.RRTDependencies=ids=>{metrics.dependencies++;return ids;};c.RRTTick=()=>metrics.ticks++;
 c.server.GetTitleInternalData=()=>({Data:{SESSION_GUARD_REDIS:JSON.stringify({url:'https://game.example.com/internal/game-store',token:'private',titleId:'T'})}});
 c.RRDLockCall=(cfg,script,keys)=>{if(script===c.RRD_LOCK_ACQUIRE){metrics.locks++;assert(keys.length>0);}else metrics.unlocks++;return 1;};
 return metrics;
}
test('ordinary purchase uses account lock without theft dependency traversal or settlement',()=>{
 const c=setup(),m=lockSetup(c);assert.equal(c.RRDLocked(()=>({success:true}),{},null,false,{localOnly:true}).success,true);
 assert.deepEqual(m,{checks:1,dependencies:0,ticks:0,locks:1,unlocks:1});
});
test('combat retains target locks, dependency validation and theft settlement',()=>{
 const c=setup(),m=lockSetup(c);assert(c.RRDLocked(()=>({success:true}),{targetPlayFabId:'123456ABCDEF'},null,true).success);
 assert.equal(m.dependencies,2);assert.equal(m.ticks,1);assert.equal(m.locks,1);assert.equal(m.unlocks,1);
});
test('read handler mutation branch still requires an authorized session',()=>{
 const c=setup();c.SG_authorize=()=>({code:'ACCOUNT_BANNED'});
 assert.equal(c.RRDLocked(()=>{throw Error('mutation ran');},{},null,false).code,'ACCOUNT_BANNED');
});
test('idle theft read avoids locks; active missions keep session and locking path',()=>{
 const c=setup();c.RRTLoad=()=>({active:{},incoming:{},history:{},trips:{}});c.RRBFleet=()=>[];
 c.RRTState=()=>({serverUnix:1,ships:[]});c.SG_authorize=()=>{throw Error('idle session call');};
 assert(c.handlers.GetTheftState({}).success);clean(c);
 c.RRTLoad=()=>({active:{x:{}},incoming:{},history:{},trips:{}});c.SG_authorize=()=>({code:'SESSION_AUTH_REQUIRED'});
 assert.equal(c.handlers.GetTheftState({}).code,'SESSION_AUTH_REQUIRED');clean(c);
});
test('visitor energy keeps the visit authorization check',()=>{
 const c=setup();c.OVCValidateVisitSession=()=>({ok:false,code:'VISIT_SESSION_REQUIRED',message:'visit'});
 assert.equal(c.handlers.GetShipCombatEnergyState({targetPlayFabId:'123456ABCDEF'}).code,'VISIT_SESSION_REQUIRED');clean(c);
});
test('request cleanup runs after errors and failed authorization',()=>{
 const c=setup();c.server.GetUserInventory=()=>{throw Error('read failed');};
 assert.throws(()=>c.handlers.GetGold({}));clean(c);
 c.SG_authorize=()=>({code:'DENIED'});c.handlers.BuyShip({});clean(c);
});
test('all original handlers remain available',()=>{
 const c=setup();assert.equal(Object.keys(c.handlers).length,101);
});


test('only own HTTPS storage bridge is accepted by CloudScript',()=>{const c=setup();assert(c.RRSelfHostedStoreUrl('https://game.example.com/internal/game-store'));for(const u of ['https://old.upstash.io','http://game.example.com/internal/game-store','https://game.example.com/internal/game-store?x=1','https://user:pass@game.example.com/internal/game-store'])assert(!c.RRSelfHostedStoreUrl(u));});

console.log(count+' CloudScript tests passed');
