"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
function section(start,end) {
  const i=html.indexOf(start), j=html.indexOf(end,i+start.length);
  assert.ok(i>=0 && j>i, "expected source block: "+start);
  return html.slice(i,j);
}
const source=section("  function ttsSourceText(){","  function ttsTagSection(){")
  +"\n"+section("  async function makeTtsTags(){","  function trackRow(t){");
new vm.Script(source,{filename:"tts-auto-tag:inline"});

function setup(reply={
  ok:true,
  body:{text:"[surprised] 가격부터 봤는데, 객실값이 잘못됐어요.",integrity:true}
}){
  const state={id:"sample-project",script:"가격부터 봤는데\n객실값이 잘못됐어요"};
  const stat={textContent:"",className:"status"};
  let calls=[],saved=0,renders=0;
  const ctx={
    current:state,uid:"test-user",FN:{tts:"https://example.invalid/functions/v1/lodging-reels-tts"},
    document:{getElementById:id=>id==="tagstat"?stat:null},
    scriptLines:()=>String(ctx.current.script||"").split("\n").map(x=>x.trim()).filter(Boolean),
    api:async(url,opts)=>{
      calls.push({url,opts});
      return {ok:reply.ok, json:async()=>reply.body};
    },
    persist:async()=>{saved++;return true;},
    renderEdit:()=>{renders++;}
  };
  vm.runInNewContext(source,ctx);
  return {ctx,state,stat,calls,get saved(){return saved;},get renders(){return renders;}};
}

test("auto-tag button handler exists and backend action is tag (not audio synthesis)",async()=>{
  const env=setup();
  assert.ok(html.includes('try{ await makeTtsTags(); } finally{'));
  await env.ctx.makeTtsTags();
  assert.equal(env.calls.length,1);
  assert.equal(env.calls[0].url,env.ctx.FN.tts);
  assert.equal(env.calls[0].opts.method,"POST");
  const data=JSON.parse(env.calls[0].opts.body);
  assert.equal(data.action,"tag");
  assert.equal(data.text,env.state.script);
  assert.equal(env.state.ttsTagSource,env.state.script);
  assert.equal(env.state.ttsTagged,"[surprised] 가격부터 봤는데, 객실값이 잘못됐어요.");
  assert.equal(env.saved,1);
  assert.equal(env.renders,1);
  assert.match(env.stat.textContent,/저장했어요/);
});

test("cannot generate tags if script is empty",async()=>{
  const env=setup();env.state.script="";
  await env.ctx.makeTtsTags();
  assert.equal(env.calls.length,0);
  assert.match(env.stat.textContent,/대본을 먼저/);
  assert.equal(env.saved,0);
});

test("does not accept a tag result when spoken numbers or words changed",async()=>{
  const env=setup({ok:true,body:{text:"[surprised] 가격부터 봤는데 객실값이 30만원이었어요."}});
  await env.ctx.makeTtsTags();
  assert.equal(env.state.ttsTagged,undefined);
  assert.equal(env.saved,0);
  assert.match(env.stat.textContent,/단어나 숫자가 변경/);
});

test("shows missing Anthropic key error instead of silently doing nothing",async()=>{
  const env=setup({ok:false,body:{error:"no_tag_key",message:"No key"}});
  await env.ctx.makeTtsTags();
  assert.equal(env.saved,0);
  assert.match(env.stat.textContent,/ANTHROPIC_API_KEY/);
  assert.match(env.stat.className,/bad/);
});

test("does not apply late tag response after a script edit",async()=>{
  const env=setup();
  let release;
  env.ctx.api=async()=>new Promise(resolve=>{
    release=()=>resolve({ok:true,json:async()=>({text:"[surprised] 가격부터 봤는데 객실값이 잘못됐어요."})});
  });
  const pending=env.ctx.makeTtsTags();
  env.state.script="전혀 다른 대본";
  release();
  await pending;
  assert.equal(env.saved,0);
  assert.equal(env.state.ttsTagged,undefined);
  assert.match(env.stat.textContent,/대본이 변경/);
});

