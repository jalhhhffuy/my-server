"use strict";
(() => {
  const key=document.getElementById("key"),account=document.getElementById("account");
  const lookup=document.getElementById("lookup"),unban=document.getElementById("unban");
  const box=document.getElementById("state"),message=document.getElementById("message");
  let selected=null,received=0,busy=false;
  const errors={ADMIN_UNAUTHORIZED:"مفتاح الإدارة غير صحيح.",ADMIN_NOT_CONFIGURED:"أضف SESSION_GUARD_ADMIN_KEY في Render أولًا.",INVALID_ACCOUNT_ID:"اكتب PlayFab ID الصحيح للحساب.",ACCOUNT_NOT_FOUND:"الحساب ليس له سجل في نظام الحماية حتى الآن.",RATE_LIMIT:"طلبات كثيرة؛ انتظر دقيقة ثم أعد المحاولة.",SESSION_GUARD_UNAVAILABLE:"تعذر الاتصال بسجل الحظر؛ لم يتم تأكيد أي تغيير."};
  function clear(){selected=null;box.hidden=true;unban.hidden=true;unban.disabled=true;message.textContent="";}
  key.addEventListener("input",clear);account.addEventListener("input",clear);
  document.getElementById("logout").addEventListener("click",()=>{key.value="";clear();key.focus();});
  function render(){
    if(!selected)return;
    const left=Math.max(0,selected.remainingSeconds-Math.floor((performance.now()-received)/1000));
    const h=String(Math.floor(left/3600)).padStart(2,"0"),m=String(Math.floor(left/60)%60).padStart(2,"0"),s=String(left%60).padStart(2,"0");
    box.hidden=false;box.textContent="الحساب: "+selected.playFabId+"\nالحالة: "+(left>0?"محظور":"غير محظور")+"\nعدد المخالفات: "+selected.strikes+(left>0?"\nالسبب: "+selected.reason+"\nالوقت المتبقي: "+h+":"+m+":"+s:"");
    unban.hidden=left<=0;unban.disabled=busy||left<=0;
  }
  async function request(action){
    if(busy)return;
    const target=account.value.trim().toUpperCase();
    if(!/^[A-F0-9]{8,40}$/.test(target)){message.textContent=errors.INVALID_ACCOUNT_ID;return;}
    if(!/^[a-f0-9]{64}$/i.test(key.value.trim())){message.textContent="اكتب مفتاح الإدارة كاملًا (64 رمزًا).";return;}
    if(action==="unban"&&(!selected||selected.playFabId!==target))return;
    busy=true;lookup.disabled=true;key.disabled=account.disabled=true;render();message.textContent="جارٍ تنفيذ الطلب...";
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
    try{
      const response=await fetch("/admin/session-guard/"+action,{method:"POST",credentials:"omit",cache:"no-store",signal:controller.signal,headers:{"Content-Type":"application/json","X-Session-Admin-Key":key.value.trim()},body:JSON.stringify({playFabId:target})});
      const r=await response.json();
      if(!response.ok||!r.ok)throw Error(errors[r.code]||"تعذر تنفيذ الطلب. أعد عرض حالة الحساب للتأكد.");
      selected=r;received=performance.now();
      message.textContent=action==="unban"?"تم فك الحظر. يستطيع اللاعب تسجيل الدخول مجددًا؛ عدد المخالفات لم يتغير.":"تم تحديث حالة الحساب من السيرفر.";
    }catch(e){clear();message.textContent=e.name==="AbortError"?"انتهت مهلة الاتصال؛ أعد عرض الحالة للتأكد من نتيجة العملية.":e.message;}
    finally{clearTimeout(timeout);busy=false;lookup.disabled=false;key.disabled=account.disabled=false;render();}
  }
  lookup.addEventListener("click",()=>request("status"));unban.addEventListener("click",()=>request("unban"));setInterval(render,1000);
})();
