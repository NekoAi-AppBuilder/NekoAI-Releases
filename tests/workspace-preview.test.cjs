const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');const {EventEmitter}=require('node:events');
const {WorkspaceRegistry}=require('../dist/main/workspaces/workspace-registry.js');
const {WorkspaceState,scopedFields}=require('../dist/main/workspaces/workspace-state.js');
const {WorkspaceEvents}=require('../dist/main/workspaces/workspace-events.js');
const {WorkspaceVisibility}=require('../dist/main/workspaces/workspace-visibility.js');
const {WorkspaceIpc}=require('../dist/main/workspaces/workspace-ipc.js');
const code=fs.readFileSync(path.join(__dirname,'../dist/main/main.js'),'utf8');
function load(name,context){const start=code.indexOf('function '+name+'(');assert(start>=0,name);const end=code.indexOf('\n}',start)+2;return vm.runInNewContext(code.slice(start,end)+';'+name,context)}
function ipc(channel,context){const start=code.indexOf('handleWorkspaceIpc("'+channel+'"');assert(start>=0,channel);const end=code.indexOf('\n});',start)+4;let handler;vm.runInNewContext(code.slice(start,end),{...context,handleWorkspaceIpc:(_name,fn)=>{handler=fn}});return handler}
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'neko-preview-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const dir of ['A','B'])fs.mkdirSync(path.join(root,dir));const registry=new WorkspaceRegistry(),A=registry.open(path.join(root,'A')),B=registry.open(path.join(root,'B'));
 let selected=A;const factory=load('createWorkspaceTaskState',{Map,Set});const states=new WorkspaceState(registry,factory,()=>selected),runtime=scopedFields(()=>states.current());
 const visibility=new WorkspaceVisibility(registry);visibility.select(A);const sent=[],disposers=new Map();
 class FakeView{
  constructor(){this.visible=false;this.bounds={x:0,y:0,width:1,height:1};this.radius=0;this.webContents=new EventEmitter();const wc=this.webContents;wc.destroyed=false;wc.url='http://127.0.0.1:51001/';wc.isDestroyed=()=>wc.destroyed;wc.setWindowOpenHandler=()=>{};wc.getURL=()=>wc.url;wc.close=()=>{wc.destroyed=true};wc.loadURL=async url=>{wc.url=url;wc.emit('did-finish-load')};}
  setVisible(value){this.visible=value}setBounds(value){this.bounds={...value}}getBounds(){return {...this.bounds}}setBorderRadius(value){this.radius=value}
 }
 const children=[];const mainWindow={isDestroyed:()=>false,webContents:{isDestroyed:()=>false,id:1,getZoomFactor:()=>1.25,send:(channel,event)=>sent.push({channel,event})},contentView:{children,addChildView:view=>{if(!children.includes(view))children.push(view)},removeChildView:view=>{const i=children.indexOf(view);if(i>=0)children.splice(i,1)}}};
 const context={injectPreviewScrollbar:async()=>true,sendWorkspaceRenderer:(channel,event)=>sent.push({channel,event}),workspaceContentView:()=>mainWindow.contentView,workspaceWebContents:()=>mainWindow.webContents,Map,Set,console:{log(){},warn(){}},electron_1:{WebContentsView:FakeView},workspaceRegistry:registry,workspaceRuntime:runtime,workspaceVisibility:visibility,workspaceEvents:new WorkspaceEvents(registry),mainWindow,
  getWorkspaceLease:()=>registry.contextLease()??selected,currentWorkspaceLease:A,
  ownWorkspaceResource:(lease,kind,resource,dispose)=>{assert.equal(kind,'preview-view');disposers.set(resource,{lease,dispose})},forgetWorkspaceResource:resource=>disposers.delete(resource),
  isAllowedInternalPreviewUrl:value=>new URL(value).hostname==='127.0.0.1',previewServerOriginMatches:(a,b)=>new URL(a).origin===new URL(b).origin,previewUrlsMatch:(a,b)=>a===b,
  preview_routes_1:{routeFromUrl:url=>new URL(url).pathname},sanitizeExternalPreviewUrl:value=>value,logSafeText:value=>value
 };
 for(const name of ['bindWorkspaceCallback','emitWorkspacePreviewEvent','logInternalPreview','emitInternalPreviewRoute','detachInternalPreviewView','ensureInternalPreviewView'])context[name]=load(name,context);
 return {registry,A,B,states,runtime,visibility,sent,context,mainWindow,disposers,select:lease=>{selected=lease;context.currentWorkspaceLease=lease;visibility.select(lease)}};
}

