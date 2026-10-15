"use strict";
// ⑨ 요소(Kling Element) — 숙소별 요소 관리, 프롬프트의 [이름] 부르기, @ 목록.
// 사진 가공 쪽 변환은 tests/image-edit.test.cjs, 영상화 쪽 변환은 tests/clip-screen.test.cjs.
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const {test}=require("node:test");

const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
const UID="11111111-2222-3333-4444-555555555555";
const P="pabc123";
const PH1=UID+"/"+P+"/photo/o1.jpg", PH2=UID+"/"+P+"/photo/o2.jpg", PH3=UID+"/"+P+"/photo/o3.jpg";
const EL=(f)=>UID+"/"+P+"/element/"+f+".jpg";
const REF=(n)=>UID+"/"+P+"/ref/r"+n+".jpg";
const FN_URL="https://example.supabase.co/functions/v1/lodging-reels-clip";

function grab(sig){
  let start=html.indexOf("  function "+sig);
  if(start<0) start=html.indexOf("  async function "+sig);
  assert.ok(start>0,sig+" exists");
  const end=html.indexOf("\n  }\n",start);
  return html.slice(start,end+5);
}
function grabVar(re,name){
  const m=html.match(re);
  assert.ok(m,name+" exists");
  return m[0];
}
const FNS=[
  "peekSpec(proj, pid){","specOf(proj, pid){",
  "elemList(proj){","elemByKey(proj, key){","elemByName(proj, name){","elemPhotos(el){","elemSig(el){",
  "elemTaskId(k){","elemAutoPending(el){","elemArchivedJobs(el){","elemRecoverableJob(el){","elemRecoveryHtml(el){","elemNameProblem(proj, name, selfKey){","elemState(proj, el){",
  "mentionsOf(proj, pid, text, stage){","mentionedElements(proj, pid, text, stage){",
  "mentionWarnings(proj, pid, text, stage){","replaceMentions(proj, pid, text, stage, map){",
  "editRefPlan(proj, pid){",
  "renameMentions(proj, from, to){","elemUsage(proj, name){","elemRename(proj, key, name){",
  "elemPhotoLocked(el){","elemDelete(key){","klingElementDelete(elementId){","elemPauseRegistration(proj,key,k,message){","elemRegister(key){","elemCheck(proj,key,options){",
  "elemAddPhotos(files, key){","elemDropPhoto(key, idx){","elemPendingKeys(proj){",
  "mentionOptions(proj, pid, stage, q){","mentionQuery(text, caret){","mentionInsert(text, start, caret, label){",
];
function plain(v){ return JSON.parse(JSON.stringify(v)); }

