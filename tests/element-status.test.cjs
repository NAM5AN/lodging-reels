"use strict";
// ⑨: '일반 요소 사용 가능' and 'Kling 정식 요소 등록 완료' must be independent.
const {test}=require("node:test"), assert=require("node:assert/strict"),
  fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
function grab(sig){
  let n=html.indexOf("  function "+sig);
  if(n<0)n=html.indexOf("  async function "+sig);
  assert.ok(n>0,sig+" exists");
  let end=html.indexOf("\n  }\n",n);
  assert.ok(end>n,sig+" ends");
  return html.slice(n,end+5);
}
const FNS=["elemList(proj){","elemByName(proj, name){","elemPhotos(el){","elemSig(el){",
  "elemNameProblem(proj, name, selfKey){","elemState(proj, el){",
  "elemStatusDetails(proj, el){","elemStatusRows(proj, el){","elemStateHtml(el){"];
function harness(el,globals=[]){
  const proj={id:"p_solo",elements:el?[el]:[]};
  const ctx=vm.createContext({
    sharedElements:globals,sharedDeletedKeys:[],current:proj,ELEM:{nameMax:20},
    elemErrors:{},esc:(s)=>String(s==null?"":s).replace(/</g,"&lt;")
  });
  vm.runInContext(FNS.map(grab).join("\n"),ctx);
  return {ctx,proj};
}
const makeEl=(other={})=>Object.assign({
  key:"el1",name:"아이",desc:"",front:{id:"uid/project/element/face.jpg"},angles:[]
},other);
function snap(ctx,el){
  const res=ctx.elemStatusDetails(ctx.current,el);
  const html=ctx.elemStatusRows(ctx.current,el);
  return {res:JSON.parse(JSON.stringify(res)),html};
}
function ready(el){
  const images=[el.front].concat(el.angles||[]).filter(Boolean).map(p=>p.id);
  el.kling={status:"ready",elementId:"9918",sig:images.join("|")};
  return el;
}

test("empty element: BOTH general and Kling registration are unavailable",()=>{
  const el=makeEl({name:"",front:null}),{ctx}=harness(el);
  const {res,html}=snap(ctx,el);
  assert.equal(res.general,false);
  assert.equal(res.formal.label,"미등록");
  assert.match(html,/일반 요소/);
  assert.match(html,/준비 필요/);
  assert.match(html,/Kling 정식 요소/);
  assert.match(html,/이름과 기준 사진 1장 필요/);
  assert.doesNotMatch(html,/✓ 등록 완료/);
});

test("one photo + name and NO description: general registration complete; Kling explicitly unregistered",()=>{
  const el=makeEl(),{ctx}=harness(el);
  const {res,html}=snap(ctx,el);
  assert.equal(res.general,true);
  assert.equal(res.state,"local");
  assert.equal(res.formal.label,"미등록");
  assert.match(res.formal.detail,/추가 각도 사진 1장 이상 필요/);
  assert.match(html,/일반 요소/);
  assert.match(html,/✓ 등록 완료 · 사용 가능/);
  assert.match(html,/사진 가공·영상화에서 \[아이\] 사용 가능/);
  assert.match(html,/Kling 정식 요소/);
  assert.match(html,/미등록/);
  const card=ctx.elemStateHtml(el);
  assert.doesNotMatch(card,/data-elreg/,"no misleading Kling registration button before second photo");
  assert.match(card,/data-eldel/);
  assert.doesNotMatch(card,/등록 중|등록 실패/);
});

test("front + angle: general ready; native Kling still unregistered but registration button becomes available",()=>{
  const el=makeEl({angles:[{id:"uid/project/element/angle.jpg"}]}),{ctx}=harness(el);
  const {res,html}=snap(ctx,el);
  assert.equal(res.general,true);
  assert.equal(res.formal.label,"미등록");
  assert.match(html,/정식 등록 가능 · Kling 등록 버튼/);
  assert.match(ctx.elemStateHtml(el),/Kling 정식 등록/);
});

