"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {execFileSync} = require("node:child_process");
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

test("HTML inline script parses and user's 8-rule prompt is unmodified",()=>{
  const repoRoot=path.join(__dirname,"..");
  const html=fs.readFileSync(path.join(repoRoot,"index.html"),"utf8");
  const m=html.match(/<script>\s*([\s\S]*?)<\/script>/);
  assert.ok(m,"Inline application script must exist");
  new vm.Script(m[1],{filename:"index.html:inline"});
  const base=execFileSync("git",["show","71a2798dc8dfacc83aaa7ace0c1fa4de36216fa3:index.html"],{encoding:"utf8"});
  function prompt(t){
    const start=t.indexOf("  function scriptPrompt(){");
    const end=t.indexOf("  // ---------- 검사 ----------",start);
    assert.ok(start>=0 && end>start);
    return t.slice(start,end);
  }
  assert.equal(prompt(html),prompt(base),"Never alter user-authored scriptPrompt()");
  assert.ok(html.includes("h+=soundSection();"));
  assert.ok(html.includes("h+=videoSection();"));
  assert.ok(html.includes("var windows=current.cutTimeline"));
});
