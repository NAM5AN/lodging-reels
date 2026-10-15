"use strict";
// ⑩ 편집모드 2단계 — 블록 옮기기·넣기·지우기·V1↔V2·되돌리기, 저장한 타임라인을 ⑪ 렌더·썸네일이 따르는지.
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const {test}=require("node:test");

const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
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
function plain(v){ return JSON.parse(JSON.stringify(v)); }
// 소수 오차를 없앤 비교용(ms 단위)
function ms(v){ return JSON.parse(JSON.stringify(v,(k,x)=>typeof x==="number" ? Math.round(x*1000)/1000 : x)); }
const TLF=[
  "renderClipForPhoto(proj, photo){",
  "tlVoiceEnd(proj){","tlTotal(proj){","tlSegments(proj){","tlSegmentAt(segs, rel){","tlPhotoIndexes(proj){",
  "tlFromMap(proj){","tlHash(s){","tlSyncKey(proj){","tlSaved(proj){","tlOf(proj){","tlClone(tl){",
  "tlFits(list, at, len, skipId){","tlRoom(proj, list, at, skipId){","tlDefaultLen(proj, kind, pid, at, segs){",
  "tlSnap(at, len, targets, th){","tlSnapTargets(proj, tl, segs, skipId, playRel){",
  "tlNeighbors(proj, list, b){","tlTrim(proj, list, b, side, t, srcDur){","tlRestore(proj, list, b, srcDur){","tlTrimmed(b, srcDur){","tlTidy(tl){",
  "tlSource(proj, b){","tlBlockAt(tl, rel){","tlFramePlan(proj, tl, time, segs){","tlGaps(proj, tl){","tlUsage(tl){",
];
function sandbox(extra){
  const sb=Object.assign({},extra||{});
  vm.runInNewContext([
    grabVar(/  var VIDEO = \{[^\n]*\n/,"VIDEO"),
    grabVar(/  var TL = \{[^\n]*\n/,"TL"),
  ].concat(TLF.map(grab)).join("\n"),sb);
  return sb;
}
const P=(n)=>"u/p/photo/p"+n+".jpg", E=(n)=>"u/p/edited/e"+n+".jpg", V=(n)=>"u/p/video/v"+n+".mp4";
function project(){
  return {
    photos:[{id:P(1)},{id:P(2)},{id:P(3)}],
    edits:{[P(1)]:{id:E(1)},[P(2)]:{id:E(2)}},
    clips:{[P(1)]:{id:V(1),dur:3,fromEdit:E(1)}},
    cutTimeline:[{start:0,end:1.2},{start:1.2,end:2.5},{start:2.5,end:4},{start:4,end:5.5},{start:5.5,end:7}],
    cutTimelineFor:"a\nb\nc\nd\ne", cutTimelineAudioId:"u/p/tts/t1.wav",
    ttsDuration:7, map:[0,0,0,1,2],
  };
}
const blk=(id,kind,n,at,len,inn)=>({id,kind,pid:P(n),at,len,in:inn||0});

test("a saved timeline is used only while it matches the current voice sync",()=>{
  const sb=sandbox(), proj=project();
  assert.equal(sb.tlSaved(proj),null);
  assert.equal(plain(sb.tlOf(proj)).tracks[0][0].id,"m0","no saved timeline → ⑩ placement");
  proj.timeline={v:1,sync:sb.tlSyncKey(proj),tracks:[[blk("x","photo",3,0,7)],[]]};
  assert.equal(plain(sb.tlOf(proj)).tracks[0][0].id,"x");
  proj.cutTimelineFor="a\nb\nc\nd\nE";            // ⑦ 을 다시 함(대본이 바뀜)
  assert.equal(sb.tlSaved(proj),null,"stale after re-sync");
  assert.equal(plain(sb.tlOf(proj)).tracks[0][0].id,"m0");
  proj.cutTimelineFor="a\nb\nc\nd\ne"; proj.cutTimelineAudioId="u/p/tts/t2.wav";
  assert.equal(sb.tlSaved(proj),null,"new voice file → stale");
  // 복사본은 저장본과 따로 논다
  proj.cutTimelineAudioId="u/p/tts/t1.wav";
  const c=sb.tlClone(sb.tlOf(proj)); c.tracks[0][0].at=3;
  assert.equal(proj.timeline.tracks[0][0].at,0);
});

test("fit, room, default length and snapping",()=>{
  const sb=sandbox(), proj=project();
  const list=[blk("a","photo",1,0,2),blk("b","photo",2,4,1.5)];
  assert.equal(sb.tlFits(list,2,2),true,"touching edges is fine");
  assert.equal(sb.tlFits(list,1.9,1),false);
  assert.equal(sb.tlFits(list,0.5,1,"a"),true,"a block does not collide with itself");
  assert.equal(sb.tlRoom(proj,list,2),2,"until the next block");
  assert.equal(sb.tlRoom(proj,list,1),0,"inside a block");
  assert.equal(sb.tlRoom(proj,list,6),1,"until the voice end");
  const segs=sb.tlSegments(proj);
  assert.equal(sb.tlDefaultLen(proj,"photo",P(2),1.2,segs),1.3,"photo fills its subtitle");
  assert.ok(Math.abs(sb.tlDefaultLen(proj,"photo",P(2),2.4,segs)-1.6)<1e-9,"too short → through the next subtitle");
  assert.equal(sb.tlDefaultLen(proj,"clip",P(1),0,segs),3,"clip uses its length");
  const targets=plain(sb.tlSnapTargets(proj,{tracks:[list,[]]},segs,"a",3.3));
  assert.ok(targets.includes(4) && targets.includes(1.2) && targets.includes(3.3) && !targets.includes(2),"skips the dragged block's own edges");
  assert.equal(sb.tlSnap(1.15,1,targets,0.1),1.2,"start snaps to a subtitle edge");
  assert.equal(sb.tlSnap(2.95,1,targets,0.1),3,"end snaps to the next block (4)");
  assert.equal(sb.tlSnap(1.7,1,targets,0.1),1.7,"nothing near → unchanged");
});

// 편집 동작: DOM 대신 가짜 함수로 돌린다.
function editor(proj, tl){
  const info=[];
  const sb=sandbox({
    edAfterChange(){ sb.changes=(sb.changes||0)+1; }, autosave(){}, edInfo(t,bad){ info.push([t,!!bad]); },
  });
  vm.runInNewContext([
    "var ed;",
    "edFind(k, id){","edSelBlock(){","edSnapshot(){","edCommit(){","edUndo(){","edSortTrack(list){",
    "edMoveBlock(k, id, to, at){","edAddBlock(src, to, at){","edDelete(){","edSwap(){","edAddAtPlayhead(){",
  ].map((x)=>x.startsWith("var")?x:grab(x)).join("\n"),sb);
  sb.ed={proj, tl:sb.tlClone(tl||sb.tlOf(proj)), segs:sb.tlSegments(proj), undo:[], sel:null, lib:null, t:0};
  return {sb,info};
}

test("move, swap, delete, add and undo back to the plain ⑩ placement",()=>{
  const proj=project();
  const {sb,info}=editor(proj);
  const t=(k)=>plain(sb.ed.tl.tracks[k]).map((b)=>b.id+"@"+b.at+"+"+Math.round(b.len*100)/100);
  assert.deepEqual(t(0),["m0@0+3","m3@4+1.5","m4@5.5+1.5"]);

  assert.equal(sb.edMoveBlock(0,"m3",0,3.5),true,"into the magenta gap");
  assert.deepEqual(t(0),["m0@0+3","m3@3.5+1.5","m4@5.5+1.5"]);
  assert.equal(sb.tlSaved(proj).tracks[0][1].at,3.5,"saved with the current sync");
  assert.equal(sb.edMoveBlock(0,"m3",0,2),false,"would overlap m0");
  assert.equal(sb.ed.undo.length,1,"a refused move leaves nothing to undo");

  assert.equal(sb.edMoveBlock(0,"m3",1,1),true,"to V2");
  assert.deepEqual(t(0),["m0@0+3","m4@5.5+1.5"]);
  assert.deepEqual(t(1),["m3@1+1.5"]);
  assert.equal(sb.edMoveBlock(0,"m4",0,6.5),true);
  assert.deepEqual(t(0),["m0@0+3","m4@5.5+1.5"],"kept inside the voice length");

  sb.ed.sel={track:1,id:"m3"};
  sb.edSwap();
  assert.deepEqual(t(1),["m3@1+1.5"],"V1 is busy at that time");
  assert.match(info.at(-1)[0],/V1의 같은 시간에 다른 블록이 있어서/);

  sb.ed.sel={track:0,id:"m0"};
  sb.edDelete();
  assert.deepEqual(t(0),["m4@5.5+1.5"]);
  assert.equal(sb.ed.sel,null);

  assert.equal(sb.edAddBlock("photo:"+P(3),0,0),true);
  assert.deepEqual(t(0).map((x)=>x.replace(/^b\w+/,"new")),["new@0+1.2","m4@5.5+1.5"],"photo fills its subtitle");
  assert.equal(sb.edAddBlock("clip:"+P(1),0,4.5),true);
  assert.deepEqual(t(0).map((x)=>x.replace(/^b\w+/,"new")),["new@0+1.2","new@4.5+1","m4@5.5+1.5"],"clip trimmed to the free room");
  assert.equal(sb.ed.tl.tracks[0][1].kind,"clip");

  sb.ed.lib="clip:"+P(1); sb.ed.t=0.5+1.1;
  sb.edAddAtPlayhead();
  assert.match(info.at(-1)[0],/V1·V2 모두 블록이 있어요/,"both tracks busy at the playhead");
  sb.ed.t=0.5+3;
  sb.edAddAtPlayhead();
  assert.deepEqual(t(0).map((x)=>x.replace(/^b\w+/,"new")),["new@0+1.2","new@3+1.5","new@4.5+1","m4@5.5+1.5"],"V1 first, up to the next block");

  while(sb.ed.undo.length) sb.edUndo();
  assert.deepEqual(t(0),["m0@0+3","m3@4+1.5","m4@5.5+1.5"]);
  assert.deepEqual(t(1),[]);
  assert.equal(proj.timeline,undefined,"undoing everything returns to the plain ⑩ placement");
});

test("final render and thumbnail follow the saved timeline; without one they keep the ⑩ placement",()=>{
  const sb=sandbox();
  vm.runInNewContext([
    grab("thumbnailDuration(proj){"), grab("thumbnailLastFrame(proj){"), grab("thumbnailFramePlan(proj, time){"),
  ].join("\n"),sb);
  const proj=project();
  const before=plain(sb.thumbnailFramePlan(proj,0.5+3.5));
  assert.equal(before.kind,"video","plain ⑩: past a 3s clip in a 4s run");
  proj.timeline={v:1,sync:sb.tlSyncKey(proj),tracks:[
    [blk("a","photo",2,0,3)],
    [blk("b","clip",1,2,2,0.5)],
  ]};
  assert.deepEqual(plain(sb.thumbnailFramePlan(proj,0.5+1)),{kind:"image",path:E(2),time:1.5,zoom:1+0.18*(1/3),timeline:true});
  const v=plain(sb.thumbnailFramePlan(proj,0.5+2.5));
  assert.equal(v.kind,"video","V2 wins");
  assert.ok(Math.abs(v.elapsed-1)<1e-9,"0.5s in-point + 0.5s into the block");
  assert.equal(plain(sb.thumbnailFramePlan(proj,0.5+5)).kind,"magenta");
  assert.equal(plain(sb.thumbnailFramePlan(proj,0.2)).cover,true,"cover is unchanged");
  // 저장 뒤 사진을 다시 가공하면 영상 블록은 사진으로
  proj.edits[P(1)]={id:"u/p/edited/e1b.jpg"};
  assert.deepEqual(plain(sb.thumbnailFramePlan(proj,0.5+2.5)).path,"u/p/edited/e1b.jpg");

  const drawThumb=grab("drawThumbnailFrame(g, plan, media){");
  assert.match(drawThumb,/if\(plan\.kind==="magenta"\)\{ drawMagentaCut\(g,""\); return "마젠타"; \}/);
  assert.match(grab("thumbnailMediaFor(plan){"),/if\(plan\.kind==="magenta"\) return null;/);
  const reel=grab("makeVideo(){");
  assert.match(reel,/var etl=tlSaved\(current\)/);
  assert.match(reel,/var tp=tlFramePlan\(current, etl, el\/1000, tsegs\);/);
  assert.match(reel,/tlDrawLive\(g, tp,/);
  assert.match(reel,/for\(var i=0;i<photos\.length && !etl;i\+\+\)/,"⑩-placement media are skipped when the timeline is used");
  assert.match(reel,/clipVideos\.push\(\{video:tv/,"timeline clips are released with the others");
});

test("shared live drawing: a new block restarts its clip at the in-point, overrun is magenta, photos zoom",()=>{
  const calls=[];
  const sb={Math, VIDEO:{w:1080,h:1920,subY:496}, fitSize:()=>72, canvasFontFamily:()=>"x",
    stroked:(_g,text)=>calls.push(["text",text])};
  vm.runInNewContext(["drawFill(g,im,zoom,cx,cy){","drawCutText(g,text){","drawMagentaCut(g,text){","drawClipCut(g,video,text,elapsed,duration){",
    "tlDrawLive(g, plan, text, media, live){"].map(grab).join("\n"),sb);
  const g={fillStyle:"",drawImage(src){ calls.push(["image",src.name]); },fillRect(){ calls.push(["fill",this.fillStyle]); }};
  const video=(name)=>({name,videoWidth:1080,videoHeight:1920,duration:3,currentTime:0,readyState:4,seeking:false,ended:false,
    played:0,paused:true,play(){ this.played++; this.paused=false; return Promise.resolve(); },pause(){ this.paused=true; }});
  const live={video:null,key:"",drift:0.45};
  const v1=video("v1");
  sb.tlDrawLive(g,{kind:"video",track:1,block:{id:"b"},elapsed:0.5},"자막",v1,live);
  assert.equal(v1.currentTime,0.5); assert.equal(v1.played,1);
  v1.currentTime=1.0;
  sb.tlDrawLive(g,{kind:"video",track:1,block:{id:"b"},elapsed:1.0},"자막",v1,live);
  assert.equal(v1.played,1,"same block keeps playing");
  sb.tlDrawLive(g,{kind:"video",track:0,block:{id:"c"},elapsed:2},"자막",v1,live);
  assert.equal(v1.played,2,"same file in another block restarts at its own point");
  assert.equal(v1.currentTime,2);
  calls.length=0;
  sb.tlDrawLive(g,{kind:"video",track:0,block:{id:"c"},elapsed:3.2},"끝",v1,live);
  assert.deepEqual(calls,[["fill","#FF00FF"],["text","끝"]],"past the clip → magenta with subtitle");
  assert.equal(v1.paused,true);
  calls.length=0;
  sb.tlDrawLive(g,{kind:"image",zoom:1.1},"사진",{name:"img",width:1080,height:1920},live);
  assert.deepEqual(calls,[["image","img"],["text","사진"]]);
  assert.equal(live.video,null,"leaving a clip stops it");
  calls.length=0;
  sb.tlDrawLive(g,{kind:"magenta"},"빈",null,live);
  assert.deepEqual(calls,[["fill","#FF00FF"],["text","빈"]]);
});

test("⑩ list: edited timeline notice, reset, and a confirm before list changes overwrite it",()=>{
  const sec=grab("matchSection(){");
  assert.match(sec,/if\(tlSaved\(current\)\)/);
  assert.match(sec,/id="tlreset"/);
  assert.match(sec,/음성 싱크가 바뀌어서, 편집모드에서 고친 타임라인 대신/);
  const drop=grab("tlDropForMap(){");
  assert.match(drop,/confirm\(/);
  assert.match(drop,/delete current\.timeline/);
  assert.match(grab("openPicker(btn, cutIdx){"),/else \{ if\(!tlDropForMap\(\)\) return; ensureMap\(\); current\.map\[cutIdx\]=pi; \}/,
    "changing a cut asks first; the cover photo does not");
  assert.match(html,/if\(!tlDropForMap\(\)\) return;\n\s*current\.map=\[\]; current\.coverPhoto=0;/,"re-distribute asks first");
  assert.match(grab("dropImage(kind, idx){"),/return \(list\|\|\[\]\)\.filter\(function\(b\)\{ return b\.pid!==it\.id; \}\);/,"deleting a photo removes its blocks");
  assert.match(html,/if\(v\.timeline\) v\.timeline=JSON\.parse\(JSON\.stringify\(v\.timeline\)\);/);
  assert.match(grab("videoSection(){"),/편집모드에서 고친 타임라인\(V1·V2\)대로 만들어요/);
});

test("editor: drag needs a prior tap on touch, snaps, shows a ghost and suppresses the follow-up click",()=>{
  const bind=grab("edBind(){");
  assert.match(bind,/if\(ev\.pointerType!=="mouse" && !el\.classList\.contains\("on"\)\) return;/);
  assert.match(bind,/setPointerCapture/);
  assert.match(bind,/data-ed|act==="undo"/);
  for(const a of ['act==="undo"','act==="swap"','act==="del"','act==="add"']) assert.ok(bind.includes(a),a);
  // 키보드는 문서 전체에서 받는다(고친 뒤 다시 그려서 포커스가 사라져도 동작)
  assert.match(html,/document\.addEventListener\("keydown", function\(ev\)\{\n    if\(!ed\) return;/);
  assert.match(html,/ev\.key==="Delete" \|\| ev\.key==="Backspace"/);
  assert.match(html,/\(ev\.ctrlKey \|\| ev\.metaKey\) && \(ev\.key==="z"/);
  const move=grab("edDragMove(d, x, y){");
  assert.match(move,/tlSnap\(/);
  assert.match(move,/tlFits\(/);
  assert.match(move,/ed-ghost/);
  assert.match(grab("edDragEnd(d, cancel){"),/ed\.noClickUntil=performance\.now\(\)\+250/);
  assert.match(html,/\.ed-blk\.on,\.ed-src\.on\{touch-action:none\}/,"a selected block can be dragged on touch without scrolling");
  assert.match(bind,/addEventListener\("dragstart", function\(ev\)\{ ev\.preventDefault\(\); \}\)/,"native image drag never steals the pointer");
  assert.match(grab("edBlockHtml(b, k){"),/draggable="false"/);
  assert.match(grab("edClose(fromPop){"),/if\(e\.changed && current===e\.proj\)\{ flushSave\(\); renderEdit\(current\); \}/);
});

test("trim front and back: clips stay inside their source, photos are free, neighbours and 0.2s are hard limits; restore brings it back",()=>{
  const sb=sandbox(), proj=project();          // 음성 7초
  const clip=blk("c","clip",1,2,3,0);           // 2~5초, 원본 3초 전부 사용
  const list=[blk("a","photo",2,0,1.5),clip,blk("z","photo",3,6,1)];
  assert.deepEqual(plain(sb.tlNeighbors(proj,list,clip)),{lo:1.5,hi:6});
  // 앞 자르기: 시작이 늦어지면 in 이 같이 는다
  assert.deepEqual(ms(sb.tlTrim(proj,list,clip,"l",2.8,3)),{at:2.8,len:2.2,in:0.8});
  // 앞을 다시 밖으로: 원본 처음(in 0) 밖으로는 못 간다
  const cut={...clip,at:2.8,len:2.2,in:0.8};
  assert.deepEqual(ms(sb.tlTrim(proj,list,cut,"l",1.6,3)),{at:2,len:3,in:0},"stops at the source start (2s), not the neighbour (1.5s)");
  // 뒤 자르기 / 다시 늘리기: 원본 끝까지만
  assert.ok(Math.abs(sb.tlTrim(proj,list,clip,"r",4,3).len-2)<1e-9);
  assert.equal(sb.tlTrim(proj,list,{...clip,len:2},"r",5.9,3).len,3,"stops at the source end, before the next block");
  // 최소 0.2초
  assert.ok(Math.abs(sb.tlTrim(proj,list,clip,"l",9,3).len-0.2)<1e-9);
  assert.ok(Math.abs(sb.tlTrim(proj,list,clip,"r",0,3).len-0.2)<1e-9);
  // 사진은 원본 길이 제한 없이 옆 블록까지
  const ph=list[0];
  assert.equal(sb.tlTrim(proj,list,ph,"r",1.9,0).len,1.9);
  assert.equal(sb.tlTrim(proj,list,ph,"r",9,0).len,2,"up to the clip at 2s");
  assert.equal(sb.tlTrim(proj,list,list[2],"r",9,0).len,1,"up to the voice end (7s)");
  // 되돌리기
  assert.equal(sb.tlTrimmed(cut,3),true);
  assert.equal(sb.tlTrimmed(clip,3),false);
  assert.equal(sb.tlTrimmed(ph,0),false,"photos are never 'trimmed'");
  assert.deepEqual(ms(sb.tlRestore(proj,list,cut,3)),{at:2,in:0,len:3});
  const tight=[blk("a","photo",2,0,2.5),{...cut},blk("z","photo",3,6,1)];
  const r=ms(sb.tlRestore(proj,tight,tight[1],3));
  assert.deepEqual(r,{at:2.5,in:0.5,len:2.5},"only as far as the neighbour allows");
  assert.equal(sb.tlRestore(proj,list,ph,0),null);
  // 자른 영상은 그 구간만 나온다(⑪·미리보기 공통 계산)
  proj.timeline={v:1,sync:sb.tlSyncKey(proj),tracks:[[cut],[]]};
  const fp=plain(sb.tlFramePlan(proj,sb.tlOf(proj),0.5+3));
  assert.ok(Math.abs(fp.elapsed-1)<1e-9,"0.8s in-point + 0.2s into the block");
});

test("editor trim wiring: handles on the selected block, one undo step per drag, restore button",()=>{
  assert.match(grab("edBlockHtml(b, k){"),/<i class="ed-h l" data-h="l"[^>]*><\/i><i class="ed-h r" data-h="r"/);
  assert.match(html,/\.ed-blk\.on \.ed-h\{display:block\}/,"handles only on the selected block");
  assert.match(html,/\.ed-h\{display:none;[^}]*touch-action:none/);
  const bind=grab("edBind(){");
  assert.match(bind,/d\.trim=hd\.dataset\.h; d\.orig=\{at:d\.block\.at, len:d\.block\.len, in:d\.block\.in\|\|0\};/);
  assert.match(bind,/edTrimMove\(d, ev\.clientX\)/);
  assert.ok(bind.includes('act==="restore"'));
  const end=grab("edDragEnd(d, cancel){");
  assert.match(end,/b\.at=d\.orig\.at; b\.len=d\.orig\.len; b\.in=d\.orig\.in;\n\s*if\(cancel/,"put back before the undo snapshot");
  assert.match(end,/edSnapshot\(\);\n\s*b\.at=r\.at; b\.len=r\.len; b\.in=r\.in;\n\s*edCommit\(\);/);
  assert.match(grab("edTrimMove(d, x){"),/tlTrim\(/);
  assert.match(grab("edShowSel(){"),/data-ed="restore"/);
});

test("positions are tidied to 0.1ms on save without opening gaps between touching blocks",()=>{
  const sb=sandbox();
  const tl={tracks:[[{id:"a",at:0,len:1.0000000374602025,in:0},{id:"b",at:1.0000000374602025,len:1.9999999625397975,in:1.0000000374602025}],[]]};
  sb.tlTidy(tl);
  assert.equal(tl.tracks[0][0].len,1);
  assert.equal(tl.tracks[0][1].at,1);
  assert.equal(tl.tracks[0][1].in,1);
  assert.equal(tl.tracks[0][0].at+tl.tracks[0][0].len,tl.tracks[0][1].at,"still touching");
  assert.ok(Math.abs(tl.tracks[0][1].at+tl.tracks[0][1].len-3)<1e-9);
  assert.match(grab("edCommit(){"),/tlTidy\(ed\.tl\);/);
});