test('actual Preview state factory separates sessions, URLs, dropdowns and restart handles',t=>{
 const {states,A,B}=fixture(t);const a=states.get(A),b=states.get(B);a.previewState.url='http://localhost:51001';a.activePreviewSessionId=8;a.internalPreviewOverlayActive=true;a.previewRoutesCache={routes:['A']};
 assert.equal(b.previewState.url,null);assert.equal(b.activePreviewSessionId,0);assert.equal(b.internalPreviewOverlayActive,false);assert.equal(b.previewRoutesCache,null);assert.notEqual(a.previewState,b.previewState);
});

test('selecting B hides A without changing geometry or reloading',t=>{
 const f=fixture(t);const a=f.registry.run(f.A,()=>f.context.ensureInternalPreviewView()),b=f.registry.run(f.B,()=>f.context.ensureInternalPreviewView());
 a.setBounds({x:20,y:40,width:1000,height:700});f.visibility.request(f.A,true);f.visibility.request(f.B,true);assert.equal(a.visible,true);assert.equal(b.visible,false);
 const before=a.getBounds();f.select(f.B);assert.equal(a.visible,false);assert.equal(b.visible,true);assert.deepEqual(a.getBounds(),before);assert.equal(a.webContents.getURL(),'http://127.0.0.1:51001/');
});

test('an overlay in inactive A never hides B or exposes A',t=>{
 const f=fixture(t);const a=f.registry.run(f.A,()=>f.context.ensureInternalPreviewView()),b=f.registry.run(f.B,()=>f.context.ensureInternalPreviewView());f.visibility.request(f.A,true);f.visibility.request(f.B,true);f.select(f.B);
 f.visibility.overlay(f.A,true);f.visibility.overlay(f.A,false);assert.equal(a.visible,false);assert.equal(b.visible,true);
 f.visibility.overlay(f.B,true);assert.equal(b.visible,false);f.visibility.overlay(f.B,false);assert.equal(b.visible,true);
});

test('explicit visible=false survives selection changes',t=>{
 const f=fixture(t);const a=f.registry.run(f.A,()=>f.context.ensureInternalPreviewView());f.visibility.request(f.A,true);f.visibility.request(f.A,false);f.select(f.B);f.select(f.A);assert.equal(a.visible,false);
});

test('native page callbacks retain A origin while B is selected',t=>{
 const f=fixture(t);const a=f.registry.run(f.A,()=>f.context.ensureInternalPreviewView());f.select(f.B);a.webContents.emit('did-navigate-in-page',{},'http://127.0.0.1:51001/admin',true);
 const event=f.sent.find(x=>x.event.type==='preview.route-changed');assert.equal(event.event.properties.workspaceId,f.A.workspaceId);assert.equal(event.event.properties.path,'/admin');
});

test('late native callback after closing A cannot target selected B',t=>{
 const f=fixture(t);const a=f.registry.run(f.A,()=>f.context.ensureInternalPreviewView());f.registry.close(f.A);f.select(f.B);a.webContents.emit('did-finish-load');assert.equal(f.sent.length,0);
});

test('disposing A native view removes only its own child',async t=>{
 const f=fixture(t);const a=f.registry.run(f.A,()=>f.context.ensureInternalPreviewView()),b=f.registry.run(f.B,()=>f.context.ensureInternalPreviewView());f.mainWindow.contentView.addChildView(a);f.mainWindow.contentView.addChildView(b);f.select(f.B);
 await f.disposers.get(a).dispose();assert.equal(a.webContents.destroyed,true);assert.equal(b.webContents.destroyed,false);assert.deepEqual(f.mainWindow.contentView.children,[b]);
});

