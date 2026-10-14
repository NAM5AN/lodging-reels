"use strict";
// No live services: every database/storage/Kling call is simulated.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const UID='11111111-2222-3333-4444-555555555555';
const plain=x=>JSON.parse(JSON.stringify(x));
function grab(name){
 const re=new RegExp('  (?:async )?function '+name+'\\('),m=re.exec(html);assert.ok(m,name);
 return html.slice(m.index,html.indexOf('\n  }\n',m.index)+5);
}
function element(global=true){
 const root=UID+'/'+(global?'_shared_elements':'hotelA')+'/element/';
 const el={key:global?'shared_hotelA_localK':'localK',name:'하린',desc:'',scope:global?'global':'local',
  front:{id:root+'front.jpg',w:900,h:1200},angles:[{id:root+'side.jpg',w:900,h:1200}]};
 if(global)Object.assign(el,{sourceProject:'hotelA',sourceKey:'localK'});
 el.kling={status:'ready',elementId:'111',sig:el.front.id+'|'+el.angles[0].id};return el;
}
function project(el){const pid=UID+'/hotelA/photo/o.jpg';return {id:'hotelA',name:'호텔',elements:el?[el]:[],photos:[{id:pid,w:900,h:1200}],
 edits:{[pid]:{id:UID+'/hotelA/edited/e.jpg'}},editSpecs:{[pid]:{prompt:'[하린]',vprompt:'[하린]가 웃어요',refs:[]}}};}
function harness(el=element(),opt={}){
 const db=opt.db||new Map([[el.key,plain(el)]]),calls=[],uploaded=[],removed=[],saves=[],toasts=[];
 let serial=0;
 const proj=project(el.scope==='global'?null:el);
 const ctx=vm.createContext({uid:UID,current:proj,projects:[proj],sharedElements:el.scope==='global'?[el]:[],sharedDeletedKeys:[],
  sharedLoaded:true,sharedSyncBusy:{},sharedLoadError:'',elemPhotoBusy:{},elemInflight:{},elemErrors:{},elemDrafts:{},
  clipPollTimer:null,console:{error(){},warn(){}},ELEM:{nameMax:20,descMax:100,maxAngles:3,minSide:300,maxRatio:2.5,giveUpMs:1800000},
  EDIT:{maxRefs:15},CLIP:{maxInputs:7,minSide:300,maxRatio:2.5},MENTION_RE:/\[([^\[\]\n]{1,30})\]/g,
  SUPA:{url:'https://mock.test',sharedTable:'shared'},FN:{clip:'https://mock.test/clip'},
  esc:x=>String(x??'').replace(/</g,'&lt;'),toast:x=>toasts.push(x),answer:true,confirm:()=>ctx.answer,
  newPath:(p,k,e)=>UID+'/'+p+'/'+k+'/new'+(++serial)+'.'+e,
  storeUpload:async(id,blob)=>{uploaded.push(id);return {id,sizeBytes:blob.size||1}},storeDelete:async id=>removed.push(id),
  shrink:async f=>({blob:{size:5},w:f.w,h:f.h}),persist:async p=>{saves.push(plain(p));return true},
  ensureClipPoll:()=>{ctx.poll=(ctx.poll||0)+1},sharedRefreshLive:()=>{},renderEdit:()=>{},elemRefreshLive:()=>{},renderClipsSoon:()=>{},
  api:async(url,opts={})=>{
   const body=opts.body?JSON.parse(opts.body):null;calls.push({url,method:opts.method,body});
   if(opt.fail) {const r=opt.fail(url,opts,body);if(r)return r;}
   if(url.includes('/rest/')){
    if(!opts.method)return {ok:true,json:async()=>Array.from(db).map(([key,data])=>({element_key:key,name:data.name,data:plain(data)}))};
    if(opts.method==='PATCH'){
     const cond=new URL(url).searchParams.get('data->>revision'),old=db.get(body.element_key);
     const match=old&&(cond==='is.null'?!old.revision:cond==='eq.'+old.revision);
     if(!match)return {ok:true,json:async()=>[]};
    }
    db.set(body.element_key,plain(body.data));return {ok:true,json:async()=>[{data:plain(body.data)}]};
   }
   if(body.action==='element_create'){
    assert.equal(db.get(el.key).kling.status,'pending','durable pending record BEFORE paid request');
    return {ok:true,status:200,text:async()=>JSON.stringify({operation:{taskId:'task1'}})};
   }
   if(body.action==='element_status')return {ok:true,status:200,text:async()=>JSON.stringify(ctx.result||{status:'ready',elementId:'222'})};
   throw Error('Unexpected API action '+JSON.stringify(body));
  }
 });
 const fns=['peekSpec','elemList','elemByKey','elemByName','elemPhotos','elemSig','elemNameProblem','elemState','elemStatusDetails','elemStatusRows',
 'persistSharedElement','loadSharedElements','publishSharedElement','elemPhotoLocked','elemPreparedPhoto','elemSavePhotoDraft',
 'sharedRegistrationHtml','sharedRegister','sharedCheck','elemPendingKeys','clipJobIds','clipPollTick',
 'mentionsOf','mentionedElements','replaceMentions','editRefPlan','clipPlan','clipHead','clipPromptText','clipDuration','clipRequest','elemDropPhoto'];
 vm.runInContext(fns.map(grab).join('\n'),ctx);
 return {ctx,el,proj,db,calls,uploaded,removed,saves,toasts};
}
const photo=()=>({blob:{size:123},w:900,h:1200});
async function change(t){const {ctx,el,proj}=t;await ctx.elemSavePhotoDraft(proj,el.key,ctx.elemSig(el),[photo(),el.angles[0]]);return ctx.elemByKey(proj,el.key)}

