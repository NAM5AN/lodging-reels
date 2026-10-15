"use strict";
// ⑪ 분홍(마젠타) 화면 사전 차단 — 영상 제작·요금이 드는 외부 API 호출 없이 모의 검증
const {test}=require("node:test"),assert=require("node:assert/strict"),
  fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
const VID={w:1080,h:1920,subY:520,fps:30,coverHold:0.5};
const P=n=>"u/p/photo/p"+n+".jpg",E=n=>"u/p/edited/e"+n+".jpg",V=n=>"u/p/video/v"+n+".mp4";
function grab(sig){
  const begin=html.indexOf("  function "+sig)>=0?html.indexOf("  function "+sig):html.indexOf("  async function "+sig);
  assert.ok(begin>=0,"missing "+sig);
  const end=html.indexOf("\n  }\n",begin);
  assert.ok(end>begin,"closing brace "+sig);
  return html.slice(begin,end+5);
}
function harness(extra={}){
  const ctx=vm.createContext(Object.assign({
    VIDEO:VID,TL:{tracks:2,zoom:0.18},Math,Number,
    timelineReady:()=>true,
    esc:x=>String(x??"").replace(/&/g,"&amp;").replace(/</g,"&lt;"),
    trackRow:()=>"",stroked:()=>{},fitSize:()=>60,canvasFontFamily:()=>"'sans-serif'",
    fontsReady:{},current:null
  },extra));
  const fns=[
    "renderClipForPhoto(proj, photo){",
    "thumbClock(time){","thumbnailDuration(proj){","thumbnailLastFrame(proj){","thumbnailSelectedTime(proj){",
    "tlVoiceEnd(proj){","tlSegments(proj){","tlSegmentAt(segs, rel){","tlPhotoIndexes(proj){",
    "tlFromMap(proj){","tlHash(s){","tlSyncKey(proj){","tlSaved(proj){","tlOf(proj){",
    "tlClone(tl){","tlSource(proj, b){","tlBlockAt(tl, rel){","tlFramePlan(proj, tl, time, segs){",
    "videoOutputGaps(proj, voiceEnd, durations){","videoGapMessage(gaps){",
    "videoRenderGuard(proj,voiceEnd,durations){","videoSection(){",
    "drawFill(g,im,zoom,cx,cy){","drawCutText(g,text){","drawMagentaCut(g,text){",
    "drawClipCut(g,video,text,elapsed,duration){","tlDrawLive(g, plan, text, media, live){"
  ];
  vm.runInContext(fns.map(grab).join("\n"),ctx);
  return ctx;
}
function project(){
  return {
    id:"p",photos:[{id:P(1)},{id:P(2)},{id:P(3)}],
    edits:{[P(1)]:{id:E(1)},[P(2)]:{id:E(2)}},
    clips:{[P(1)]:{id:V(1),dur:3,fromEdit:E(1)}},
    cutTimeline:[{start:0,end:1.2},{start:1.2,end:2.5},{start:2.5,end:4},
      {start:4,end:5.5},{start:5.5,end:7}],
    cutTimelineFor:"1\n2\n3\n4\n5",cutTimelineAudioId:"u/p/speech/t1.wav",
    ttsDuration:7,map:[0,0,0,1,2],
    script:"1\n2\n3\n4\n5"
  };
}
const blk=(id,kind,n,at,len,inn=0)=>({id,kind,pid:n===0?"missing-file":P(n),at,len,in:inn});
const simple=p=>JSON.parse(JSON.stringify(p));
const gaps=(ctx,proj,voice,durations)=>simple(ctx.videoOutputGaps(proj,voice,durations));

test("ordinary ⑩ mapping blocks export when a Kling video is 1s shorter than the assigned cuts",()=>{
  const h=harness(),p=project(),g=gaps(h,p);
  assert.deepEqual(g,[{start:3,end:4}]);
  const message=h.videoGapMessage(g);
  assert.match(message,/영상 제작 불가/);
  assert.match(message,/분홍색 빈 화면 1구간/);
  assert.match(message,/0:03\.50–0:04\.50/,"times include the half-second cover");
  assert.equal(h.videoRenderGuard(p).ok,false);
});

test("stale or deleted video falls back to the original/edited photo, not magenta",()=>{
  const h=harness(),p=project();
  p.edits[P(1)]={id:"new-edited-file"};
  assert.deepEqual(gaps(h,p),[]);
  delete p.edits[P(1)];
  assert.deepEqual(gaps(h,p),[],"original photo can be used when the old Kling video becomes stale");
});