test('actual native sync preserves 20px corners, zoom and overlay geometry',async t=>{
 const f=fixture(t);const handler=ipc('preview:internalSync',f.context);const state=f.states.get(f.A);state.activePreviewSessionId=1;state.previewState.url='http://127.0.0.1:51001';
 const args={session:1,url:'http://127.0.0.1:51001',visible:true,bounds:{x:400,y:120,width:1000,height:600}};
 await f.registry.run(f.A,()=>handler({},args));const view=state.internalPreviewView;const before=JSON.stringify(view.getBounds());assert.equal(view.radius,25);assert.equal(view.getBounds().x,500);assert.equal(view.getBounds().width,1250);
 const overlay=ipc('preview:internalOverlay',f.context);await f.registry.run(f.A,()=>overlay({},true));assert.equal(view.visible,false);await f.registry.run(f.A,()=>overlay({},false));assert.equal(view.visible,true);assert.equal(JSON.stringify(view.getBounds()),before);
});

test('explicit IPC captures A across await even after selecting B',async t=>{
 const f=fixture(t);const router=new WorkspaceIpc(f.registry,()=>f.A);let resume;const barrier=new Promise(r=>{resume=r});
 router.register('preview:test',async()=>{await barrier;return f.registry.current().workspaceId});const pending=router.invoke(f.A,'preview:test',{},[]);f.select(f.B);resume();assert.equal(await pending,f.A.workspaceId);
});

test('legacy IPC captures selected workspace at entry',async t=>{
 const f=fixture(t);let selected=f.A;const router=new WorkspaceIpc(f.registry,()=>selected);let resume;const barrier=new Promise(r=>{resume=r});router.register('preview:test',async()=>{await barrier;return f.registry.current().workspaceId});
 const pending=router.current('preview:test',{},[]);selected=f.B;resume();assert.equal(await pending,f.A.workspaceId);
});

test('explicit IPC rejects stale leases, unknown channels and malformed arguments',t=>{
 const f=fixture(t);const router=new WorkspaceIpc(f.registry,()=>f.A);router.register('preview:test',()=>true);
 assert.throws(()=>router.invoke(f.A,'app:arbitrary',{},[]));assert.throws(()=>router.invoke(f.A,'preview:test',{},null));assert.throws(()=>router.register('preview:test',()=>false));
 f.registry.close(f.A);assert.throws(()=>router.invoke(f.A,'preview:test',{},[]));
});

test('visibility rejects a replacement until its previous native view is forgotten',t=>{
 const f=fixture(t);const a=f.registry.run(f.A,()=>f.context.ensureInternalPreviewView());assert.throws(()=>f.visibility.track(f.A,{setVisible(){}}));f.visibility.forget(f.A,a);f.visibility.track(f.A,{setVisible(){}});
});


test('overlay capture uses the styled native page without changing its bounds or visibility',async t=>{
 const f=fixture(t);const view=f.registry.run(f.A,()=>f.context.ensureInternalPreviewView());
 view.setBounds({x:500,y:150,width:1250,height:750});f.visibility.request(f.A,true);
 const order=[];const frame={};view.webContents.mainFrame=frame;
 f.context.injectPreviewScrollbar=async value=>{assert.equal(value,frame);order.push('style')};
 view.webContents.capturePage=async()=>{order.push('capture');return {isEmpty:()=>false,getScaleFactors:()=>[1,2],toDataURL:()=> 'data:image/png;base64,native-A'}};
 const handler=ipc('preview:internalCapture',f.context);const before=JSON.stringify(view.getBounds());
 const result=await f.registry.run(f.A,()=>handler({}));
 assert.deepEqual(order,['style','capture']);assert.equal(result.dataUrl,'data:image/png;base64,native-A');
 assert.equal(JSON.stringify(result.bounds),before);assert.equal(JSON.stringify(view.getBounds()),before);assert.equal(view.visible,true);assert.equal(result.zoomFactor,1.25);
});


test('native Preview attaches to the window content root, never below a studio WebContentsView',()=>{
 const root={children:[]},studio={children:[]};
 const owner=load('workspaceContentView',{mainWindow:{contentView:root},workspaceTabs:{content:()=>studio},getWorkspaceLease:()=>({workspaceId:'A',generation:1})});
 assert.equal(owner(),root);assert.notEqual(owner(),studio);
});


test('late overlay and capture safely ignore a native view whose webContents is already released',async t=>{
 const f=fixture(t);f.states.get(f.A).internalPreviewView={webContents:undefined};
 const overlay=ipc('preview:internalOverlay',f.context),capture=ipc('preview:internalCapture',f.context);
 const result=await f.registry.run(f.A,()=>overlay({},false));assert.equal(result.ok,false);
 assert.equal(await f.registry.run(f.A,()=>capture({})),null);
});
