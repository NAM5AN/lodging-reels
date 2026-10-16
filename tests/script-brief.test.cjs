"use strict";
// ③ 대본 — 여행 설정(brief)을 먼저 정하고, 만든 뒤 뜻을 검토해서 고친다.
// 사례별 금지 규칙이 아니라 '한 여행에서 나온 대본인가 / 숙소 정보와 맞는가' 를 일반 기준으로 본다.
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
function grab(sig){
  const s=html.indexOf("  function "+sig);
  assert.ok(s>0,sig+" exists");
  return html.slice(s,html.indexOf("\n  }\n",s)+5);
}
const plain=v=>JSON.parse(JSON.stringify(v));
const checks=section("  var RE_WON=","  // ---------- 영상 만들기 ----------");
const prompt=section("  function scriptPrompt(){","  // ---------- 검사 ----------");

const FACTS={id:"p1",name:"바다 호텔",area:"전라남도 어딘가군",access:"해변 근처",type:"호텔",
  people:"기준 성인 2명",price:"300,900원",keyword:"정보",
  perks:"수영장\n워터파크\n키즈풀\n무료 주차",
  memo:"추가인원 요금: 1인 50,000원 (36개월 미만 무료)\n조식 25,000원"};
const BRIEF={party:"어른 2명",priceBasis:"30만원대, 어른 2명 1박 정가",paid:["조식","추가 인원"],
  premise:"경치만 보러 갔는데 물놀이만 하다 옴",flow:["도착","워터파크","해변"],unclear:["할인 금액의 뜻"]};
const GEN={brief:BRIEF,cover:["전라남도 호텔 1박인데","체크아웃이 아까웠어요"],
  script:["경치 보러 간 건데","수영복을 안 챙겼어요","워터파크로 직행","바로 보내드릴게요"]};

function sandbox(replies,extra){
  const calls=[], stat={textContent:"",className:"status"};
  const ctx=Object.assign({
    uid:"test-user", FN:{ai:"https://example.invalid/functions/v1/lodging-reels-ai"},
    current:Object.assign({},FACTS),
    document:{getElementById:id=>id==="scstat"?stat:null, createElement:()=>({})},
    targetLines:()=>4, scriptPrompt:()=>"P", areaNarrow:()=>[],
    scStat:()=>({text:"형식 검사 통과.",bad:false}),
    scriptLines:()=>String(ctx.current.script||"").split("\n").map(x=>x.trim()).filter(Boolean),
    invalidateTtsTags:()=>{}, persist:async()=>{ ctx.saved=(ctx.saved||0)+1; return true; }, renderEdit:()=>{},
    api:async(url,opts)=>{
      const body=JSON.parse(opts.body);
      calls.push(body);
      const next=replies.shift();
      if(!next) throw new Error("unexpected model call: "+body.purpose);
      if(next.__fail) return {ok:false, text:async()=>JSON.stringify({error:next.__fail})};
      return {ok:true, text:async()=>JSON.stringify({text:JSON.stringify(next)})};
    },
    setTimeout:(f)=>f()
  },extra||{});
  vm.runInNewContext(checks,ctx);
  return {ctx,calls,stat,replies};
}

test("prompt decides one trip first, ranks facts and consistency above placement rules",()=>{
  const b=prompt.indexOf("# 먼저 이 여행을 정하세요"), q=prompt.indexOf("# 우선순위"), n=prompt.indexOf("# 분량");
  assert.ok(b>0 && q>b && n>q,"brief → priority → 분량 order");
  ["party","priceBasis","paid","premise","flow","unclear"].forEach(k=>assert.ok(prompt.includes("- "+k+":"),k));
  assert.match(prompt,/1\. 사실[\s\S]*2\. 일관성[\s\S]*3\. 흐름[\s\S]*4\. 아래의 분량/);
  assert.ok(prompt.includes("앞뒤와 안 이어지는 줄을 끼워 넣지 마세요"));
  assert.ok(prompt.includes("일행이 숙소의 기준 인원과 다르면"));
  assert.ok(prompt.includes("커버에서 한 반응이나 결론을 본문 어디에서도 다시 말하지 마세요"));
  assert.ok(prompt.includes('{"brief":{"party"'));
  // 돈 드는 항목을 정규식으로 짐작하던 코드는 없다
  assert.ok(!/paidTerms|PAID_STOP|돈이 드는 항목: /.test(html));
});

