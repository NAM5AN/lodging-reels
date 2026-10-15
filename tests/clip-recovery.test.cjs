"use strict";
// Recovery regression tests: all Supabase/Kling operations are mocked; no paid calls.
const {test}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
const UID="11111111-2222-3333-4444-555555555555";
const PID=UID+"/p1/photo/a.jpg",EDIT=UID+"/p1/edited/a.jpg";
const plain=x=>JSON.parse(JSON.stringify(x));
function grab(name){
  const m=new RegExp('  (?:async )?function '+name+'\\(').exec(html);
  assert.ok(m,"function "+name+" must exist");
  const end=html.indexOf("\n  }\n",m.index);
  assert.ok(end>m.index,"closing brace "+name);
  return html.slice(m.index,end+5);
}
function project(){
  return {id:"p1",name:"호텔",photos:[{id:PID}],edits:{[PID]:{id:EDIT}},
    editSpecs:{[PID]:{vprompt:"햇살이 비쳐요"}},clipJobs:{},clips:{},clipArchive:{}};
}
function job(age=61000,other={}){
  return {op:{taskId:"task_007"},at:Date.now()-age,dur:5,fromEdit:EDIT,inputs:2,...other};
}
function harness(opt={}){
  const proj=opt.project||project(),calls=[],saves=[],deleted=[],toasts=[],confirms=[];
  let responses=(opt.responses||[]).slice(),failSaves=(opt.failSaves||[]).slice();
  const ctx=vm.createContext({
    current:proj,uid:UID,clipInflight:{},clipErrors:{},clipMisses:{},elemInflight:{},
    clipPollTimer:null,clipClock:null,editBusy:false,
    CLIP:{maxInputs:7,maxPrompt:2500,minDur:3,maxDur:15,dur:5,giveUpMs:40*60*1000,maxMisses:15,pollMs:8000},
    FN:{clip:"https://mock.example/clip"},
    console:{error(){},warn(){}},
    esc:x=>String(x??"").replace(/&/g,"&amp;").replace(/</g,"&lt;"),
    mentionWarnings:()=>[],clipDuration:()=>5,clipHintText:()=> "가공 사진",
    clipRequest:()=>({action:"start",projectId:"p1",edited:EDIT,original:PID,
      refs:[],elements:[],duration:5,prompt:"a simple motion"}),
    clipBlocker:()=>"",elemPendingKeys:()=>[],elemByKey:()=>null,
    sharedCheck:async()=>{},elemCheck:async()=>{},
    renderClipsSoon:()=>{},renderEdit:()=>{},toast:msg=>toasts.push(msg),
    confirm:msg=>{confirms.push(msg);return opt.confirm===undefined?false:opt.confirm;},
    persist:async x=>{saves.push(plain(x));return failSaves.length?failSaves.shift():true;},
    storeDelete:async id=>deleted.push(id),
    setTimeout:()=>1,setInterval:()=>2,clearInterval:()=>{},clearTimeout:()=>{},
    api:async(url,args)=>{
      const body=JSON.parse(args.body),action=body.action;
      calls.push({action,body});
      const reply=responses.shift();
      if(!reply)throw Error("missing mock response: "+action);
      if(reply instanceof Error)throw reply;
      const status=reply.http||200;
      return {ok:status>=200&&status<300,status,text:async()=>JSON.stringify(reply.body||{})};
    }
  });
  const names=["clipJobIds","clipTaskId","clipAutoJobIds","clipOldJobs","clipRecoverableOldJob",
    "clipElapsed","clipControls","clipRequireCheck","clipStart","ensureClipPoll","clipClockTick",
    "clipPollTick","clipCheck","dropClip","stopClipJob","resumeClipJob","forgetClipJob","restoreClipJob"];
  vm.runInContext(names.map(grab).join("\n"),ctx);
  return {ctx,proj,calls,saves,deleted,toasts,confirms,
    addResponses(...r){responses.push(...r);}};
}
const pending={http:200,body:{status:"pending",kling:"processing"}};
const completed={http:200,body:{status:"completed",id:UID+"/p1/video/vfromTask.mp4",size:1234,mime:"video/mp4"}};

test("41-minute completed job is checked by existing ID, not replaced by a paid start",async()=>{
  const h=harness({responses:[completed]});h.proj.clipJobs[PID]=job(41*60*1000);
  await h.ctx.clipCheck(h.proj,PID);
  assert.deepEqual(h.calls.map(x=>x.action),["status"]);
  assert.equal(h.calls[0].body.operation.taskId,"task_007");
  assert.equal(h.proj.clips[PID].id,completed.body.id);
  assert.equal(h.proj.clipJobs[PID],undefined);
  assert.ok(h.saves.some(s=>s.clips[PID]?.id===completed.body.id));
});

