"use strict";
// Kling 정식 요소 등록 복구 시험: 유료 호출·실제 DB·실제 Kling API는 전부 가짜.
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
const UID="11111111-2222-3333-4444-555555555555",plain=x=>JSON.parse(JSON.stringify(x));
function grab(name){
  const re=new RegExp("  (?:async )?function "+name+"\\("),m=re.exec(html);
  assert.ok(m,"function "+name+" exists");
  const end=html.indexOf("\n  }\n",m.index);assert.ok(end>m.index,"function "+name+" is terminated");
  return html.slice(m.index,end+5);
}
function makeEl(shared=false){
  const folder=shared?"_shared_elements":"hotelX",prefix=UID+"/"+folder+"/element/";
  return {key:shared?"common_1":"local_1",name:"강아지",desc:"작은 강아지",scope:shared?"global":"local",
    front:{id:prefix+"front.jpg",w:900,h:1200},angles:[{id:prefix+"side.jpg",w:900,h:1200}],
    kling:shared?{status:"ready",elementId:"OLD_1",sig:"original_photos_no_longer_current",at:1}:undefined};
}
function makeProj(el){return{id:"hotelX",name:"숙소",photos:[],elements:el?[el]:[],clipJobs:{},clipArchive:{}};}
function env(options={}){
  const global=!!options.global;
  const el=makeEl(global),proj=makeProj(global?null:el);
  if(options.kling)el.kling=plain(options.kling);
  const requests=[],saved=[],warnings=[],logs=[],asked=[];
  const queue=(options.replies||[]).slice();
  let revision=0;
  let viewInputs=[];
  const ctx=vm.createContext({
    uid:UID,current:options.home?null:proj,projects:[proj],
    sharedElements:global?[el]:[],sharedDeletedKeys:[],sharedLoaded:true,sharedSyncBusy:{},
    elemInflight:{},elemPhotoBusy:{},elemErrors:{},elemDrafts:{},elemMisses:{},
    editBusy:false,clipInflight:{},clipMisses:{},clipErrors:{},clipPollTimer:null,clipClock:null,
    CLIP:{pollMs:8000,giveUpMs:2400000,maxMisses:15},ELEM:{nameMax:20,descMax:100,maxAngles:3,minSide:300,maxRatio:2.5,giveUpMs:1800000,maxMisses:15},
    FN:{clip:"https://mock.invalid/clip"},
    SUPA:{url:"https://mock.invalid",sharedTable:"shared",table:"projects"},
    view:{querySelectorAll:()=>viewInputs,querySelector:()=>null},
    esc:x=>String(x??"").replace(/&/g,"&amp;").replace(/</g,"&lt;"),
    toast:x=>warnings.push(x),renderClipsSoon:()=>{},renderEdit:()=>{},elemRefreshLive:()=>{},sharedRefreshLive:()=>{},
    setTimeout:()=>{ctx.scheduled=(ctx.scheduled||0)+1;return 1;},
    setInterval:()=>1,clearTimeout:()=>{},clearInterval:()=>{},
    console:{warn:x=>logs.push(x),error:x=>logs.push(x)},
    confirm:x=>{asked.push(x);return options.confirm!==false;},
    persist:async p=>{
      const fail=options.failLocalSave&&options.failLocalSave(plain(p),saved.length);
      saved.push({type:"local",snapshot:plain(p)});
      return !fail;
    },
    persistSharedElement:async (next,expected)=>{
      const fail=options.failSharedSave&&options.failSharedSave(next,expected,saved.length);
      if(fail)throw Error("mock shared revision/save failure");
      const stored=Object.assign({},next,{scope:"global",revision:"r"+(++revision)});
      ctx.sharedElements=ctx.sharedElements.filter(x=>x.key!==next.key);
      ctx.sharedElements.unshift(stored);
      saved.push({type:"shared",snapshot:plain(stored)});
    },
    publishSharedElement:async (p,e)=>{ctx.published=(ctx.published||[]).concat([e.key]);return true;},
    api:async (url,opts)=>{
      const data=JSON.parse(opts.body||"{}");
      requests.push(data);
      const r=queue.shift();
      if(!r)throw Error("No mock response for "+data.action);
      if(r instanceof Error)throw r;
      const status=r.http||200;
      return {ok:status>=200&&status<300,status,text:async()=>JSON.stringify(r.body)};
    }
  });
  const functions=["elemList","elemByKey","elemPhotos","elemSig","elemNameProblem","elemState",
    "elemTaskId","elemAutoPending","elemArchivedJobs","elemRecoverableJob","elemRecoveryHtml",
    "elemStatusDetails","elemPhotoLocked","elemPendingKeys","elemPendingWork",
    "elemPauseRegistration","elemRegister","elemCheck","sharedPauseRegistration","sharedRegister","sharedCheck",
    "elemSaveRecovery","elemRecoveryTarget","elemManualCheck","elemPauseByKey","elemResumeByKey",
    "elemAbandonByKey","elemRestoreByKey","elemAttachByKey",
    "clipJobIds","clipTaskId","clipAutoJobIds","ensureClipPoll","clipPollTick"];
  vm.runInContext(functions.map(grab).join("\n"),ctx);
  return {ctx,el,proj,requests,saved,warnings,asked,
    push(...items){queue.push(...items)},setInputs(a){viewInputs=a}};
}
const pending={http:200,body:{status:"pending"}};
const ready={http:200,body:{status:"ready",elementId:"NEW_2"}};
const create={http:200,body:{operation:{taskId:"TASK_ID_123"}}};
const error={http:200,body:{status:"error",message:"face rejected"}};
const oldJob=(age=31*60*1000)=>({status:"pending",taskId:"OLD_JOB_1",sig:"x",at:Date.now()-age,prevElementId:"OLD_1"});