test("actual decoded Kling video duration can fill a declared-short gap",()=>{
  const h=harness(),p=project();
  assert.deepEqual(gaps(h,p).map(x=>[x.start,x.end]),[[3,4]]);
  assert.deepEqual(gaps(h,p,7,{[V(1)]:4.2}),[],"final check trusts actual decoded metadata, not requested duration");
});

test("actual decoded duration SHORTER than requested detects a gap missed by metadata",()=>{
  const h=harness(),p=project();
  p.clips[P(1)].dur=4;
  assert.deepEqual(gaps(h,p),[],"planned run appears fully covered");
  assert.deepEqual(gaps(h,p,7,{[V(1)]:3.3}),[{start:3.3,end:4}]);
});

test("V2 photo fills the short Kling clip's remaining gap and allows export",()=>{
  const h=harness(),p=project();
  p.timeline={v:1,sync:h.tlSyncKey(p),tracks:[
    [blk("video","clip",1,0,3),blk("next","photo",2,4,1.5),blk("last","photo",3,5.5,1.5)],
    [blk("patch","photo",3,3,1)]
  ]};
  assert.deepEqual(gaps(h,p),[]);
  assert.equal(h.videoRenderGuard(p).ok,true);
  assert.equal(h.videoRenderGuard(p).message,"");
});

test("a real small 20ms hole is detected, not hidden by video-frame sampling",()=>{
  const h=harness(),p=project();
  p.clips={};
  p.timeline={v:1,sync:h.tlSyncKey(p),tracks:[[blk("a","photo",1,0,2.01),blk("b","photo",2,2.03,4.97)],[]]};
  const g=gaps(h,p);
  assert.equal(g.length,1);
  assert.ok(Math.abs(g[0].start-2.01)<1e-8);
  assert.ok(Math.abs(g[0].end-2.03)<1e-8);
});

test("one missing V2 source masks V1 in the actual renderer and is reported as unsafe",()=>{
  const h=harness(),p=project();
  p.clips={};
  p.timeline={v:1,sync:h.tlSyncKey(p),tracks:[
    [blk("background","photo",1,0,7)],
    [blk("invalid-top","photo",0,2,1)]
  ]};
  assert.deepEqual(gaps(h,p),[{start:2,end:3}],"validation honors V2 being above V1");
  p.timeline.tracks[1][0].pid=P(3);
  assert.deepEqual(gaps(h,p),[]);
});

test("trimming the first 1.8s of a 3s video makes the remaining 0.8s a blocked magenta hole",()=>{
  const h=harness(),p=project();
  p.timeline={v:1,sync:h.tlSyncKey(p),tracks:[
    [blk("trim","clip",1,0,2,1.8),blk("photo","photo",2,2,5)],[]
  ]};
  assert.deepEqual(gaps(h,p),[{start:1.2,end:2}]);
});

test("an actual video of shorter duration after edit causes a hole even when saved len fits",()=>{
  const h=harness(),p=project();
  p.timeline={v:1,sync:h.tlSyncKey(p),tracks:[
    [blk("trim","clip",1,0,2.5,0.5),blk("photo","photo",2,2.5,4.5)],[]
  ]};
  assert.deepEqual(gaps(h,p),[],"declared 3s source: 0.5+2.5 fits exactly");
  assert.deepEqual(gaps(h,p,7,{[V(1)]:2.8}),[{start:2.3,end:2.5}]);
});

test("V2 can cover the end of an overlong V1 clip without leaving a visible magenta area",()=>{
  const h=harness(),p=project();
  p.timeline={v:1,sync:h.tlSyncKey(p),tracks:[
    [blk("v1","clip",1,0,5),blk("after","photo",2,5,2)],
    [blk("v2","photo",3,2.7,2.3)]
  ]};
  assert.deepEqual(gaps(h,p),[],"V2 hides every moment that extends beyond the 3s Kling source");
});

test("saved timeline must cover the entire ACTUAL processed voice duration",()=>{
  const h=harness(),p=project();
  p.clips={};
  p.timeline={v:1,sync:h.tlSyncKey(p),tracks:[[blk("photo","photo",2,0,7)],[]]};
  assert.deepEqual(gaps(h,p),[]);
  assert.deepEqual(gaps(h,p,7.25),[{start:7,end:7.25}],"post-audio guard catches an unexpected speech tail");
});

