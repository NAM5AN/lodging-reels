"use strict";
// ⑨ 영상화 — 화면(index.html) 쪽 로직. 서버(Edge Function)는 tests/clip-function.test.ts 가 Deno 로 본다.
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
const FN_URL="https://kfgtvifupumjuewwxzmz.supabase.co/functions/v1/lodging-reels-clip";

function grab(sig){
  let start=html.indexOf("  function "+sig);
  if(start<0) start=html.indexOf("  async function "+sig);
  assert.ok(start>0,sig+" exists");
  const end=html.indexOf("\n  }\n",start);
  return html.slice(start,end+5);
}
function clipConst(){
  const m=html.match(/  var CLIP = \{[\s\S]*?\};\n/);
  assert.ok(m,"CLIP settings exist");
  return m[0];
}
function sandbox(extra){
  const sb=Object.assign({esc:(v)=>String(v??""),clipInflight:{},clipErrors:{},clipMisses:{},FN:{clip:FN_URL}},extra||{});
  vm.runInNewContext([
    clipConst(),
    grab("peekSpec(proj, pid){"), grab("specOf(proj, pid){"),
    grab("clipHead(proj, refCount){"), grab("clipPromptText(proj, pid){"), grab("clipInputs(proj, pid){"),
    grab("clipInputsHint(proj, pid){"), grab("clipInputProblem(proj, pid){"), grab("clipDuration(proj, pid){"),
    grab("clipRequest(proj, pid){"), grab("clipState(proj, pid){"), grab("clipElapsed(job){"),
  ].join("\n"),sb);
  return sb;
}
// vm 안에서 만든 객체는 프로토타입이 달라서 JSON 으로 비교한다.
function plain(v){ return JSON.parse(JSON.stringify(v)); }
function project(refs){
  return {
    id:P,
    photos:[{id:ORIGINAL,w:680,h:453},{id:UID+"/"+P+"/photo/o2.jpg",w:680,h:453}],
    edits:{[ORIGINAL]:{id:EDITED,w:992,h:656}},
    editSpecs:{[ORIGINAL]:{prompt:"사진 프롬프트",refs:(refs||[1,2]).map((n)=>({id:REF(n),w:1200,h:1600})),vprompt:"아이가 침대 위에서 뛰어요"}},
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
});

test("request: image_1 edited → image_2 original → image_3~ refs, the photo's own prompt",()=>{
  const sb=sandbox(), proj=project([1,2]);
  const r=sb.clipRequest(proj,ORIGINAL);
  assert.equal(r.action,"start");
  assert.equal(r.projectId,P);
  assert.equal(r.edited,EDITED);
  assert.equal(r.original,ORIGINAL);
  assert.deepEqual(plain(r.refs),[REF(1),REF(2)]);
  assert.match(r.prompt,/^Create a vertical 9:16 photorealistic short-form video that brings the scene in <<<image_1>>> to life\./);
  assert.match(r.prompt,/<<<image_2>>> is the original photo of the real accommodation\./);
  assert.match(r.prompt,/as in <<<image_2>>>; do not add rooms or facilities/);
  assert.match(r.prompt,/<<<image_3>>> to <<<image_4>>> are additional references\./);
  assert.match(r.prompt,/\n\n아이가 침대 위에서 뛰어요$/);
  assert.equal(sb.clipInputsHint(proj,ORIGINAL),"영상 레퍼런스: 가공 · 원본 · 레퍼런스 1~2번");

  const one=sandbox().clipRequest(project([1]),ORIGINAL);
  assert.match(one.prompt,/<<<image_3>>> is an additional reference\./);
  const none=sandbox().clipRequest(project([]),ORIGINAL);
  assert.doesNotMatch(none.prompt,/image_3/);
  proj.editKeepReal=false;
  assert.doesNotMatch(sb.clipRequest(proj,ORIGINAL).prompt,/do not add rooms/);
});

test("request: Kling takes 7 images, so refs 6+ are left out and the row says so",()=>{
  const sb=sandbox(), proj=project([1,2,3,4,5,6,7]);
  const r=sb.clipRequest(proj,ORIGINAL);
  assert.deepEqual(plain(r.refs),[1,2,3,4,5].map(REF));
  assert.match(r.prompt,/<<<image_3>>> to <<<image_7>>> are additional references/);
  assert.match(sb.clipInputsHint(proj,ORIGINAL),/레퍼런스 1~5번 \(Kling 한도가 7장이라 레퍼런스 6번부터는 빠져요\)/);
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
  proj.editSpecs[ORIGINAL].vprompt="  ";
  assert.equal(sb.clipRequest(proj,ORIGINAL),null,"blank video prompt");
  proj.edits[o2]={id:UID+"/"+P+"/edited/e2.jpg"};
  assert.deepEqual(plain(sb.clipInputs(proj,o2)),[UID+"/"+P+"/edited/e2.jpg",o2],"no refs → edited + original");
  assert.equal(sb.clipInputsHint(proj,o2),"영상 레퍼런스: 가공 · 원본");
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
    renderClipsSoon:()=>{}, ensureClipPoll:()=>{}, toast:(m)=>toasts.push(m), console:{error(){}},
  });
  vm.runInNewContext(grab("clipStart(proj, pid){")+"\n"+grab("clipCheck(proj, pid){"),sb);
  return {sb,calls,deleted,persisted,toasts};
}