// 가짜 api·저장소로 돌린다. replies 는 api 호출 순서대로 돌려줄 응답.
function sandbox(proj, replies){
  const calls=[], deleted=[], persisted=[], toasts=[], confirms=[];
  let n=0;
  const sb={
    current:proj, uid:UID, sharedElements:[], elemPhotoBusy:{}, esc:(v)=>String(v??""), FN:{clip:FN_URL},
    api:async(url,opts)=>{
      calls.push({url,body:JSON.parse(opts.body)});
      const r=(replies||[]).shift() || {status:200,body:{ok:true}};
      if(r instanceof Error) throw r;
      return {ok:r.status<400,status:r.status,text:async()=>JSON.stringify(r.body)};
    },
    persist:async(p)=>{ persisted.push(plain(p)); return true; },
    storeDelete:async(id)=>{ deleted.push(id); },
    storeUpload:async(p,blob)=>({id:p,sizeBytes:blob.size||1}),
    newPath:(projId,kind,ext)=>UID+"/"+projId+"/"+kind+"/n"+(++n)+"."+ext,
    shrink:async(f)=>({blob:{size:10},w:f.w,h:f.h}),
    renderEdit:()=>{}, renderClipsSoon:()=>{}, ensureClipPoll:()=>{}, elemRefreshLive:()=>{ sb.live=(sb.live||0)+1; },
    toast:(m)=>toasts.push(m), confirm:(m)=>{ confirms.push(m); return sb.answer!==false; },
    console:{error(){},warn(){}},
  };
  vm.runInNewContext([
    grabVar(/  var EDIT = \{[\s\S]*?\n  \};\n/,"EDIT"),
    grabVar(/  var ELEM = \{[^\n]*\n/,"ELEM"),
    grabVar(/  var elemInflight=[^\n]*\n/,"elem state"),
    grabVar(/  var MENTION_RE=[^\n]*\n/,"MENTION_RE"),
  ].concat(FNS.map(grab)).join("\n"),sb);
  return {sb,calls,deleted,persisted,toasts,confirms};
}
function element(name,slug,opt){
  const el={key:"k_"+slug,name,desc:name+" 설명",front:{id:EL(slug+"f"),w:800,h:1000},angles:[{id:EL(slug+"a"),w:800,h:1000}]};
  if(opt && opt.ready) el.kling={status:"ready",elementId:opt.ready,taskId:"et_"+slug,sig:EL(slug+"f")+"|"+EL(slug+"a"),at:1};
  return el;
}
function project(){
  return {
    id:P,
    photos:[{id:PH1},{id:PH2},{id:PH3}],
    editSpecs:{
      [PH1]:{prompt:"[아이]가 침대에서 [강아지]를 안아요",refs:[{id:REF(1)},{id:REF(2)}],vprompt:"[아이]가 웃어요"},
      [PH2]:{prompt:"창가에 선 [아이]",refs:[],vprompt:""},
      [PH3]:{prompt:"빈 방",refs:[],vprompt:"[강아지]가 뛰어요"},
    },
    elements:[element("아이","kid",{ready:"9001"}),element("강아지","dog")],
  };
}

test("element names: unique, never inside one another, no brackets or reserved words",()=>{
  const {sb}=sandbox(project());
  const proj=sb.current;
  assert.equal(sb.elemNameProblem(proj,"엄마",""),"");
  assert.equal(sb.elemNameProblem(proj,"아이","k_kid"),"","its own name is fine");
  assert.match(sb.elemNameProblem(proj,"  ",""),/이름을 적어주세요/);
  assert.match(sb.elemNameProblem(proj,"가".repeat(21),""),/20자까지/);
  assert.match(sb.elemNameProblem(proj,"[아빠]",""),/\[ \] @/);
  assert.match(sb.elemNameProblem(proj,"아빠@",""),/\[ \] @/);
  for(const r of ["원본","가공","삭제됨","레퍼런스3","레퍼런스 3"]) assert.match(sb.elemNameProblem(proj,r,""),/미리 정해진 이름/,r);
  assert.match(sb.elemNameProblem(proj,"아이",""),/같은 이름의 요소가 있어요/);
  assert.match(sb.elemNameProblem(proj,"아이엄마",""),/「아이」 — 이름이 서로 겹쳐요/,"contains another name");
  assert.match(sb.elemNameProblem(proj,"강",""),/「강아지」 — 이름이 서로 겹쳐요/,"inside another name");
});

test("element state: draft until complete, then new → pending → ready; changed photos make it stale",()=>{
  const {sb}=sandbox(project());
  const proj=sb.current, kid=proj.elements[0], dog=proj.elements[1];
  assert.equal(sb.elemState(proj,kid),"ready");
  assert.equal(sb.elemState(proj,dog),"new");
  dog.desc=" ";
  assert.equal(sb.elemState(proj,dog),"new","description is optional");
  dog.angles=[];
  assert.equal(sb.elemState(proj,dog),"local","one photo is already usable as a local element");
  dog.front=null;
  assert.equal(sb.elemState(proj,dog),"draft","the single main photo is needed");
  dog.front={id:EL("dogf"),w:800,h:1000};
  dog.angles=[{id:EL("doga")}];
  dog.kling={status:"pending",taskId:"t",sig:sb.elemSig(dog),at:Date.now()};
  assert.equal(sb.elemState(proj,dog),"pending");
  dog.kling={status:"failed",msg:"x",sig:sb.elemSig(dog),at:1};
  assert.equal(sb.elemState(proj,dog),"failed");
  kid.angles.push({id:EL("kid2")});
  assert.equal(sb.elemState(proj,kid),"stale");
  assert.deepEqual(plain(sb.elemPendingKeys(proj)),[]);
  dog.kling.status="pending";
  assert.deepEqual(plain(sb.elemPendingKeys(proj)),["k_dog"]);
});

test("[이름] in a prompt: known names, photo words, typos and stage rules",()=>{
  const {sb}=sandbox(project());
  const proj=sb.current;
  const kinds=(t,stage)=>plain(sb.mentionsOf(proj,PH1,t,stage)).map((x)=>x.kind+(x.n?x.n:""));
  assert.deepEqual(kinds("[원본] [가공] [레퍼런스2] [레퍼런스3] [아이] [ 강아지 ] [아잉] [삭제됨]","clip"),
    ["original","edited","ref2","bad_ref3","element","element","unknown","deleted"]);
  assert.deepEqual(kinds("[가공]","edit"),["bad_edited"],"[가공] is video-only");
  assert.deepEqual(plain(sb.mentionedElements(proj,PH1,"[강아지] [아이] [강아지]","edit")).map((e)=>e.name),["강아지","아이"],
    "named order, no repeats");
  assert.deepEqual(plain(sb.mentionWarnings(proj,PH1,"[아잉] [아잉] [가공] [레퍼런스3] [삭제됨] [아이]","edit")),[
    "[아잉] — 등록된 요소가 아니에요",
    "[가공] — 사진 가공에서는 쓸 수 없어요 (지금 만드는 결과물이에요)",
    "[레퍼런스3] — 이 줄 레퍼런스는 2장이에요",
    "[삭제됨] — 지운 요소예요. 다른 요소로 바꿔주세요",
  ]);
  assert.deepEqual(plain(sb.mentionWarnings(proj,PH2,"[레퍼런스1]","edit")),["[레퍼런스1] — 이 줄 레퍼런스는 0장이에요"],
    "warnings are per row");
  assert.equal(sb.replaceMentions(proj,PH1,"[아이]와 [아잉]","edit",(t)=>t.kind==="element"?"X":null),"X와 [아잉]");
});

test("photo edit uses only the elements named in that row",()=>{
  const {sb}=sandbox(project());
  const proj=sb.current;
  assert.deepEqual(plain(sb.editRefPlan(proj,PH1)).ids,[REF(1),REF(2),EL("kidf"),EL("kida"),EL("dogf"),EL("doga")]);
  assert.deepEqual(plain(sb.editRefPlan(proj,PH2)).ids,[EL("kidf"),EL("kida")]);
  assert.deepEqual(plain(sb.editRefPlan(proj,PH3)).ids,[],"[강아지] only in the video prompt");
  const g=plain(sb.editRefPlan(proj,PH1)).groups.map((x)=>[x.el.name,x.from,x.to]);
  assert.deepEqual(g,[["아이",4,5],["강아지",6,7]],"Image 1 = original, 2-3 = row refs");
});

test("rename: [옛이름] follows in every prompt of this 숙소; a bad name is kept in the box with a reason",()=>{
  const {sb}=sandbox(project());
  const proj=sb.current;
  assert.equal(sb.elemRename(proj,"k_kid","딸"),true);
  assert.equal(proj.elements[0].name,"딸");
  assert.equal(proj.editSpecs[PH1].prompt,"[딸]가 침대에서 [강아지]를 안아요");
  assert.equal(proj.editSpecs[PH1].vprompt,"[딸]가 웃어요");
  assert.equal(proj.editSpecs[PH2].prompt,"창가에 선 [딸]");
  assert.deepEqual(plain(sb.elemUsage(proj,"딸")),[1,2]);
  assert.deepEqual(plain(sb.elemUsage(proj,"강아지")),[1,3]);

  assert.equal(sb.elemRename(proj,"k_kid","강아지"),false);
  assert.equal(proj.elements[0].name,"딸","unchanged");
  assert.match(sb.elemErrors.k_kid,/같은 이름/);
  assert.equal(sb.elemDrafts.k_kid,"강아지","typed text is kept for the box");
  assert.equal(proj.editSpecs[PH2].prompt,"창가에 선 [딸]","prompts untouched");
  assert.equal(sb.elemRename(proj,"k_kid"," 딸 "),true,"same name again clears the error");
  assert.equal(sb.elemErrors.k_kid,undefined);
  assert.equal(sb.elemDrafts.k_kid,undefined);

  // 처음 이름을 붙이면, 미리 적어 둔 [이름] 이 그때부터 요소가 된다
  proj.elements.push({key:"k_new",name:"",desc:"",front:null,angles:[]});
  proj.editSpecs[PH3].prompt="[엄마]가 앉아 있어요";
  assert.equal(sb.mentionsOf(proj,PH3,proj.editSpecs[PH3].prompt,"edit")[0].kind,"unknown");
  assert.equal(sb.elemRename(proj,"k_new","엄마"),true);
  assert.equal(sb.mentionsOf(proj,PH3,proj.editSpecs[PH3].prompt,"edit")[0].kind,"element");
});

test("delete: warns once with the rows that use it, then those rows say [삭제됨]",async()=>{
  const t=sandbox(project());
  const proj=t.sb.current;
  t.sb.answer=false;
  await t.sb.elemDelete("k_kid");
  assert.equal(proj.elements.length,2,"cancelled");
  assert.match(t.confirms[0],/「아이」 요소를 1·2번 줄에서 쓰고 있어요/);
  assert.match(t.confirms[0],/\[아이\] 은 \[삭제됨\] 으로 바뀌어요/);

  t.sb.answer=true;
  await t.sb.elemDelete("k_kid");
  assert.deepEqual(proj.elements.map((e)=>e.key),["k_dog"]);
  assert.equal(proj.editSpecs[PH1].prompt,"[삭제됨]가 침대에서 [강아지]를 안아요");
  assert.equal(proj.editSpecs[PH1].vprompt,"[삭제됨]가 웃어요");
  assert.equal(proj.editSpecs[PH2].prompt,"창가에 선 [삭제됨]");
  assert.equal(t.persisted.length,1);
  await new Promise((r)=>setTimeout(r,0));
  assert.deepEqual(t.deleted.sort(),[EL("kida"),EL("kidf")]);
  assert.deepEqual(t.calls.map((c)=>c.body),[{action:"element_delete",elementId:"9001"}],"Kling copy removed too");
  assert.deepEqual(plain(t.sb.mentionWarnings(proj,PH2,proj.editSpecs[PH2].prompt,"edit")),["[삭제됨] — 지운 요소예요. 다른 요소로 바꿔주세요"]);
  assert.deepEqual(plain(t.sb.editRefPlan(proj,PH2)).ids,[],"no photos sent for a deleted element");

  // 아무 줄에서도 안 쓰면 그냥 묻는다. Kling 에 없으면 Kling 호출도 없다.
  const u=sandbox(project());
  u.sb.current.editSpecs[PH1].prompt="x"; u.sb.current.editSpecs[PH3].vprompt="y";
  await u.sb.elemDelete("k_dog");
  assert.equal(u.confirms[0],"「강아지」 요소를 지울까요?");
  assert.equal(u.calls.length,0);
});

test("photos: first is the front, then up to 3 angles; Kling size and ratio rules apply",async()=>{
  const proj=project();
  proj.elements.push({key:"k_new",name:"엄마",desc:"",front:null,angles:[]});
  const t=sandbox(proj);
  await t.sb.elemAddPhotos([{w:900,h:1200},{w:200,h:900},{w:3000,h:1000},{w:1000,h:1000},{w:800,h:800},{w:700,h:700},{w:600,h:600}],"k_new");
  const el=proj.elements[2];
  assert.equal(el.front.id,UID+"/"+P+"/element/n1.jpg");
  assert.deepEqual(el.angles.map((x)=>x.id),[2,3,4].map((k)=>UID+"/"+P+"/element/n"+k+".jpg"));
  assert.equal(el.front.w,900);
  assert.match(t.toasts.at(-1),/정면 1장 \+ 다른 각도 3장까지예요/);
  assert.ok(t.toasts.length>0);
  assert.equal(t.persisted.length,1);

  const s=sandbox(project());
  s.sb.current.elements.push({key:"k_new",name:"엄마",desc:"",front:null,angles:[]});
  await s.sb.elemAddPhotos([{w:200,h:900}],"k_new");
  assert.match(s.toasts.at(-1),/300px 이상/);
  await s.sb.elemAddPhotos([{w:3000,h:1000}],"k_new");
  assert.match(s.toasts.at(-1),/1:2\.5 ~ 2\.5:1/);
  assert.equal(s.sb.current.elements[2].front,null);

  // 정면을 지우면 첫 번째 다른 각도가 정면이 된다
  await t.sb.elemDropPhoto("k_new",0);
  assert.equal(el.front.id,UID+"/"+P+"/element/n2.jpg");
  assert.deepEqual(el.angles.map((x)=>x.id),[3,4].map((k)=>UID+"/"+P+"/element/n"+k+".jpg"));
  await t.sb.elemDropPhoto("k_new",2);
  assert.deepEqual(el.angles.map((x)=>x.id),[UID+"/"+P+"/element/n3.jpg"]);
  assert.deepEqual(t.deleted,[UID+"/"+P+"/element/n1.jpg",UID+"/"+P+"/element/n4.jpg"]);
});

test("register: one Kling request per tap, saved as pending, then ready (old Kling copy removed) or failed",async()=>{
  const t=sandbox(project(),[{status:200,body:{operation:{taskId:"et1"}}}]);
  const proj=t.sb.current, dog=proj.elements[1];
  await Promise.all([t.sb.elemRegister("k_dog"),t.sb.elemRegister("k_dog")]);
  assert.equal(t.calls.length,1);
  assert.deepEqual(t.calls[0].body,{action:"element_create",projectId:P,name:"강아지",desc:"강아지 설명",
    front:EL("dogf"),angles:[EL("doga")]});
  assert.equal(dog.kling.status,"pending");
  assert.equal(dog.kling.taskId,"et1");
  assert.equal(dog.kling.sig,EL("dogf")+"|"+EL("doga"));
  assert.equal(t.persisted.at(-1).elements[1].kling.taskId,"et1","saved so a reload keeps waiting");

  // 다시 등록(사진 변경 후): 끝나면 예전 Kling 요소를 지운다
  const kid=proj.elements[0];
  kid.angles.push({id:EL("kid2")});
  t.calls.length=0;
  const r=sandbox(proj,[
    {status:200,body:{operation:{taskId:"et2"}}},
    {status:200,body:{status:"pending"}},
    {status:200,body:{status:"ready",elementId:"9100"}},
    {status:200,body:{ok:true}},
  ]);
  await r.sb.elemRegister("k_kid");
  assert.equal(kid.kling.prevElementId,"9001");
  await r.sb.elemCheck(proj,"k_kid");
  assert.equal(kid.kling.status,"pending");
  await r.sb.elemCheck(proj,"k_kid");
  assert.equal(kid.kling.status,"ready");
  assert.equal(kid.kling.elementId,"9100");
  assert.equal(r.sb.elemState(proj,kid),"ready");
  assert.ok(r.sb.live>=1,"status line refreshed in place, even while a prompt is being typed");
  assert.deepEqual(r.calls.map((c)=>c.body.action),["element_create","element_status","element_status"],"old Kling ID is preserved instead of deleting it");
  assert.deepEqual(r.calls[1].body,{action:"element_status",projectId:P,operation:{taskId:"et2"}});
  assert.ok(kid.retiredElementIds.includes("9001"),"previous official identity remains recoverable");
  assert.match(r.toasts.at(-1),/「아이」 Kling 등록이 끝났어요/);

  const f=sandbox(project(),[{status:200,body:{status:"error",message:"face not clear"}}]);
  const d=f.sb.current.elements[1];
  d.kling={status:"pending",taskId:"et9",sig:f.sb.elemSig(d),at:Date.now()};
  await f.sb.elemCheck(f.sb.current,"k_dog");
  assert.equal(d.kling.status,"failed");
  assert.equal(f.sb.elemState(f.sb.current,d),"failed");
  assert.equal(d.kling.msg,"face not clear","shown on the card as 'Kling 등록 실패: face not clear'");
});

test("register: incomplete input and definite rejection unlock, uncertain work remains tracked",async()=>{
  const t=sandbox(project(),[{status:404,body:{}},{status:502,body:{error:"kling_auth",message:"Kling API 키가 거부됐어요."}}]);
  const proj=t.sb.current, dog=proj.elements[1];
  dog.desc=""; dog.angles=[];
  await t.sb.elemRegister("k_dog");
  assert.equal(t.calls.length,0);
  assert.match(t.sb.elemErrors.k_dog,/사진 한 장으로 이미 사용할 수 있어요/);
  dog.angles=[{id:EL("doga")}];
  await t.sb.elemRegister("k_dog");
  assert.equal(t.calls[0].body.desc,"","optional description remains empty in the client; server supplies name");
  assert.ok(!dog.kling,"rolled back");
  assert.match(t.sb.elemErrors.k_dog,/lodging-reels-clip\)가 아직 배포되지 않았어요/);
  await t.sb.elemRegister("k_dog");
  assert.equal(dog.kling.status,"pending");
  assert.equal(dog.kling.needsCheck,true);
  assert.match(dog.kling.notice,/등록 요청 결과를 확인하지 못했어요/);

  // 미확인 접수는 작업 ID가 없거나 30분을 넘겨도 실패로 없애지 않는다.
  dog.kling={status:"pending",taskId:null,sig:"s",at:Date.now()-121000};
  await t.sb.elemCheck(proj,"k_dog");
  assert.equal(dog.kling.status,"pending");
  assert.equal(dog.kling.needsCheck,true);
  dog.kling={status:"pending",taskId:"x",sig:"s",at:Date.now()-31*60*1000};
  await t.sb.elemCheck(proj,"k_dog");
  assert.equal(dog.kling.status,"pending");
  assert.equal(dog.kling.taskId,"x");
  assert.equal(dog.kling.needsCheck,true);
});