test("client canonical comparison tolerates punctuation and tags but not changed digits",()=>{
  const env=setup();
  const base="2인 기준 30만원대";
  assert.equal(env.ctx.canonicalTtsSpeech(base),
    env.ctx.canonicalTtsSpeech("[thoughtful] 2인 기준, 30만원대!"));
  assert.notEqual(env.ctx.canonicalTtsSpeech(base),
    env.ctx.canonicalTtsSpeech("[thoughtful] 4인 기준, 30만원대!"));
});

test("Korean Audio Tags are rejected, English single and comma-combined tags are accepted",()=>{
  const env=setup();
  assert.match(env.ctx.ttsTagLanguageError("[신나게] 짐 풀기도 전에 수영복부터"),/영어/);
  assert.match(env.ctx.ttsTagLanguageError("짐 풀기 전에 [놀랍다는 듯] 와!"),/영어/);
  assert.equal(env.ctx.ttsTagLanguageError("[surprised] 짐 풀기도 전에 수영복부터"),"");
  assert.equal(env.ctx.ttsTagLanguageError("[whispering, playful] 수영복부터 꺼낸 이유"),"");
  assert.equal(env.ctx.ttsTagLanguageError("태그 없이 한국어 내레이션"),"");
  assert.match(env.ctx.ttsTagLanguageError("[unterminated 대본"),/영어/);
});

test("auto-tag response with Korean brackets is never accepted or saved",async()=>{
  const env=setup({ok:true,body:{text:"[신나게] 가격부터 봤는데, [놀랍다는 듯] 객실값이 잘못됐어요.",integrity:true}});
  await env.ctx.makeTtsTags();
  assert.equal(env.saved,0);
  assert.equal(env.renders,0);
  assert.equal(env.state.ttsTagged,undefined);
  assert.match(env.stat.textContent,/영어/);
});

test("explicit tag language conversion failure surfaces a meaningful status",async()=>{
  const env=setup({ok:false,body:{error:"tag_language_failed",message:"Could not correct"}});
  await env.ctx.makeTtsTags();
  assert.equal(env.saved,0);
  assert.match(env.stat.textContent,/자동 영어 교정에 실패/);
});

test("saved legacy Korean tags are considered stale even when narration matches",()=>{
  const env=setup();
  env.state.ttsTagged="[신나게] 가격부터 봤는데 [놀랍다는 듯] 객실값이 잘못됐어요";
  env.state.ttsTagSource=env.state.script;
  assert.equal(env.ctx.tagsMatchScript(),false);
  env.state.ttsTagged="[surprised] 가격부터 봤는데 [thoughtful] 객실값이 잘못됐어요";
  assert.equal(env.ctx.tagsMatchScript(),true);
});

test("TTS synthesis refuses legacy Korean Audio Tags before making any API call",async()=>{
  const env=setup();
  env.state.ttsTagged="[신나게] 가격부터 봤는데 객실값이 잘못됐어요";
  env.state.ttsTagSource=env.state.script;
  const vdstat={textContent:"",className:"status"};
  env.ctx.document.getElementById=(id)=>id==="vdstat"?vdstat:null;
  vm.runInNewContext(section("  async function makeTTS(){","  async function makeAudioProcessed(){"),env.ctx);
  await env.ctx.makeTTS();
  assert.equal(env.calls.length,0);
  assert.match(vdstat.textContent,/영어/);
  assert.match(vdstat.className,/bad/);
});

