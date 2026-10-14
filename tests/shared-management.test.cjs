"use strict";
// Main-page management for account-wide completed Kling elements.
const {test}=require("node:test"),assert=require("node:assert/strict"),
  fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
const UID="11111111-2222-3333-4444-555555555555",FRONT=UID+"/_shared_elements/element/f.jpg",
  ANGLE=UID+"/_shared_elements/element/a.jpg",KLING="1945551";
function grab(sig){
  let start=html.indexOf("  function "+sig);
  if(start<0)start=html.indexOf("  async function "+sig);
  assert.ok(start>0,sig+" exists");
  const end=html.indexOf("\n  }\n",start);
  assert.ok(end>start,sig+" ends");
  return html.slice(start,end+5);
}
function plain(x){return JSON.parse(JSON.stringify(x))}
function globalElement(opts={}){
  return Object.assign({
    key:"shared_hotelA_localK",sourceProject:"hotelA",sourceKey:"localK",
    scope:"global",name:"하린",desc:"고정 등장 인물",aliases:[],
    front:{id:FRONT,w:900,h:1200},angles:[{id:ANGLE,w:900,h:1200}],
    kling:{status:"ready",elementId:KLING,sig:FRONT+"|"+ANGLE}
  },opts);
}
function project(id="hotelA",locals=[],prompts=[]){
  const specs={};
  prompts.forEach((p,i)=>{specs["photo_"+i]={prompt:p,vprompt:""}});
  return {id,name:id,elements:locals,editSpecs:specs};
}
function funcs(ctx,sigs){
  vm.runInNewContext(sigs.map(grab).join("\n"),ctx);
  return ctx;
}
function pure(extra={}){
  const ctx=Object.assign({
    uid:UID,sharedElements:[],sharedDeletedKeys:[],sharedLoaded:true,
    sharedLoadError:"",sharedSyncBusy:{},sharedManageBusy:false,elemInflight:{},elemPhotoBusy:{},elemErrors:{},
    projects:[],ELEM:{nameMax:20,descMax:100,maxAngles:3},
    SUPA:{url:"https://example.supabase.co",bucket:"lodging-reels",sharedTable:"lodging_reels_shared_elements"},
    FN:{clip:"https://example.supabase.co/functions/v1/lodging-reels-clip"},
  },extra);
  return funcs(ctx,[
    "elemList(proj){","elemByKey(proj, key){","elemByName(proj, name){",
    "elemPhotos(el){","elemSig(el){","elemState(proj, el){","elemPhotoLocked(el){","sharedRegistrationHtml(el){","elemNameProblem(proj, name, selfKey){",
    "sharedUsageSummary(el){","sharedNameProblem(el, name){",
    "updateSharedMetadata(key, name, desc){","sharedDeletedLabel(){",
    "deleteSharedRegistered(key){"
  ]);
}

