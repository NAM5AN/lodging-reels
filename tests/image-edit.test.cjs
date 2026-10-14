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

test("Sunburst generateImage payload contains source+references in order and original aspect",()=>{
  const v=lib.validate({base:photo,baseW:1600,baseH:900,refs:[ref1,ref2],prompt:"p",quality:"xhigh"},UID);
  const imgs=[Uint8Array.from([11]),Uint8Array.from([22]),Uint8Array.from([33])];
  const full=lib.buildPayload(v,imgs,false);
  assert.equal(full.model,"openai/gpt-image-2.5-sunburst");
  assert.equal(full.prompt.text,"p");
  assert.equal(full.prompt.images.length,3);
  assert.strictEqual(full.prompt.images[0],imgs[0],"Image 1 is original photo");
  assert.strictEqual(full.prompt.images[1],imgs[1],"Image 2 is first extra reference");
  assert.strictEqual(full.prompt.images[2],imgs[2],"Image 3 is second extra reference");
  assert.equal(full.size,"1600x896");
  assert.equal(full.providerOptions.openai.quality,"xhigh");
  assert.equal(full.providerOptions.openai.outputFormat,"jpeg");
  assert.equal(full.providerOptions.openai.outputCompression,90);
  assert.equal(full.n,1);
  assert.equal(full.maxRetries,0);
  const [w,h]=full.size.split("x").map(Number);
  assert.equal(w%16,0);assert.equal(h%16,0);
  assert.ok(Math.abs(w/h-1600/900)<0.012,"request size stays close to source aspect ratio");
  const min=lib.buildPayload(v,imgs,true);
  assert.deepEqual(Object.keys(min).sort(),["maxRetries","model","n","prompt","providerOptions"]);
  assert.equal(min.size,undefined);
  assert.equal(min.providerOptions.openai.quality,"xhigh");
  assert.equal(min.providerOptions.openai.outputFormat,"jpeg");
  assert.equal(min.providerOptions.openai.outputCompression,90);
  assert.strictEqual(min.prompt.images,imgs,"minimal retry still sends every input image");
});

test("max quality remains set on a size-only fallback for a small source",()=>{
  const v=lib.validate({base:photo,baseW:680,baseH:453,refs:[ref1],prompt:"new angle",quality:"max"},UID);
  const imgs=[Uint8Array.from([1]),Uint8Array.from([2])];
  const normal=lib.buildPayload(v,imgs,false);
  const retry=lib.buildPayload(v,imgs,true);
  assert.equal(normal.size,"992x672");
  assert.equal(retry.size,undefined);
  assert.equal(normal.providerOptions.openai.quality,"max");
  assert.deepEqual(retry.providerOptions,normal.providerOptions,"never remove quality, format or compression");
  assert.strictEqual(retry.prompt.images,imgs);
  assert.match(html,/크기만 자동 선택으로 재시도했어요/);
  assert.ok(!html.includes("크기·품질 옵션 없이 만들어졌어요"));
});

test("source photos and extra references are downloaded as actual bytes",async()=>{
  const v=lib.validate({base:photo,baseW:1920,baseH:1080,refs:[ref1,ref2],prompt:"side view",quality:"high"},UID);
  const got=[];
  const fakeFetch=async function(url,options){
    got.push({url,signal:options.signal});
    return {
      ok:true,
      headers:{get:(key)=>key==="content-type"?"image/jpeg":key==="content-length"?"4":null},
      arrayBuffer:async()=>Uint8Array.from([255,216,255,217]).buffer
    };
  };
  const images=await lib.loadPromptImages(v,fakeFetch);
  assert.equal(images.length,3);
  assert.ok(images.every(x=>x instanceof Uint8Array));
  assert.ok(images.every(x=>x.byteLength===4));
  assert.deepEqual(got.map(x=>x.url),[
    lib.publicUrl(photo),lib.publicUrl(ref1),lib.publicUrl(ref2)
  ]);
  assert.ok(got.every(x=>x.signal instanceof AbortSignal));
  await assert.rejects(
    lib.loadPromptImages(v,async()=>({ok:false,status:404})),
    /storage_read_404/
  );
});

