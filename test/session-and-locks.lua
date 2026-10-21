local now=1000
local database={}
local objects={}
local sequence=0
local function clone(v)
 if type(v)~='table' then return v end
 local o={};for k,x in pairs(v)do o[k]=clone(x)end;return o
end
cjson={encode=function(v) sequence=sequence+1;local id='json-'..sequence;objects[id]=clone(v);return id end,
 decode=function(id)assert(objects[id],'invalid json fixture');return clone(objects[id])end}
redis={call=function(command,key,value,px,ttl)
 command=string.upper(command)
 local item=database[key]
 if item and item.expires and item.expires<=now*1000 then database[key]=nil;item=nil end
 if command=='TIME' then return {tostring(now),'0'} end
 if command=='GET' then return item and item.value or false end
 if command=='SET' then database[key]={value=value,expires=px=='PX' and now*1000+tonumber(ttl) or (px=='EX' and now*1000+tonumber(ttl)*1000 or nil)};return 'OK' end
 if command=='EXISTS' then return item and 1 or 0 end
 if command=='DEL' then database[key]=nil;return item and 1 or 0 end
 error('unknown fixture command '..command)
end}
local passed=0
local function test(name,f)database={};now=1000;f();passed=passed+1;print('PASS '..name)end
local function eval(script,keys,args)KEYS=keys;ARGV=args;local fn,err=load(script);assert(fn,err);return fn()end

local session=[====[-- One atomic decision per account. Redis time is the only authority.
local raw = redis.call('GET', KEYS[1])
local s = raw and cjson.decode(raw) or {version=1,strikes=0,banUntil=0,freezeUntil=0,revoked={}}
local now = tonumber(redis.call('TIME')[1])
local action, device, ticket, op, fresh, token = ARGV[1],ARGV[2],ARGV[3],ARGV[4],ARGV[5],ARGV[6]
local lease = 30
local reason = 'تشغيل الحساب على جهازين في نفس الوقت'
local dirty = false
local function reply(ok,code)
  if dirty then
    -- Keep strikes/bans/admin history permanently. A clean inactive account's
    -- session-only record may expire after all 7-day revocations have expired.
    if (s.strikes or 0)==0 and (s.banUntil or 0)<=now and not s.adminAudit then
      redis.call('SET',KEYS[1],cjson.encode(s),'EX',691200)
    else
      redis.call('SET',KEYS[1],cjson.encode(s))
    end
  end
  local r={ok=ok,success=ok,code=code,serverUnix=now,banUntil=s.banUntil or 0,
    remainingSeconds=math.max(0,(s.banUntil or 0)-now),strikes=s.strikes or 0,reason=reason}
  if ok and s.active and (action=='enter' or action=='heartbeat') then
    r.sessionToken=s.active.token
    r.ready=(s.active.readyAt or 0)<=now
    r.leaseUntil=s.active.expires
  end
  return cjson.encode(r)
end
local function revoke(t,code)
  if t and t~='' then s.revoked[t]={untilUnix=now+604800,code=code} end
end
-- Only expired revoked credentials are pruned; active revocations remain.
if (raw or action=='enter') and now>=(s.nextCleanupAt or 0) then
  for key,item in pairs(s.revoked) do
    if item.untilUnix<=now then s.revoked[key]=nil;dirty=true end
  end
  s.nextCleanupAt=now+300;dirty=true
end
-- A ban is enforced for every action, including retries/status/new sessions.
if (s.banUntil or 0)>now then return reply(false,'ACCOUNT_BANNED') end
if action=='status' then
  if s.revoked[ticket] and s.revoked[ticket].untilUnix>now then
    return reply(false,s.revoked[ticket].code)
  end
  return reply(true,'OK')
end
if action=='enter' then
  for key,item in pairs(s.revoked) do
    if item.untilUnix<=now then s.revoked[key]=nil;dirty=true end
  end
  if s.revoked[ticket] then return reply(false,s.revoked[ticket].code) end
  if (s.freezeUntil or 0)>now then
    revoke(ticket,'MULTI_DEVICE_WARNING');dirty=true
    return reply(false,'MULTI_DEVICE_WARNING')
  end
  if s.active and s.active.expires>now then
    if s.active.device~=device then
      s.strikes=(s.strikes or 0)+1
      s.banUntil=s.strikes>=2 and now+(s.strikes-1)*3600 or 0
      local code=s.strikes==1 and 'MULTI_DEVICE_WARNING' or 'ACCOUNT_BANNED'
      revoke(s.active.ticket,code);revoke(ticket,code)
      s.active=nil;s.freezeUntil=now+10;dirty=true
      return reply(false,code)
    end
    -- Same device / same authenticated login: replay-safe retry after lost reply.
    if s.active.ticket==ticket then
      s.active.expires=now+lease;dirty=true
      return reply(true,'OK')
    end
    -- Re-login on the same installation replaces its old session, no penalty.
    revoke(s.active.ticket,'SESSION_REPLACED')
  end
  s.active={device=device,ticket=ticket,op=op,token=fresh,expires=now+lease,readyAt=now+2}
  dirty=true
  return reply(true,'OK')
end
if action=='leave' then
  if s.active and s.active.token==token then s.active=nil;dirty=true end
  return reply(true,'OK')
end
if action=='ticket' then
  if s.revoked[ticket] and s.revoked[ticket].untilUnix>now then return reply(false,s.revoked[ticket].code) end
  if not s.active or s.active.expires<=now or s.active.ticket~=ticket then return reply(false,'SESSION_REVOKED') end
else
  if not s.active or s.active.token~=token or s.active.expires<=now then
    if s.strikes==1 and (s.freezeUntil or 0)>now then return reply(false,'MULTI_DEVICE_WARNING') end
    return reply(false,'SESSION_REVOKED')
  end
end
if action=='heartbeat' then s.active.expires=now+lease;dirty=true end
if action~='heartbeat' and (s.active.readyAt or 0)>now then return reply(false,'SESSION_PENDING') end
return reply(true,'OK')
]====]

