"use strict";
// Shared Kling elements belong to the account, not to any lodging project.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
const UID="11111111-2222-3333-4444-555555555555";
const ORIGINAL=(id)=>UID+"/"+id+"/photo/o.jpg";
const EDITED=(id)=>UID+"/"+id+"/edited/e.jpg";
const SHARED=UID+"/_shared_elements/element/";
const FN="https://kfgtvifupumjuewwxzmz.supabase.co";
function grab(sig) {
  let from=html.indexOf("  function "+sig);
  if(from<0) from=html.indexOf("  async function "+sig);
  assert.ok(from>0,sig+" exists");
  const end=html.indexOf("\n  }\n",from);
  assert.ok(end>from,sig+" function closes");
  return html.slice(from,end+5);
}
function plain(x){return JSON.parse(JSON.stringify(x));}
const core=[
  "peekSpec(proj, pid){","elemList(proj){","elemByKey(proj, key){","elemByName(proj, name){",
  "elemPhotos(el){","elemSig(el){","elemNameProblem(proj, name, selfKey){","elemState(proj, el){",
  "mentionsOf(proj, pid, text, stage){","mentionedElements(proj, pid, text, stage){",
  "replaceMentions(proj, pid, text, stage, map){","editRefPlan(proj, pid){",
  "clipHead(proj, refCount, els){","clipPlan(proj, pid){","clipPromptText(proj, pid){",
  "clipBlocker(proj, pid){","clipInputProblem(proj, pid){","clipDuration(proj, pid){","clipRequest(proj, pid){",
].map(grab).join("\n");

function shared(name="운영자"){
  const front={id:SHARED+"front.jpg",w:900,h:1200,size:1200};
  const angle={id:SHARED+"angle.jpg",w:900,h:1200,size:1200};
  const el={key:"shared_hotelA_localK",name,desc:"",scope:"global",
    sourceProject:"hotelA",sourceKey:"localK",front,angles:[angle]};
  el.kling={status:"ready",elementId:"991882",sig:front.id+"|"+angle.id,at:1};
  return el;
}
function project(id="hotelB",local=[]){
  return {id,elements:local,photos:[{id:ORIGINAL(id),w:900,h:1200}],
    edits:{[ORIGINAL(id)]:{id:EDITED(id),w:900,h:1200}},
    editSpecs:{[ORIGINAL(id)]:{prompt:"[운영자]가 [원본]에서 웃어요",vprompt:"[운영자]가 손을 흔들어요",refs:[]}}};
}
function pure(globals){
  const box=vm.createContext({
    sharedElements:globals||[],EDIT:{maxRefs:15},
    ELEM:{nameMax:20,descMax:100,maxAngles:3},
    CLIP:{maxInputs:7,minSide:300,maxRatio:2.5},
    MENTION_RE:/\[([^\[\]\n]{1,30})\]/g
  });
  vm.runInContext(core,box);
  return box;
}

test("account-wide ready Kling element appears in brand-new and existing lodging without duplicate upload",()=>{
  const el=shared(),s=pure([el]);
  for(const proj of [project("hotelB"),project("hotelC")]){
    assert.equal(s.elemList(proj).length,1);
    assert.equal(s.elemByName(proj,"운영자").key,el.key);
    assert.equal(s.elemState(proj,el),"ready");
    const pid=ORIGINAL(proj.id);
    const photo=s.editRefPlan(proj,pid);
    assert.deepEqual(plain(photo.ids),[el.front.id,el.angles[0].id]);
    const video=s.clipRequest(proj,pid);
    assert.deepEqual(plain(video.elements),["991882"],"reuses the same paid Kling element ID");
    assert.deepEqual(plain(video.refs),[],"does not upload photos per video for registered element");
    assert.match(video.prompt,/@element_1/);
    assert.equal(s.clipBlocker(proj,pid),"");
  }
});

