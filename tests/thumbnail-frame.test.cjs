"use strict";
// ⑪ 썸네일: 전체 릴스 타임라인에서 자막 없는 단일 프레임 선택, 영상/사진/마젠타 검증.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");

function grab(sig){
  let from=html.indexOf("  function "+sig);
  if(from<0)from=html.indexOf("  async function "+sig);
  assert.ok(from>0,sig+" exists");
  const end=html.indexOf("\n  }\n",from);
  assert.ok(end>from,sig+" ends");
  return html.slice(from,end+5);
}
const sigs=[
  "renderClipForPhoto(proj, photo){",
  "thumbnailDuration(proj){","thumbnailLastFrame(proj){",
  "thumbnailSelectedTime(proj){","thumbClock(time){",
  "thumbnailFramePlan(proj, time){",
  "drawFill(g,im,zoom,cx,cy){","drawCutText(g,text){",
  "drawMagentaCut(g,text){","drawThumbnailFrame(g, plan, media){",
  "wrapText(t,max){","drawCoverOverlay(g,lines){",
  "drawSelectedCover(g,plan,media,proj){"
];
function harness(){
  const calls=[];
  const ctx=vm.createContext({
    VIDEO:{w:1080,h:1920,fps:30,coverHold:0.5,subY:496},
    Math,Number,
    fitSize:()=>72, canvasFontFamily:()=>"'sans-serif'",
    stroked:(_g,text)=>calls.push({type:"text",text})
  });
  vm.runInContext(sigs.map(grab).join("\n"),ctx);
  const g={
    fillStyle:"",
    drawImage(...args){calls.push({type:"image",source:args[0],rect:args.slice(1)})},
    fillRect(...args){calls.push({type:"fill",color:this.fillStyle,rect:args})}
  };
  return {ctx,calls,g};
}
function project(){
  return {
    id:"proj",coverPhoto:1,ttsDuration:4,
    photos:[{id:"p0"},{id:"p1"}],
    edits:{p0:{id:"edited0"},p1:{id:"edited1"}},
    clips:{p0:{id:"clip0.mp4",fromEdit:"edited0",dur:2}},
    map:[0,0,1,0,0],
    cutTimeline:[
      {start:0,end:0.8},
      {start:0.8,end:1.6},
      {start:1.6,end:2.4},
      {start:2.4,end:3.2},
      {start:3.2,end:4}
    ]
  };
}

test("selector covers the whole voice-aligned ⑪ reel including 0.5s cover, not a single raw clip",()=>{
  const {ctx}=harness(),p=project();
  assert.equal(ctx.thumbnailDuration(p),4.5);
  assert.ok(Math.abs(ctx.thumbnailLastFrame(p)-(4.5-1/30))<1e-9);
  assert.equal(ctx.thumbnailSelectedTime(p),0,"legacy projects keep their old cover until a new frame is selected");
  p.thumbTime=5.73;
  assert.equal(ctx.thumbnailSelectedTime(p),4.5-1/30,"saved selection must be clamped to timeline length");
  p.thumbTime=0;
  assert.equal(ctx.thumbnailSelectedTime(p),0,"zero is a real manual choice");
  p.thumbTime=999;
  assert.ok(ctx.thumbnailSelectedTime(p)<4.5,"max is the last frame");
  assert.equal(ctx.thumbClock(61.25),"1:01.25");
});

test("cover selection is the chosen cover PHOTO with no text or overlay",()=>{
  const {ctx,g,calls}=harness(),p=project();
  const plan=ctx.thumbnailFramePlan(p,0.1);
  assert.equal(plan.kind,"image");
  assert.equal(plan.cover,true);
  assert.equal(plan.photoIndex,1);
  assert.equal(plan.path,"edited1");
  const img={width:720,height:1280};
  ctx.drawThumbnailFrame(g,plan,img);
  assert.deepEqual(calls.map(x=>x.type),["image"],"no subtitles, dark overlay or cover title");
  assert.equal(calls[0].source,img);
});

test("saved video is preferred and consecutive captions share elapsed time; separated reuse restarts",()=>{
  const {ctx}=harness(),p=project();
  const first=ctx.thumbnailFramePlan(p,0.5+0.3);
  const second=ctx.thumbnailFramePlan(p,0.5+1.3);
  const another=ctx.thumbnailFramePlan(p,0.5+2.7);
  assert.equal(first.kind,"video");
  assert.equal(first.path,"clip0.mp4");
  assert.ok(Math.abs(first.elapsed-0.3)<1e-9);
  assert.ok(Math.abs(second.elapsed-1.3)<1e-9,
    "second caption must not restart the same movie");
  assert.ok(Math.abs(another.elapsed-0.3)<1e-9,
    "a video shown again after another photo starts a new run");
});