test("natural punctuation is preserved across subtitle cuts without altering Korean words",async()=>{
  const input=["짐 풀기도 전에","수영복부터 꺼낸 이유","야외 풀은 보통 여름 한철 뿐인데","여긴 사계절 온수풀"].join(String.fromCharCode(10));
  const output="[excited] 짐 풀기도 전에, 수영복부터 꺼낸 이유? [surprised] 야외 풀은 보통 여름 한철 뿐인데... 여긴 사계절 온수풀!";
  const env=setup({ok:true,body:{text:output,integrity:true,english_tags:true}});
  env.state.script=input;
  await env.ctx.makeTtsTags();
  assert.equal(env.saved,1);
  assert.equal(env.state.script,input,"original subtitle text must remain unchanged");
  assert.equal(env.state.ttsTagged,output,"questions, commas, ellipses and exclamation marks should survive");
  assert.equal(env.state.ttsTagSource,input);
  assert.equal(env.ctx.canonicalTtsSpeech(output),env.ctx.canonicalTtsSpeech(input));
  assert.equal(env.ctx.tagsMatchScript(),true);
});

test("the UI explains automatic contextual punctuation and preserved words",()=>{
  assert.ok(html.includes("쉼표·마침표·물음표·느낌표·말줄임표"));
  assert.ok(html.includes("호흡과 의미에 맞춰 자동으로 정리해요"));
  assert.ok(html.includes("원래 단어·숫자는 바꾸지 않아요"));
});

test("gentle tones are excluded from standalone and composite English tags",()=>{
  const env=setup();
  const input="[gentle] 가격부터 봤는데 [warm, gentle] 객실값이 잘못됐어요";
  const output=env.ctx.removeGentleAudioTags(input);
  assert.equal(output,"가격부터 봤는데 [warm] 객실값이 잘못됐어요");
  assert.equal(env.ctx.canonicalTtsSpeech(output),env.ctx.canonicalTtsSpeech(input));
  assert.equal(env.ctx.removeGentleAudioTags("[Gentle, curious] 좋아요"),"[curious] 좋아요");
  assert.equal(env.ctx.removeGentleAudioTags("[speaking gently] 좋아요"),"좋아요");
  assert.equal(env.ctx.removeGentleAudioTags("[curious] 좋아요"),"[curious] 좋아요");
});

test("AI generated gentle tone is automatically removed before save",async()=>{
  const env=setup({ok:true,body:{
    text:"[gentle] 가격부터 봤는데 [warm, gentle] 객실값이 잘못됐어요",
    integrity:true
  }});
  await env.ctx.makeTtsTags();
  assert.equal(env.saved,1);
  assert.equal(env.state.ttsTagged,"가격부터 봤는데 [warm] 객실값이 잘못됐어요");
  assert.match(env.stat.textContent,/gentle 계열 태그를 제외/);
  assert.equal(env.ctx.tagsMatchScript(),true);
});

test("manual or stored gentle tags are rejected even if spoken text is unchanged",()=>{
  const env=setup();
  env.state.ttsTagSource=env.state.script;
  env.state.ttsTagged="[warm, gentle] 가격부터 봤는데 객실값이 잘못됐어요";
  assert.match(env.ctx.ttsTagLanguageError(env.state.ttsTagged),/gentle/);
  assert.equal(env.ctx.tagsMatchScript(),false);
  env.state.ttsTagged="[curious] 가격부터 봤는데 객실값이 잘못됐어요";
  assert.equal(env.ctx.tagsMatchScript(),true);
});

test("TTS must not run for a legacy gentle tag",async()=>{
  const env=setup();
  env.state.ttsTagged="[gentle] 가격부터 봤는데 객실값이 잘못됐어요";
  env.state.ttsTagSource=env.state.script;
  const vdstat={textContent:"",className:"status"};
  env.ctx.document.getElementById=id=>id==="vdstat"?vdstat:null;
  vm.runInNewContext(section("  async function makeTTS(){","  async function makeAudioProcessed(){"),env.ctx);
  await env.ctx.makeTTS();
  assert.equal(env.calls.length,0);
  assert.match(vdstat.textContent,/gentle/);
  assert.match(vdstat.className,/bad/);
});
