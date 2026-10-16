"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");

global.window = global;
require("../reels-media.js");
const media = global.ReelsMedia;

test("speed and pitch are independent values",()=>{
  assert.equal(media.SPEED,1.2);
  assert.equal(media.PITCH_SEMITONES,1);
  assert.ok(media.VERSION.includes("speed1.2-pitch1"));
});

test("timestamp alignment ignores tags but preserves caption characters",()=>{
  const speech="[thoughtful] 겨울에도 물에 떠서 [short pause] 하늘을 보며 쉬어요!";
  const chars=Array.from(speech);
  const aligned={
    characters:chars,
    character_start_times_seconds:chars.map((_,i)=>i*0.04),
    character_end_times_seconds:chars.map((_,i)=>i*0.04+0.03),
  };
  const lines=["겨울에도 물에 떠서","하늘을 보며 쉬어요"];
  const t=media.timelineFromAlignment(lines,aligned,4.0,1.2);
  assert.equal(t.length,2);
  assert.equal(t[0].start,0);
  assert.equal(t[1].text,lines[1]);
  const position=chars.findIndex((ch,i)=>ch==="하" && chars.slice(i,i+3).join("")==="하늘을");
  assert.equal(t[1].start,+(position*0.04/1.2).toFixed(3));
  assert.equal(t[0].end,t[1].start);
  assert.equal(t[1].end,4.0);
});

test("punctuation and whitespace do not shift canonical timing boundaries",()=>{
  assert.equal(media.speechLetters("겨울, 에도! 30만원"),media.speechLetters("겨울에도30만원"));
  const chars=Array.from("가!나,다");
  const aligned={characters:chars,
    character_start_times_seconds:chars.map((_,i)=>i*0.3),
    character_end_times_seconds:chars.map((_,i)=>i*0.3+0.2)};
  const t=media.timelineFromAlignment(["가","나 다"],aligned,2.0,1.2);
  assert.equal(t.length,2);
  assert.equal(t[1].start,+(2*0.3/1.2).toFixed(3));
});

test("a nonmatching transcript is rejected, never silently evenly split",()=>{
  const data={characters:["이","름","이","틀","림"],
    character_start_times_seconds:[0,0.1,0.2,0.3,0.4],
    character_end_times_seconds:[0.1,0.2,0.3,0.4,0.5]};
  assert.throws(()=>media.timelineFromAlignment(["다른 대본"],data,2,1.2),
    /일치하지 않아요/);
});

test("can encode output PCM as a valid WAV blob",()=>{
  const pcm={
    numberOfChannels:1,length:3,sampleRate:44100,
    getChannelData:()=>new Float32Array([0,0.5,-0.5]),
  };
  const result=media.wavFromBuffer(pcm);
  assert.equal(result.type,"audio/wav");
  assert.equal(result.size,44+6);
});

test("HTML inline script parses and current 9-rule prompt and model routing stay intact",()=>{
  const repoRoot=path.join(__dirname,"..");
  const html=fs.readFileSync(path.join(repoRoot,"index.html"),"utf8");
  const m=html.match(/<script>\s*([\s\S]*?)<\/script>/);
  assert.ok(m,"Inline application script must exist");
  new vm.Script(m[1],{filename:"index.html:inline"});
  const start=html.indexOf("  function scriptPrompt(){");
  const end=html.indexOf("  // ---------- 검사 ----------",start);
  assert.ok(start>=0 && end>start,"User script prompt and checks must exist");
  const p=html.slice(start,end);
  assert.ok(p.includes("# 지켜야 할 9가지 구조"));
  assert.ok(p.includes("1. 첫 두 줄"));
  assert.ok(p.includes("2. 시설"));
  assert.ok(p.includes("3. 줄에서 문장"));
  assert.ok(p.includes("8. 마지막"));
  assert.ok(p.includes("9. 화자는 숙소 편이 아니라 시청자 편에 서세요."));
  assert.ok(html.includes("function sideWarnings(lines)"));
  assert.ok(html.includes("var w=sideWarnings(lines).concat(sceneWarnings(lines)).concat(scriptWarnings(lines));"));
  // OCR does not set a purpose; script creation/repair/extension all use Opus 5.5.
  assert.ok(html.includes('applyFields(await askJSON(fillPrompt('));
  // The first call decides the trip brief, cover and lines together; review is its own Opus stage.
  assert.ok(html.includes('}, "script_brief");'));
  assert.ok(html.includes('null, "script_review"'));
  assert.ok(html.includes('null, "script_repair"'));
  assert.ok(html.includes('null, "script_extend"'));
  assert.ok(html.includes('if(purpose==="script_repair")request.repair_indices=repairIndices||[];'));
  assert.ok(html.includes("function ttsSettingsSection()"));
  assert.ok(p.includes("제약") && p.includes("유료"),"Facts and paid constraints stay distinct");
  assert.ok(html.includes("await askJSON(scriptPrompt()"));
  assert.ok(!html.includes("await askJSON(shortPrompt()"),"Never downgrade to abbreviated prompt");
  assert.ok(html.includes("h+=soundSection();"));
  assert.ok(html.includes("h+=videoSection();"));
  assert.ok(html.includes("var windows=current.cutTimeline"));
});