test("ordinary image shots use the SAME progressive Ken Burns zoom as ⑪ footage",()=>{
  const {ctx}=harness(),p=project();
  const plan=ctx.thumbnailFramePlan(p,0.5+2);
  assert.equal(plan.kind,"image");
  assert.equal(plan.photoIndex,1);
  assert.equal(plan.path,"edited1");
  assert.ok(plan.zoom>1 && plan.zoom<=1.18);
  delete p.clips.p0;
  const fallback=ctx.thumbnailFramePlan(p,0.5+0.3);
  assert.equal(fallback.kind,"image");
  assert.equal(fallback.path,"edited0");
});

test("stale Kling clip cannot be used for a thumbnail or final video",()=>{
  const {ctx}=harness(),p=project();
  p.edits.p0={id:"edited-new"};
  const plan=ctx.thumbnailFramePlan(p,0.5+0.3);
  assert.equal(plan.kind,"image");
  assert.equal(plan.path,"edited-new");
  assert.equal(ctx.renderClipForPhoto(p,p.photos[0]),null);
});

test("short clip becomes pure #FF00FF after duration, with NO subtitles or still-frame substitution",()=>{
  const {ctx,g,calls}=harness(),p=project();
  const plan=ctx.thumbnailFramePlan(p,0.5+1.4);
  assert.equal(plan.kind,"video");
  const video={videoWidth:1080,videoHeight:1920,duration:1.2,readyState:4,seeking:false,ended:false};
  assert.equal(ctx.drawThumbnailFrame(g,plan,video),"마젠타");
  assert.deepEqual(calls.map(x=>x.type),["fill"]);
  assert.equal(calls[0].color,"#FF00FF");
  assert.deepEqual(calls[0].rect,[0,0,1080,1920]);
});

test("a valid video frame is drawn from the muted Kling video with no caption overlay",()=>{
  const {ctx,g,calls}=harness(),p=project();
  const plan=ctx.thumbnailFramePlan(p,0.5+0.25);
  const video={videoWidth:1080,videoHeight:1920,duration:2,readyState:4,seeking:false,ended:false};
  assert.equal(ctx.drawThumbnailFrame(g,plan,video),"Kling 영상");
  assert.deepEqual(calls.map(x=>x.type),["image"]);
  assert.equal(calls[0].source,video);
});

test("seekClipFrame is a pause-and-seek operation, not an audio or paid Kling request",async()=>{
  const ctx=vm.createContext({VIDEO:{fps:30},Math,Number,setTimeout,clearTimeout,Promise,Error});
  vm.runInContext(grab("seekClipFrame(video, time){"),ctx);
  const events={};
  let position=0,pauses=0;
  const video={
    duration:5,readyState:4,seeking:false,
    get currentTime(){return position;},
    set currentTime(v){position=v;},
    pause(){pauses++;},
    addEventListener(n,fn){events[n]=fn;},
    removeEventListener(n,fn){if(events[n]===fn)delete events[n];}
  };
  await ctx.seekClipFrame(video,2.1);
  assert.equal(position,2.1);
  assert.equal(pauses,1);
  assert.deepEqual(Object.keys(events),[],"listeners cleaned up");
});