test("start: one request even when tapped twice, typed length is sent, failure unlocks the row",async()=>{
  const t=runner([{status:200,body:{operation:{taskId:"t1"}}}]);
  const proj=project();
  proj.editSpecs[ORIGINAL].vdur="8";
  await Promise.all([t.sb.clipStart(proj,ORIGINAL),t.sb.clipStart(proj,ORIGINAL)]);
  assert.equal(t.calls.length,1,"second tap ignored while the first is in flight");
  assert.equal(t.calls[0].url,FN_URL);
  assert.equal(t.calls[0].body.duration,8);
  assert.deepEqual(plain(proj.clipJobs[ORIGINAL].op),{taskId:"t1"});
  assert.equal(proj.clipJobs[ORIGINAL].dur,8);
  assert.deepEqual(t.persisted.at(-1).clipJobs[ORIGINAL].op,{taskId:"t1"},"job saved so a reload can resume");

  const f=runner([{status:502,body:{error:"kling_auth",message:"Kling API 키가 거부됐어요."}}]);
  const proj2=project();
  await f.sb.clipStart(proj2,ORIGINAL);
  assert.equal(proj2.clipJobs[ORIGINAL],undefined);
  assert.match(f.sb.clipErrors[ORIGINAL],/1번 영상 요청 실패: Kling API 키가 거부됐어요\./);
});

test("start: a bad length or an image Kling would reject never reaches the server",async()=>{
  const t=runner([]);
  const proj=project();
  proj.editSpecs[ORIGINAL].vdur="20";
  await t.sb.clipStart(proj,ORIGINAL);
  assert.equal(t.calls.length,0);
  assert.match(t.sb.clipErrors[ORIGINAL],/1번 영상 길이는 3~15초 사이 정수로 적어주세요/);
  proj.editSpecs[ORIGINAL].vdur="";
  proj.photos[0].h=200;
  await t.sb.clipStart(proj,ORIGINAL);
  assert.equal(t.calls.length,0);
  assert.match(t.sb.clipErrors[ORIGINAL],/원본이 너무 작아요/);
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
  assert.match(e.sb.clipErrors[ORIGINAL],/1번 영상 만들기 실패: content risk/);
});

test("check: transient errors keep waiting, a stopped job's result is thrown away, old jobs give up",async()=>{
  const t=runner([{status:503,body:{error:"upstream"}},new Error("offline")]);
  const proj=project();
  proj.clipJobs={[ORIGINAL]:{op:{taskId:"t1"},at:Date.now()}};
  await t.sb.clipCheck(proj,ORIGINAL);
  await t.sb.clipCheck(proj,ORIGINAL);
  assert.ok(proj.clipJobs[ORIGINAL],"503 and network errors do not cancel the wait");
  assert.equal(t.sb.clipMisses[ORIGINAL],2);

  // 응답을 기다리는 사이 '기다리기 그만' → 도착한 결과 파일은 지운다
  let release;
  const gate=new Promise((r)=>{ release=r; });
  const s=runner([]);
  s.sb.api=async()=>{ await gate; return {ok:true,status:200,text:async()=>JSON.stringify({status:"completed",id:"late.mp4"})}; };
  vm.runInNewContext(grab("clipCheck(proj, pid){"),s.sb);
  const proj2=project();
  proj2.clipJobs={[ORIGINAL]:{op:{taskId:"t9"},at:Date.now()}};
  const pending=s.sb.clipCheck(proj2,ORIGINAL);
  delete proj2.clipJobs[ORIGINAL];
  release();
  await pending;
  assert.equal((proj2.clips||{})[ORIGINAL],undefined);
  assert.deepEqual(s.deleted,["late.mp4"]);

  const g=runner([]);
  const proj3=project();
  proj3.clipJobs={[ORIGINAL]:{op:{taskId:"old"},at:Date.now()-41*60*1000}};
  await g.sb.clipCheck(proj3,ORIGINAL);
  assert.equal(g.calls.length,0);
  assert.equal(proj3.clipJobs[ORIGINAL],undefined);
  assert.match(g.sb.clipErrors[ORIGINAL],/40분 넘게/);
});

test("row layout: 원본 → 가공 → 영상, then 사진 가공 / 영상화 with its own length box",()=>{
  const src=grab("editSection(){");
  const order=['(i+1)+"번 원본"','(i+1)+"번 가공 결과"',"'<span class=\"earrow\">→</span>'+vcell",
    'for="ep_\'+i+\'">사진 가공</label>',"clipControls(p, i, sp, cs)"].map((k)=>src.indexOf(k));
  assert.ok(order.every((v)=>v>0),"all parts present: "+order);
  assert.deepEqual([...order].sort((a,b)=>a-b),order,"in the requested order");
  const controls=grab("clipControls(p, i, sp, cs){");
  const parts=['>영상화</label>',"data-vprompt=","data-vdur=",'type="number"','inputmode="numeric"',"data-clip=","data-unclip=","data-clipstop="];
  for(const k of parts) assert.ok(controls.includes(k),k);
  assert.ok(controls.indexOf("data-vprompt=")<controls.indexOf("data-vdur=") && controls.indexOf("data-vdur=")<controls.indexOf("data-clip="),
    "prompt → length → buttons");
  assert.ok(!html.includes('id="f_clipDur"'),"no shared length select");
  assert.ok(!/proj\.clipDur|current\.clipDur/.test(html),"length is not stored per project");
  assert.ok(src.includes("완료된 영상은 ⑪ 편집에서 자동 우선 사용되며"),"completed clips feed the final reel");
  assert.ok(src.includes("길이가 부족하면 마젠타 단색으로 나와요"),"overrun is explicitly communicated");
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
