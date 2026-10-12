"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const {test}=require("node:test");

const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");

function getFn(name){
  const start=html.indexOf("  function "+name+"(){");
  assert.ok(start>0,name+" exists");
  const end=html.indexOf("\n  }\n",start);
  assert.ok(end>start,name+" closes cleanly");
  return html.slice(start,end+5);
}

function makeContext(data={}){
  const sandbox={current:data,esc:(v)=>String(v??"")};
  vm.runInNewContext([
    getFn("ttsVoiceSettings"),
    getFn("ttsVoiceFingerprint"),
    getFn("ttsSettingsSection"),
  ].join("\n"),sandbox);
  return sandbox;
}

test("voice defaults preserve stored ElevenLabs voice settings",()=>{
  const box=makeContext({});
  const opts=box.ttsVoiceSettings();
  assert.equal(opts.custom,false);
  assert.equal(opts.stability,0.50);
  assert.equal(opts.similarity,0.75);
  const output=box.ttsSettingsSection();
  assert.match(output,/Stability \(안정성\)/);
  assert.match(output,/Similarity \(유사도\)/);
  assert.match(output,/id="ttsStability"/);
  assert.match(output,/id="ttsSimilarity"/);
  assert.match(output,/disabled/);
  assert.match(output,/Eleven v4/);
});

test("custom voice settings survive serialization, accept exact endpoints and reject corrupt values",()=>{
  const box=makeContext({
    ttsVoiceSettings:{custom:true,stability:0.30,similarity:0.90},
    ttsVoiceId:"SomeVoiceIdentifier123"
  });
  const opts=box.ttsVoiceSettings();
  assert.equal(opts.custom,true);
  assert.equal(opts.stability,0.30);
  assert.equal(opts.similarity,0.90);
  const fingerprint=box.ttsVoiceFingerprint();
  assert.ok(fingerprint.includes("SomeVoiceIdentifier123"));
  assert.ok(!box.ttsSettingsSection().includes('value="0.3" disabled'));
  box.current.ttsVoiceId="DifferentVoiceIdentifier987";
  assert.notEqual(box.ttsVoiceFingerprint(),fingerprint);
  box.current.ttsVoiceSettings={custom:true,stability:2,similarity:NaN};
  assert.equal(box.ttsVoiceSettings().stability,0.50);
  assert.equal(box.ttsVoiceSettings().similarity,0.75);
});

test("TTS payload only carries v4-supported settings and stores applied fingerprint",()=>{
  assert.match(html,/payload\.voice_settings\s*=\s*\{/);
  assert.match(html,/stability:voiceSettings\.stability/);
  assert.match(html,/similarity:voiceSettings\.similarity/);
  assert.match(html,/current\.ttsVoiceFingerprint=ttsVoiceFingerprint\(\)/);
  assert.match(html,/action:"synthesize_timed"/);
  assert.match(html,/h\+=ttsSettingsSection\(\)/);
  assert.match(html,/ttsOverride/);
  assert.doesNotMatch(html,/payload\.voice_settings\s*=\s*\{[^}]*similarity_boost/);
});
