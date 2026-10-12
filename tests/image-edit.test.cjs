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

test("payload: Sunburst, base photo first, 1088x1920 jpeg, minimal drops optional params",()=>{
  const v=lib.validate({base:photo,refs:[ref1,ref2],prompt:"p",quality:"xhigh"},UID);
  const full=lib.buildPayload(v,false);
  assert.equal(full.model,"openai/gpt-image-2.5-sunburst");
  assert.equal(full.images.length,3);
  assert.ok(full.images[0].image_url.endsWith("/photo/lx9k2a.jpg"),"base is Image 1");
  assert.ok(full.images[0].image_url.startsWith("https://kfgtvifupumjuewwxzmz.supabase.co/storage/v1/object/public/lodging-reels/"));
  assert.equal(full.size,"1088x1920");
  assert.equal(full.quality,"xhigh");
  assert.equal(full.output_format,"jpeg");
  assert.equal(full.n,1);
  const [w,h]=full.size.split("x").map(Number);
  assert.equal(w%16,0); assert.equal(h%16,0);
  assert.ok(w>=1080 && h>=1920,"never upscale to 1080x1920");
  const min=lib.buildPayload(v,true);
  assert.deepEqual(Object.keys(min).sort(),["images","model","n","prompt"]);
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
  vm.runInNewContext([grab("srcId(p){"),grab("editPromptText(proj, note){")].join("\n"),sandbox);
  return sandbox;
}

test("srcId: an edited photo is used downstream, otherwise the original",()=>{
  const b=box({edits:{"a.jpg":{id:"a-edited.jpg"}}});
  assert.equal(b.srcId({id:"a.jpg"}),"a-edited.jpg");
  assert.equal(b.srcId({id:"b.jpg"}),"b.jpg");
});

test("prompt: keeps the real space by default and tells the model which image is the base",()=>{
  const b=box({});
  const t=b.editPromptText({editPrompt:"따뜻한 조명",refs:[{id:1},{id:2}]},"창밖은 노을");
  assert.match(t,/^Image 1 is the base photo to edit\. Images 2-3 are references only\./);
  assert.match(t,/do not add rooms or facilities/);
  assert.match(t,/9:16/);
  assert.match(t,/\n\n따뜻한 조명\n\nFor this photo only: 창밖은 노을$/);

  const off=b.editPromptText({editPrompt:"x",refs:[],editKeepReal:false},"");
  assert.doesNotMatch(off,/real accommodation/);
  assert.doesNotMatch(off,/references only/,"no refs sentence without refs");
  assert.match(off,/\n\nx$/);
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