test("main page displays registered-elements management between fonts and lodging list",()=>{
  const main=grab("renderList(){"),home=grab("sharedManagementSection(){"),
    events=grab("bindSharedManagement(){");
  assert.match(main,/fontSection\(\)\+sharedManagementSection\(\)\+h/);
  assert.match(main,/bindSharedManagement\(\)/);
  assert.match(home,/계정 공통 요소 관리/);
  assert.match(home,/Kling 정식 등록/);
  assert.match(home,/data-shared-name/);
  assert.match(home,/data-shared-desc/);
  assert.match(home,/data-shared-save/);
  assert.match(home,/data-shared-delete/);
  assert.match(home,/previewImg\(blobUrl\(photo.id\)/);
  assert.match(home,/sharedUsageSummary\(el\)/);
  assert.match(events,/updateSharedMetadata\(key,name,desc\)/);
  assert.match(events,/deleteSharedRegistered\(key\)/);
  assert.match(events,/if\(!confirm\(msg\)\)return/,"remote delete always confirms explicitly");
});

test("library UI renders four actual reference photos and exposes the immutable Kling ID",()=>{
  const el=globalElement({angles:[{id:ANGLE},{id:FRONT+"3"},{id:FRONT+"4"}]});
  el.kling.sig=[el.front,...el.angles].map(p=>p.id).join("|");
  const ctx=pure({sharedElements:[el],projects:[project("hotelB")]});
  ctx.esc=(x)=>String(x).replace(/&/g,"&amp;").replace(/</g,"&lt;");
  ctx.blobUrl=(x)=>"https://example.test/"+x;
  ctx.previewImg=(url,txt)=>'<img data-preview="'+url+'" alt="'+txt+'">';
  ctx.elemStatusRows=()=>'<div class="elem-statuses">일반 요소 · 등록 완료 · 사용 가능 / Kling 정식 요소 · 등록 완료</div>';
  funcs(ctx,["sharedManagementSection(){"]);
  const h=ctx.sharedManagementSection();
  assert.match(h,/Kling 정식 등록 1개/);
  assert.match(h,/하린/);
  assert.match(h,/1945551/);
  assert.match(h,/data-shared-entry="shared_hotelA_localK"/);
  assert.equal((h.match(/data-preview=/g)||[]).length,4);
  assert.match(h,/이름·설명 수정/);
  assert.match(h,/정식 요소 삭제/);
  assert.doesNotMatch(h,/카테고리/,"no redundant character/background category");
});

test("rename preserves same photos and Kling element ID; old saved prompts resolve through aliases",async()=>{
  const el=globalElement(),p=project("hotelB",[],["[하린]이 침대에 앉아 있다"]),saved=[];
  const ctx=pure({sharedElements:[el],projects:[p],
    persistSharedElement:async function(v){
      saved.push(plain(v));ctx.sharedElements=[Object.assign({},v,{scope:"global"})];
    }});
  assert.equal(await ctx.updateSharedMetadata(el.key,"릴리","새로운 안내"),true);
  assert.equal(saved.length,1);
  assert.equal(saved[0].name,"릴리");
  assert.equal(saved[0].desc,"새로운 안내");
  assert.deepEqual(saved[0].aliases,["하린"]);
  assert.equal(saved[0].front.id,FRONT);
  assert.equal(saved[0].angles[0].id,ANGLE);
  assert.equal(saved[0].kling.elementId,KLING);
  assert.equal(ctx.elemByName(p,"하린").name,"릴리","existing saved prompt remains valid");
  assert.equal(ctx.elemByName(p,"릴리").kling.elementId,KLING);
  assert.equal(ctx.sharedUsageSummary(ctx.sharedElements[0])[0].cuts,1);
  assert.equal(await ctx.updateSharedMetadata(el.key,"릴리","새로운 안내"),false,"no paid refresh on no-op");
  assert.equal(saved.length,1);
});

test("rename rejects reserved names, duplicate names and conflicts with any property's local names",async()=>{
  const g=globalElement(),second=globalElement({key:"another",name:"마스코트",aliases:["페퍼"]});
  const local={key:"local2",name:"멍멍이",front:{id:"localphoto.jpg"}};
  const ctx=pure({sharedElements:[g,second],projects:[project("hotelZ",[local])]});
  ctx.persistSharedElement=async()=>{throw Error("should not persist")};
  for(const n of ["","[하린]","원본","마스코트","페퍼","멍멍이"]){
    await assert.rejects(()=>ctx.updateSharedMetadata(g.key,n,"x"),/이름|쓸 수|정해진|겹쳐요/,"name "+n);
  }
  await assert.rejects(()=>ctx.updateSharedMetadata(g.key,"새로운친구","x".repeat(101)),/100자/);
});

test("an in-use registered element cannot be deleted from any property",async()=>{
  const el=globalElement(),ctx=pure({sharedElements:[el],
    projects:[project("hotelA",[],["[하린] hello"]),project("hotelB",[],["[하린] world"])]});
  ctx.api=async()=>{throw Error("should not call API")};
  await assert.rejects(()=>ctx.deleteSharedRegistered(el.key),/hotelA.*hotelB.*사용 중/);
  assert.equal(ctx.sharedElements.length,1);
});

test("delete archives the account row before deleting only shared photos and remote Kling identity",async()=>{
  const el=globalElement(),calls=[],ctx=pure({sharedElements:[el],projects:[project("hotelA")]});
  ctx.api=async function(url,opt){
    calls.push({url,method:opt.method,body:opt.body?JSON.parse(opt.body):null});
    return {ok:true,text:async()=>""};
  };
  const warnings=await ctx.deleteSharedRegistered(el.key);
  assert.deepEqual(plain(warnings),[]);
  assert.equal(calls.length,4);
  assert.match(calls[0].url,/lodging_reels_shared_elements\?on_conflict=owner,element_key/);
  assert.equal(calls[0].body.element_key,el.key);
  assert.equal(calls[0].body.data.deleted,true);
  assert.ok(calls[0].body.name.length<=20);
  assert.equal(calls[0].body.name==="하린",false,"archive frees the previous public name");
  assert.equal(calls[1].method,"DELETE");
  assert.ok(calls[1].url.includes(FRONT));
  assert.ok(calls[2].url.includes(ANGLE));
  assert.equal(calls[3].body.action,"element_delete");
  assert.equal(calls[3].body.elementId,KLING);
  assert.deepEqual(plain(ctx.sharedDeletedKeys),[el.key]);
  assert.equal(ctx.sharedElements.length,0);
});

test("failed account archive leaves both global photos and remote Kling element untouched",async()=>{
  const el=globalElement(),calls=[],ctx=pure({sharedElements:[el],projects:[]});
  ctx.api=async function(url,opt){
    calls.push({url,body:opt.body});
    return {ok:false,status:500,text:async()=>"{db unavailable}"};
  };
  await assert.rejects(()=>ctx.deleteSharedRegistered(el.key),/삭제 기록을 저장하지 못했어요/);
  assert.equal(calls.length,1,"no destructive remote action before archive succeeds");
  assert.equal(ctx.sharedElements.length,1);
  assert.equal(ctx.sharedDeletedKeys.length,0);
});

test("failed external cleanup is reported after account deletion, with no accidental auto re-share",async()=>{
  const el=globalElement(),ctx=pure({sharedElements:[el],projects:[]});
  ctx.api=async function(url,opt){
    if(url.includes("lodging_reels_shared_elements"))return {ok:true};
    return {ok:false,status:502};
  };
  const warnings=await ctx.deleteSharedRegistered(el.key);
  assert.ok(warnings.some(x=>x.includes("공통 사진")));
  assert.ok(warnings.some(x=>x.includes("Kling")));
  assert.deepEqual(plain(ctx.sharedDeletedKeys),[el.key]);
  assert.equal(ctx.sharedElements.length,0);
});

test("refresh loads only active global elements and tombstones, excluding archived elements",async()=>{
  const el=globalElement(),ctx={uid:UID,sharedElements:[],sharedDeletedKeys:[],sharedLoaded:false,
    sharedLoadError:"",console:{error(){}}};
  const rows=[
    {element_key:el.key,name:el.name,data:el},
    {element_key:"shared_hotelA_removed",name:"deleted_x2",data:{deleted:true}},
  ];
  ctx.SUPA={url:"https://example.supabase.co",sharedTable:"lodging_reels_shared_elements"};
  ctx.api=async()=>({ok:true,json:async()=>rows});
  funcs(ctx,["loadSharedElements(){"]);
  assert.equal(await ctx.loadSharedElements(),true);
  assert.equal(ctx.sharedLoaded,true);
  assert.equal(ctx.sharedElements.length,1);
  assert.deepEqual(plain(ctx.sharedDeletedKeys),["shared_hotelA_removed"]);
  assert.equal(ctx.sharedElements[0].kling.elementId,KLING);
});

test("archived original local element stays hidden; auto-migration cannot reupload it",async()=>{
  const el=globalElement(),src={key:"localK",name:"하린",desc:"",front:{id:UID+"/hotelA/element/x.jpg"},
    angles:[{id:UID+"/hotelA/element/y.jpg"}]};
  src.kling={status:"ready",elementId:KLING,sig:src.front.id+"|"+src.angles[0].id};
  const p=project("hotelA",[src]),ctx=pure({sharedDeletedKeys:[el.key],projects:[p],sharedElements:[]});
  assert.deepEqual(plain(ctx.elemList(p)),[]);
  assert.equal(ctx.elemByName(p,"하린"),null);
  ctx.current=p;ctx.uid=UID;
  ctx.sharedLoaded=true;ctx.sharedSyncBusy={};
  ctx.fetch=async()=>{throw Error("must not upload")};
  funcs(ctx,["publishSharedElement(proj,el){"]);
  assert.equal(await ctx.publishSharedElement(p,src),false,"tombstone blocks automatic resurrection");
});

test("project's local removal will not delete a Kling ID still owned by the common library",()=>{
  const src=grab("elemDelete(key){");
  assert.match(src,/!sharedElements\.some\(function\(g\)/);
  assert.match(src,/String\(g\.kling\.elementId\)===String\(el\.kling\.elementId\)/);
});

test("changing display name or description never calls a paid Kling registration endpoint",()=>{
  const src=grab("updateSharedMetadata(key, name, desc){");
  assert.doesNotMatch(src,/api\(FN\.clip|element_create|kling\(req/);
  assert.match(src,/persistSharedElement\(Object\.assign/);
});