test("high-level generateImage receives all visual references through Vercel Gateway",async()=>{
  const v=lib.validate({base:photo,baseW:1600,baseH:900,refs:[ref1,ref2],prompt:"new camera position",quality:"high"},UID);
  const images=[Uint8Array.from([1]),Uint8Array.from([2]),Uint8Array.from([3])];
  let sent,usedToken;
  const fakeSDK={
    createGateway:({apiKey})=>{
      usedToken=apiKey;
      return {imageModel:(slug)=>({modelSlug:slug})};
    },
    generateImage:async options=>{
      sent=options;
      return {images:[{base64:"/9j/4AAQ",mediaType:"image/jpeg"}]};
    }
  };
  const response=await lib.generateWithReferences(v,images,"TEST_ONLY_OIDC",false,new AbortController().signal,fakeSDK);
  assert.equal(usedToken,"TEST_ONLY_OIDC");
  assert.equal(sent.model.modelSlug,"openai/gpt-image-2.5-sunburst");
  assert.strictEqual(sent.prompt.images,images);
  assert.equal(sent.prompt.text,"new camera position");
  assert.equal(sent.size,"1600x896");
  assert.equal(sent.providerOptions.openai.quality,"high");
  assert.equal(response.images[0].mediaType,"image/jpeg");
  const fallback=await lib.generateWithReferences(v,images,"TEST_ONLY_OIDC",true,new AbortController().signal,fakeSDK);
  assert.equal(sent.size,undefined,"size-only retry omits size");
  assert.equal(sent.providerOptions.openai.quality,"high","SDK still forwards chosen quality");
  assert.equal(sent.providerOptions.openai.outputFormat,"jpeg");
  assert.equal(sent.providerOptions.openai.outputCompression,90);
  assert.strictEqual(sent.prompt.images,images);
  assert.equal(fallback.images[0].mediaType,"image/jpeg");
  assert.match(html,/원본 사진 1장과 이 사진에 연결된 레퍼런스 사진/);
  assert.match(html,/AI에 실제 이미지 입력으로 전달/);
  assert.ok(!html.includes("AI 미전달"));
});

test("image response MIME sniffing remains available as SDK output fallback",()=>{
  assert.equal(lib.sniffMime("/9j/4AAQ"),"image/jpeg");
  assert.equal(lib.sniffMime("iVBORw0K"),"image/png");
  assert.equal(lib.sniffMime("UklGRiQ"),"image/webp");
});

test("retry only on size error, never silently removing max or format options",()=>{
  assert.equal(lib.looksLikeSizeError(400,"Invalid size '688x448'. Requested resolution is below the current minimum pixel budget."),true);
  assert.equal(lib.looksLikeSizeError(400,"Invalid size 1088x1920"),true);
  assert.equal(lib.looksLikeSizeError(422,"Requested resolution too small"),true);
  assert.equal(lib.looksLikeSizeError(400,"Invalid quality max"),false);
  assert.equal(lib.looksLikeSizeError(400,"Unknown parameter: output_compression"),false);
  assert.equal(lib.looksLikeSizeError(401,"unauthorized size"),false);
  assert.equal(lib.looksLikeSizeError(400,"Your request was rejected by the safety system"),false);
});

// ---------- 화면 ----------
function grab(sig){
  const start=html.indexOf("  function "+sig);
  assert.ok(start>0,sig+" exists");
  const end=html.indexOf("\n  }\n",start);
  return html.slice(start,end+5);
}