test("native registration in progress: general still ready, Kling marked 등록 중",()=>{
  const el=makeEl({angles:[{id:"uid/project/element/side.jpg"}],
    kling:{status:"pending",taskId:"task1",at:123}}),{ctx}=harness(el);
  const {res,html}=snap(ctx,el);
  assert.equal(res.general,true);
  assert.equal(res.formal.label,"등록 중");
  assert.match(html,/Kling 서버 등록을 기다리는 중/);
  assert.match(html,/✓ 등록 완료 · 사용 가능/);
  assert.doesNotMatch(ctx.elemStateHtml(el),/data-elreg/);
});

test("native registration failed: general still ready; Kling status never appears as complete",()=>{
  const el=makeEl({angles:[{id:"uid/project/element/side.jpg"}],
    kling:{status:"failed",msg:"face not clear"}}),{ctx}=harness(el);
  const {res,html}=snap(ctx,el);
  assert.equal(res.general,true);
  assert.equal(res.formal.label,"등록 실패");
  assert.match(html,/face not clear/);
  assert.match(ctx.elemStateHtml(el),/Kling 다시 등록/);
});

test("ready native element with matching signature and an ID: BOTH statuses complete",()=>{
  const el=ready(makeEl({angles:[{id:"uid/project/element/side.jpg"}]})),{ctx}=harness(el);
  const {res,html}=snap(ctx,el);
  assert.equal(res.general,true);
  assert.equal(res.formal.label,"등록 완료");
  assert.match(html,/영상화에서 정식 Kling 요소 ID 사용/);
  assert.equal((html.match(/등록 완료/g)||[]).length,2);
  assert.doesNotMatch(ctx.elemStateHtml(el),/data-elreg/);
});

test("ready flag alone without element ID cannot falsely claim native completion",()=>{
  const el=ready(makeEl({angles:[{id:"uid/project/element/side.jpg"}]}));
  el.kling.elementId="";
  const {ctx}=harness(el);
  const {res}=snap(ctx,el);
  assert.notEqual(res.formal.label,"등록 완료");
});

test("changed angle requires Kling re-registration but general photo reference remains usable",()=>{
  const el=ready(makeEl({angles:[{id:"uid/project/element/side.jpg"}]})),{ctx}=harness(el);
  el.angles.push({id:"uid/project/element/new-side.jpg"});
  const {res}=snap(ctx,el);
  assert.equal(res.general,true);
  assert.equal(res.formal.label,"재등록 필요");
  assert.match(ctx.elemStateHtml(el),/Kling 다시 등록/);
  el.angles=[];
  const after=snap(ctx,el);
  assert.equal(after.res.general,true,"single photo still works for general use");
  assert.equal(after.res.formal.label,"재등록 필요","cannot claim registered when all angles removed");
});

test("account-global element reports both types available in any lodging without another upload",()=>{
  const el=ready(makeEl({scope:"global",angles:[{id:"uid/_shared_elements/element/side.jpg"}]}));
  const {ctx}=harness(null,[el]);
  const {res,html}=snap(ctx,el);
  assert.equal(res.general,true);
  assert.equal(res.formal.label,"등록 완료");
  assert.match(html,/모든 숙소에서 같은 Kling 요소 ID 사용/);
  assert.equal(ctx.elemByName(ctx.current,"아이").key,el.key);
});

test("statuses update in place for name or Kling polling without wiping whole card",()=>{
  const refresh=grab("elemRefreshLive(){");
  const output=grab("elemStateHtml(el){");
  assert.match(refresh,/box\.innerHTML=elemStateHtml\(el\)/);
  assert.match(output,/elemStatusRows\(current,el\)/);
  assert.match(output,/data-elreg/);
  assert.match(output,/data-eldel/);
});

test("main and project shared listings show both statuses",()=>{
  const main=grab("sharedManagementSection(){"),project=grab("sharedElementCard(el){");
  assert.match(main,/sharedRegistrationHtml\(el\)/);
  assert.match(grab("sharedRegistrationHtml(el){"),/elemStatusRows\(\{elements:\[\]\},el\)/);
  assert.match(project,/sharedRegistrationHtml\(el\)/);
  assert.match(html,/class="elem-statuses"/);
});