test("makeScript: brief first, review finds a contradiction, the line is rewritten in content, re-review is clean",async()=>{
  const env=sandbox([GEN,
    {issues:[{line:2,kind:"일관성",why:"수영복이 없는데 워터파크로 감",fix:"물놀이를 한 쪽으로"},
             {line:9,kind:"사실",why:"없는 줄",fix:"-"},
             {line:2,kind:"흐름",why:"중복",fix:"-"}]},
    {fixed:{"2":"물에서 안 나왔어요"}},
    {issues:[]}]);
  await env.ctx.makeScript();
  assert.deepEqual(env.calls.map(c=>c.purpose),["script_brief","script_review","script_repair","script_review"]);
  assert.equal(env.calls[0].max_tokens,8000);
  const rv=env.calls[1].prompt;
  assert.ok(rv.includes("# 숙소 정보") && rv.includes("제약 조건") && rv.includes("추가인원 요금"));
  assert.ok(rv.includes("일행: 어른 2명") && rv.includes("돈 드는 것: 조식, 추가 인원"));
  assert.ok(rv.includes("2. 수영복을 안 챙겼어요"));
  ["1. 사실","2. 일관성","3. 오해","4. 흐름"].forEach(k=>assert.ok(rv.includes(k),k));
  const rp=env.calls[2];
  assert.deepEqual(rp.repair_indices,[2]);
  assert.ok(rp.prompt.includes("내용을 바꿔서라도 해결하세요"));
  assert.ok(rp.prompt.includes("[일관성] 수영복이 없는데 워터파크로 감 / 고칠 방향: 물놀이를 한 쪽으로"));
  assert.ok(rp.prompt.includes("숙소명: 바다 호텔") && rp.prompt.includes("일행: 어른 2명"));
  const c=env.ctx.current;
  assert.equal(c.script,"경치 보러 간 건데\n물에서 안 나왔어요\n워터파크로 직행\n바로 보내드릴게요");
  assert.deepEqual(plain(c.scriptBrief),BRIEF);
  assert.deepEqual(plain(c.scriptReview.issues),[]);
  assert.equal(c.scriptReview.src,c.script);
  assert.equal(c.scriptReview.cover,"전라남도 호텔 1박인데\n체크아웃이 아까웠어요");
  assert.equal(c.scriptReview.error,"");
});

test("makeScript stops when a fix does not reduce issues and keeps what is left for the screen",async()=>{
  const env=sandbox([GEN,
    {issues:[{line:3,kind:"오해",why:"일행 추가요금이 빠짐",fix:"어른 기준이라고"}]},
    {fixed:{"3":"워터파크부터 갔어요"}},
    {issues:[{line:4,kind:"흐름",why:"갑자기 끝남",fix:"이어지게"}]}]);
  await env.ctx.makeScript();
  assert.deepEqual(env.calls.map(c=>c.purpose),["script_brief","script_review","script_repair","script_review"]);
  const left=plain(env.ctx.current.scriptReview.issues);
  assert.equal(left.length,1);
  assert.equal(left[0].i,3);
  assert.equal(left[0].kind,"흐름");
  assert.equal(left[0].why,"갑자기 끝남");
});

test("a content fix that breaks the form gets one form repair before the re-review",async()=>{
  const env=sandbox([GEN,
    {issues:[{line:2,kind:"일관성",why:"w",fix:"f"}]},
    {fixed:{"2":"수영복 없이 갔는데 물놀이만 하다 왔어요"}},
    {fixed:{"2":"물에서 안 나왔어요"}},
    {issues:[]}]);
  await env.ctx.makeScript();
  assert.deepEqual(env.calls.map(c=>c.purpose),["script_brief","script_review","script_repair","script_repair","script_review"]);
  assert.ok(!env.calls[3].prompt.includes("숙소명:"),"form-only repair does not need the facts");
  assert.match(env.calls[3].prompt,/너무 길어요/);
  assert.equal(env.ctx.current.script.split("\n")[1],"물에서 안 나왔어요");
});

test("if the review call fails the script is still saved and the screen says the review is missing",async()=>{
  const env=sandbox([GEN,{__fail:"upstream_error"},{__fail:"upstream_error"}]);
  await env.ctx.makeScript();
  assert.equal(env.ctx.current.script.split("\n").length,4);
  assert.equal(env.ctx.current.scriptReview.error,"upstream_error");
  assert.deepEqual(plain(env.ctx.current.scriptBrief),BRIEF);
});

test("old answers without a brief still work",async()=>{
  const env=sandbox([{cover:GEN.cover,script:GEN.script},{issues:[]}]);
  await env.ctx.makeScript();
  assert.equal(env.ctx.current.scriptBrief,null);
  assert.ok(env.calls[1].prompt.includes("정해 둔 설정 없음"));
});