test("stale saved timeline correctly returns to ⑩ default layout for gap detection",()=>{
  const h=harness(),p=project();
  p.timeline={v:1,sync:"out-of-date voice",tracks:[[blk("photo","photo",2,0,7)],[]]};
  assert.deepEqual(gaps(h,p),[{start:3,end:4}],"stale edits may not bypass the preflight");
});

test("overlapping gaps merge into readable ranges and list only the first four",()=>{
  const h=harness(),p=project();
  p.clips={};
  p.timeline={v:1,sync:h.tlSyncKey(p),tracks:[[],[]]};
  assert.deepEqual(gaps(h,p),[{start:0,end:7}]);
  assert.match(h.videoGapMessage(gaps(h,p)),/0:00\.50–0:07\.50/);
});

test("⑪ button is disabled with a persistent status explaining how to fix the gap",()=>{
  const p=project(),h=harness({current:p});
  const html=h.videoSection();
  assert.match(html,/id="mkvideo"[^>]* disabled title=/);
  assert.match(html,/id="renderstat"[^>]*>영상 제작 불가:/);
  assert.match(html,/⑩ 편집모드에서 사진·영상 블록/);
  p.edits[P(1)]={id:"new-edit"};
  const updated=h.videoSection();
  assert.doesNotMatch(updated,/id="mkvideo"[^>]* disabled/);
  assert.doesNotMatch(updated,/영상 제작 불가:/);
});

test("⑪ makeVideo checks gaps before loading any media and rechecks actual media before MediaRecorder",()=>{
  const render=grab("makeVideo(){");
  const first=render.indexOf("var gate=videoRenderGuard(current);");
  const fonts=render.indexOf("document.fonts.load");
  const actual=render.indexOf("gate=videoRenderGuard(current,actualVoiceSeconds,actualClipDurations)");
  const recorder=render.indexOf("rec.start();");
  assert.ok(first>0&&first<fonts,"preflight must run before any expensive media load");
  assert.ok(actual>fonts&&actual<recorder,"second pass must run before recording");
  assert.match(render,/actualClipDurations\[fp\]=tv\.duration/);
  assert.match(render,/actualClipDurations\[clip\.id\]=video\.duration/);
  assert.match(render,/tlDrawLive\(g, tp,[\s\S]*tlLive, true\)/);
  assert.match(render,/drawClipCut\(g,clip\.video,cuts\[idx\]\|\|"",elapsed,clip\.duration,true\)/);
  assert.doesNotMatch(render,/api\(FN\.clip/,"video export never creates a new paid Kling video");
});

test("video decoder delay and end of source ABORTS ⑪ recording, while ⑩ preview may still show magenta",()=>{
  const h=harness(),events=[],g={fillStyle:"",drawImage:()=>events.push("image"),
    fillRect:()=>events.push("magenta")};
  const video={videoWidth:1080,videoHeight:1920,duration:4,readyState:1,seeking:true,ended:false};
  h.drawClipCut(g,video,"",0.2,4);
  assert.deepEqual(events,["magenta"],"previews remain informative");
  events.length=0;
  assert.throws(()=>h.drawClipCut(g,video,"",0.2,4,true),/분홍 화면/);
  assert.deepEqual(events,[],"strict rendering never paints a magenta frame");
  video.readyState=4;video.seeking=false;
  assert.throws(()=>h.drawClipCut(g,video,"",4,4,true),/분홍 화면/);
  assert.deepEqual(events,[]);
});

test("edited timeline magenta or unloaded media similarly aborts recording",()=>{
  const h=harness(),events=[],g={fillStyle:"",drawImage:()=>events.push("image"),
    fillRect:()=>events.push("magenta")},live={video:null,key:"",drift:0.45};
  const plan={kind:"magenta",seg:0};
  h.tlDrawLive(g,plan,"",null,live);
  assert.deepEqual(events,["magenta"]);
  events.length=0;
  assert.throws(()=>h.tlDrawLive(g,plan,"",null,live,true),/빈 화면/);
  assert.deepEqual(events,[]);
  assert.throws(()=>h.tlDrawLive(g,{kind:"video",block:{id:"b"},track:0,elapsed:0.2,seg:1},"",null,live,true),/빈 화면/);
});

test("existing editor controls and video format remain unchanged",()=>{
  const edit=grab("edOpen(){"),render=grab("makeVideo(){");
  assert.match(edit,/edRenderTimeline/);
  assert.match(render,/var mime=pickMime\(\)/);
  assert.match(render,/new MediaRecorder/);
  assert.match(html,/function makeSelectedCoverCanvas\(/);
  for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
});
