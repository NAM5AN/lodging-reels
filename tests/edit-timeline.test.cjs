"use strict";
// ⑩ 편집모드 — 블록 타임라인 계산(⑩ 컷 배치 → V1/V2 블록, 시점별 프레임, 마젠타 구간)과 화면 연결.
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
function sandbox(){
  const sb={};
  vm.runInNewContext([
    grabVar(/  var VIDEO = \{[^\n]*\n/,"VIDEO"),
    grabVar(/  var TL = \{[^\n]*\n/,"TL"),
    grab("renderClipForPhoto(proj, photo){"),
    grab("thumbnailDuration(proj){"), grab("thumbnailLastFrame(proj){"), grab("thumbnailFramePlan(proj, time){"),
    grab("tlVoiceEnd(proj){"), grab("tlTotal(proj){"), grab("tlSegments(proj){"), grab("tlSegmentAt(segs, rel){"),
    grab("tlPhotoIndexes(proj){"), grab("tlFromMap(proj){"), grab("tlOf(proj){"), grab("tlSource(proj, b){"),
    grab("tlHash(s){"), grab("tlSyncKey(proj){"), grab("tlSaved(proj){"), grab("tlClone(tl){"),
    grab("tlBlockAt(tl, rel){"), grab("tlFramePlan(proj, tl, time, segs){"), grab("tlGaps(proj, tl){"), grab("tlUsage(tl){"),
  ].join("\n"),sb);
  return sb;
}
const P=(n)=>"u/p/photo/p"+n+".jpg", E=(n)=>"u/p/edited/e"+n+".jpg", V=(n)=>"u/p/video/v"+n+".mp4";
// 자막 5개, 말이 끊김 없이 이어지는 경우(⑪ 과 같은 값이 나와야 하는 기준 상황)
function project(){
  return {
    photos:[{id:P(1)},{id:P(2)},{id:P(3)}],
    edits:{[P(1)]:{id:E(1)},[P(2)]:{id:E(2)}},
    clips:{[P(1)]:{id:V(1),dur:3,fromEdit:E(1)}},
    cutTimeline:[{start:0,end:1.2},{start:1.2,end:2.5},{start:2.5,end:4},{start:4,end:5.5},{start:5.5,end:7}],
    ttsDuration:7,
    map:[0,0,0,1,2],
  };
}

test("subtitle blocks run back to back: the first starts at 0, each ends where the next starts, the last at the voice end",()=>{
  const sb=sandbox(), proj=project();
  proj.cutTimeline=[{start:0.2,end:1.1},{start:1.3,end:2.4},{start:2.6,end:3.9}];
  proj.ttsDuration=4.5;
  const segs=plain(sb.tlSegments(proj));
  assert.deepEqual(segs.map((s)=>[s.start,s.end]),[[0,1.3],[1.3,2.6],[2.6,4.5]]);
  assert.deepEqual(segs.map((s)=>[s.speakStart,s.speakEnd]),[[0.2,1.1],[1.3,2.4],[2.6,3.9]],"speech range kept for display");
  assert.equal(sb.tlSegmentAt(sb.tlSegments(proj),0.05),0);
  assert.equal(sb.tlSegmentAt(sb.tlSegments(proj),1.3),1);
  assert.equal(sb.tlSegmentAt(sb.tlSegments(proj),9),2);
  assert.equal(sb.tlTotal(proj),5);
  delete proj.ttsDuration;
  assert.equal(sb.tlVoiceEnd(proj),3.9,"falls back to the last speech end");
});

test("cut placement becomes V1 blocks: same photo in a row is one block; a clip shorter than its run leaves a magenta gap",()=>{
  const sb=sandbox(), proj=project();
  const tl=plain(sb.tlFromMap(proj));
  assert.deepEqual(tl.tracks[1],[],"V2 starts empty");
  assert.deepEqual(tl.tracks[0].map((b)=>[b.kind,b.pid,b.at,b.len,b.in]),[
    ["clip",P(1),0,3,0],      // 컷 1~3(0~4초) 이 1번 사진, 영상은 3초 → 3~4초 비움
    ["photo",P(2),4,1.5,0],
    ["photo",P(3),5.5,1.5,0],
  ]);
  assert.deepEqual(plain(sb.tlGaps(proj,sb.tlFromMap(proj))),[{start:3,end:4}]);
  // 사진을 다시 가공하면 옛 영상은 안 쓰고 사진 블록이 된다(⑪ 과 같은 규칙)
  proj.edits[P(1)]={id:"u/p/edited/e1b.jpg"};
  assert.deepEqual(plain(sb.tlFromMap(proj)).tracks[0][0],{id:"m0",kind:"photo",pid:P(1),at:0,len:4,in:0});
  assert.deepEqual(plain(sb.tlGaps(proj,sb.tlFromMap(proj))),[]);
  // 빈 map 은 ⑩ 기본 배분과 같다
  delete proj.map;
  assert.deepEqual(plain(sb.tlPhotoIndexes(proj)),[0,0,1,1,2]);
  assert.equal(proj.map,undefined,"reading does not write");
});

test("the preview plan matches today's ⑪ / thumbnail plan for every frame",()=>{
  const sb=sandbox(), proj=project(), tl=sb.tlOf(proj), segs=sb.tlSegments(proj);
  for(let t=0.5;t<sb.tlTotal(proj)-0.01;t+=1/30){
    const old=sb.thumbnailFramePlan(proj,t), now=sb.tlFramePlan(proj,tl,t,segs);
    const at=t.toFixed(3);
    if(old.kind==="video"){
      if(old.elapsed>=old.clipDuration){ assert.equal(now.kind,"magenta",at+" past the clip end"); continue; }
      assert.equal(now.kind,"video",at);
      assert.equal(now.path,old.path,at);
      assert.ok(Math.abs(now.elapsed-old.elapsed)<1e-9,at+" elapsed");
    }else{
      assert.equal(now.kind,"image",at);
      assert.equal(now.path,old.path,at);
      assert.ok(Math.abs(now.zoom-old.zoom)<1e-9,at+" zoom");
    }
  }
  assert.equal(sb.tlFramePlan(proj,tl,0.2,segs).kind,"cover");
  const p=sb.tlFramePlan(proj,tl,0.5+4.2,segs);
  assert.equal(p.seg,3,"subtitle index for the text");
  assert.equal(p.track,0);
});

test("V2 sits above V1; time covered by neither track is magenta",()=>{
  const sb=sandbox(), proj=project();
  const tl={v:1,tracks:[
    [{id:"a",kind:"photo",pid:P(2),at:0,len:2,in:0},{id:"b",kind:"clip",pid:P(1),at:4,len:2,in:1}],
    [{id:"c",kind:"photo",pid:P(3),at:1.5,len:1,in:0}],
  ]};
  const at=(rel)=>plain(sb.tlFramePlan(proj,tl,0.5+rel));
  assert.equal(at(1).path,E(2));
  assert.equal(at(1.6).path,P(3),"V2 wins while both have a block");
  assert.equal(at(1.6).track,1);
  assert.equal(at(2.2).path,P(3),"V2 covers V1's gap");
  assert.equal(at(3).kind,"magenta");
  assert.equal(at(4.5).kind,"video");
  assert.ok(Math.abs(at(4.5).elapsed-1.5)<1e-9,"trimmed start (in) is added");
  assert.deepEqual(plain(sb.tlGaps(proj,tl)),[{start:2.5,end:4},{start:6,end:7}]);
  assert.deepEqual(plain(sb.tlUsage(tl)),{["photo:"+P(2)]:1,["clip:"+P(1)]:1,["photo:"+P(3)]:1});
  // 지운 사진을 가리키는 블록은 마젠타
  proj.photos=proj.photos.filter((x)=>x.id!==P(2));
  assert.equal(at(1).kind,"magenta");
});

test("⑩ keeps its list and gets an edit-mode button that opens a full-screen landscape editor",()=>{
  const sec=grab("matchSection(){");
  assert.ok(sec.includes('id="openedit"'),"button in ⑩");
  assert.ok(sec.indexOf('id="openedit"')<sec.indexOf("cuts.forEach"),"top of the card, above the list");
  assert.ok(sec.includes('class="cpick"'),"the cut list stays");
  assert.match(html,/getElementById\("openedit"\);\n\s*if\(oe\) oe\.addEventListener\("click",function\(\)\{ flushSave\(\); edOpen\(\); \}\);/);
  const open=grab("edOpen(){");
  assert.match(open,/requestFullscreen\(\{navigationUI:"hide"\}\)/);
  assert.match(open,/screen\.orientation\.lock\("landscape"\)/);
  assert.match(open,/history\.pushState\(\{edMode:1\}/);
  assert.match(html,/window\.addEventListener\("popstate", function\(\)\{ if\(ed\) edClose\(true\); \}\);/,"Android back closes the editor");
  const shell=grab("edShell(){");
  for(const k of ['id="edlib"','id="edcv"','id="edlanes"','data-ed="play"','data-ed="close"','data-ed="zin"','data-ed="zout"','data-ed="undo"','id="edact"'])
    assert.ok(shell.includes(k),k);
  assert.ok(shell.indexOf('id="edlib"')<shell.indexOf('id="edcv"'),"library left, preview right");
  const lanes=grab("edRenderTimeline(){");
  const order=['class="ed-ruler"','data-lane="sub"','data-lane="1"','data-lane="0"'].map((k)=>lanes.indexOf(k));
  assert.ok(order.every((v)=>v>0) && [...order].sort((a,b)=>a-b).join()===order.join(),"ruler, subtitle+voice, V2, V1");
  assert.ok(lanes.includes('class="ed-wave"'),"voice waveform sits in the subtitle lane");
  assert.ok(lanes.includes("tlGaps(p, tl)"),"magenta gaps are drawn");
  const close=grab("edClose(fromPop){");
  assert.match(close,/releaseClipVideos/);
  assert.match(close,/exitFullscreen/);
  assert.match(close,/orientation\.unlock/);
});