test("slider, timestamp and selected frame survive project saves; export is caption-free JPG",()=>{
  const videoUI=grab("videoSection(){"),events=grab("renderEdit(p){");
  const thumbSave=grab("makeThumb(){");
  const thumbRender=grab("requestThumbnailFrame(proj, time){");
  assert.match(videoUI,/id="thumbtime"/);
  assert.match(videoUI,/type="range"/);
  assert.match(videoUI,/thumbnailDuration\(current\)/);
  assert.match(videoUI,/thumbnailSelectedTime\(current\)/);
  assert.match(videoUI,/id="thumbframe"/);
  assert.match(videoUI,/id="savethumb"/);
  assert.match(events,/thumbProj\.thumbTime=seconds/);
  assert.match(events,/autosave\(\)/);
  assert.match(events,/requestThumbnailFrame\(thumbProj,seconds\)/);
  assert.match(thumbSave,/requestThumbnailFrame\(proj,time\)/);
  assert.match(thumbSave,/canvas\.toBlob\(resolve,"image\/jpeg",0\.95\)/);
  assert.match(thumbSave,/download[s]\.save/);
  assert.match(thumbRender,/drawSelectedCover\(g,plan,media,proj\)/);
  assert.doesNotMatch(thumbSave,/drawCover\(|drawCutText\(/,"save doesn't add cover title or subtitles");
  assert.match(videoUI,/검은 반투명 배경과 커버 타이틀은 미리보기·저장 JPG·완성 영상 첫 커버에 똑같이 적용돼요/);
  assert.doesNotMatch(videoUI,/id="mkthumb"/,"old fixed-cover thumbnail button removed");
});

test("full ⑪ video rendering remains independent of thumbnail time and does not call Kling",()=>{
  const main=grab("makeVideo(){");
  assert.match(main,/var renderMap=ensureMap/);
  assert.match(main,/drawClipCut\(g,clip\.video/);
  assert.match(main,/coverCanvas=await makeSelectedCoverCanvas\(current\)/);
  assert.match(main,/g\.drawImage\(coverCanvas,0,0,VIDEO\.w,VIDEO\.h\)/);
  assert.match(main,/drawCut\(g,imgs\[pi\]/);
  assert.doesNotMatch(main,/FN\.clip/,"no new paid API calls during render");
  assert.ok(!main.includes("drawCover(g,coverImg"),"outdated static cover must not be used");
});


test("chosen frame receives identical 40% dark overlay and cover title in thumbnail preview",()=>{
  const {ctx,g,calls}=harness(),p=project();
  p.cover="5성급 호텔은\n특별한 여행을";
  p.thumbTime=2.5;
  const plan=ctx.thumbnailFramePlan(p,p.thumbTime);
  const image={width:1080,height:1920};
  assert.equal(plan.kind,"image","image scene at 2.5s");
  ctx.drawSelectedCover(g,plan,image,p);
  assert.deepEqual(calls.map(x=>x.type),["image","fill","text","text"]);
  assert.equal(calls[1].color,"rgba(0,0,0,0.40)");
  assert.equal(calls[2].text,"5성급 호텔은");
  assert.equal(calls[3].text,"특별한 여행을");
  assert.ok(!calls.some(x=>x.text==="자막"),"normal video captions cannot leak into cover");
});

test("chosen Kling timestamp is captured as the MP4 cover, then its decoded frame is released",async()=>{
  const calls=[],video={duration:7,videoWidth:1080,videoHeight:1920};
  const canv={width:0,height:0,getContext:()=>({tag:"canvas-context"})};
  const ctx=vm.createContext({
    VIDEO:{w:1080,h:1920},
    document:{createElement(tag){assert.equal(tag,"canvas");return canv;}},
    thumbnailSelectedTime:()=>5.73,
    thumbnailFramePlan:(proj,time)=>{
      calls.push({task:"plan",time});
      return {kind:"video",path:"user/proj/video/kling.mp4",elapsed:2.73};
    },
    loadClipVideo:async()=>{calls.push({task:"load"});return video;},
    blobUrl:(path)=>{calls.push({task:"url",path});return "https://example.test/kling.mp4";},
    seekClipFrame:async(v,t)=>{assert.strictEqual(v,video);calls.push({task:"seek",time:t});},
    drawSelectedCover:(g,plan,m,p)=>{
      assert.deepEqual(g,{tag:"canvas-context"});
      calls.push({task:"compose"});
    },
    releaseClipVideos:(list)=>{assert.strictEqual(list[0].video,video);calls.push({task:"release"});}
  });
  vm.runInContext(grab("makeSelectedCoverCanvas(proj){"),ctx);
  const result=await ctx.makeSelectedCoverCanvas({});
  assert.strictEqual(result,canv);
  assert.equal(result.width,1080);
  assert.equal(result.height,1920);
  assert.deepEqual(calls.map(x=>x.task),["plan","url","load","seek","compose","release"]);
  assert.equal(calls[0].time,5.73);
  assert.equal(calls[3].time,2.73);
});

test("cover image and video intro use same composed canvas while later cuts keep original subtitles",()=>{
  const shared=grab("drawCoverOverlay(g,lines){");
  const cover=grab("drawCover(g,im,lines){");
  const compose=grab("drawSelectedCover(g,plan,media,proj){");
  const snapshot=grab("makeSelectedCoverCanvas(proj){");
  const preview=grab("requestThumbnailFrame(proj, time){");
  const reel=grab("makeVideo(){");
  assert.match(shared,/rgba\(0,0,0,0\.40\)/);
  assert.match(cover,/drawCoverOverlay\(g,lines\)/);
  assert.match(compose,/drawCoverOverlay\(g,cover\)/);
  assert.match(snapshot,/drawSelectedCover\(canvas\.getContext\("2d"\),plan,media,proj\)/);
  assert.match(preview,/drawSelectedCover\(g,plan,media,proj\)/);
  assert.match(reel,/coverCanvas=await makeSelectedCoverCanvas\(current\)/);
  assert.match(reel,/g\.drawImage\(coverCanvas,0,0,VIDEO\.w,VIDEO\.h\)/);
  assert.match(reel,/drawCut\(g,imgs\[pi\],cuts\[idx\]\|\|"",k\)/);
  assert.match(reel,/drawClipCut\(g,clip\.video,cuts\[idx\]\|\|"",elapsed,clip\.duration,true\)/,
    "⑪ renderer aborts instead of drawing a temporary magenta video frame");
});
