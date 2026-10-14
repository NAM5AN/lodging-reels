"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
const inline=html.match(/<script>\s*([\s\S]*?)\s*<\/script>/);
assert.ok(inline,"main inline script exists");
const js=inline[1];
function functionSource(name){
  const from=js.indexOf("  function "+name+"(");
  assert.ok(from>=0,name+" exists");
  const to=js.indexOf("\n  }\n",from);
  assert.ok(to>from,name+" function closes");
  return js.slice(from,to+5);
}

test("photo viewer is a keyboard-accessible overlay with an X control",()=>{
  assert.match(html,/id="photoLightbox"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*hidden/);
  assert.match(html,/id="lbClose"[^>]*aria-label="사진 닫기"/);
  assert.match(html,/\.photo-lightbox\[hidden\]\{display:none\}/);
  assert.match(js,/previewClose\.addEventListener\("click",closePhotoPreview\)/);
  assert.match(js,/if\(ev\.key==="Escape"\)/);
  assert.match(js,/document\.body\.style\.overflow="hidden"/);
  assert.match(js,/document\.body\.style\.overflow=previewState\.priorOverflow/);
});
test("all gallery, original, edited, reference, and rendered-cover photos can be viewed",()=>{
  assert.match(js,/previewImg\(blobUrl\(it\.id\),\(i\+1\)\+"번 사진"\)/);
  assert.match(js,/previewImg\(blobUrl\(p\.id\),\(i\+1\)\+"번 원본"\)/);
  assert.match(js,/previewImg\(blobUrl\(e\.id\),\(i\+1\)\+"번 가공 결과"\)/);
  assert.match(js,/previewImg\(blobUrl\(r\.id\),/);
  // ⑪ 썸네일은 전체 영상에서 고른 자막 없는 프레임을 Canvas로 미리 보여 준다.
  assert.match(js,/id="thumbframe"/);
  assert.match(js,/class="tprev"/);
  assert.match(js,/view\.addEventListener\("click"/);
  assert.match(js,/view\.addEventListener\("keydown"/);
  assert.match(js,/tabindex="0"/);
});
test("cut selection and photo reordering still use their original controls",()=>{
  assert.match(js,/class="cut-look" data-preview-url=/);
  assert.match(js,/class="cstrip-look" data-preview-url=/);
  assert.match(js,/d\.querySelectorAll\("button\[data-pi\]"\)/);
  assert.match(js,/if\(cutIdx<0\) current\.coverPhoto=pi/);
  assert.match(js,/data-mv="-1"/);
  assert.match(js,/data-del="1"/);
});
test("mouse wheel, pointer dragging, and two-finger zoom are enabled without page scrolling",()=>{
  assert.match(html,/\.photo-lightbox \.lb-stage\{[^}]*touch-action:none/);
  assert.match(js,/previewStage\.addEventListener\("wheel"/);
  assert.match(js,/Math\.exp\(-ev\.deltaY\*\.002\)/);
  assert.match(js,/\},\{passive:false\}\)/);
  assert.match(js,/previewStage\.addEventListener\("pointerdown"/);
  assert.match(js,/previewStage\.addEventListener\("pointermove"/);
  assert.match(js,/previewStage\.addEventListener\("pointerup",previewRelease\)/);
  assert.match(js,/previewState\.scale\*newDist\/oldDist/);
  assert.match(js,/target\.setPointerCapture\(ev\.pointerId\)/);
});
test("tapping outside the enlarged image closes it; movement is not mistaken for a tap",()=>{
  assert.match(js,/if\(ev\.target===lightbox\)closePhotoPreview\(\)/);
  assert.match(js,/if\(ev\.target===previewStage\)closePhotoPreview\(\)/);
  assert.match(js,/previewState\.blockClickUntil=Date\.now\(\)\+350/);
});
test("zoom remains between 1× and 8× with drag bounds at image edges",()=>{
  const stage={clientWidth:400,clientHeight:300,
    getBoundingClientRect(){return {left:0,top:0,width:400,height:300};}};
  const state={baseW:400,baseH:300,scale:1,x:0,y:0};
  const context=vm.createContext({
    previewState:state,previewStage:stage,lightbox:{hidden:false},
    previewDraw(){}, Math
  });
  vm.runInContext(functionSource("previewConstrain")+"\n"+functionSource("previewZoomAt"),context);
  vm.runInContext("previewZoomAt(3,200,150);",context);
  assert.equal(state.scale,3);
  assert.equal(state.x,0);
  assert.equal(state.y,0);
  vm.runInContext("previewZoomAt(100,100,100);",context);
  assert.equal(state.scale,8,"upper bound");
  assert.ok(Math.abs(state.x)<=1400 && Math.abs(state.y)<=1050,"translation bounded");
  vm.runInContext("previewZoomAt(0,200,150);",context);
  assert.equal(state.scale,1,"minimum scale");
  assert.equal(state.x,0);
  assert.equal(state.y,0);
});
test("inline browser script parses",()=>{
  assert.doesNotThrow(()=>new vm.Script(js));
});
