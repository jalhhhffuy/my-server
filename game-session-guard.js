"use strict";
const crypto = require("crypto");
const ATOMIC_SCRIPT = "-- One atomic decision per account. Redis time is the only authority.\nlocal raw = redis.call('GET', KEYS[1])\nlocal s = raw and cjson.decode(raw) or {version=1,strikes=0,banUntil=0,freezeUntil=0,revoked={}}\nlocal now = tonumber(redis.call('TIME')[1])\nlocal action, device, ticket, op, fresh, token = ARGV[1],ARGV[2],ARGV[3],ARGV[4],ARGV[5],ARGV[6]\nlocal lease = 30\nlocal reason = 'تشغيل الحساب على جهازين في نفس الوقت'\nlocal dirty = false\nlocal function reply(ok,code)\n  if dirty then redis.call('SET',KEYS[1],cjson.encode(s)) end\n  local r={ok=ok,success=ok,code=code,serverUnix=now,banUntil=s.banUntil or 0,\n    remainingSeconds=math.max(0,(s.banUntil or 0)-now),strikes=s.strikes or 0,reason=reason}\n  if ok and s.active and (action=='enter' or action=='heartbeat') then\n    r.sessionToken=s.active.token\n    r.ready=(s.active.readyAt or 0)<=now\n    r.leaseUntil=s.active.expires\n  end\n  return cjson.encode(r)\nend\nlocal function revoke(t,code)\n  if t and t~='' then s.revoked[t]={untilUnix=now+604800,code=code} end\nend\n-- A ban is enforced for every action, including retries/status/new sessions.\nif (s.banUntil or 0)>now then return reply(false,'ACCOUNT_BANNED') end\nif action=='status' then\n  if s.revoked[ticket] and s.revoked[ticket].untilUnix>now then\n    return reply(false,s.revoked[ticket].code)\n  end\n  return reply(true,'OK')\nend\nif action=='enter' then\n  for key,item in pairs(s.revoked) do\n    if item.untilUnix<=now then s.revoked[key]=nil;dirty=true end\n  end\n  if s.revoked[ticket] then return reply(false,s.revoked[ticket].code) end\n  if (s.freezeUntil or 0)>now then\n    revoke(ticket,'MULTI_DEVICE_WARNING');dirty=true\n    return reply(false,'MULTI_DEVICE_WARNING')\n  end\n  if s.active and s.active.expires>now then\n    if s.active.device~=device then\n      s.strikes=(s.strikes or 0)+1\n      s.banUntil=s.strikes>=2 and now+(s.strikes-1)*3600 or 0\n      local code=s.strikes==1 and 'MULTI_DEVICE_WARNING' or 'ACCOUNT_BANNED'\n      revoke(s.active.ticket,code);revoke(ticket,code)\n      s.active=nil;s.freezeUntil=now+10;dirty=true\n      return reply(false,code)\n    end\n    -- Same device / same authenticated login: replay-safe retry after lost reply.\n    if s.active.ticket==ticket then\n      s.active.expires=now+lease;dirty=true\n      return reply(true,'OK')\n    end\n    -- Re-login on the same installation replaces its old session, no penalty.\n    revoke(s.active.ticket,'SESSION_REPLACED')\n  end\n  s.active={device=device,ticket=ticket,op=op,token=fresh,expires=now+lease,readyAt=now+2}\n  dirty=true\n  return reply(true,'OK')\nend\nif action=='leave' then\n  if s.active and s.active.token==token then s.active=nil;dirty=true end\n  return reply(true,'OK')\nend\nif action=='ticket' then\n  if s.revoked[ticket] and s.revoked[ticket].untilUnix>now then return reply(false,s.revoked[ticket].code) end\n  if not s.active or s.active.expires<=now or s.active.ticket~=ticket then return reply(false,'SESSION_REVOKED') end\nelse\n  if not s.active or s.active.token~=token or s.active.expires<=now then\n    if s.strikes==1 and (s.freezeUntil or 0)>now then return reply(false,'MULTI_DEVICE_WARNING') end\n    return reply(false,'SESSION_REVOKED')\n  end\nend\nif action=='heartbeat' then s.active.expires=now+lease;dirty=true end\nif action~='heartbeat' and (s.active.readyAt or 0)>now then return reply(false,'SESSION_PENDING') end\nreturn reply(true,'OK')\n";
const sha = value => crypto.createHash("sha256").update(String(value || "")).digest("hex");
function configuration() {
  const url = String(process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || "");
  const title = String(process.env.PLAYFAB_TITLE_ID || "").trim();
  if (!/^https:\/\/[a-z0-9.-]+\.upstash\.io$/i.test(url) || !token || !title)
    throw Object.assign(new Error("SESSION_CONFIG_MISSING"), {code:"SESSION_CONFIG_MISSING"});
  return {url, token, prefix:"rr:session:v1:" + title + ":"};
}
async function decision(playerId, action, values = {}) {
  const cfg = configuration();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(cfg.url, {method:"POST",signal:controller.signal,
      headers:{"Content-Type":"application/json",Authorization:"Bearer " + cfg.token},
      body:JSON.stringify(["EVAL",ATOMIC_SCRIPT,"1",cfg.prefix+playerId,action,
        values.device||"",values.ticket||"",values.operation||"",values.fresh||"",values.token||""])});
    const json = await response.json();
    if (!response.ok || json.error || typeof json.result !== "string") throw Error("SESSION_STORE_UNAVAILABLE");
    return JSON.parse(json.result);
  } finally {clearTimeout(timeout);}
}
const messages = {
  ACCOUNT_BANNED:"حسابك محظور حاليًا",
  MULTI_DEVICE_WARNING:"تحذير: تم تشغيل الحساب على جهازين وإخراج الجهازين. هذه المخالفة الأولى، وتكرارها يسبب الحظر.",
  SESSION_REPLACED:"تم استبدال جلسة الدخول. سجّل الدخول من جديد.",
  SESSION_REVOKED:"انتهت صلاحية الجلسة أو تم إلغاؤها. سجّل الدخول من جديد.",
  SESSION_PENDING:"جاري التحقق من أمان الجلسة",
  SESSION_CONFIG_MISSING:"إعدادات حماية الجلسة غير مكتملة في السيرفر"
};
function decorate(r) {r.message=messages[r.code] || (r.ok ? "OK" : "تعذر التحقق من الجلسة");return r;}
function getTicket(req) {
  const h=String(req.headers["x-authorization"]||req.headers.authorization||"").replace(/^Bearer\s+/i,"");
  return String(h||(req.body&&req.body.sessionTicket)||"").trim();
}
function tokenOwner(token) {
  const m=/^([A-Fa-f0-9]{8,40})\.([a-f0-9]{64})$/.exec(String(token||""));
  return m ? m[1] : "";
}
module.exports = function installGameSessionGuard(app, authenticateBare) {
  async function auth(req) {
    const ticket=getTicket(req);
    if (!ticket || ticket.length>4096) throw Object.assign(Error("AUTH_REQUIRED"),{code:"AUTH_REQUIRED"});
    const a=await authenticateBare(ticket);
    if (!a || !a.success || !/^[a-f0-9]{8,40}$/i.test(a.playFabId||""))
      throw Object.assign(Error("AUTH_INVALID"),{code:"AUTH_INVALID"});
    return {id:a.playFabId,ticket:sha(ticket)};
  }
  function route(action, needsTicket) {
    return async (req,res) => {
      res.set("Cache-Control","no-store");
      try {
        let id, hashedTicket="", lease=String((req.body||{}).sessionToken||"");
        if (needsTicket) {const a=await auth(req);id=a.id;hashedTicket=a.ticket;}
        else {id=tokenOwner(lease);if (!id) return res.status(401).json({ok:false,code:"AUTH_REQUIRED"});}
        const values={ticket:hashedTicket,token:lease};
        if (action==="enter") {
          const device=String((req.body||{}).deviceId||"");
          const operation=String((req.body||{}).operationId||"");
          if (!/^[a-zA-Z0-9_-]{16,128}$/.test(device)||! /^[a-zA-Z0-9_-]{16,64}$/.test(operation))
            return res.status(400).json({ok:false,code:"INVALID_SESSION_INPUT"});
          values.device=sha(device);values.operation=operation;
          values.fresh=id+"."+crypto.randomBytes(32).toString("hex");
        }
        // Business denial uses HTTP 200 so the client reads the exact ban/countdown,
        // rather than retrying it as a transient transport failure.
        return res.json(decorate(await decision(id,action,values)));
      } catch(e) {
        return res.status(e.code==="AUTH_INVALID"||e.code==="AUTH_REQUIRED"?401:503)
          .json({ok:false,success:false,code:e.code||"SESSION_GUARD_UNAVAILABLE",
            message:messages[e.code]||"تعذر التحقق من أمان الجلسة. حاول مرة أخرى."});
      }
    };
  }
  app.post("/session/enter",route("enter",true));
  app.post("/session/heartbeat",route("heartbeat",false));
  app.post("/session/leave",route("leave",false));
  app.post("/session/status",route("status",true));
  const guard = {
    async assertTicket(playerId,ticket) {
      const r=decorate(await decision(playerId,"ticket",{ticket:sha(ticket)}));
      if (!r.ok) throw Object.assign(Error(r.message),{code:r.code,sessionState:r});
      return r;
    }
  };
  app.locals.gameSessionGuard=guard;
  return guard;
};
// Testable decision boundary; no credentials or live services in tests.
module.exports._test={decision,sha,tokenOwner,ATOMIC_SCRIPT};
