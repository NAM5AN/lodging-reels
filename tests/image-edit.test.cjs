"use strict";
// ⑨ 이미지 가공 — Vercel 함수의 순수 로직과 화면 조각을 검사한다.
// 실제 Gateway 호출과 이미지 생성은 여기서 하지 않는다(돈이 들고, 키가 없다).
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const {test}=require("node:test");

const lib=require("../api/image-edit.js")._lib;
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");

const UID="11111111-2222-3333-4444-555555555555";
const OTHER="99999999-2222-3333-4444-555555555555";
const photo=UID+"/pabc123/photo/lx9k2a.jpg";
const ref1=UID+"/pabc123/ref/r1.jpg";
const ref2=UID+"/pabc123/ref/r2.png";

test("paths: only the caller's own photo/ref files pass",()=>{
  assert.equal(lib.checkPath(photo,UID,["photo"]),true);
  assert.equal(lib.checkPath(ref1,UID,["ref"]),true);
  assert.equal(lib.checkPath(OTHER+"/pabc123/photo/x.jpg",UID,["photo"]),false,"other user");
  assert.equal(lib.checkPath(UID+"/pabc123/info/x.jpg",UID,["photo"]),false,"wrong kind");
  assert.equal(lib.checkPath(UID+"/../x/photo/x.jpg",UID,["photo"]),false,"dot-dot");
  assert.equal(lib.checkPath(UID+"/pabc123/photo/x.gif",UID,["photo"]),false,"extension");
  assert.equal(lib.checkPath("https://evil.example/x.jpg",UID,["photo"]),false,"absolute url");
  assert.equal(lib.checkPath(UID+"/p/photo/a/b.jpg",UID,["photo"]),false,"extra segment");
});

test("validate: prompt required, refs capped at 15, quality falls back to high",()=>{
  assert.equal(lib.validate({base:photo,refs:[],prompt:"  "},UID).error,"empty_prompt");
  const many=Array.from({length:16},(_,i)=>UID+"/pabc123/ref/r"+i+".jpg");
  assert.equal(lib.validate({base:photo,refs:many,prompt:"x"},UID).error,"too_many_refs");
  assert.equal(lib.validate({base:ref1,refs:[],prompt:"x"},UID).error,"bad_base","a ref cannot be the base");
  assert.equal(lib.validate({base:photo,refs:[photo],prompt:"x"},UID).error,"bad_ref","a photo cannot be a ref");
  const ok=lib.validate({base:photo,refs:[ref1,ref2],prompt:" warm light ",quality:"turbo"},UID);
  assert.equal(ok.error,undefined);
  assert.equal(ok.prompt,"warm light");
  assert.equal(ok.quality,"high");
  assert.equal(lib.validate({base:photo,refs:[],prompt:"x",quality:"max"},UID).quality,"max");
});

test("payload: Sunburst Generate only text prompt, original aspect size, jpeg, minimal drops optional params",()=>{
  const v=lib.validate({base:photo,baseW:1600,baseH:900,refs:[ref1,ref2],prompt:"p",quality:"xhigh"},UID);
  const full=lib.buildPayload(v,false);
  assert.equal(full.model,"openai/gpt-image-2.5-sunburst");
  assert.equal(full.images,undefined,"Generate API cannot accept images");
  assert.equal(full.image,undefined,"Neither base nor refs is sent");
  assert.equal(full.prompt,"p");
  assert.equal(full.size,"1600x896");
  assert.equal(full.quality,"xhigh");
  assert.equal(full.output_format,"jpeg");
  assert.equal(full.n,1);
  const [w,h]=full.size.split("x").map(Number);
  assert.equal(w%16,0); assert.equal(h%16,0);
  assert.ok(Math.abs(w/h-1600/900)<0.012,"request size stays close to source aspect ratio");
  const min=lib.buildPayload(v,true);
  assert.deepEqual(Object.keys(min).sort(),["model","n","prompt"]);
});

test("Generate request contains no base or reference URLs; frontend makes limits clear",()=>{
  const v=lib.validate({base:photo,baseW:1920,baseH:1080,refs:[ref1,ref2],prompt:"side view",quality:"high"},UID);
  const payload=lib.buildPayload(v,false);
  assert.deepEqual(Object.keys(payload).sort(),["model","n","output_compression","output_format","prompt","quality","size"]);
  assert.ok(!JSON.stringify(payload).includes("/photo/"));
  assert.ok(!JSON.stringify(payload).includes("/ref/"));
  assert.match(html,/Generate 실험 모드/);
  assert.match(html,/원본과 레퍼런스 사진은 AI에 전달되지 않아요/);
});

