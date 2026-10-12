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
  assert.equal(media.PITCH_SEMITONES,0.2);
  assert.ok(media.VERSION.includes("speed1.2-pitch0.2"));
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

test("HTML inline script parses and all 8 authored script rules are still present",()=>{
  const repoRoot=path.join(__dirname,"..");
  const html=fs.readFileSync(path.join(repoRoot,"index.html"),"utf8");
  const m=html.match(/<script>\s*([\s\S]*?)<\/script>/);
  assert.ok(m,"Inline application script must exist");
  new vm.Script(m[1],{filename:"index.html:inline"});
  const start=html.indexOf("  function scriptPrompt(){");
  const end=html.indexOf("  // ---------- 검사 ----------",start);
  assert.ok(start>=0 && end>start,"User script prompt and checks must exist");
  const p=html.slice(start,end);
  assert.ok(p.includes("# 지켜야 할 8가지 구조"));
  assert.ok(p.includes("1. 첫 두 줄"));
  assert.ok(p.includes("2. 시설"));
  assert.ok(p.includes("3. 줄에서 문장"));
  assert.ok(p.includes("8. 마지막"));
  assert.ok(p.includes("제약") && p.includes("유료"),"Facts and paid constraints stay distinct");
  assert.ok(html.includes("await askJSON(scriptPrompt()"));
  assert.ok(!html.includes("await askJSON(shortPrompt()"),"Never downgrade to abbreviated prompt");
  assert.ok(html.includes("h+=soundSection();"));
  assert.ok(html.includes("h+=videoSection();"));
  assert.ok(html.includes("var windows=current.cutTimeline"));
});
