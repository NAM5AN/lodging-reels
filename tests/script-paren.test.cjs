"use strict";
// ⑤ 대본 — '(1박 기준)' '(1인 기준)' 같은 괄호 메모가 대본에 남지 않는지.
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const {test}=require("node:test");

const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");

function section(start,end){
  const i=html.indexOf(start), j=html.indexOf(end,i+start.length);
  assert.ok(i>=0 && j>i,"expected source block: "+start);
  return html.slice(i,j);
}
// 검사 함수부터 makeScript 끝까지. 모델 호출은 api 를 바꿔 끼워 흉내 낸다.
const checks=section("  var RE_WON=","  // ---------- 영상 만들기 ----------");
const prompt=section("  function scriptPrompt(){","  // ---------- 검사 ----------");

function sandbox(replies){
  const calls=[], stat={textContent:"",className:"status"};
  const ctx={
    uid:"test-user", FN:{ai:"https://example.invalid/functions/v1/lodging-reels-ai"},
    current:{id:"p1",name:"숙소",perks:"수영장",people:"2인",keyword:"특가",memo:""},
    document:{getElementById:id=>id==="scstat"?stat:null},
    targetLines:()=>4, scriptPrompt:()=>"P", areaNarrow:()=>[],
    scStat:()=>({text:"",bad:false}),
    invalidateTtsTags:()=>{}, persist:async()=>true, renderEdit:()=>{},
    api:async(url,opts)=>{
      const body=JSON.parse(opts.body);
      calls.push(body);
      const next=replies.shift();
      assert.ok(next,"unexpected model call: "+body.purpose);
      return {ok:true, text:async()=>JSON.stringify({text:JSON.stringify(next)})};
    },
    setTimeout:(f)=>f()
  };
  vm.runInNewContext(checks,ctx);
  return {ctx,calls,stat};
}

const PAREN=/[()（）]/;
const FIRST={cover:["주말에 가봤어요","진짜예요"],
  script:["가격부터 봤는데","19만원대 (2인 기준)","(1박 기준)","댓글 남겨주세요"]};

test("prompt no longer asks for bracket notes and every example is bracket-free",()=>{
  assert.ok(!prompt.includes("괄호로 짧게 달아주세요"));
  assert.ok(!prompt.includes("16자까지"));
  assert.ok(!prompt.includes("금액 줄 괄호에"));
  assert.ok(!prompt.includes("아는 범위까지만 괄호에"));
  assert.ok(prompt.includes("괄호는 어느 줄에도 쓰지 마세요"));
  prompt.split("\n").filter(l=>l.includes("맞음:")).forEach(l=>{
    const good=l.slice(l.indexOf("맞음:")).split("틀림:")[0];
    assert.ok(!PAREN.test(good),"correct example has a bracket: "+good);
  });
  // 인원 기준은 괄호가 아니라 말로
  assert.ok(prompt.includes("금액 줄에 이 인원을 괄호 없이 말로 넣으세요"));
});

test("lineProblems flags any bracket and no longer gives bracket lines a 20-char allowance",()=>{
  const {ctx}=sandbox([]);
  const probs=ctx.lineProblems(["가격부터 봤는데","3만원대 (1박)","(1인 기준)","둘이 1박에 19만원대"],"");
  assert.deepEqual(JSON.parse(JSON.stringify(probs.map(p=>p.i))),[1,2]);
  probs.forEach(p=>{
    assert.ok(p.tag.includes("괄호"));
    assert.match(p.why,/괄호/);
  });
  const long=ctx.lineProblems(["19만원대부터 (2인 기준, 주중)"],"")[0];
  assert.match(long.why,/12자 이내로/);
});

test("dropParens removes notes, keeps the words of a bracket-only line and never drops a cut",()=>{
  const {ctx}=sandbox([]);
  const out=ctx.dropParens(["3만원대부터 (와우할인가)","(1박 기준) 19만원대","(1인 기준)",
    "19만원대（2인）가능","괄호 없는 줄","조식 (유료) 있어요","가격은(1박)19만원대"]);
  assert.deepEqual(JSON.parse(JSON.stringify(out)),
    ["3만원대부터","19만원대","1인 기준","19만원대 가능","괄호 없는 줄","조식 있어요","가격은 19만원대"]);
  out.forEach(t=>assert.ok(!PAREN.test(t)));
});

test("scriptWarnings reports any bracket line, including hand-edited scripts",()=>{
  const {ctx}=sandbox([]);
  const w=ctx.scriptWarnings(["가격부터 봤는데","19만원대 (2인)","댓글 남겨주세요"]);
  assert.ok(w.includes("괄호 들어간 줄 1개"),w.join(" / "));
  assert.ok(!ctx.scriptWarnings(["가격부터 봤는데","둘이 1박에 19만원대","댓글 남겨주세요"])
    .some(x=>/괄호/.test(x)));
});

test("makeScript sends bracket lines to repair with a no-bracket rule",async()=>{
  const env=sandbox([FIRST,{fixed:{"2":"둘이 1박에 19만원대","3":"1박에 이 가격"}}]);
  await env.ctx.makeScript();
  assert.equal(env.calls.length,2);
  assert.equal(env.calls[1].purpose,"script_repair");
  assert.deepEqual(env.calls[1].repair_indices,[2,3]);
  assert.match(env.calls[1].prompt,/괄호 \( \) 는 쓰지 마세요/);
  assert.equal(env.ctx.current.script,"가격부터 봤는데\n둘이 1박에 19만원대\n1박에 이 가격\n댓글 남겨주세요");
});

test("makeScript strips brackets the model refuses to drop, keeping the cut count",async()=>{
  const env=sandbox([FIRST,{fixed:{"2":"19만원대 (2인)","3":"(1박)"}}]);
  await env.ctx.makeScript();
  const lines=env.ctx.current.script.split("\n");
  assert.equal(lines.length,4);
  assert.deepEqual(lines,["가격부터 봤는데","19만원대","1박","댓글 남겨주세요"]);
  assert.ok(!PAREN.test(env.ctx.current.script));
  assert.ok(!/괄호/.test(env.stat.textContent),"left-over summary must not mention brackets");
});

test("extend prompt also forbids brackets",async()=>{
  const env=sandbox([{cover:["주말에 가봤어요","진짜예요"],script:["가격부터 봤는데","둘이 1박에 19만원대"]},
    {more:["댓글에 특가","바로 보내드려요"]}]);
  await env.ctx.makeScript();
  assert.equal(env.calls[1].purpose,"script_extend");
  assert.match(env.calls[1].prompt,/괄호 \( \) 는 쓰지 마세요/);
});