test("reviewScript keeps one valid issue per line and fixes unknown kinds",async()=>{
  const env=sandbox([{issues:[{line:0,kind:"사실",why:"a",fix:""},{line:5,kind:"사실",why:"b",fix:""},
    {line:2,kind:"이상함",why:"c",fix:""},{line:2,kind:"사실",why:"d",fix:""},{line:1,kind:"사실",why:" e ",fix:"g"}]}]);
  const out=plain(await env.ctx.reviewScript(["가","나","다","라"],"",null));
  assert.deepEqual(out,[
    {i:0,text:"가",content:true,kind:"사실",why:"e",fix:"g"},
    {i:1,text:"나",content:true,kind:"흐름",why:"c",fix:""}]);
});

test("normalizeBrief fixes the shape and rejects empty answers",()=>{
  const {ctx}=sandbox([]);
  assert.equal(ctx.normalizeBrief(null),null);
  assert.equal(ctx.normalizeBrief([]),null);
  assert.equal(ctx.normalizeBrief({paid:["a"]}),null);
  const b=plain(ctx.normalizeBrief({party:" 둘 ",paid:"조식",flow:["a","",null],unclear:null,extra:1}));
  assert.deepEqual(b,{party:"둘",priceBasis:"",paid:["조식"],premise:"",flow:["a"],unclear:[]});
});

test("paid-item warning uses the brief's list, not a regex guess",()=>{
  const {ctx}=sandbox([]);
  const lines=["조식까지 챙겨 먹고","조식은 따로 내고","사 우나로 마무리"];
  assert.ok(!ctx.scriptWarnings(lines).some(w=>/돈 드는 항목/.test(w)),"no brief → no guess");
  ctx.current.scriptBrief={paid:["조식","사우나","발레 파킹"]};
  const w=ctx.scriptWarnings(lines).filter(x=>/돈 드는 항목/.test(x));
  assert.equal(w.length,1);
  assert.match(w[0],/조식/);
  assert.match(w[0],/사우나/,"spaces do not hide a term");
  assert.ok(!/발레/.test(w[0]));
});

test("reviewNow only reports on a hand-edited script and records what it looked at",async()=>{
  const env=sandbox([{issues:[{line:1,kind:"사실",why:"w",fix:"f"}]}]);
  env.ctx.current.script="손으로 고친 줄\n둘째 줄";
  env.ctx.current.cover="위\n아래";
  env.ctx.current.scriptBrief=BRIEF;
  await env.ctx.reviewNow();
  assert.equal(env.calls[0].purpose,"script_review");
  assert.ok(env.calls[0].prompt.includes("가격 기준: 30만원대"));
  assert.equal(env.ctx.current.script,"손으로 고친 줄\n둘째 줄");
  const rv=plain(env.ctx.current.scriptReview);
  assert.equal(rv.src,"손으로 고친 줄\n둘째 줄");
  assert.equal(rv.issues[0].why,"w");
  assert.equal(env.ctx.saved,1);
});

test("screen shows the brief, unclear points, issues and a stale note, all escaped",()=>{
  const ctx={current:{script:"a\nb<i>",cover:"c",
      scriptBrief:Object.assign({},BRIEF,{party:"어른 <2>명"}),
      scriptReview:{src:"a\nold",cover:"c",issues:[{i:1,text:"b<i>",kind:"흐름",why:"w<x>",fix:"f"}],error:""}}};
  vm.runInNewContext(grab("esc(s){")+grab("scriptLines(){")+grab("scriptBriefHtml(){")+"\nthis.h=scriptBriefHtml();",ctx);
  const h=ctx.h;
  assert.ok(h.includes("AI가 이해한 설정"));
  assert.ok(h.includes("어른 &lt;2&gt;명") && !h.includes("<2>"));
  assert.ok(h.includes("돈 드는 것") && h.includes("조식, 추가 인원"));
  assert.ok(h.includes("확인 필요") && h.includes("할인 금액의 뜻"));
  assert.ok(h.includes("내용 검토: 1줄 확인 필요") && h.includes("검토한 뒤 대본이 바뀌었어요"));
  assert.ok(h.includes("2줄 · 흐름") && h.includes("w&lt;x&gt;"));
  assert.ok(h.includes('id="rvscript"') && h.includes("내용 검토 다시"));
  ctx.current.scriptReview={src:"a\nb<i>",cover:"c",issues:[],error:""};
  vm.runInNewContext("this.h=scriptBriefHtml();",ctx);
  assert.ok(ctx.h.includes("내용 검토: 문제 없음") && !ctx.h.includes("바뀌었어요"));
  ctx.current.script="";
  vm.runInNewContext("this.h=scriptBriefHtml();",ctx);
  assert.equal(ctx.h,"");
});