test("local registration saves the pending claim BEFORE submitting the paid request",async()=>{
  const h=env({replies:[create]});
  await Promise.all([h.ctx.elemRegister(h.el.key),h.ctx.elemRegister(h.el.key)]);
  assert.equal(h.requests.filter(x=>x.action==="element_create").length,1);
  assert.equal(h.saved[0].snapshot.elements[0].kling.status,"pending");
  assert.equal(h.saved[0].snapshot.elements[0].kling.taskId,null);
  assert.equal(h.el.kling.taskId,"TASK_ID_123");
  assert.equal(h.saved.at(-1).snapshot.elements[0].kling.taskId,"TASK_ID_123");
});
test("local save failure blocks paid registration completely",async()=>{
  const h=env({failLocalSave:()=>true});
  await h.ctx.elemRegister(h.el.key);
  assert.equal(h.requests.length,0);
  assert.equal(h.el.kling,undefined);
});
test("local ambiguous network start is paused and a second paid request is blocked",async()=>{
  const h=env({replies:[Error("lost response")]});
  await h.ctx.elemRegister(h.el.key);
  assert.equal(h.el.kling.status,"pending");
  assert.equal(h.el.kling.needsCheck,true);
  await h.ctx.elemRegister(h.el.key);
  assert.deepEqual(h.requests.map(x=>x.action),["element_create"]);
});
test("31-minute local work checks existing task before pausing and later recovers",async()=>{
  const h=env({kling:oldJob(),replies:[pending,ready]});
  await h.ctx.elemCheck(h.proj,h.el.key);
  assert.deepEqual(h.requests.map(x=>x.action),["element_status"]);
  assert.equal(h.el.kling.needsCheck,true);
  assert.equal(h.el.kling.taskId,"OLD_JOB_1");
  await h.ctx.elemManualCheck(h.el.key);
  assert.equal(h.el.kling.status,"ready");
  assert.equal(h.el.kling.elementId,"NEW_2");
  assert.deepEqual(h.requests.map(x=>x.action),["element_status","element_status"]);
});
test("31-minute shared work checks existing task before pausing and recovers old ID safely",async()=>{
  const h=env({global:true,kling:{...oldJob(),elementId:"OLD_1"},replies:[pending,ready]});
  await h.ctx.sharedCheck(h.el.key);
  assert.equal(h.ctx.sharedElements[0].kling.needsCheck,true);
  assert.equal(h.ctx.sharedElements[0].kling.taskId,"OLD_JOB_1");
  await h.ctx.elemManualCheck(h.el.key);
  assert.equal(h.ctx.sharedElements[0].kling.elementId,"NEW_2");
  assert.ok(h.ctx.sharedElements[0].retiredElementIds.includes("OLD_1"));
  assert.deepEqual(h.requests.map(x=>x.action),["element_status","element_status"]);
});
test("reloading to home finds BOTH project-local and shared pending work",()=>{
  const h=env({home:true,global:true,kling:{...oldJob(1000),elementId:"OLD_1"}});
  const local=makeEl();local.key="another";local.kling=oldJob(1000);
  h.proj.elements=[local];
  assert.equal(h.ctx.elemPendingWork().length,2);
  h.ctx.ensureClipPoll();
  assert.ok(h.ctx.scheduled>0,"home polling starts without opening a property");
  h.el.kling.needsCheck=true;local.kling.needsCheck=true;
  assert.equal(h.ctx.elemPendingWork().length,0,"paused jobs do not trigger infinite automatic retries");
});
test("home polling completes local registered elements without paid element_create",async()=>{
  const h=env({home:true,kling:oldJob(1000),replies:[ready]});
  await h.ctx.clipPollTick();
  assert.equal(h.el.kling.elementId,"NEW_2");
  assert.equal(h.el.kling.status,"ready");
  assert.deepEqual(h.requests.map(x=>x.action),["element_status"]);
});
test("15 transient local status failures pause but never delete an existing task ID",async()=>{
  const h=env({kling:oldJob(1000),replies:Array.from({length:15},()=>({http:503,body:{error:"temporary"}}))});
  for(let i=0;i<15;i++)await h.ctx.elemCheck(h.proj,h.el.key);
  assert.equal(h.el.kling.needsCheck,true);
  assert.equal(h.el.kling.taskId,"OLD_JOB_1");
  assert.equal(h.requests.length,15);
  await h.ctx.elemRegister(h.el.key);
  assert.equal(h.requests.length,15);
});
test("shared hard 403 status failure pauses and preserves ID rather than unlocking a new paid registration",async()=>{
  const h=env({global:true,kling:oldJob(1000),replies:[{http:403,body:{error:"denied"}}]});
  await h.ctx.sharedCheck(h.el.key);
  assert.equal(h.ctx.sharedElements[0].kling.status,"pending");
  assert.equal(h.ctx.sharedElements[0].kling.needsCheck,true);
  assert.equal(h.ctx.sharedElements[0].kling.taskId,"OLD_JOB_1");
});
test("no task ID after two minutes stays recoverable and can attach existing ID for status lookup",async()=>{
  const h=env({kling:{...oldJob(121000),taskId:null},replies:[ready]});
  await h.ctx.elemCheck(h.proj,h.el.key);
  assert.equal(h.el.kling.status,"pending");
  assert.equal(h.el.kling.needsCheck,true);
  h.setInputs([{dataset:{elementTask:h.el.key},value:"MANUAL_ID_12"}]);
  await h.ctx.elemAttachByKey(h.el.key);
  assert.equal(h.el.kling.elementId,"NEW_2");
  assert.deepEqual(h.requests.map(x=>x.action),["element_status"]);
  assert.equal(h.requests[0].operation.taskId,"MANUAL_ID_12");
});
test("manual pause and resume preserve the existing task and reset only the auto-check clock",async()=>{
  const h=env({kling:oldJob(31*60*1000)});
  await h.ctx.elemPauseByKey(h.el.key);
  assert.equal(h.el.kling.needsCheck,true);
  await h.ctx.elemResumeByKey(h.el.key);
  assert.equal(h.el.kling.needsCheck,false);
  assert.ok(h.el.kling.pollSince>Date.now()-5000);
  assert.equal(h.requests.length,0);
});
test("two explicit abandon confirmations archive the job and a manual restore checks it without paid create",async()=>{
  const h=env({kling:{...oldJob(),needsCheck:true},replies:[ready]});
  await h.ctx.elemAbandonByKey(h.el.key);
  assert.equal(h.asked.length,2);
  assert.equal(h.el.kling.status,"failed");
  assert.equal(h.el.klingHistory[0].taskId,"OLD_JOB_1");
  await h.ctx.elemRestoreByKey(h.el.key);
  assert.equal(h.el.kling.elementId,"NEW_2");
  assert.equal(h.el.klingHistory.length,0);
  assert.deepEqual(h.requests.map(x=>x.action),["element_status"]);
});
test("declining abandon preserves the lock and prevents billing",async()=>{
  const h=env({confirm:false,kling:{...oldJob(),needsCheck:true}});
  await h.ctx.elemAbandonByKey(h.el.key);
  assert.equal(h.el.kling.status,"pending");
  assert.equal(h.requests.length,0);
});
test("shared ambiguous start keeps pending registration rather than marking it as failed",async()=>{
  const h=env({global:true,replies:[Error("upstream timeout")]});
  await h.ctx.sharedRegister(h.el.key);
  assert.equal(h.ctx.sharedElements[0].kling.status,"pending");
  assert.equal(h.ctx.sharedElements[0].kling.needsCheck,true);
  assert.equal(h.requests.filter(x=>x.action==="element_create").length,1);
  await h.ctx.sharedRegister(h.el.key);
  assert.equal(h.requests.filter(x=>x.action==="element_create").length,1);
});
test("shared successful request persists taskId before reload and preserves old official ID",async()=>{
  const h=env({global:true,replies:[create]});
  await h.ctx.sharedRegister(h.el.key);
  const live=h.ctx.sharedElements[0];
  assert.equal(live.kling.taskId,"TASK_ID_123");
  assert.equal(live.kling.elementId,"OLD_1");
  assert.equal(h.saved[0].snapshot.kling.taskId,null);
  assert.equal(h.saved.at(-1).snapshot.kling.taskId,"TASK_ID_123");
});
test("confirmed Kling failure is distinct from uncertain status and unlocks a retry",async()=>{
  const h=env({kling:oldJob(1000),replies:[error]});
  await h.ctx.elemCheck(h.proj,h.el.key);
  assert.equal(h.el.kling.status,"failed");
  assert.equal(h.el.kling.confirmedFailed,true);
  assert.equal(h.el.kling.msg,"face rejected");
  assert.equal(h.el.kling.taskId,"OLD_JOB_1");
});
test("UI exposes manual status, optional task ID attach and archive restoration",()=>{
  const h=env({kling:{...oldJob(),needsCheck:true,notice:"확인 필요"}});
  let ui=h.ctx.elemRecoveryHtml(h.el);
  for(const key of ["data-element-check","data-element-resume","data-element-abandon"])assert.match(ui,new RegExp(key));
  h.el.kling.taskId=null;
  ui=h.ctx.elemRecoveryHtml(h.el);
  assert.match(ui,/data-element-task/);assert.match(ui,/data-element-attach/);
  h.el.kling.status="failed";h.el.klingHistory=[oldJob()];
  ui=h.ctx.elemRecoveryHtml(h.el);
  assert.match(ui,/data-element-restore/);
  const details=h.ctx.elemStatusDetails(h.proj,{...h.el,kling:{...oldJob(),needsCheck:true}});
  assert.equal(details.formal.label,"확인 필요");
});
test("no Supabase functions, audio or timeline rendering changes in the recovery patch",()=>{
  assert.match(html,/function edOpen\(/);
  assert.match(html,/function clipPlan\(/);
  assert.match(html,/function makeScript\(/);
  assert.match(html,/function elemPendingWork\(/);
  assert.doesNotMatch(grab("elemCheck"),/30분 넘게 안 끝|await done/);
  assert.doesNotMatch(grab("sharedCheck"),/status:"failed",msg:"등록 확인 시간이 초과/);
  for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
});