test("@ list: typing @ offers elements and photos, picking writes [이름]",()=>{
  const {sb}=sandbox(project());
  const proj=sb.current;
  proj.edits={[PH1]:{id:UID+"/"+P+"/edited/e1.jpg"}};
  const labels=(stage,q)=>plain(sb.mentionOptions(proj,PH1,stage,q)).map((o)=>o.label);
  assert.deepEqual(labels("edit",""),["아이","강아지","원본","레퍼런스1","레퍼런스2"]);
  assert.deepEqual(labels("clip",""),["아이","강아지","가공","원본","레퍼런스1","레퍼런스2"],"[가공] only for video");
  assert.deepEqual(labels("edit","강"),["강아지"]);
  assert.deepEqual(labels("edit","레퍼"),["레퍼런스1","레퍼런스2"]);
  const kid=plain(sb.mentionOptions(proj,PH1,"edit","아"))[0];
  assert.equal(kid.thumb,EL("kidf"),"thumbnail is the front photo");
  proj.elements.push({key:"k_x",name:"",desc:"",front:null,angles:[]});
  assert.equal(labels("edit","").length,5,"unnamed elements are not offered");

  assert.deepEqual(plain(sb.mentionQuery("침대 위 @아",7)),{start:5,q:"아"});
  assert.deepEqual(plain(sb.mentionQuery("@",1)),{start:0,q:""});
  assert.equal(sb.mentionQuery("메일 a@",5),null,"an e-mail style @ does not open the list");
  assert.deepEqual(plain(sb.mentionQuery("침대위@강",6)),{start:4,q:"강"},"right after Korean text is fine");
  assert.equal(sb.mentionQuery("[아이] 와",5),null);
  assert.equal(sb.mentionQuery("@아이 가",5),null,"a space ends the query");
  assert.deepEqual(plain(sb.mentionInsert("침대 위 @아 가 앉아",5,7,"아이")),{text:"침대 위 [아이] 가 앉아",caret:9});
});