test('global photo replacement is atomic, keeps old assets, becomes stale and never calls Kling',async()=>{
 const t=harness(),old=plain(t.el),live=await change(t);
 assert.ok(live.front.id.startsWith(UID+'/_shared_elements/element/'));
 assert.deepEqual(plain(live.retiredPhotos),[old.front]);assert.deepEqual(plain(live.kling),old.kling);
 assert.equal(t.ctx.elemStatusDetails(t.proj,live).formal.label,'재등록 필요');assert.equal(t.ctx.elemState(t.proj,live),'stale');
 assert.deepEqual(t.removed,[]);assert.equal(t.calls.filter(c=>c.body?.action).length,0);
 assert.ok(live.revision);assert.equal(t.db.get(live.key).front.id,live.front.id);
});

test('local replacement uses project storage, persists the new snapshot and preserves existing output',async()=>{
 const t=harness(element(false)),before=plain(t.proj.edits),live=await change(t);
 assert.ok(live.front.id.startsWith(UID+'/hotelA/element/'));assert.equal(t.saves.length,1);
 assert.equal(t.saves[0].elements[0].front.id,live.front.id);assert.deepEqual(plain(t.proj.edits),before);
 assert.equal(t.ctx.elemState(t.proj,live),'stale');assert.equal(t.calls.length,0);
});

test('main-photo selection swaps existing photo order without upload or paid requests',async()=>{
 const t=harness(),{ctx,el}=t;
 await ctx.elemSavePhotoDraft(null,el.key,ctx.elemSig(el),[el.angles[0],el.front]);
 const live=ctx.elemByKey(null,el.key);assert.equal(live.front.id,el.angles[0].id);assert.equal(t.uploaded.length,0);
 assert.equal(ctx.elemState(null,live),'stale');assert.equal(t.calls.length,1);
});

test('keeping a single global photo is allowed for general use; all-global-photo deletion is blocked',async()=>{
 const t=harness(),{ctx,el}=t;
 await ctx.elemSavePhotoDraft(null,el.key,ctx.elemSig(el),[el.front]);
 const live=ctx.elemByKey(null,el.key);assert.equal(ctx.elemState(null,live),'local');assert.equal(ctx.elemStatusDetails(null,live).general,true);
 assert.doesNotMatch(ctx.sharedRegistrationHtml(live),/data-shared-register/);
 await assert.rejects(()=>ctx.elemSavePhotoDraft(null,el.key,ctx.elemSig(live),[]),/기준 사진 1장/);
});

test('unchanged draft performs no storage/database/Kling write',async()=>{
 const t=harness();assert.equal(await t.ctx.elemSavePhotoDraft(null,t.el.key,t.ctx.elemSig(t.el),[t.el.front,...t.el.angles]),false);
 assert.equal(t.calls.length,0);assert.equal(t.uploaded.length,0);
});

test('invalid size/ratio/count and changed snapshot are rejected before saving',async()=>{
 for(const item of [{blob:{},w:200,h:500},{blob:{},w:300,h:1000}]){const t=harness();await assert.rejects(()=>t.ctx.elemSavePhotoDraft(null,t.el.key,t.ctx.elemSig(t.el),[item]),/크기|비율/);assert.equal(t.calls.length,0);}
 const t=harness();await assert.rejects(()=>t.ctx.elemSavePhotoDraft(null,t.el.key,'old',[]),/변경/);
 await assert.rejects(()=>t.ctx.elemSavePhotoDraft(null,t.el.key,t.ctx.elemSig(t.el),Array(5).fill(photo())),/최대 4장/);
 await assert.rejects(()=>t.ctx.elemPreparedPhoto({w:200,h:500}),/300px/);
});

