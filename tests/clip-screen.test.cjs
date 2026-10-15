"use strict";
// ⑨ 영상화 — 화면(index.html) 쪽 로직. 서버(Edge Function)는 tests/clip-function.test.ts 가 Deno 로 본다.
// 요소 관리·[이름] 부르기·@ 목록은 tests/elements.test.cjs.
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const {test}=require("node:test");

const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
const fnSrc=fs.readFileSync(path.join(__dirname,"..","supabase","functions","lodging-reels-clip","clip.ts"),"utf8");
function fnConst(name){
  const m=fnSrc.match(new RegExp("export const "+name+" = ([^;]+);"));
  assert.ok(m,name+" in clip.ts");
  return Number(m[1].trim());
}

const UID="11111111-2222-3333-4444-555555555555";
const P="pabc123";
const EDITED=UID+"/"+P+"/edited/e1.jpg";
const ORIGINAL=UID+"/"+P+"/photo/o1.jpg";
const REF=(n)=>UID+"/"+P+"/ref/r"+n+".jpg";
const EL=(f)=>UID+"/"+P+"/element/"+f+".jpg";
const FN_URL="https://kfgtvifupumjuewwxzmz.supabase.co/functions/v1/lodging-reels-clip";

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
const PURE=[
  "peekSpec(proj, pid){","specOf(proj, pid){",
  "elemList(proj){","elemByKey(proj, key){","elemByName(proj, name){","elemPhotos(el){","elemSig(el){",
  "elemNameProblem(proj, name, selfKey){","elemState(proj, el){",
  "mentionsOf(proj, pid, text, stage){","mentionedElements(proj, pid, text, stage){",
  "mentionWarnings(proj, pid, text, stage){","replaceMentions(proj, pid, text, stage, map){",
  "clipHead(proj, refCount, els){","clipPlan(proj, pid){","clipPromptText(proj, pid){","clipInputs(proj, pid){",
  "clipInputsHint(proj, pid){","clipInputProblem(proj, pid){","clipBlocker(proj, pid){","clipDuration(proj, pid){",
  "clipRequest(proj, pid){","clipState(proj, pid){","clipElapsed(job){","clipHintText(proj, pid){",
];
function sandbox(extra){
  const sb=Object.assign({esc:(v)=>String(v??""),clipInflight:{},clipErrors:{},clipMisses:{},
    FN:{clip:FN_URL},confirm:()=>false,uid:UID},extra||{});
  vm.runInNewContext([
    grabVar(/  var CLIP = \{[\s\S]*?\};\n/,"CLIP"),
    grabVar(/  var ELEM = \{[^\n]*\n/,"ELEM"),
    grabVar(/  var elemInflight=[^\n]*\n/,"elem state"),
    grabVar(/  var MENTION_RE=[^\n]*\n/,"MENTION_RE"),
  ].concat(PURE.map(grab)).join("\n"),sb);
  return sb;
}
// vm 안에서 만든 객체는 프로토타입이 달라서 JSON 으로 비교한다.
function plain(v){ return JSON.parse(JSON.stringify(v)); }
function element(name,slug,opt){
  const el={key:"k_"+slug,name,desc:name+" 설명",front:{id:EL(slug+"f"),w:800,h:1000},angles:[{id:EL(slug+"a"),w:800,h:1000}]};
  if(opt && opt.ready) el.kling={status:"ready",elementId:opt.ready,taskId:"et_"+slug,sig:EL(slug+"f")+"|"+EL(slug+"a"),at:1};
  return el;
}
function project(refs,vprompt){
  return {
    id:P,
    photos:[{id:ORIGINAL,w:680,h:453},{id:UID+"/"+P+"/photo/o2.jpg",w:680,h:453}],
    edits:{[ORIGINAL]:{id:EDITED,w:992,h:656}},
    editSpecs:{[ORIGINAL]:{prompt:"사진 프롬프트",refs:(refs||[1,2]).map((n)=>({id:REF(n),w:1200,h:1600})),
      vprompt:vprompt==null ? "아이가 침대 위에서 뛰어요" : vprompt}},
    elements:[element("아이","kid",{ready:"9001"}),element("강아지","dog",{ready:"9002"})],
  };
}

test("page calls the Kling Supabase function and shares its limits",()=>{
  const sb=sandbox();
  assert.ok(html.includes('clip: SUPA.url + "/functions/v1/lodging-reels-clip"'));
  assert.ok(!html.includes("/api/video-make"),"no Vercel video function");
  assert.equal(sb.CLIP.maxInputs,fnConst("MAX_INPUTS"));
  assert.equal(sb.CLIP.maxPrompt,fnConst("MAX_PROMPT"));
  assert.equal(sb.CLIP.minDur,fnConst("MIN_DURATION"));
  assert.equal(sb.CLIP.maxDur,fnConst("MAX_DURATION"));
  assert.equal(sb.CLIP.dur,fnConst("DEFAULT_DURATION"));
  assert.equal(sb.ELEM.nameMax,fnConst("ELEMENT_NAME_MAX"));
  assert.equal(sb.ELEM.descMax,fnConst("ELEMENT_DESC_MAX"));
  assert.equal(sb.ELEM.maxAngles,fnConst("ELEMENT_ANGLES_MAX"));
  assert.ok(!/<<<image_/.test(html),"old <<<image_N>>> syntax is gone");
});

test("request: @image_1 edited → @image_2 original → @image_3~ refs, the photo's own prompt",()=>{
  const sb=sandbox(), proj=project([1,2]);
  const r=sb.clipRequest(proj,ORIGINAL);
  assert.equal(r.action,"start");
  assert.equal(r.projectId,P);
  assert.equal(r.edited,EDITED);
  assert.equal(r.original,ORIGINAL);
  assert.deepEqual(plain(r.refs),[REF(1),REF(2)]);
  assert.deepEqual(plain(r.elements),[],"no element named → none sent");
  assert.match(r.prompt,/^Create a vertical 9:16 photorealistic short-form video that brings the scene in @image_1 to life\./);
  assert.match(r.prompt,/@image_2 is the original photo of the real accommodation\./);
  assert.match(r.prompt,/as in @image_2; do not add rooms or facilities/);
  assert.match(r.prompt,/@image_3 to @image_4 are additional references\./);
  assert.match(r.prompt,/\n\n아이가 침대 위에서 뛰어요$/,"plain words are not element mentions");
  assert.equal(sb.clipInputsHint(proj,ORIGINAL),"영상에 들어가는 것: 가공 · 원본 · 레퍼런스 1·2번 (4/7)");

  const one=sandbox().clipRequest(project([1]),ORIGINAL);
  assert.match(one.prompt,/@image_3 is an additional reference\./);
  const none=sandbox().clipRequest(project([]),ORIGINAL);
  assert.doesNotMatch(none.prompt,/image_3/);
  proj.editKeepReal=false;
  assert.doesNotMatch(sb.clipRequest(proj,ORIGINAL).prompt,/do not add rooms/);
});

test("request: [가공] [원본] [레퍼런스N] [요소] become @image / @element in the order sent",()=>{
  const sb=sandbox(), proj=project([1,2],"[가공] 속 [아이]가 [강아지]와 [원본]의 침대에서 [레퍼런스2]처럼 웃어요 [아잉]");
  const r=sb.clipRequest(proj,ORIGINAL);
  assert.deepEqual(plain(r.elements),["9001","9002"],"Kling element ids in mention order");
  assert.match(r.prompt,/ @element_1 is 아이: 아이 설명\. @element_2 is 강아지: 강아지 설명\./);
  assert.match(r.prompt,/\n\n@image_1 속 @element_1가 @element_2와 @image_2의 침대에서 @image_4처럼 웃어요 \[아잉\]$/,
    "an unknown name is sent as typed");
  assert.equal(sb.clipInputsHint(proj,ORIGINAL),"영상에 들어가는 것: 가공 · 원본 · 레퍼런스 1·2번 · 아이 · 강아지 (6/7)");
  assert.deepEqual(plain(sb.mentionWarnings(proj,ORIGINAL,proj.editSpecs[ORIGINAL].vprompt,"clip")),["[아잉] — 등록된 요소가 아니에요"]);
  // 같은 요소를 두 번 불러도 한 번만 들어간다
  proj.editSpecs[ORIGINAL].vprompt="[아이]와 [아이]";
  const twice=sb.clipRequest(proj,ORIGINAL);
  assert.deepEqual(plain(twice.elements),["9001"]);
  assert.match(twice.prompt,/\n\n@element_1와 @element_1$/);
});

test("request: 7 inputs in total — refs not named in the prompt drop from the end, named ones stay",()=>{
  const sb=sandbox(), proj=project([1,2,3,4,5,6,7],"뛰어요");
  let r=sb.clipRequest(proj,ORIGINAL);
  assert.deepEqual(plain(r.refs),[1,2,3,4,5].map(REF));
  assert.match(r.prompt,/@image_3 to @image_7 are additional references/);
  assert.equal(sb.clipInputsHint(proj,ORIGINAL),"영상에 들어가는 것: 가공 · 원본 · 레퍼런스 1·2·3·4·5번 (7/7) — 자리가 없어 레퍼런스 6·7번은 빠져요");

  proj.editSpecs[ORIGINAL].vprompt="[레퍼런스7] 의 옷을 입은 [아이]";
  r=sb.clipRequest(proj,ORIGINAL);
  assert.deepEqual(plain(r.refs),[1,2,3,7].map(REF),"named ref 7 kept, 4·5·6 dropped to make room for the element");
  assert.deepEqual(plain(r.elements),["9001"]);
  assert.match(r.prompt,/@image_3 to @image_6 are additional references/);
  assert.match(r.prompt,/\n\n@image_6 의 옷을 입은 @element_1$/,"ref 7 is the 4th ref sent → @image_6");
  assert.match(sb.clipInputsHint(proj,ORIGINAL),/레퍼런스 1·2·3·7번 · 아이 \(7\/7\) — 자리가 없어 레퍼런스 4·5·6번은 빠져요$/);
  assert.equal(sb.clipBlocker(proj,ORIGINAL),"");

  proj.editSpecs[ORIGINAL].vprompt="[레퍼런스1][레퍼런스2][레퍼런스3][레퍼런스4] [아이] [강아지]";
  const plan=sb.clipPlan(proj,ORIGINAL);
  assert.equal(plan.total,8);
  assert.equal(plan.over,true);
  assert.match(sb.clipBlocker(proj,ORIGINAL),/이미지·요소가 8개예요 \(최대 7개\)/,"blocked before sending");
  assert.match(sb.clipInputsHint(proj,ORIGINAL),/\(8\/7\) — 자리가 없어 레퍼런스 5·6·7번은 빠져요 — 최대 7개라 프롬프트에서 부른 레퍼런스나 요소를 줄여야 보낼 수 있어요$/);
});

test("a stale, pending, failed or unregistered Kling element can still be used as a photo reference",()=>{
  const sb=sandbox(), proj=project([1],"[아이]가 뛰어요");
  const kid=proj.elements[0];
  assert.equal(sb.clipBlocker(proj,ORIGINAL),"");
  kid.angles.push({id:EL("kid2"),w:800,h:1000});
  assert.equal(sb.elemState(proj,kid),"stale");
  assert.equal(sb.clipBlocker(proj,ORIGINAL),"","stale native registration falls back to photo");
  let r=sb.clipRequest(proj,ORIGINAL);
  assert.deepEqual(plain(r.elements),[]);
  assert.deepEqual(plain(r.refs),[REF(1),EL("kidf")]);
  assert.match(r.prompt,/@image_4/);
  kid.kling={status:"pending",taskId:"t",sig:"x",at:Date.now()};
  assert.equal(sb.clipBlocker(proj,ORIGINAL),"","registration in progress does not block photo mode");
  kid.kling={status:"failed",msg:"bad",sig:"x",at:1};
  assert.equal(sb.clipBlocker(proj,ORIGINAL),"","failed registration does not block photo mode");
  delete kid.kling;
  assert.equal(sb.clipBlocker(proj,ORIGINAL),"","unregistered element uses its front photo");
  const local=sb.clipPlan(proj,ORIGINAL);
  assert.equal(local.localRefs.length,1);
  assert.equal(local.elements.length,0);
  // An unmentioned element never consumes an input.
  proj.editSpecs[ORIGINAL].vprompt="[강아지]가 뛰어요";
  assert.equal(sb.clipBlocker(proj,ORIGINAL),"");
  assert.deepEqual(plain(sb.clipRequest(proj,ORIGINAL).elements),["9002"]);
});

test("length is typed per video: blank → 5, any whole 3-15, otherwise blocked",()=>{
  const sb=sandbox(), proj=project();
  const sp=proj.editSpecs[ORIGINAL];
  assert.equal(sb.clipRequest(proj,ORIGINAL).duration,5,"blank");
  for(const [typed,want] of [["7",7],["3",3],["15",15],[" 12 ",12],["2",null],["16",null],["4.5",null],["abc",null],["-5",null]]){
    sp.vdur=typed;
    assert.equal(sb.clipDuration(proj,ORIGINAL),want,JSON.stringify(typed));
  }
  // 다른 사진의 길이는 따로다
  const o2=UID+"/"+P+"/photo/o2.jpg";
  proj.editSpecs[o2]={prompt:"",refs:[],vprompt:"",vdur:"9"};
  sp.vdur="4";
  assert.equal(sb.clipDuration(proj,ORIGINAL),4);
  assert.equal(sb.clipDuration(proj,o2),9);
  assert.equal(sb.specOf({editSpecs:{}},"x").vdur,"","new spec starts blank");
});

test("request: nothing is sent without an edited photo or a video prompt",()=>{
  const sb=sandbox(), proj=project();
  const o2=UID+"/"+P+"/photo/o2.jpg";
  proj.editSpecs[o2]={prompt:"x",refs:[],vprompt:"걷는다"};
  assert.equal(sb.clipRequest(proj,o2),null,"no edited photo yet");
  assert.equal(sb.clipHintText(proj,o2),"가공 사진을 만들면 영상을 만들 수 있어요.");
  proj.editSpecs[ORIGINAL].vprompt="  ";
  assert.equal(sb.clipRequest(proj,ORIGINAL),null,"blank video prompt");
  proj.edits[o2]={id:UID+"/"+P+"/edited/e2.jpg"};
  assert.deepEqual(plain(sb.clipInputs(proj,o2)),[UID+"/"+P+"/edited/e2.jpg",o2],"no refs → edited + original");
  assert.equal(sb.clipHintText(proj,o2),"영상에 들어가는 것: 가공 · 원본 (2/7)");
});

test("images Kling would reject are caught before sending (300px, 1:2.5~2.5:1)",()=>{
  const sb=sandbox(), proj=project();
  assert.equal(sb.clipInputProblem(proj,ORIGINAL),"");
  proj.edits[ORIGINAL].w=280;
  assert.match(sb.clipInputProblem(proj,ORIGINAL),/가공 사진이 너무 작아요 \(280×656\)/);
  proj.edits[ORIGINAL].w=992;
  proj.editSpecs[ORIGINAL].refs[1]={id:REF(2),w:3000,h:1000};
  assert.match(sb.clipInputProblem(proj,ORIGINAL),/레퍼런스 2번 비율이 너무 길어요/);
  proj.editSpecs[ORIGINAL].refs[1]={id:REF(2)};
  assert.equal(sb.clipInputProblem(proj,ORIGINAL),"","unknown size is left to Kling");
});

test("state: pending job locks the button, a remade photo marks the video stale",()=>{
  const sb=sandbox(), proj=project();
  assert.equal(sb.clipState(proj,ORIGINAL).canMake,true);
  proj.clipJobs={[ORIGINAL]:{op:{taskId:"t"},at:Date.now()-75000}};
  assert.equal(sb.clipState(proj,ORIGINAL).canMake,false);
  assert.equal(sb.clipElapsed(proj.clipJobs[ORIGINAL]),"1:15");
  delete proj.clipJobs[ORIGINAL];
  proj.clips={[ORIGINAL]:{id:"v.mp4",fromEdit:EDITED}};
  assert.equal(sb.clipState(proj,ORIGINAL).stale,false);
  proj.edits[ORIGINAL]={id:UID+"/"+P+"/edited/e1b.jpg"};
  assert.equal(sb.clipState(proj,ORIGINAL).stale,true,"photo remade after the video");
  delete proj.edits[ORIGINAL];
  assert.equal(sb.clipState(proj,ORIGINAL).stale,true,"photo result deleted");
  assert.equal(sb.clipState(proj,ORIGINAL).canMake,false);
});

// clipStart / clipCheck 를 가짜 api 로 돌린다.
function runner(replies){
  const calls=[], deleted=[], persisted=[], toasts=[];
  const sb=sandbox({
    api:async(url,opts)=>{
      calls.push({url,body:JSON.parse(opts.body)});
      const r=replies.shift();
      if(r instanceof Error) throw r;
      return {ok:r.status<400,status:r.status,text:async()=>JSON.stringify(r.body)};
    },
    persist:async(p)=>{ persisted.push(plain(p)); return true; },
    storeDelete:async(id)=>{ deleted.push(id); },
    renderClipsSoon:()=>{}, ensureClipPoll:()=>{}, toast:(m)=>toasts.push(m), console:{error(){},warn(){}},
  });
  vm.runInNewContext([
      "clipJobIds(proj){","clipTaskId(job){","clipAutoJobIds(proj){","clipOldJobs(proj,pid){",
      "clipRecoverableOldJob(proj,pid){","clipRequireCheck(proj,pid,job,message){",
      "clipStart(proj, pid){","clipCheck(proj,pid,options){",
    ].map(grab).join("\n"),sb);
  return {sb,calls,deleted,persisted,toasts};
}

test("start: one request even when tapped twice, typed length and elements are sent, failure unlocks the row",async()=>{
  const t=runner([{status:200,body:{operation:{taskId:"t1"}}}]);
  const proj=project([1,2],"[아이]가 뛰어요");
  proj.editSpecs[ORIGINAL].vdur="8";
  await Promise.all([t.sb.clipStart(proj,ORIGINAL),t.sb.clipStart(proj,ORIGINAL)]);
  assert.equal(t.calls.length,1,"second tap ignored while the first is in flight");
  assert.equal(t.calls[0].url,FN_URL);
  assert.equal(t.calls[0].body.duration,8);
  assert.deepEqual(t.calls[0].body.elements,["9001"]);
  assert.deepEqual(plain(proj.clipJobs[ORIGINAL].op),{taskId:"t1"});
  assert.equal(proj.clipJobs[ORIGINAL].dur,8);
  assert.equal(proj.clipJobs[ORIGINAL].inputs,5,"2 photos + 2 refs + 1 element");
  assert.deepEqual(t.persisted.at(-1).clipJobs[ORIGINAL].op,{taskId:"t1"},"job saved so a reload can resume");

  const f=runner([{status:502,body:{error:"kling_auth",message:"Kling API 키가 거부됐어요."}}]);
  const proj2=project();
  await f.sb.clipStart(proj2,ORIGINAL);
  assert.ok(proj2.clipJobs[ORIGINAL],"502 may hide an accepted Kling job, so keep a recovery record");
  assert.equal(proj2.clipJobs[ORIGINAL].needsCheck,true);
  assert.match(proj2.clipJobs[ORIGINAL].notice,/요청 결과를 확인하지 못했어요/);
});

test("start: invalid inputs are blocked but unregistered elements can use one photo reference",async()=>{
  const t=runner([{status:200,body:{operation:{taskId:"tlocal"}}}]);
  const proj=project();
  proj.editSpecs[ORIGINAL].vdur="20";
  await t.sb.clipStart(proj,ORIGINAL);
  assert.match(t.sb.clipErrors[ORIGINAL],/1번 영상 길이는 3~15초 사이 정수로 적어주세요/);
  proj.editSpecs[ORIGINAL].vdur="";
  proj.photos[0].h=200;
  await t.sb.clipStart(proj,ORIGINAL);
  assert.match(t.sb.clipErrors[ORIGINAL],/원본이 너무 작아요/);
  proj.photos[0].h=453;
  delete proj.elements[1].kling;
  proj.editSpecs[ORIGINAL].vprompt="[강아지]가 뛰어요";
  await t.sb.clipStart(proj,ORIGINAL);
  assert.equal(t.calls.length,1,"an unregistered element can start using its photo");
  assert.deepEqual(t.calls[0].body.refs,[REF(1),REF(2),EL("dogf")]);
  assert.deepEqual(t.calls[0].body.elements,[],"no made-up Kling element ID");
  assert.deepEqual(plain(proj.clipJobs[ORIGINAL].op),{taskId:"tlocal"});
  delete proj.clipJobs[ORIGINAL]; // reset mock job for the later input-limit check
  proj.editSpecs[ORIGINAL].refs=[1,2,3,4,5].map((n)=>({id:REF(n),w:1200,h:1600}));
  proj.editSpecs[ORIGINAL].vprompt="[레퍼런스1][레퍼런스2][레퍼런스3][레퍼런스4][레퍼런스5] [아이]";
  await t.sb.clipStart(proj,ORIGINAL);
  assert.match(t.sb.clipErrors[ORIGINAL],/이미지·요소가 8개예요 \(최대 7개\)/);
  assert.equal(t.calls.length,1,"only the valid one-photo request reaches the API");
  assert.equal((proj.clipJobs||{})[ORIGINAL],undefined);
});

test("check: pending waits, completed swaps in the new video and deletes the old one, error stops",async()=>{
  const t=runner([
    {status:200,body:{status:"pending",kling:"processing"}},
    {status:200,body:{status:"completed",id:UID+"/"+P+"/video/vnew.mp4",size:123,mime:"video/mp4"}},
  ]);
  const proj=project();
  proj.clips={[ORIGINAL]:{id:UID+"/"+P+"/video/vold.mp4",fromEdit:EDITED}};
  proj.clipJobs={[ORIGINAL]:{op:{taskId:"t1"},at:Date.now()-60000,dur:7,fromEdit:EDITED,inputs:4}};
  t.sb.current=proj;
  await t.sb.clipCheck(proj,ORIGINAL);
  assert.ok(proj.clipJobs[ORIGINAL],"still pending");
  assert.deepEqual(t.calls[0].body,{action:"status",projectId:P,operation:{taskId:"t1"}});
  await t.sb.clipCheck(proj,ORIGINAL);
  assert.equal(proj.clipJobs[ORIGINAL],undefined);
  assert.equal(proj.clips[ORIGINAL].id,UID+"/"+P+"/video/vnew.mp4");
  assert.equal(proj.clips[ORIGINAL].fromEdit,EDITED);
  assert.equal(proj.clips[ORIGINAL].dur,7);
  assert.deepEqual(t.deleted,[UID+"/"+P+"/video/vold.mp4"]);
  assert.match(t.toasts[0],/1번 영상이 완성됐어요/);

  const e=runner([{status:200,body:{status:"error",message:"content risk"}}]);
  const proj2=project();
  proj2.clipJobs={[ORIGINAL]:{op:{taskId:"t2"},at:Date.now()}};
  await e.sb.clipCheck(proj2,ORIGINAL);
  assert.equal(proj2.clipJobs[ORIGINAL],undefined);
  assert.match(e.sb.clipErrors[ORIGINAL],/1번 영상 Kling 생성 실패\(확인됨\): content risk/);
});

test("check: transient errors keep waiting, a stopped job's result is thrown away, old jobs give up",async()=>{
  const t=runner([{status:503,body:{error:"upstream"}},new Error("offline")]);
  const proj=project();
  proj.clipJobs={[ORIGINAL]:{op:{taskId:"t1"},at:Date.now()}};
  await t.sb.clipCheck(proj,ORIGINAL);
  await t.sb.clipCheck(proj,ORIGINAL);
  assert.ok(proj.clipJobs[ORIGINAL],"503 and network errors do not cancel the wait");
  assert.equal(t.sb.clipMisses[ORIGINAL],2);

  // 결과 확인 중 사용자가 추적을 보관한 경우, 나중에 복구할 수 있으므로 완료 파일을 지우지 않는다
  let release;
  const gate=new Promise((r)=>{ release=r; });
  const s=runner([]);
  s.sb.api=async()=>{ await gate; return {ok:true,status:200,text:async()=>JSON.stringify({status:"completed",id:"late.mp4"})}; };
  vm.runInNewContext(grab("clipCheck(proj,pid,options){"),s.sb);
  const proj2=project();
  proj2.clipJobs={[ORIGINAL]:{op:{taskId:"t9"},at:Date.now()}};
  const pending=s.sb.clipCheck(proj2,ORIGINAL);
  delete proj2.clipJobs[ORIGINAL];
  release();
  await pending;
  assert.equal((proj2.clips||{})[ORIGINAL],undefined);
  assert.deepEqual(s.deleted,[],"late result is retained for potential archive recovery");

  const g=runner([{status:200,body:{status:"pending",kling:"processing"}}]);
  const proj3=project();
  proj3.clipJobs={[ORIGINAL]:{op:{taskId:"old"},at:Date.now()-41*60*1000}};
  await g.sb.clipCheck(proj3,ORIGINAL);
  assert.equal(g.calls.length,1,"after 40min the existing ID is checked, not deleted");
  assert.equal(g.calls[0].body.operation.taskId,"old");
  assert.equal(proj3.clipJobs[ORIGINAL].needsCheck,true);
  assert.match(proj3.clipJobs[ORIGINAL].notice,/아직 진행 중/);
});

test("row layout: 원본 → 가공 → 영상, then 사진 가공 / 영상화 with its own length box",()=>{
  const src=grab("editSection(){");
  const order=['(i+1)+"번 원본"','(i+1)+"번 가공 결과"',"'<span class=\"earrow\">→</span>'+vcell",
    'for="ep_\'+i+\'">사진 가공</label>',"clipControls(p, i, sp, cs)"].map((k)=>src.indexOf(k));
  assert.ok(order.every((v)=>v>0),"all parts present: "+order);
  assert.deepEqual([...order].sort((a,b)=>a-b),order,"in the requested order");
  const controls=grab("clipControls(p, i, sp, cs){");
  const parts=['>영상화</label>',"data-vprompt=","data-vwarn=","data-vdur=",'type="number"','inputmode="numeric"',"data-vhint=","data-clip=","data-unclip=","data-clipstop="];
  for(const k of parts) assert.ok(controls.includes(k),k);
  assert.ok(controls.indexOf("data-vprompt=")<controls.indexOf("data-vdur=") && controls.indexOf("data-vdur=")<controls.indexOf("data-clip="),
    "prompt → length → buttons");
  assert.ok(!html.includes('id="f_clipDur"'),"no shared length select");
  assert.ok(!/proj\.clipDur|current\.clipDur/.test(html),"length is not stored per project");
  assert.ok(src.includes("완료된 영상은 ⑪ 편집에서 자동 우선 사용되며"),"completed clips feed the final reel");
  assert.ok(src.includes("길이가 부족하면 마젠타 단색으로 나와요"),"overrun is explicitly communicated");
  assert.ok(src.includes("h+=elemSection();"),"element panel sits in step 9");
  assert.ok(src.indexOf("h+=elemSection();")<src.indexOf('id="editall"'),"element panel comes before the rows");
  assert.ok(src.includes("data-ewarn=") && src.includes("data-elinks="),"photo-edit row shows warnings and element tiles");
});

test("clips are cleaned up with their photo and project, kept across reloads, and polling resumes",()=>{
  assert.match(grab("removeProject(p){"),/p\.clips\|\|\{\}/);
  const drop=grab("dropImage(kind, idx){");
  assert.match(drop,/delete current\.clips\[it\.id\]/);
  assert.match(drop,/delete current\.clipJobs\[it\.id\]/);
  assert.match(drop,/storeDelete\(cl\.id\)/);
  assert.match(html,/v\.clips=Object\.assign\(\{\}, v\.clips\|\|\{\}\);/);
  assert.match(html,/v\.clipJobs=JSON\.parse\(JSON\.stringify\(v\.clipJobs\|\|\{\}\)\);/);
  assert.match(html,/if\(clipJobIds\(current\)\.length\) ensureClipPoll\(\);/);
});


test("one-photo no-description [아이] in Kling video becomes @image_N without creating a native Kling element",()=>{
  const sb=sandbox(), proj=project([1],"[아이]가 [원본]에서 웃어요");
  const kid=proj.elements[0];
  kid.angles=[]; kid.desc=""; delete kid.kling;
  assert.equal(sb.elemState(proj,kid),"local");
  assert.equal(sb.clipBlocker(proj,ORIGINAL),"");
  const plan=sb.clipPlan(proj,ORIGINAL), r=sb.clipRequest(proj,ORIGINAL);
  assert.deepEqual(plain(plan.images),[EDITED,ORIGINAL,REF(1),EL("kidf")]);
  assert.deepEqual(plain(r.refs),[REF(1),EL("kidf")]);
  assert.deepEqual(plain(r.elements),[],"no Kling element ID is invented");
  assert.equal(plan.total,4);
  assert.match(r.prompt,/@image_4 shows 아이/);
  assert.match(r.prompt,/\n\n@image_4가 @image_2에서 웃어요$/);
  assert.match(sb.clipInputsHint(proj,ORIGINAL),/아이\(사진 참조\) \(4\/7\)/);
  kid.front.w=200; kid.front.h=1000;
  assert.match(sb.clipBlocker(proj,ORIGINAL),/요소 「아이」이 너무 작아요/);
  kid.front.w=800; kid.front.h=1000;
  kid.front=null;
  assert.match(sb.clipBlocker(proj,ORIGINAL),/\[아이\] — 요소 사진을 먼저 추가해주세요/);
});

test("local image elements and ready Kling IDs share the same seven-input budget and ordering",()=>{
  const sb=sandbox(), proj=project([1,2,3,4,5],"[레퍼런스5] [아이] [강아지]");
  const kid=proj.elements[0];kid.angles=[];delete kid.kling;kid.desc="";
  const p=sb.clipPlan(proj,ORIGINAL),r=sb.clipRequest(proj,ORIGINAL);
  assert.equal(p.total,7);
  assert.deepEqual(plain(p.refs.map(x=>x.n)),[1,2,5]);
  assert.deepEqual(plain(p.localRefs.map(x=>x.imageIndex)),[6]);
  assert.deepEqual(plain(r.refs),[REF(1),REF(2),REF(5),EL("kidf")]);
  assert.deepEqual(plain(r.elements),["9002"]);
  assert.match(r.prompt,/@image_6\s+@element_1/);
  assert.equal(sb.clipBlocker(proj,ORIGINAL),"");
});