function grabVar(re,name){
  const m=html.match(re);
  assert.ok(m,name+" exists");
  return m[0];
}
function box(current){
  const sandbox={current, esc:(v)=>String(v??"")};
  vm.runInNewContext([
    grabVar(/  var EDIT = \{[\s\S]*?\n  \};\n/,"EDIT"),
    grabVar(/  var ELEM = \{[^\n]*\n/,"ELEM"),
    grabVar(/  var MENTION_RE=[^\n]*\n/,"MENTION_RE"),
    grab("srcId(p){"), grab("peekSpec(proj, pid){"), grab("specOf(proj, pid){"),
    grab("elemList(proj){"), grab("elemByName(proj, name){"), grab("elemPhotos(el){"),
    grab("mentionsOf(proj, pid, text, stage){"), grab("mentionedElements(proj, pid, text, stage){"),
    grab("replaceMentions(proj, pid, text, stage, map){"), grab("editRefPlan(proj, pid){"),
    grab("imagesLabel(from, to){"),
    grab("editHead(proj, refCount){"), grab("editPromptText(proj, pid){"),
    grab("editRequest(proj, pid){"), grab("editPending(proj){"),
  ].join("\n"),sandbox);
  return sandbox;
}

test("elements named in the prompt join the refs after the row's own; the API accepts element files",()=>{
  const b=box({});
  const E=(f)=>UID+"/pabc123/element/"+f+".jpg";
  const el=(name,slug,n)=>({key:"k"+slug,name,desc:name+" 설명",
    front:{id:E(slug+"0")},angles:Array.from({length:n-1},(_,i)=>({id:E(slug+(i+1))}))});
  const proj={photos:[{id:photo,w:1600,h:900}],
    elements:[el("아이","kid",2),el("강아지","dog",3),el("엄마","mom",2)],
    editSpecs:{[photo]:{prompt:"[원본] 침대 위에서 [아이]가 [강아지]를 안고 [레퍼런스2] 같은 조명",refs:[{id:ref1},{id:ref2}]}}};
  const r=b.editRequest(proj,photo);
  assert.deepEqual([...r.refs],[ref1,ref2,E("kid0"),E("kid1"),E("dog0"),E("dog1"),E("dog2")],
    "row refs → 아이 → 강아지; 엄마 is not named so it is not sent");
  assert.match(r.prompt,/Images 2-8 are additional visual references/);
  assert.match(r.prompt,/ Images 4-5 show "아이": 아이 설명\. Images 6-8 show "강아지": 강아지 설명\./);
  assert.match(r.prompt,/\n\nImage 1 침대 위에서 아이 \(Images 4-5\)가 강아지 \(Images 6-8\)를 안고 Image 3 같은 조명$/);
  assert.doesNotMatch(r.prompt,/엄마/);

  // 서버 쪽: 요소 사진 경로(element)는 레퍼런스로 받는다. 남의 폴더는 여전히 거절.
  const v=lib.validate({base:photo,refs:r.refs,prompt:"x"},UID);
  assert.equal(v.error,undefined);
  assert.equal(lib.validate({base:photo,refs:[OTHER+"/pabc123/element/x.jpg"],prompt:"x"},UID).error,"bad_ref");
  assert.equal(lib.validate({base:UID+"/pabc123/element/x.jpg",refs:[],prompt:"x"},UID).error,"bad_base","an element photo cannot be the base");

  // 15장 넘으면 화면이 보내기 전에 막는다(editOne 이 over 를 본다).
  proj.editSpecs[photo].refs=Array.from({length:12},(_,i)=>({id:UID+"/pabc123/ref/q"+i+".jpg"}));
  const plan=b.editRefPlan(proj,photo);
  assert.equal(plan.ids.length,17);
  assert.equal(plan.over,true);
  assert.match(html,/var plan=editRefPlan\(proj, photoId\);\n\s*if\(plan\.over\) throw new Error/);
});

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
  assert.match(a.prompt,/Image 1 shows the real location where the requested scene takes place/);
  assert.match(a.prompt,/Create a new photorealistic photograph/);
  assert.match(a.prompt,/Images 2-3 are additional visual references/);
  assert.match(a.prompt,/for relevant people, appearance, clothing, actions, props, lighting, atmosphere or photographic composition/);
  assert.match(a.prompt,/without changing their actual arrangement/);
  assert.match(a.prompt,/\n\n창밖을 노을로$/);
  assert.equal(a.quality,"high");

  const c=b.editRequest(proj,"p2");
  assert.deepEqual([...c.refs],[],"p2 gets none of p1's refs");
  assert.doesNotMatch(c.prompt,/Images 2-/, "no additional reference sentence without refs");
  assert.match(c.prompt,/\n\n침구를 흰색으로$/);

  assert.equal(b.editRequest(proj,"p3"),null,"blank prompt → nothing is sent");
  assert.deepEqual([...b.editPending(proj)],["p1","p2"],"bulk run skips blank prompts");

  proj.edits={p1:{id:"e1"}};
  assert.deepEqual([...b.editPending(proj)],["p2"],"bulk run skips photos that already have a result");
});