local acquire=[====[for i=1,#KEYS do if redis.call('EXISTS',KEYS[i])==1 then return 0 end end for i=1,#KEYS do redis.call('SET',KEYS[i],ARGV[1],'PX',120000) end return 1]====]

local release=[====[for i=1,#KEYS do if redis.call('GET',KEYS[i])==ARGV[1] then redis.call('DEL',KEYS[i]) end end return 1]====]

local theftSave=[====[local n=tonumber(ARGV[2]);for i=1,n do if redis.call('GET',KEYS[i])~=ARGV[1] then return 0 end end;for i=n+1,#KEYS do redis.call('SET',KEYS[i],ARGV[i-n+2]) end;return 1]====]

local admin=[====[-- Administrative access is authenticated by the Node server before EVAL.
local raw=redis.call('GET',KEYS[1])
local now=tonumber(redis.call('TIME')[1])
if not raw then return cjson.encode({ok=false,code='ACCOUNT_NOT_FOUND'}) end
local s=cjson.decode(raw)
local previous=s.banUntil or 0
if ARGV[1]=='unban' then
  s.banUntil=0
  s.freezeUntil=0
  -- Old revoked credentials remain revoked; a fresh login is required.
  -- Do not clear active leases or strikes: this is only a ban release.
  s.adminAudit=s.adminAudit or {}
  table.insert(s.adminAudit,{action='manual_admin_unban',at=now,previousBanUntil=previous,strikes=s.strikes or 0})
  while #s.adminAudit>100 do table.remove(s.adminAudit,1) end
  redis.call('SET',KEYS[1],cjson.encode(s))
end
return cjson.encode({ok=true,code='OK',serverUnix=now,banUntil=s.banUntil or 0,
remainingSeconds=math.max(0,(s.banUntil or 0)-now),strikes=s.strikes or 0,
reason='تشغيل الحساب على جهازين في نفس الوقت'})
]====]
local key='rr:session:v1:T:ABCDEF123456'
local function decide(action,device,ticket,token,fresh)
 return cjson.decode(eval(session,{key},{action,device or '',ticket or '', 'operation',fresh or 'new',token or ''}))
end
test('enter retry is replay safe',function()
 local first=decide('enter','D','T','','A');assert(first.ok and first.sessionToken=='A' and not first.ready)
 now=1001;local again=decide('enter','D','T','','B');assert(again.sessionToken=='A' and again.strikes==0)
 now=1003;assert(decide('check','','','A').ok)
end)
test('pending/heartbeat use original ready and lease rules',function()
 decide('enter','D','T','','A');assert(decide('check','','','A').code=='SESSION_PENDING')
 now=1001;local h=decide('heartbeat','','','A');assert(h.ok and not h.ready and h.leaseUntil==1031)
 now=1032;assert(decide('heartbeat','','','A').code=='SESSION_REVOKED')
end)
test('same device new login revokes old ticket without a strike',function()
 decide('enter','D','T','','A');local r=decide('enter','D','T2','','B');assert(r.ok and r.strikes==0)
 assert(decide('ticket','','T').code=='SESSION_REPLACED');now=1003;assert(decide('ticket','','T2').ok)
end)
test('two devices warn and revoke both credentials',function()
 decide('enter','D','T','','A');local r=decide('enter','OTHER','T2','','B')
 assert(not r.ok and r.code=='MULTI_DEVICE_WARNING' and r.strikes==1)
 assert(decide('ticket','','T').code=='MULTI_DEVICE_WARNING');assert(decide('ticket','','T2').code=='MULTI_DEVICE_WARNING')
 assert(decide('check','','','A').code=='MULTI_DEVICE_WARNING')
end)
test('repeat multi-device violation bans for one hour',function()
 decide('enter','D','T','','A');decide('enter','OTHER','T2','','B');now=1011
 assert(decide('enter','D','T3','','C').ok);local r=decide('enter','OTHER','T4','','D')
 assert(r.code=='ACCOUNT_BANNED' and r.remainingSeconds==3600 and r.strikes==2)
 assert(decide('status','','newTicket').code=='ACCOUNT_BANNED')
end)
test('admin unban retains strikes and revoked credentials',function()
 decide('enter','D','T','','A');decide('enter','E','T2','','B');now=1011
 decide('enter','D','T3','','C');decide('enter','E','T4','','D')
 local a=cjson.decode(eval(admin,{key},{'unban'}));assert(a.ok and a.banUntil==0 and a.strikes==2)
 local s=cjson.decode(redis.call('GET',key));assert(s.revoked.T and #s.adminAudit==1)
end)
test('lock acquisition is all-or-none and release is token-owned',function()
 assert(eval(acquire,{'K1','K2'},{'owner'})==1)
 assert(eval(acquire,{'K2','K3'},{'other'})==0);assert(not redis.call('GET','K3'))
 eval(release,{'K1','K2'},{'wrong'});assert(redis.call('GET','K1')=='owner')
 eval(release,{'K1','K2'},{'owner'});assert(not redis.call('GET','K1'))
end)
test('lock expires after 120 seconds',function()
 eval(acquire,{'K'},{'old'});now=1121;assert(eval(acquire,{'K'},{'new'})==1)
 eval(release,{'K'},{'old'});assert(redis.call('GET','K')=='new')
end)
test('theft writes require every live fencing lease',function()
 eval(acquire,{'K1','K2'},{'owner'})
 assert(eval(theftSave,{'K1','K2','T1','T2'},{'owner','2','cargo1','cargo2'})==1)
 assert(redis.call('GET','T1')=='cargo1');now=1121
 eval(acquire,{'K1','K2'},{'new'})
 assert(eval(theftSave,{'K1','K2','T1','T2'},{'owner','2','lost','lost'})==0)
 assert(redis.call('GET','T1')=='cargo1' and redis.call('GET','T2')=='cargo2')
end)
test('inactive clean session records expire after eight days',function()
 decide('enter','D','T','','A');now=1000+691201;assert(not redis.call('GET',key))
end)
test('violation records are never expired by session cleanup',function()
 decide('enter','D','T','','A');decide('enter','E','T2','','B');now=1000+691201
 local r=decide('status','','fresh');assert(r.strikes==1)
end)
test('invalid heartbeat cannot create a new storage record',function()
 assert(decide('heartbeat','','','random').code=='SESSION_REVOKED');assert(not redis.call('GET',key))
end)
print(passed..' Lua behavior checks passed (simulated Redis storage/time)')