test("global record takes precedence and original project's saved local copy is hidden, not lost",()=>{
  const el=shared(),origin={key:"localK",name:"운영자",front:{id:UID+"/hotelA/element/local.jpg"},angles:[],desc:""};
  const other={key:"other",name:"강아지",front:{id:UID+"/hotelA/element/dog.jpg"},angles:[],desc:""};
  const s=pure([el]),proj=project("hotelA",[origin,other]),effective=s.elemList(proj);
  assert.deepEqual(plain(effective.map(x=>x.name)),["운영자","강아지"]);
  assert.equal(proj.elements.length,2,"source data is retained in its original project");
  assert.equal(s.elemByName(proj,"운영자").scope,"global");
  assert.match(s.elemNameProblem(proj,"운영자","new"),/같은 이름/);
});

test("promoting a native Kling registration uploads independent photo copies exactly once and persists under the account",async()=>{
  const calls=[],uploaded=[],saved=[],source=(name)=>UID+"/hotelA/element/"+name+".jpg";
  const origin={key:"localK",name:"운영자",desc:"캐릭터",front:{id:source("front"),w:900,h:1200},
    angles:[{id:source("side"),w:900,h:1200}]};
  origin.kling={status:"ready",elementId:"991882",sig:source("front")+"|"+source("side"),at:1};
  const p=project("hotelA",[origin]);
  let num=0;
  const box=vm.createContext({
    uid:UID,SUPA:{url:FN,sharedTable:"lodging_reels_shared_elements"},
    sharedElements:[],sharedDeletedKeys:[],sharedLoaded:true,sharedLoadError:"",sharedSyncBusy:{},current:p,
    fetch:async(url)=>({ok:true,blob:async()=>({size:300,source:url})}),
    blobUrl:(id)=>FN+"/storage/v1/object/public/lodging-reels/"+id,
    storeUpload:async(id,blob,type)=>{uploaded.push({id,blob,type});return {id,sizeBytes:blob.size};},
    newPath:(proj,kind,ext)=>UID+"/"+proj+"/"+kind+"/img"+(++num)+"."+ext,
    storeDelete:async(id)=>{calls.push({delete:id});},
    api:async(url,opts)=>{saved.push({url,opts,body:JSON.parse(opts.body)});return {ok:true};},
    renderClipsSoon:()=>{},
  });
  vm.runInContext([
    grab("elemPhotos(el){"),grab("elemSig(el){"),
    grab("persistSharedElement(el){"),grab("publishSharedElement(proj,el){")
  ].join("\n"),box);
  assert.equal(await box.publishSharedElement(p,origin),true);
  assert.equal(uploaded.length,2);
  assert.ok(uploaded.every(x=>x.id.startsWith(SHARED)),"source project photos are copied to account-owned global folder");
  assert.ok(saved[0].url.includes("/rest/v1/lodging_reels_shared_elements?on_conflict=owner,element_key"));
  assert.equal(saved[0].body.owner,UID);
  assert.equal(saved[0].body.data.kling.elementId,"991882");
  assert.equal(saved[0].body.data.sourceProject,"hotelA");
  assert.equal(saved[0].body.data.front.id,uploaded[0].id);
  assert.equal(saved[0].body.data.angles[0].id,uploaded[1].id);
  assert.equal(box.sharedElements.length,1);
  assert.equal(await box.publishSharedElement(p,origin),true);
  assert.equal(uploaded.length,2,"already-shared native element is never uploaded twice");
  assert.equal(saved.length,1);
});