test("screen wiring: panel, row warnings, @ list and live updates are bound; data survives reloads",()=>{
  const sec=grab("editSection(){");
  assert.ok(sec.includes("h+=elemSection();"));
  const card=grab("elemCard(el){");
  for(const k of ["data-elpick=","data-elfile=","data-elphdel=","data-elname=","data-eldesc=","data-elstate="]) assert.ok(card.includes(k),k);
  assert.ok(!/data-pick="elem_/.test(html),"element photo button does not reuse the generic [data-pick] binding");
  const st=grab("elemStateHtml(el){");
  assert.ok(st.includes("data-elreg=") && st.includes("data-eldel="));
  assert.match(html,/view\.addEventListener\("change",function\(ev\)\{\n    if\(!current\) return;/,"element inputs use one delegated listener");
  assert.match(html,/bindPrompt\(ta, ta\.dataset\.eprompt, "edit"\)/);
  assert.match(html,/bindPrompt\(ta, ta\.dataset\.vprompt, "clip"\)/);
  const live=grab("rowRefreshLive(pid){");
  for(const k of ["data-ewarn","data-elinks","data-vwarn","data-vhint"]) assert.ok(live.includes('"'+k+'"'),k);
  assert.match(html,/ta\.addEventListener\("keydown", mentionKey\)/);
  assert.match(html,/mentionClose\(\);\n    view\.innerHTML=h;/,"the @ list never outlives a re-render");
  assert.match(html,/v\.elements=JSON\.parse\(JSON\.stringify\(v\.elements\|\|\[\]\)\);/);
  const rm=grab("removeProject(p){");
  assert.match(rm,/el\.front\]\.concat\(el\.angles/);
  assert.match(rm,/klingElementDelete\(el\.kling\.elementId\)/);
  assert.match(grab("clipPollTick(){"),/elemCheck\(w\.proj,w\.key\)/,"per-project element registration is polled on the clip timer");
});


test("one-photo element with empty description is usable in photo editing without Kling registration",()=>{
  const proj=project();
  const solo={key:"k_solo",name:"토끼",desc:"",front:{id:EL("solof"),w:720,h:900},angles:[]};
  proj.elements.push(solo);
  proj.editSpecs[PH3].prompt="[토끼]가 창가에 있어요";
  const {sb}=sandbox(proj);
  assert.equal(sb.elemState(proj,solo),"local");
  assert.deepEqual(plain(sb.editRefPlan(proj,PH3).ids),[EL("solof")]);
  assert.deepEqual(plain(sb.mentionedElements(proj,PH3,proj.editSpecs[PH3].prompt,"edit")).map(x=>x.name),["토끼"]);
  assert.equal(sb.mentionWarnings(proj,PH3,proj.editSpecs[PH3].prompt,"edit").length,0);
  assert.deepEqual(plain(sb.mentionOptions(proj,PH3,"edit","토끼")).map(x=>x.label),["토끼"]);
});

test("elements UI offers a single-photo path, optional description and no category dropdown",()=>{
  const section=grab("elemSection(){"),card=grab("elemCard(el){"),state=grab("elemStateHtml(el){");
  assert.match(section,/이름과 기준 사진 1장만 넣으면 바로 사용해요/);
  assert.match(section,/설명과 다른 각도/);
  assert.match(section,/카테고리는 따로 고를 필요 없어요/);
  assert.match(card,/설명 \(선택/);
  assert.match(state,/elemStatusRows\(current,el\)/,"regular/photo and Kling registration states are rendered separately");
  assert.doesNotMatch(section+card,/data-elcategory|data-eltype|카테고리 선택/);
});