test("default prompt makes a new photo in the same real location without locking camera or pose",()=>{
  const b=box({});
  const one=b.editPromptText({editSpecs:{p:{prompt:"x",refs:[{id:"r"}]}}},"p");
  assert.match(one,/Image 1 shows the real location/);
  assert.match(one,/not as a fixed camera frame to repeat/);
  assert.match(one,/photograph as if someone physically present/);
  assert.match(one,/Image 2 is an additional visual reference/);
  assert.match(one,/Do not invent extra rooms, windows or built-in facilities/);
  assert.match(one,/original viewpoint is not a required default/);
  assert.match(one,/Follow the user's specific instructions for subject, action, expression, gaze and camera perspective/);
  assert.match(one,/When no pose is specified/);
  assert.match(one,/original width-to-height aspect ratio/);
  assert.doesNotMatch(one,/7-year-old|young girl|rolling on bed|parents' view|flower pose|chin resting/i,
    "single-case subject, activity, viewpoint and pose are not hard-coded");
  const off=b.editPromptText({editKeepReal:false,editSpecs:{p:{prompt:"x",refs:[]}}},"p");
  assert.doesNotMatch(off,/Do not invent extra rooms, windows or built-in facilities/);
  assert.match(off,/^Image 1 shows the real location/);
  assert.match(off,/original width-to-height aspect ratio/);
  assert.doesNotMatch(off,/Images 2-/);
  const offWithRefs=b.editPromptText({editKeepReal:false,editSpecs:{p:{prompt:"x",refs:[{id:"r"}]}}},"p");
  assert.match(offWithRefs,/Use the additional images as references for relevant people/);
  assert.doesNotMatch(offWithRefs,/Image 1 remains the reference for the actual accommodation layout/);
});

test("generic help shows the common prompt, not a fictional two-reference prompt",()=>{
  assert.match(html,/editHead\(current, 0\)/);
  assert.doesNotMatch(html,/editHead\(current,\s*2\)/);
  assert.match(html,/해당 사진에 레퍼런스가 있으면 Image 2~N 설명 문장이 자동 추가돼요/);
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
  assert.equal(lib.sizeForAspect(680,453),"992x672");
  assert.equal(lib.sizeForAspect(453,680),"672x992");
  assert.equal(lib.sizeForAspect(400,400),"816x816");
  assert.equal(lib.sizeForAspect(1600,900),"1600x896");
  assert.equal(lib.sizeForAspect(900,1600),"896x1600");
  assert.equal(lib.sizeForAspect(1920,1920),"1920x1920");
  assert.equal(lib.sizeForAspect(5000,3000),"1920x1152");
  assert.equal(lib.sizeForAspect(0,0),null);
  for(const [w,h] of [[680,453],[453,680],[400,400],[1600,900],[900,1600],[5000,3000],[1888,629],[6000,100],[100,6000]]){
    const [a,b]=lib.sizeForAspect(w,h).split("x").map(Number);
    assert.equal(a%16,0);assert.equal(b%16,0);
    assert.ok(a*b>=lib.MIN_PIXELS,"Sunburst minimum pixel budget");
    assert.ok(Math.max(a,b)/Math.min(a,b)<=3.00001,"Sunburst aspect constraint");
    assert.ok(Math.max(a,b)<=lib.MAX_EDGE,"max edge budget");
  }
  const input=lib.validate({base:photo,baseW:900,baseH:1600,refs:[],prompt:"x"},UID);
  assert.equal(input.baseW,900);
  assert.equal(input.baseH,1600);
  assert.equal(lib.buildPayload(input,[Uint8Array.from([1])],false).size,"896x1600");
});

test("stage nine no longer forces portrait aspect or fixes output at 1080x1920",()=>{
  assert.ok(html.includes("원본 사진 1장과 이 사진에 연결된 레퍼런스 사진"));
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
  assert.ok(html.includes("coverCanvas=await makeSelectedCoverCanvas(current)"),
    "cover now takes the user's selected frame from the whole ⑪ timeline, including valid Kling MP4 cuts");
  assert.ok(html.includes("g.drawImage(coverCanvas,0,0,VIDEO.w,VIDEO.h)"),
    "the precomposed title/overlay cover becomes the actual beginning of the rendered MP4");
  assert.ok(!/loadImg\(blobUrl\(photos\[/.test(html),"no renderer reads the raw photo");
});
