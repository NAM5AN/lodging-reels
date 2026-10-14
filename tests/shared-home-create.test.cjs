"use strict";
// No live Supabase, storage, or Kling calls. Home-page registration is free and atomic.
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
const UID="11111111-2222-3333-4444-555555555555",clone=x=>JSON.parse(JSON.stringify(x));
function grab(name){
  const m=new RegExp("  (?:async )?function "+name+"\\(").exec(html);
  assert.ok(m,"missing "+name);
  const end=html.indexOf("\n  }\n",m.index);
  assert.ok(end>m.index,name+" closing brace");
  return html.slice(m.index,end+5);
}
function harness(opts={}){
  const db=opts.db||new Map(),calls=[],uploads=[],removed=[],toasts=[];
  let serial=0;
  const ctx=vm.createContext({
    uid:UID,sharedLoaded:true,sharedLoadError:"",sharedManageBusy:false,sharedCreateBusy:false,
    sharedElements:[],sharedDeletedKeys:[],sharedSyncBusy:{},sharedCreateEditor:null,
    projects:opts.projects||[{id:"hotelA",name:"호텔 A",elements:[],editSpecs:{}}],
    ELEM:{nameMax:20,descMax:100,maxAngles:3,minSide:300,maxRatio:2.5,giveUpMs:1800000},
    SUPA:{url:"https://test.supabase.co",bucket:"assets",sharedTable:"shared"},
    FN:{clip:"https://test.supabase.co/functions/v1/clip"},
    console:{error(){},warn(){}},toast:x=>toasts.push(x),
    esc:x=>String(x??"").replace(/&/g,"&amp;").replace(/</g,"&lt;"),
    blobUrl:x=>"https://test.supabase.co/assets/"+x,
    previewImg:(url,label)=>'<img src="'+url+'" alt="'+label+'">',
    newPath:()=>UID+"/_shared_elements/element/photo"+(++serial)+".jpg",
    storeUpload:async(path,blob)=>{uploads.push(path);return{id:path,sizeBytes:blob.size||123}},
    storeDelete:async path=>{removed.push(path)},
    confirm:()=>opts.confirm??false,
    ensureClipPoll:()=>{},
    sharedRefreshLive:()=>{},
    api:async (url,options={})=>{
      const body=options.body?JSON.parse(options.body):undefined;
      calls.push({url,method:options.method||"GET",body});
      if(opts.fail){const response=opts.fail(url,options,body);if(response)return response;}
      if(url.includes("/rest/v1/shared")){
        if(!options.method)return {ok:true,json:async()=>[...db.values()].map(r=>clone(r))};
        if(options.method==="POST"){
          const rows=[...db.values()].filter(r=>r.name===body.name && r.element_key!==body.element_key && !r.data.deleted);
          if(!url.includes("on_conflict") && (rows.length||db.has(body.element_key)))
            return{ok:false,status:409,text:async()=>"{duplicate}"};
          db.set(body.element_key,clone(body));
          return {ok:true,status:201,json:async()=>[clone(body)]};
        }
      }
      if(body?.action==="element_create")return{ok:true,status:200,text:async()=>JSON.stringify({operation:{taskId:"task_test"}})};
      throw Error("unexpected call "+url+" "+JSON.stringify(body));
    }
  });
  const names=["elemList","elemByKey","elemByName","elemPhotos","elemSig","elemNameProblem",
    "elemState","elemStatusDetails","elemStatusRows","sharedUsageSummary","sharedNameProblem",
    "createSharedElement","loadSharedElements","sharedRegistrationHtml",
    "sharedDeletedLabel","deleteSharedRegistered","sharedRegister"];
  vm.runInContext(names.map(grab).join("\n"),ctx);
  return {ctx,db,calls,uploads,removed,toasts};
}
const pic=(w=900,h=1200)=>({blob:{size:45000},w,h});
async function create(t,name="하린",items=[pic()]){
  return t.ctx.createSharedElement(name,"캐릭터 설명",items);
}
test("main displays account-wide create button, separate refresh, and registration dialog",()=>{
  const home=grab("sharedManagementSection"),events=grab("bindSharedManagement"),
    open=grab("sharedCreateDialogOpen"),draw=grab("sharedCreateDialogDraw");
  assert.match(home,/id="addshared"/);
  assert.match(home,/id="refreshshared"/);
  assert.match(events,/sharedCreateDialogOpen\(\)/);
  for(const marker of ["data-shared-create-name","data-shared-create-desc","data-shared-create-file",
      "data-shared-create-save","data-shared-create-cancel","data-shared-create-pick"])
    assert.match(open,new RegExp(marker));
  for(const marker of ["data-shared-create-remove","data-shared-create-front"])assert.match(draw,new RegExp(marker));
  assert.match(open,/if\(ev\.target!==dialog\)return/,"cancelled file picker cannot dismiss editor");
  assert.match(open,/elemPreparedPhoto\(file\)/);
  assert.doesNotMatch(grab("createSharedElement"),/element_create|FN\.clip/,"no paid registration when saving general photos");
});
test("one-photo shared registration is immediately usable by every lodging after save",async()=>{
  const t=harness(),el=await create(t);
  assert.equal(el.scope,"global");
  assert.equal(el.kling.status,"unregistered");
  assert.equal(el.angles.length,0);
  assert.equal(t.ctx.elemState(null,el),"local");
  assert.equal(t.ctx.elemStatusDetails(null,el).formal.label,"미등록");
  assert.match(el.front.id,/_shared_elements\/element/);
  assert.equal(t.calls.filter(x=>x.method==="POST").length,1,"one DB insert, no paid Kling");
  assert.ok(!t.calls.some(x=>x.body?.action));
  assert.ok(!t.calls[0].url.includes("on_conflict"),"new record is insert-only");
  assert.equal(t.db.get(el.key).name,"하린");
  for(const p of [{id:"hotelA",elements:[]},{id:"hotelB",elements:[]}]){
    assert.equal(t.ctx.elemByName(p,"하린").front.id,el.front.id);
  }
  assert.doesNotMatch(t.ctx.sharedRegistrationHtml(el),/data-shared-register/,"one photo cannot trigger formal Kling registration");
});
test("two-photo creation offers OPTIONAL first formal registration",async()=>{
  const t=harness(),el=await create(t,"정원",[pic(),pic()]);
  assert.equal(t.ctx.elemState(null,el),"new");
  assert.match(t.ctx.sharedRegistrationHtml(el),/data-shared-register/);
  assert.match(t.ctx.sharedRegistrationHtml(el),/>Kling 정식 등록</);
  assert.equal(el.angles.length,1);
  assert.equal(t.uploads.length,2);
  assert.ok(!t.calls.some(x=>x.body?.action),"paid creation did not run");
});
test("reload includes regular shared elements with no Kling ID and keeps old official ones",async()=>{
  const t=harness(),newEl=await create(t);
  const old={key:"shared_old",scope:"global",name:"기존인물",front:{id:UID+"/old.jpg"},
    angles:[{id:UID+"/old2.jpg"}],kling:{status:"ready",elementId:"987",sig:UID+"/old.jpg|"+UID+"/old2.jpg"}};
  t.db.set(old.key,{owner:UID,element_key:old.key,name:old.name,data:clone(old)});
  t.ctx.sharedElements=[];t.ctx.sharedLoaded=false;
  await t.ctx.loadSharedElements();
  assert.deepEqual(clone(t.ctx.sharedElements.map(x=>x.name).sort()),["기존인물","하린"]);
  assert.equal(t.ctx.elemByName({elements:[]},"하린").key,newEl.key);
  assert.equal(t.ctx.elemByName({elements:[]},"기존인물").kling.elementId,"987");
});
test("missing name, forbidden names, missing photo and five photos fail with no writes",async()=>{
  for(const [name,items] of [["", [pic()]],["[이름]",[pic()]],["원본",[pic()]],["새이름",[]],["새이름",Array(5).fill(pic())]]){
    const t=harness();
    await assert.rejects(()=>create(t,name,items));
    assert.equal(t.uploads.length,0);
    assert.equal(t.calls.length,0);
  }
});
test("bad photo size and ratio cannot be persisted",async()=>{
  for(const bad of [pic(200,800),pic(350,1300)]){
    const t=harness();
    await assert.rejects(()=>create(t,"새이름",[bad]),/사진 크기나 비율/);
    assert.equal(t.calls.length,0);
  }
});
test("duplicate shared name or any lodging-local name is rejected before upload",async()=>{
  const t=harness({projects:[{id:"hotelB",name:"B",elements:[{key:"local",name:"멍멍이"}]}]});
  await create(t);
  for(const duplicate of ["하린","멍멍이"]){
    await assert.rejects(()=>create(t,duplicate),/같은 이름|겹쳐요/);
  }
  assert.equal(t.uploads.length,1);
  assert.equal(t.calls.length,1);
});
test("DB duplicate on a second browser rolls back only newly uploaded files",async()=>{
  const t=harness({fail:(url,opt)=>url.includes("/rest/") && opt.method==="POST"?
    {ok:false,status:409,text:async()=>"{duplicate}"}:null});
  await assert.rejects(()=>create(t),/같은 이름/);
  assert.deepEqual(t.removed,t.uploads);
  assert.equal(t.ctx.sharedElements.length,0);
});
test("ambiguous write failure protects photos from deletion and does not claim success",async()=>{
  const t=harness({fail:(url,opt)=>{if(url.includes("/rest/") && opt.method==="POST")throw Error("lost response")}});
  await assert.rejects(()=>create(t),/lost response/);
  assert.equal(t.removed.length,0);
  assert.equal(t.uploads.length,1);
  assert.equal(t.ctx.sharedElements.length,0);
});
test("concurrent submit is prevented while first save is pending",async()=>{
  const t=harness();
  let resume;
  t.ctx.storeUpload=async()=>{await new Promise(resolve=>{resume=resolve});return{id:UID+"/hold.jpg",sizeBytes:123}};
  const pending=create(t);
  await assert.rejects(()=>create(t,"다른인물"),/다른 공통 요소 작업/);
  resume();await pending;
  assert.equal(t.db.size,1);
});
test("deleting a shared general element never calls Kling paid/delete endpoints",async()=>{
  const t=harness(),el=await create(t);
  t.calls.length=0;
  const warnings=await t.ctx.deleteSharedRegistered(el.key);
  assert.deepEqual(clone(warnings),[]);
  assert.equal(t.ctx.sharedElements.length,0);
  assert.equal(t.ctx.sharedDeletedKeys[0],el.key);
  assert.deepEqual(t.removed,[el.front.id]);
  assert.ok(!t.calls.some(x=>x.body?.action),"no Kling element ID means no Kling endpoint");
});
test("all inline scripts parse and existing features remain in the same page",()=>{
  for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
  assert.match(html,/function scriptPrompt\(/);
  assert.match(html,/function renderEdit\(/);
  assert.match(html,/function elemPhotoEditorOpen\(/);
});