test("response: both data[].b64_json and data[] string shapes are read",()=>{
  assert.deepEqual(lib.pickImage({data:[{b64_json:"/9jAAA"}]}),{b64:"/9jAAA"});
  assert.deepEqual(lib.pickImage({data:["iVBORxx"]}),{b64:"iVBORxx"});
  assert.deepEqual(lib.pickImage({data:[{url:"https://x/y.png"}]}),{url:"https://x/y.png"});
  assert.equal(lib.pickImage({data:[]}),null);
  assert.equal(lib.sniffMime("/9j/4AAQ"),"image/jpeg");
  assert.equal(lib.sniffMime("iVBORw0K"),"image/png");
  assert.equal(lib.sniffMime("UklGRiQ"),"image/webp");
});

test("retry only when an optional parameter was rejected",()=>{
  assert.equal(lib.looksLikeParamError(400,"Unknown parameter: output_compression"),true);
  assert.equal(lib.looksLikeParamError(400,"Invalid size 1088x1920"),true);
  assert.equal(lib.looksLikeParamError(401,"unauthorized size"),false);
  assert.equal(lib.looksLikeParamError(400,"Your request was rejected by the safety system"),false);
});

// ---------- 화면 ----------
function grab(sig){
  const start=html.indexOf("  function "+sig);
  assert.ok(start>0,sig+" exists");
  const end=html.indexOf("\n  }\n",start);
  return html.slice(start,end+5);
}

function box(current){
  const sandbox={current, esc:(v)=>String(v??"")};
  vm.runInNewContext([
    grab("srcId(p){"), grab("peekSpec(proj, pid){"), grab("specOf(proj, pid){"),
    grab("editHead(proj, refCount){"), grab("editPromptText(proj, pid){"),
    grab("editRequest(proj, pid){"), grab("editPending(proj){"),
  ].join("\n"),sandbox);
  return sandbox;
}

test("srcId: an edited photo is used downstream, otherwise the original",()=>{
  const b=box({edits:{"a.jpg":{id:"a-edited.jpg"}}});
  assert.equal(b.srcId({id:"a.jpg"}),"a-edited.jpg");
  assert.equal(b.srcId({id:"b.jpg"}),"b.jpg");
});

test("each photo carries its own prompt and its own references",()=>{
  const b=box({});
  const proj={
    photos:[{id:"p1",w:1600,h:900},{id:"p2",w:800,h:1200},{id:"p3",w:1000,h:1000}],
    editSpecs:{
      p1:{prompt:"창밖을 노을로",refs:[{id:"r1"},{id:"r2"}]},
      p2:{prompt:"침구를 흰색으로",refs:[]},
      p3:{prompt:"   ",refs:[{id:"r9"}]},
    },
  };
  const a=b.editRequest(proj,"p1");
  assert.equal(a.base,"p1");
  assert.equal(a.baseW,1600);
  assert.equal(a.baseH,900);
  assert.deepEqual([...a.refs],["r1","r2"],"only p1's refs");
  assert.match(a.prompt,/Generate one realistic accommodation photograph/);
  assert.doesNotMatch(a.prompt,/Image 1|Images 2-3/);
  assert.match(a.prompt,/\n\n창밖을 노을로$/);
  assert.equal(a.quality,"high");

  const c=b.editRequest(proj,"p2");
  assert.deepEqual([...c.refs],[],"p2 gets none of p1's refs");
  assert.doesNotMatch(c.prompt,/reference|Image 1/,"Generate prompt never references unseen input images");
  assert.match(c.prompt,/\n\n침구를 흰색으로$/);

  assert.equal(b.editRequest(proj,"p3"),null,"blank prompt → nothing is sent");
  assert.deepEqual([...b.editPending(proj)],["p1","p2"],"bulk run skips blank prompts");

  proj.edits={p1:{id:"e1"}};
  assert.deepEqual([...b.editPending(proj)],["p2"],"bulk run skips photos that already have a result");
});

test("Generate prompt never claims to see user-uploaded photos; keep-real toggle works",()=>{
  const b=box({});
  const one=b.editPromptText({editSpecs:{p:{prompt:"x",refs:[{id:"r"}]}}},"p");
  assert.match(one,/Generate one realistic accommodation photograph/);
  assert.doesNotMatch(one,/Image 1|Image 2|reference image/);
  assert.match(one,/do not invent extra rooms or facilities/);
  assert.match(one,/requested output aspect ratio/);
  const off=b.editPromptText({editKeepReal:false,editSpecs:{p:{prompt:"x",refs:[]}}},"p");
  assert.doesNotMatch(off,/do not invent extra rooms or facilities/);
  assert.match(off,/^Generate one realistic accommodation photograph/);
  assert.match(off,/requested output aspect ratio/);
});

test("text typed under the old shared-prompt layout is carried into the photo's own prompt",()=>{
  const b=box({});
  const proj={editPrompt:"따뜻한 조명",editNotes:{p1:"창밖은 노을"},photos:[{id:"p1"},{id:"p2"}]};
  assert.equal(b.peekSpec(proj,"p1").prompt,"따뜻한 조명\n창밖은 노을");
  assert.equal(b.peekSpec(proj,"p2").prompt,"따뜻한 조명");
  assert.equal(proj.editSpecs,undefined,"reading does not write");
  b.specOf(proj,"p1").prompt="새로 씀";
  assert.equal(b.peekSpec(proj,"p1").prompt,"새로 씀");
});

