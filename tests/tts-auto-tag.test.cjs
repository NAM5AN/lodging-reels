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