test("41-minute pending result is stored as 'check required'; manual check later retrieves video",async()=>{
  const h=harness({responses:[pending]});h.proj.clipJobs[PID]=job(41*60*1000);
  await h.ctx.clipCheck(h.proj,PID);
  assert.equal(h.calls.length,1);
  assert.equal(h.proj.clipJobs[PID].op.taskId,"task_007");
  assert.equal(h.proj.clipJobs[PID].needsCheck,true);
  assert.equal(h.ctx.clipAutoJobIds(h.proj).length,0);
  assert.ok(h.saves.some(s=>s.clipJobs[PID]?.op?.taskId==="task_007"));
  h.addResponses(completed);
  await h.ctx.clipCheck(h.proj,PID,{force:true});
  assert.equal(h.proj.clips[PID].id,completed.body.id);
  assert.equal(h.proj.clipJobs[PID],undefined);
  assert.deepEqual(h.calls.map(x=>x.action),["status","status"]);
});

test("after reload, a saved expired job is recoverable without new Kling generation",async()=>{
  const p=project();p.clipJobs[PID]=job(50*60*1000);
  const reloaded=plain(p),h=harness({project:reloaded,responses:[completed]});
  await h.ctx.clipCheck(h.proj,PID);
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].action,"status");
  assert.equal(h.proj.clips[PID].fromEdit,EDIT);
});

test("15 transient failures pause tracking but never discard task ID or unlock paid generation",async()=>{
  const h=harness({responses:Array.from({length:15},()=>({http:503,body:{error:"upstream"}}))});
  h.proj.clipJobs[PID]=job(1000);
  for(let i=0;i<15;i++)await h.ctx.clipCheck(h.proj,PID);
  assert.equal(h.calls.length,15);
  assert.equal(h.proj.clipJobs[PID].op.taskId,"task_007");
  assert.equal(h.proj.clipJobs[PID].needsCheck,true);
  await h.ctx.clipStart(h.proj,PID);
  assert.equal(h.calls.length,15,"a second paid start must not occur");
  h.addResponses(completed);
  await h.ctx.clipCheck(h.proj,PID,{force:true});
  assert.equal(h.proj.clips[PID].id,completed.body.id);
});

test("hard status errors keep existing task ID until a later explicit verification",async()=>{
  const h=harness({responses:[{http:403,body:{error:"not_authorized"}},completed]});
  h.proj.clipJobs[PID]=job(1000);
  await h.ctx.clipCheck(h.proj,PID);
  assert.equal(h.proj.clipJobs[PID].needsCheck,true);
  assert.equal(h.proj.clipJobs[PID].op.taskId,"task_007");
  await h.ctx.clipCheck(h.proj,PID,{force:true});
  assert.equal(h.proj.clips[PID].id,completed.body.id);
});

test("stopping automatic polling preserves ID; resuming restarts 40-minute polling window",async()=>{
  const h=harness();h.proj.clipJobs[PID]=job(41*60*1000);
  await h.ctx.stopClipJob(PID);
  assert.equal(h.proj.clipJobs[PID].needsCheck,true);
  assert.deepEqual(plain(h.ctx.clipAutoJobIds(h.proj)),[]);
  assert.equal(h.proj.clipJobs[PID].op.taskId,"task_007");
  await h.ctx.resumeClipJob(PID);
  assert.equal(h.proj.clipJobs[PID].needsCheck,false);
  assert.ok(h.proj.clipJobs[PID].pollSince>Date.now()-5000);
  assert.deepEqual(plain(h.ctx.clipAutoJobIds(h.proj)),[PID]);
  assert.equal(h.calls.length,0,"pause/resume never creates a paid request");
});

test("save failure before start prevents all paid generation requests",async()=>{
  const h=harness({failSaves:[false]});
  await h.ctx.clipStart(h.proj,PID);
  assert.equal(h.calls.length,0);
  assert.equal(h.proj.clipJobs[PID],undefined);
  assert.match(h.ctx.clipErrors[PID],/생성은 시작하지 않았어요/);
});

test("network failure during start preserves an unknown paid request as an explicit warning",async()=>{
  const h=harness({responses:[new Error("connection lost")]});
  await h.ctx.clipStart(h.proj,PID);
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].action,"start");
  assert.equal(h.saves[0].clipJobs[PID].op,null,"claim stored BEFORE the paid request");
  assert.equal(h.proj.clipJobs[PID].needsCheck,true);
  assert.equal(h.proj.clipJobs[PID].op,null);
  await h.ctx.clipStart(h.proj,PID);
  assert.equal(h.calls.length,1,"unknown request must prevent another paid start");
});

test("legacy no-ID jobs are flagged after 2 minutes, not silently released",async()=>{
  const h=harness();h.proj.clipJobs[PID]=job(121000,{op:null});
  await h.ctx.clipCheck(h.proj,PID);
  assert.equal(h.calls.length,0);
  assert.equal(h.proj.clipJobs[PID].needsCheck,true);
  assert.match(h.proj.clipJobs[PID].notice,/작업 ID가 없어요/);
});

