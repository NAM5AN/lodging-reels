"use strict";
// ⑪ final reel: prefer saved Kling MP4 per photo, never loop it, render overrun magenta.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
function grab(sig){
  let start=html.indexOf("  function "+sig);
  if(start<0) start=html.indexOf("  async function "+sig);
  assert.ok(start>0,sig+" exists");
  const end=html.indexOf("\n  }\n",start);
  assert.ok(end>start,sig+" closing brace exists");
  return html.slice(start,end+5);
}
const renderFunctions=[
  "drawFill(g,im,zoom,cx,cy){",
  "drawCutText(g,text){",
  "drawMagentaCut(g,text){",
  "clipElapsedInRun(windows,runFrom,index,rel){",
  "drawClipCut(g,video,text,elapsed,duration){",
  "renderClipForPhoto(proj, photo){"
].map(grab).join("\n");
function sandbox(){
  const calls=[];
  const box={
    VIDEO:{w:1080,h:1920,subY:496},Math,Number,
    fitSize:()=>72,canvasFontFamily:()=>"'Example'",
    stroked:(_g,text)=>calls.push({kind:"text",text})
  };
  vm.runInNewContext(renderFunctions,box);
  const g={
    fillStyle:"",
    drawImage(...args){calls.push({kind:"image",source:args[0],size:args.slice(1)})},
    fillRect(...args){calls.push({kind:"fill",color:this.fillStyle,args})}
  };
  return {box,g,calls};
}

test("a completed MP4 is selected only while its source edit is still current",()=>{
  const {box}=sandbox();
  const p={id:"photo1"};
  const clip={id:"u/p/video/file.mp4",fromEdit:"edit1",dur:5};
  const proj={edits:{photo1:{id:"edit1"}},clips:{photo1:clip}};
  assert.strictEqual(box.renderClipForPhoto(proj,p),clip);
  proj.edits.photo1={id:"edit2"};
  assert.equal(box.renderClipForPhoto(proj,p),null,"stale clip is rejected");
  delete proj.edits.photo1;
  assert.equal(box.renderClipForPhoto(proj,p),null,"deleted edit rejects clip");
  proj.edits.photo1={id:"edit1"};
  delete proj.clips.photo1;
  assert.equal(box.renderClipForPhoto(proj,p),null,"missing clip uses image");
  assert.equal(box.renderClipForPhoto(null,p),null);
});

test("adjacent captions share clip time, separated runs restart their own clip window",()=>{
  const {box}=sandbox();
  const windows=[
    {start:0,end:0.9},
    {start:0.9,end:1.8},
    {start:1.8,end:2.6},
    {start:2.6,end:3.6},
    {start:3.6,end:4.6}
  ];
  // Photos are [A,A,B,A,A]; replaying A after B is a new run.
  const runFrom=[0,0,2,3,3];
  assert.equal(box.clipElapsedInRun(windows,runFrom,0,0.4),0.4);
  assert.equal(box.clipElapsedInRun(windows,runFrom,1,1.3),1.3);
  assert.equal(box.clipElapsedInRun(windows,runFrom,2,2.2),0.40000000000000013);
  assert.ok(Math.abs(box.clipElapsedInRun(windows,runFrom,3,2.9)-0.3)<1e-9);
  assert.ok(Math.abs(box.clipElapsedInRun(windows,runFrom,4,4.3)-1.7)<1e-9);
});

test("video within its duration is drawn as a full-canvas frame with subtitles",()=>{
  const {box,g,calls}=sandbox();
  const video={videoWidth:1080,videoHeight:1920,width:0,height:0,readyState:4,seeking:false,ended:false};
  box.drawClipCut(g,video,"자막 테스트",4.9,5);
  assert.deepEqual(calls.map(e=>e.kind),["image","text"]);
  assert.strictEqual(calls[0].source,video);
  assert.equal(calls[1].text,"자막 테스트");
});

test("video duration shortage paints pure magenta and still draws subtitles; never freezes last frame",()=>{
  const {box,g,calls}=sandbox();
  const video={videoWidth:1080,videoHeight:1920,readyState:4,seeking:false,ended:false};
  box.drawClipCut(g,video,"남는 구간 자막",5,5);
  assert.deepEqual(calls.map(e=>e.kind),["fill","text"]);
  assert.equal(calls[0].color,"#FF00FF");
  assert.deepEqual([...calls[0].args],[0,0,1080,1920]);
  assert.equal(calls[1].text,"남는 구간 자막");
  calls.length=0;
  box.drawClipCut(g,video,"",12,5);
  assert.deepEqual(calls.map(e=>e.kind),["fill"],"empty caption has solid magenta");
});

test("ended or not-yet-decodable clip never silently substitutes the edited photo",()=>{
  const {box,g,calls}=sandbox();
  const video={videoWidth:1080,videoHeight:1920,readyState:4,seeking:false,ended:true};
  box.drawClipCut(g,video,"a",0.8,5);
  assert.equal(calls[0].kind,"fill");
  calls.length=0;
  video.ended=false;video.readyState=1;
  box.drawClipCut(g,video,"b",0.8,5);
  assert.equal(calls[0].kind,"fill");
  assert.equal(calls[0].color,"#FF00FF");
});

test("Kling inputs are silent and not set to loop; source plays are reset only on new runs",()=>{
  const loader=grab("loadClipVideo(url){");
  const render=grab("makeVideo(){");
  assert.match(loader,/video\.muted=true/);
  assert.match(loader,/video\.loop=false/);
  assert.match(loader,/video\.crossOrigin="anonymous"/);
  assert.match(render,/renderClipForPhoto\(current,photos\[i\]\)/);
  assert.match(render,/activeVideo!==clip\.video \|\| activeRun!==runFrom\[idx\]/);
  assert.match(render,/clipElapsedInRun\(windows,runFrom,idx,rel\)/);
  assert.match(render,/elapsed>=clip\.duration/);
  assert.match(render,/drawClipCut\(g,clip\.video/);
  assert.match(render,/drawCut\(g,imgs\[pi\]/);
  assert.match(render,/g\.drawImage\(coverCanvas,0,0,VIDEO\.w,VIDEO\.h\)/);
  assert.match(render,/coverCanvas=await makeSelectedCoverCanvas\(current\)/);
  assert.doesNotMatch(render,/api\(FN\.clip/,"final render never starts new paid Kling jobs");
});

test("⑩ photo mapping is unchanged and ⑪ tells the user about the magenta overrun",()=>{
  assert.match(html,/var mp=renderMap/);
  assert.match(html,/renderMap=ensureMap\(\)/);
  assert.match(html,/⑨ Kling 영상이 있으면 MP4를 우선 사용/);
  assert.match(html,/클립 길이가 부족한 부분은 반복 없이 마젠타\(#FF00FF\) 단색/);
  assert.match(html,/useClip\?'🎬 영상':'사진'/);
});