test('photo saves are blocked while registration or another photo save is running',async()=>{
 for(const mode of ['pending','upload','create']){const t=harness();if(mode==='pending')t.el.kling.status='pending';else if(mode==='upload')t.ctx.elemPhotoBusy[t.el.key]=true;else t.ctx.elemInflight[t.el.key]=true;
 await assert.rejects(()=>change(t),/등록 중/);assert.equal(t.calls.length,0);assert.equal(t.uploaded.length,0);}
});

test('definite database rejection cleans only NEW uploads, not old photos or Kling IDs',async()=>{
 const t=harness(element(),{fail:(u)=>u.includes('/rest/')?{ok:false,status:409,text:async()=>''}:null}),before=plain(t.el);
 await assert.rejects(()=>change(t),/같은 이름/);assert.deepEqual(t.removed,t.uploaded);assert.equal(t.removed.length,1);
 assert.deepEqual(plain(t.ctx.sharedElements[0]),before);assert.deepEqual(t.db.get(t.el.key),before);
});

test('ambiguous network failure does not delete uploads that a completed DB write might already reference',async()=>{
 const t=harness(element(),{fail:()=>{throw Error('network disconnected')}});
 await assert.rejects(()=>change(t),/network/);assert.equal(t.removed.length,0);assert.equal(t.uploaded.length,1);
 assert.equal(t.ctx.sharedElements[0].front.id,t.el.front.id);
});

test('failed local save leaves local element and old photos unchanged',async()=>{
 const t=harness(element(false)),before=plain(t.el);t.ctx.persist=async()=>false;
 await assert.rejects(()=>change(t),/저장 결과/);assert.deepEqual(plain(t.el),before);assert.equal(t.removed.length,0);
});

test('a stale second device cannot overwrite a newer common photo revision',async()=>{
 const first=harness(),second=harness(plain(first.el),{db:first.db});await change(first);
 await assert.rejects(()=>change(second),/다른 기기/);assert.equal(second.removed.length,1);
 assert.equal(first.db.get(first.el.key).revision,first.ctx.sharedElements[0].revision);
});

test('legacy project migration cannot overwrite a modified/re-registered common element',async()=>{
 const t=harness(),src=element(false);src.kling.elementId='OLD_LOCAL';const live=await change(t);
 t.calls.length=0;t.uploaded.length=0;assert.equal(await t.ctx.publishSharedElement(t.proj,src),true);
 assert.equal(t.calls.length,0);assert.equal(t.uploaded.length,0);assert.equal(t.ctx.sharedElements[0],live);
});

test('changed shared elements fall back to new general photos in EVERY lodging, never the old official ID',async()=>{
 const t=harness(),live=await change(t);
 for(const state of ['ready','pending','failed']){live.kling.status=state;
  for(const id of ['hotelA','hotelB']){const p=project();p.id=id;const pid=p.photos[0].id,req=t.ctx.clipRequest(p,pid);
   assert.deepEqual(plain(req.elements),[]);assert.deepEqual(plain(req.refs),[live.front.id]);assert.match(req.prompt,/@image_3/);
   assert.equal(t.ctx.editRefPlan(p,pid).ids[0],live.front.id);}
 }
});

test('cancelled re-registration and unchanged ready elements never call the paid endpoint',async()=>{
 const t=harness();await t.ctx.sharedRegister(t.el.key);assert.equal(t.calls.length,0);
 await change(t);t.calls.length=0;t.ctx.answer=false;await t.ctx.sharedRegister(t.el.key);assert.equal(t.calls.length,0);
});

test('explicit re-registration saves pending before one paid request and persists the task ID',async()=>{
 const t=harness();await change(t);t.calls.length=0;
 await Promise.all([t.ctx.sharedRegister(t.el.key),t.ctx.sharedRegister(t.el.key)]);
 assert.deepEqual(t.calls.filter(c=>c.body?.action).map(c=>c.body.action),['element_create']);
 const live=t.ctx.sharedElements[0];assert.equal(live.kling.status,'pending');assert.equal(live.kling.taskId,'task1');
 assert.equal(live.kling.elementId,'111');assert.equal(t.db.get(live.key).kling.taskId,'task1');
 const req=t.calls.find(c=>c.body?.action==='element_create').body;assert.equal(req.projectId,'_shared_elements');assert.equal(req.front,live.front.id);
});

test('two devices cannot submit duplicate re-registration: atomic revision claim gates paid request',async()=>{
 const a=harness();await change(a);const b=harness(plain(a.ctx.sharedElements[0]),{db:a.db});
 await Promise.all([a.ctx.sharedRegister(a.el.key),b.ctx.sharedRegister(b.el.key)]);
 assert.equal([...a.calls,...b.calls].filter(c=>c.body?.action==='element_create').length,1);
});