test("screen has no shared prompt box or shared reference picker",()=>{
  assert.ok(!html.includes('id="f_editPrompt"'),"no shared prompt textarea");
  assert.ok(!html.includes('imageGrid("ref")'),"no shared reference grid");
  assert.ok(html.includes('data-eprompt="'),"per-photo prompt");
  assert.ok(html.includes('data-eref="'),"per-photo reference input");
  assert.ok(html.includes("querySelectorAll('input[type=file][data-kind]')"),
    "generic uploader ignores per-photo reference inputs");
});


// --- 원본 사진 비율 유지 (가로 · 세로 · 정사각 · 레거시 메타데이터) ---
test("sizeForAspect preserves source orientation and outputs 16-aligned dimensions",()=>{
  assert.equal(lib.sizeForAspect(1600,900),"1600x896");
  assert.equal(lib.sizeForAspect(900,1600),"896x1600");
  assert.equal(lib.sizeForAspect(1920,1920),"1920x1920");
  assert.equal(lib.sizeForAspect(5000,3000),"1920x1152");
  assert.equal(lib.sizeForAspect(0,0),null);
  const input=lib.validate({base:photo,baseW:900,baseH:1600,refs:[],prompt:"x"},UID);
  assert.equal(input.baseW,900);
  assert.equal(input.baseH,1600);
  assert.equal(lib.buildPayload(input,false).size,"896x1600");
});

test("stage nine no longer forces portrait aspect or fixes output at 1080x1920",()=>{
  assert.ok(html.includes("원본 사진은 <strong>비율 결정과 결과 비교에만 사용</strong>돼요"));
  assert.ok(!html.includes("GPT Image 2.5 Sunburst 로 1080×1920 세로 이미지를 만들어요"));
  assert.ok(html.includes("function fitOriginalAspect(blob, targetW, targetH)"));
  assert.ok(!html.includes("function fitVertical(blob)"));
  assert.ok(html.includes("id:up.id, w:fit.w, h:fit.h"));
  assert.ok(html.includes("body.baseW=original.naturalWidth;body.baseH=original.naturalHeight;"),
    "older photo metadata can be recovered from the actual source image");
  assert.ok(html.includes("var VIDEO = {w:1080, h:1920"),"final reel output stays 9:16");
});

test("browser image processing center-crops only the minimal amount for original aspect",async ()=>{
  const src=grab("fitOriginalAspect(blob, targetW, targetH){");
  const capture={};
  class StubImg{
    constructor(){this.naturalWidth=1600;this.naturalHeight=896;}
    set src(_){this.onload();}
  }
  const doc={createElement(t){
    assert.equal(t,"canvas");
    return {width:0,height:0,getContext(){
      return {drawImage(...args){capture.args=args;},imageSmoothingQuality:""};
    },toBlob(cb){cb({type:"image/jpeg"});}};
  }};
  const sandbox={Image:StubImg,document:doc,URL:{
    createObjectURL(){return "blob:local";},revokeObjectURL(){}
  }};
  vm.runInNewContext(src,sandbox);
  const result=await sandbox.fitOriginalAspect({},1600,900);
  assert.ok(result.w>result.h,"landscape should remain landscape");
  assert.ok(Math.abs(result.w/result.h-1600/900)<0.001,"final JPEG uses original aspect");
  assert.ok(result.w>=1590,"16-aligned request only needs a minimal source crop");
  assert.equal(result.srcW,1600);
  assert.equal(result.srcH,896);
});

test("steps are renumbered: ⑨ 가공 → ⑩ 컷 배치 → ⑪ 영상",()=>{
  assert.ok(html.includes("<h2>⑨ 이미지 가공</h2>"));
  assert.ok(html.includes("<h2>⑩ 싱크에 맞춰 배치한 컷에 사진 넣기</h2>"));
  assert.ok(html.includes("<h2>⑪ 영상 만들기</h2>"));
  assert.ok(!html.includes("<h2>⑨ 싱크에 맞춰"),"old ⑨ header gone");
  const order=["h+=imageSection(\"photo\"","h+=editSection();","h+=matchSection();","h+=videoSection();"]
    .map((k)=>html.indexOf(k));
  assert.ok(order.every((v)=>v>0),"all sections rendered");
  assert.deepEqual([...order].sort((a,b)=>a-b),order,"rendered in step order");
});

test("video and cut picker read through srcId, never photo.id directly",()=>{
  assert.ok(html.includes("imgs.push(await loadImg(blobUrl(srcId(photos[i]))))"));
  assert.ok(html.includes("loadImg(blobUrl(srcId(photos[ci])))"));
  assert.ok(!/loadImg\(blobUrl\(photos\[/.test(html),"no renderer reads the raw photo");
});