test("default fonts load for cover and subtitles without manual uploads",async()=>{
  const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
  const start=html.indexOf("  // ---------- 폰트 ----------");
  const end=html.indexOf("  // ---------- 로그인 ----------",start);
  assert.ok(start>0 && end>start);
  const sources=[],added=[],removed=[];
  const context={
    uid:null,console:{warn(){}},
    document:{fonts:{add(face){added.push(face);},delete(face){removed.push(face);}}},
    FontFace:class {
      constructor(family,source){this.family=family;this.source=source;sources.push(source);}
      async load(){return this;}
    },
    fetch:async()=>{throw new Error("fetch should not happen for defaults without uid");},
    blobUrl:()=>{throw new Error("Storage URL should not be used for defaults");},
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start,end),context,{filename:"font-section.js"});
  await vm.runInContext("checkFonts()",context);
  const fonts=vm.runInContext("FONTS.map(f=>[f.k,f.label,f.face,fontsReady[f.k],fontSource[f.k]])",context);
  assert.equal(fonts.length,2);
  assert.deepEqual(Array.from(fonts[0]),["body","온글잎 콘콘체","ReelBody",true,"default"]);
  assert.deepEqual(Array.from(fonts[1]),["cover","학교안심 어항꾸미기 B","ReelCover",true,"default"]);
  assert.ok(sources.some(x=>x.includes("Ownglyph_corncorn-Rg.woff2")));
  assert.ok(sources.some(x=>x.includes("Hakgyoansim_EohangkkumigiB.woff2")));
  assert.equal(added.length,2);
  assert.ok(html.includes('if(k==="cover" && fontsReady.cover) return'));
  assert.ok(html.includes('if(k==="body" && fontsReady.body) return'));
  assert.ok(html.includes("await checkFonts();"),"App startup should load both fonts");
});

test("user-uploaded font overrides CDN default without changing the second font",async()=>{
  const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
  const start=html.indexOf("  // ---------- 폰트 ----------");
  const end=html.indexOf("  // ---------- 로그인 ----------",start);
  const loaded=[],removed=[];
  const context={
    uid:"mock-user",console:{warn(){}},
    document:{fonts:{add(face){loaded.push(face);},delete(face){removed.push(face);}}},
    FontFace:class {
      constructor(family,source){this.family=family;this.source=source;}
      async load(){return this;}
    },
    fetch:async url=>({ok:url.includes("/body.ttf")}),
    blobUrl:path=>"https://test.supabase.co/"+path,
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start,end),context,{filename:"font-section.js"});
  await vm.runInContext("checkFonts()",context);
  assert.equal(vm.runInContext("fontSource.body",context),"custom");
  assert.equal(vm.runInContext("fontSource.cover",context),"default");
  assert.ok(loaded.find(f=>f.family==="ReelBody").source.includes("/body.ttf?v="));
  assert.ok(loaded.find(f=>f.family==="ReelCover").source.includes("EohangkkumigiB.woff2"));
});