test('pending-save failure prevents Kling registration entirely',async()=>{
 const t=harness();await change(t);t.ctx.api=async()=>({ok:false,status:500,text:async()=>''});t.calls.length=0;
 await t.ctx.sharedRegister(t.el.key);assert.equal(t.calls.length,0);assert.equal(t.ctx.sharedElements[0].kling.status,'ready');
});

test('success enables new ID only after save; keeps old ID and pictures for in-flight generations',async()=>{
 const t=harness();await change(t);await t.ctx.sharedRegister(t.el.key);await t.ctx.sharedCheck(t.el.key);
 const live=t.ctx.sharedElements[0];assert.equal(t.ctx.elemState(t.proj,live),'ready');assert.equal(live.kling.elementId,'222');
 assert.deepEqual(plain(live.retiredElementIds),['111']);assert.equal(live.retiredPhotos.length,1);assert.deepEqual(t.removed,[]);
 assert.ok(!t.calls.some(c=>c.body?.action==='element_delete'));
 assert.deepEqual(plain(t.ctx.clipRequest(t.proj,t.proj.photos[0].id).elements),['222']);
});

test('backend status:error marks failure; the previous ID is retained but never used for changed photos',async()=>{
 const t=harness();await change(t);await t.ctx.sharedRegister(t.el.key);t.ctx.result={status:'error',message:'photo rejected'};
 await t.ctx.sharedCheck(t.el.key);const live=t.ctx.sharedElements[0];assert.equal(live.kling.status,'failed');assert.equal(live.kling.elementId,'111');
 assert.equal(t.ctx.elemStatusDetails(null,live).formal.label,'등록 실패');assert.deepEqual(plain(t.ctx.clipRequest(t.proj,t.proj.photos[0].id).elements),[]);
});

test('ready-result save failure never enables the unpersisted new ID',async()=>{
 const t=harness();await change(t);await t.ctx.sharedRegister(t.el.key);const orig=t.ctx.api;
 t.ctx.api=async(u,o)=>o?.method==='PATCH'?{ok:false,status:503,text:async()=>''}:orig(u,o);
 await t.ctx.sharedCheck(t.el.key);assert.equal(t.ctx.sharedElements[0].kling.status,'pending');assert.equal(t.ctx.sharedElements[0].kling.elementId,'111');
});

test('reload retains pending/failed/stale official-origin entries; resumes pending polling on home',async()=>{
 const t=harness();await change(t);await t.ctx.sharedRegister(t.el.key);t.ctx.current=null;await t.ctx.loadSharedElements();
 assert.equal(t.ctx.sharedElements.length,1);assert.equal(t.ctx.sharedElements[0].kling.status,'pending');assert.ok(t.ctx.poll>0);
 t.ctx.result={status:'error',message:'x'};await t.ctx.clipPollTick();assert.equal(t.ctx.sharedElements[0].kling.status,'failed');
 await t.ctx.loadSharedElements();assert.equal(t.ctx.sharedElements.length,1);assert.equal(t.ctx.sharedElements[0].kling.status,'failed');
});

test('timeout without task ID marks failure without automatically resubmitting a paid create',async()=>{
 const t=harness();t.el.kling={...t.el.kling,status:'pending',at:Date.now()-121000,taskId:null};
 t.db.set(t.el.key,plain(t.el));await t.ctx.sharedCheck(t.el.key);
 assert.equal(t.ctx.sharedElements[0].kling.status,'failed');assert.ok(!t.calls.some(c=>c.body?.action));
});

test('UI has draft save/cancel, per-photo replacement, primary selection, account-wide warning and mobile tap targets',()=>{
 assert.match(grab('elemPhotoEditorOpen'),/계정 공통 요소예요\. 저장하면 모든 숙소에 반영/);
 for(const name of ['data-photo-save','data-photo-cancel','data-photo-file','data-photo-add'])assert.ok(grab('elemPhotoEditorOpen').includes(name));
 for(const name of ['data-photo-replace','data-photo-front','data-photo-remove'])assert.ok(grab('elemPhotoEditorDraw').includes(name));
 assert.doesNotMatch(grab('elemPhotoEditorClose'),/persist|api\(|element_create/);
 assert.match(html,/\[data-element-photos\],\[data-shared-register\]\{min-height:44px/);
 assert.match(grab('sharedElementCard'),/data-element-photos/);assert.match(grab('elemCard'),/data-element-photos/);
});

test('all inline scripts parse after integration',()=>{
 for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
});

test("cancelling the native file picker never closes the unsaved element dialog",()=>{
 assert.match(grab("elemPhotoEditorOpen"),/addEventListener\("cancel",function\(ev\)\{if\(ev.target!==dialog\)return/);
});