test("definite 402 rejection releases the lock without discarding an accepted task",async()=>{
  const h=harness({responses:[{http:402,body:{error:"balance",message:"not enough funds"}}]});
  await h.ctx.clipStart(h.proj,PID);
  assert.equal(h.calls[0].action,"start");
  assert.equal(h.proj.clipJobs[PID],undefined);
  assert.match(h.ctx.clipErrors[PID],/요청 거절/);
});

test("completed video DB-save failure preserves task ID and previous clip for later retry",async()=>{
  const h=harness({responses:[completed,completed],failSaves:[false,true,true]});
  h.proj.clipJobs[PID]=job();
  h.proj.clips[PID]={id:"old.mp4",fromEdit:EDIT};
  await h.ctx.clipCheck(h.proj,PID);
  assert.equal(h.proj.clips[PID].id,"old.mp4");
  assert.equal(h.proj.clipJobs[PID].needsCheck,true);
  assert.equal(h.proj.clipJobs[PID].op.taskId,"task_007");
  assert.deepEqual(h.deleted,[]);
  await h.ctx.clipCheck(h.proj,PID,{force:true});
  assert.equal(h.proj.clips[PID].id,completed.body.id);
  assert.equal(h.proj.clipJobs[PID],undefined);
  assert.deepEqual(h.deleted,["old.mp4"]);
});

test("manual abandon requires two confirmations, archives ID, warns before a second paid start",async()=>{
  const h=harness({confirm:true,responses:[{http:200,body:{operation:{taskId:"new_job"}}}]});
  h.proj.clipJobs[PID]=job(41*60*1000,{needsCheck:true});
  await h.ctx.forgetClipJob(PID);
  assert.equal(h.confirms.length,2);
  assert.equal(h.proj.clipJobs[PID],undefined);
  assert.equal(h.proj.clipArchive[PID][0].op.taskId,"task_007");
  await h.ctx.clipStart(h.proj,PID);
  assert.equal(h.confirms.length,3,"old job triggers another explicit cost warning");
  assert.equal(h.calls.filter(x=>x.action==="start").length,1);
  assert.equal(h.proj.clipJobs[PID].op.taskId,"new_job");
  assert.equal(h.proj.clipArchive[PID][0].op.taskId,"task_007");
});

test("declined abandon never removes an existing task",async()=>{
  const h=harness({confirm:false});h.proj.clipJobs[PID]=job(41*60*1000,{needsCheck:true});
  await h.ctx.forgetClipJob(PID);
  assert.equal(h.proj.clipJobs[PID].op.taskId,"task_007");
  assert.equal(h.proj.clipArchive[PID],undefined);
  assert.equal(h.calls.length,0);
});

test("archived task can be reattached and recovered at zero additional paid generation calls",async()=>{
  const h=harness({confirm:true,responses:[completed]});
  h.proj.clipJobs[PID]=job(41*60*1000,{needsCheck:true});
  await h.ctx.forgetClipJob(PID);
  await h.ctx.restoreClipJob(PID);
  assert.equal(h.proj.clips[PID].id,completed.body.id);
  assert.equal(h.proj.clipJobs[PID],undefined);
  assert.equal(h.proj.clipArchive[PID].length,0);
  assert.deepEqual(h.calls.map(x=>x.action),["status"]);
});

test("UI explains paused, archived and unknown jobs and offers manual verification",()=>{
  const h=harness(),sp={vprompt:"t",vdur:""};
  h.proj.clipJobs[PID]=job(1000,{needsCheck:true,notice:"완료 확인이 필요해요"});
  let output=h.ctx.clipControls(h.proj.photos[0],0,sp,{job:h.proj.clipJobs[PID],canMake:false});
  assert.match(output,/data-clipcheck="0"/);
  assert.match(output,/data-clipresume="0"/);
  assert.match(output,/data-clipforget="0"/);
  assert.match(output,/task_007/);
  assert.doesNotMatch(output,/data-clipstop="0"/);
  h.proj.clipJobs[PID].op=null;
  output=h.ctx.clipControls(h.proj.photos[0],0,sp,{job:h.proj.clipJobs[PID],canMake:false});
  assert.doesNotMatch(output,/data-clipcheck="0"/);
  assert.match(output,/Kling 작업 내역/);
  delete h.proj.clipJobs[PID];
  h.proj.clipArchive[PID]=[job(41*60*1000)];
  output=h.ctx.clipControls(h.proj.photos[0],0,sp,{job:null,canMake:true});
  assert.match(output,/data-cliprestore="0"/);
  assert.match(output,/중복 비용/);
  for(const btn of ["data-clipcheck","data-clipresume","data-clipforget","data-cliprestore"])
    assert.ok(html.includes('view.querySelectorAll("['+btn+']")'),"missing event binding "+btn);
});

test("client inline scripts parse and server endpoint remains unchanged",()=>{
  for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
  assert.match(html,/SUPA\.url \+ "\/functions\/v1\/lodging-reels-clip"/);
  assert.doesNotMatch(grab("clipCheck"),/await giveUp|delete.*clipJobs.*40분/);
});