test("a failed account save cleans up newly copied photos without deleting source photos or Kling element",async()=>{
  const deleted=[],s1=UID+"/hotelA/element/a.jpg",s2=UID+"/hotelA/element/b.jpg";
  const el={key:"localK",name:"운영자",desc:"",front:{id:s1},angles:[{id:s2}],
    kling:{status:"ready",elementId:"991882",sig:s1+"|"+s2}};
  const p=project("hotelA",[el]),box=vm.createContext({
    uid:UID,SUPA:{url:FN,sharedTable:"lodging_reels_shared_elements"},
    sharedElements:[],sharedDeletedKeys:[],sharedLoaded:true,sharedSyncBusy:{},current:p,
    fetch:async()=>({ok:true,blob:async()=>({size:5})}),
    blobUrl:(id)=>FN+"/"+id,
    newPath:(_p,_k,_e)=>SHARED+"new"+Math.random()+".jpg",
    storeUpload:async(path)=>({id:path,sizeBytes:5}),
    storeDelete:async(path)=>{deleted.push(path);},
    api:async()=>({ok:false,status:409,text:async()=>"{duplicate name}"}),
    renderClipsSoon:()=>{},
  });
  vm.runInContext([grab("elemPhotos(el){"),grab("elemSig(el){"),
    grab("persistSharedElement(el){"),grab("publishSharedElement(proj,el){")].join("\n"),box);
  await assert.rejects(()=>box.publishSharedElement(p,el),/같은 이름/);
  assert.equal(deleted.length,2);
  assert.ok(deleted.every(id=>id.startsWith(SHARED)));
  assert.deepEqual(p.elements,[el],"the original element is not changed");
});

test("deleting the source property cannot remove already-shared Kling element or global image copies",async()=>{
  const sharedEl=shared(),orig=UID+"/hotelA/element/old.jpg";
  const source={key:"localK",name:"운영자",front:{id:orig},angles:[],kling:{status:"ready",elementId:"991882"}};
  const proj=project("hotelA",[source]),removed=[],klingDeleted=[];
  const sb=vm.createContext({
    projects:[proj],sharedElements:[sharedEl],sharedLoaded:true,
    storeDelete:async(id)=>{removed.push(id);},api:async()=>({ok:true}),
    klingElementDelete:(id)=>{klingDeleted.push(id);},
  });
  vm.runInContext(grab("removeProject(p){"),sb);
  await sb.removeProject(proj);
  assert.ok(removed.includes(orig),"source project pictures were deleted");
  assert.ok(!removed.includes(sharedEl.front.id),"global images are independent");
  assert.deepEqual(klingDeleted,[],"global Kling registration must survive project deletion");
});

test("a new project is initialized with global elements even without uploading a property photo",()=>{
  const ui=grab("elemSection(){"),layout=grab("editSection(){");
  const start=grab("start(){"),load=grab("loadAll(){");
  assert.match(ui,/sharedElementCard\(el\)/);
  assert.match(ui,/계정 공통 요소/);
  assert.match(ui,/다른 숙소에서도 \[이름\]/);
  assert.match(layout,/if\(!ph\.length\) return h\+elemSection\(\)/);
  assert.match(start,/syncExistingSharedElements\(\)/);
  assert.match(load,/await loadSharedElements\(\)/);
  assert.match(html,/await loadSharedElements\(\);\n        if\(p\) renderEdit\(p\)/);
});

test("row-level security keeps shared elements isolated per authenticated account",()=>{
  const sql=fs.readFileSync(path.join(__dirname,"..","supabase","migrations",
    "20261014_shared_kling_elements.sql"),"utf8");
  assert.match(sql,/create table if not exists public\.lodging_reels_shared_elements/);
  assert.match(sql,/primary key \(owner, element_key\)/);
  assert.match(sql,/unique \(owner, name\)/);
  assert.match(sql,/enable row level security/);
  assert.match(sql,/for all to authenticated/);
  assert.match(sql,/using \(owner = \(select auth\.uid\(\)\)\)/);
  assert.match(sql,/with check \(owner = \(select auth\.uid\(\)\)\)/);
});

test("global library entries are read-only from ordinary project edit/delete controls",()=>{
  const card=grab("sharedElementCard(el){");
  const del=grab("elemDelete(key){"),rename=grab("elemRename(proj, key, name){");
  const register=grab("elemRegister(key){"),remove=grab("removeProject(p){");
  assert.doesNotMatch(card,/data-elphdel|data-elreg|data-eldel/);
  assert.match(del,/el\.scope==="global"/);
  assert.match(rename,/el\.scope==="global"/);
  assert.match(register,/el\.scope==="global"/);
  assert.match(remove,/sharedElements\.some/);
});
