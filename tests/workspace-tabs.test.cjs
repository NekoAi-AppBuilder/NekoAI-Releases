const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');const {EventEmitter}=require('node:events');
const {WorkspaceRegistry}=require('../dist/main/workspaces/workspace-registry');
const {WorkspaceState}=require('../dist/main/workspaces/workspace-state');
const {WorkspaceIpc}=require('../dist/main/workspaces/workspace-ipc');
const {WorkspaceObjects,configureWorkspaceObjects,closeWorkspaceObjects,serializedObject}=require('../dist/main/workspaces/workspace-objects');
const {WorkspacePorts}=require('../dist/main/workspaces/workspace-ports');
const source=fs.readFileSync(path.join(__dirname,'../dist/main/workspaces/workspace-tabs.js'),'utf8');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'neko-tabs-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));for(const name of ['A','B'])fs.mkdirSync(path.join(root,name));
 const registry=new WorkspaceRegistry();let next=1;const views=[];const closed=[];let selected=null,confirmation=true,confirmations=0;let nextLoad=()=>Promise.resolve();
 class View{constructor(){this.visible=false;this.bounds={};this.children=[];this.webContents=new EventEmitter();Object.assign(this.webContents,{id:++next,sent:[],destroyed:false,getURL:()=>'',setWindowOpenHandler:()=>{},loadURL:async()=>{},loadFile:()=>nextLoad(),focus:()=>{},isDestroyed:()=>this.webContents.destroyed,close:()=>{this.webContents.destroyed=true},send:(...args)=>this.webContents.sent.push(args)});views.push(this)}setBackgroundColor(){}setVisible(value){this.visible=value}setBounds(bounds){this.bounds={...bounds}}addChildView(view){this.children.push(view)}removeChildView(view){this.children=this.children.filter(value=>value!==view)}}
 const rootSent=[];const window=new EventEmitter();Object.assign(window,{webContents:{id:1,send:(...args)=>rootSent.push(args)},isDestroyed:()=>false,getContentBounds:()=>({width:1600,height:1000}),contentView:{children:[],addChildView(view){this.children.push(view)},removeChildView(view){this.children=this.children.filter(value=>value!==view)}}});
 const module={exports:{}};vm.runInNewContext(source,{exports:module.exports,module,console,require:name=>name==='electron'?{WebContentsView:View}:require(name)});
 const host=new module.exports.WorkspaceTabs(window,registry,{preload:'fixture',index:'fixture',select:lease=>selected=lease,busy:()=>false,confirmClose:async()=>{confirmations++;return confirmation},close:async lease=>{closed.push(lease.workspaceId);registry.close(lease)}});
 return {setNextLoad:fn=>nextLoad=fn,root,registry,host,views,closed,window,rootSent,selected:()=>selected,confirm:value=>confirmation=value,confirmations:()=>confirmations};
}
test('opening B creates another live studio and preserves A view, draft and session',t=>{
 const f=fixture(t);f.host.newHome();const a=f.views[0];assert(f.host.routeOpen(a.webContents.id,path.join(f.root,'A'),'test'));const A=f.host.owner(a.webContents.id);f.registry.bindSession(A,'session-A');a.draft='unsent';
 assert.equal(f.host.routeOpen(a.webContents.id,path.join(f.root,'B'),'test'),false);const b=f.views[1];assert.notEqual(a,b);assert.equal(a.draft,'unsent');assert.equal(a.webContents.destroyed,false);assert.equal(f.registry.forSession('session-A').workspaceId,A.workspaceId);assert.equal(a.visible,false);assert.equal(b.visible,true);
});
test('reopening same project selects its existing studio and session',t=>{
 const f=fixture(t);f.host.newHome();const a=f.views[0];f.host.routeOpen(a.webContents.id,path.join(f.root,'A'),'test');const A=f.host.owner(a.webContents.id);f.registry.bindSession(A,'session-A');f.host.routeOpen(a.webContents.id,path.join(f.root,'B'),'test');
 assert.equal(f.host.routeOpen(f.views[1].webContents.id,path.join(f.root,'A','.'),'test'),false);assert.equal(f.views.length,2);assert.equal(f.selected().workspaceId,A.workspaceId);assert.equal(a.visible,true);
});
test('close B leaves A alive and reselects A with same geometry',async t=>{
 const f=fixture(t);f.host.newHome();const a=f.views[0];f.host.routeOpen(a.webContents.id,path.join(f.root,'A'),'test');const A=f.host.owner(a.webContents.id);f.host.routeOpen(a.webContents.id,path.join(f.root,'B'),'test');const B=f.host.owner(f.views[1].webContents.id);const bounds={...a.bounds};
 assert(await f.host.close(B.workspaceId));assert.equal(f.closed.length,1);assert.equal(f.closed[0],B.workspaceId);assert.equal(f.selected().workspaceId,A.workspaceId);assert.deepEqual(a.bounds,bounds);assert.equal(a.webContents.destroyed,false);
});
test('busy close can be cancelled without disposing the task',async t=>{
 const f=fixture(t);f.host.newHome();const a=f.views[0];f.host.routeOpen(a.webContents.id,path.join(f.root,'A'),'test');const A=f.host.owner(a.webContents.id);f.host.setBusy(a.webContents.id,true);f.confirm(false);
 assert.equal(await f.host.close(A.workspaceId),false);assert.equal(f.closed.length,0);assert.equal(f.confirmations(),1);assert.equal(a.webContents.destroyed,false);
});
test('busy close with approval disposes only origin and returns to Home',async t=>{
 const f=fixture(t);f.host.newHome();const a=f.views[0];f.host.routeOpen(a.webContents.id,path.join(f.root,'A'),'test');const A=f.host.owner(a.webContents.id);f.host.setBusy(a.webContents.id,true);
 assert(await f.host.close(A.workspaceId));assert.equal(f.confirmations(),1);assert.equal(f.host.snapshot().tabs.length,1);assert.equal(f.host.snapshot().tabs[0].projectPath,null);
});
test('bootstrap stays available to its renderer until initialization is acknowledged',t=>{
 const f=fixture(t);f.host.newHome();f.host.routeOpen(f.views[0].webContents.id,path.join(f.root,'A'),'test');f.host.routeOpen(f.views[0].webContents.id,path.join(f.root,'B'),'test');
 const b=f.views[1];assert.equal(f.host.bootstrap(f.views[0].webContents.id),null);assert.equal(f.host.bootstrap(b.webContents.id).projectPath,path.join(f.root,'B'));assert.equal(f.host.bootstrap(b.webContents.id).projectPath,path.join(f.root,'B'));f.host.finishBootstrap(b.webContents.id);assert.equal(f.host.bootstrap(b.webContents.id),null);assert.equal(f.host.trusted(99999),false);
});
test('native Preview parent is specific to each studio and uses local coordinates',t=>{
 const f=fixture(t);f.host.newHome();const a=f.views[0];f.host.routeOpen(a.webContents.id,path.join(f.root,'A'),'test');const A=f.host.owner(a.webContents.id);f.host.routeOpen(a.webContents.id,path.join(f.root,'B'),'test');const B=f.host.owner(f.views[1].webContents.id);
 const preview={bounds:{x:16,y:130,width:1000,height:700}};f.host.content(A).addChildView(preview);assert.equal(f.host.content(B).children.length,0);f.host.select(A.workspaceId);assert.equal(f.host.content(A).children[0],preview);assert.equal(preview.bounds.y,130);assert.equal(a.bounds.y,0);
});
test('bootstrap state and IPC cannot fall back to selected project',async t=>{
 const f=fixture(t);const A=f.registry.open(path.join(f.root,'A'));const state=new WorkspaceState(f.registry,()=>({value:'empty'}),()=>A);state.get(A).value='A';const router=new WorkspaceIpc(f.registry,()=>A);router.register('read',()=>state.current().value);
 const value=await f.registry.runBootstrap(async()=>{await Promise.resolve();return router.current('read',{},[])});assert.equal(value,'empty');assert.equal(state.get(A).value,'A');
});
test('integration instances and callbacks remain owned by A after B selection',async t=>{
 const f=fixture(t);const A=f.registry.open(path.join(f.root,'A')),B=f.registry.open(path.join(f.root,'B'));let selected=A;configureWorkspaceObjects(f.registry,()=>selected);let count=0;class Manager extends EventEmitter{constructor(){super();this.id=++count;this.project=null}async set(value){await Promise.resolve();this.project=value;this.emit('state',value)}}
 const pool=new WorkspaceObjects(()=>new Manager(),{events:['state']});const seen=[];pool.proxy.on('state',value=>seen.push({value,owner:f.registry.current().workspaceId}));let resume;const gate=new Promise(r=>resume=r);
 const pending=f.registry.run(A,async()=>{const manager=pool.proxy;await gate;await manager.set('A')});selected=B;await f.registry.run(B,()=>pool.proxy.set('B'));resume();await pending;
 assert.equal(f.registry.run(A,()=>pool.proxy.project),'A');assert.equal(f.registry.run(B,()=>pool.proxy.project),'B');assert.equal(seen.find(event=>event.value==='A').owner,A.workspaceId);
});
test('closing A disposes its integrations without affecting B and late events drop',async t=>{
 const f=fixture(t);const A=f.registry.open(path.join(f.root,'A')),B=f.registry.open(path.join(f.root,'B'));configureWorkspaceObjects(f.registry,()=>B);const disposed=[];class Manager extends EventEmitter{}
 const pool=new WorkspaceObjects(()=>new Manager(),{events:['state'],dispose:object=>disposed.push(object)});const {concreteWorkspaceObject}=require('../dist/main/workspaces/workspace-objects');const a=f.registry.run(A,()=>concreteWorkspaceObject(pool.proxy));const b=f.registry.run(B,()=>concreteWorkspaceObject(pool.proxy));let events=0;pool.proxy.on('state',()=>events++);
 await closeWorkspaceObjects(A);f.registry.close(A);a.emit('state');assert.equal(events,0);assert.deepEqual(disposed,[a]);assert.equal(f.registry.run(B,()=>concreteWorkspaceObject(pool.proxy)),b);
});
test('shared vault operations are serialized and preserve both project entries',async()=>{
 let active=0,max=0;const raw={data:{},async save(key){active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));this.data[key]=true;active--}};const vault=serializedObject(raw);await Promise.all([vault.save('A'),vault.save('B')]);assert.equal(max,1);assert.deepEqual(raw.data,{A:true,B:true});
});
test('simultaneous reservations choose different ports before either engine listens',async()=>{
 const ports=new WorkspacePorts(),A={workspaceId:'A',generation:1},B={workspaceId:'B',generation:1};const [a,b]=await Promise.all([ports.reserve(45100,A),ports.reserve(45100,B)]);assert.notEqual(a,b);ports.releaseAll(A);const next=await ports.reserve(45100,A);assert.equal(next,a);ports.releaseAll(A);ports.releaseAll(B);
});



test('tab selection updates every studio without a global header or reserved top space',t=>{
 const f=fixture(t);f.host.newHome();const a=f.views[0];f.host.routeOpen(a.webContents.id,path.join(f.root,'A'),'test');const A=f.host.owner(a.webContents.id);f.host.routeOpen(a.webContents.id,path.join(f.root,'B'),'test');
 for(const view of f.views)view.webContents.sent.length=0;
 f.host.select(A.workspaceId);
 for(const view of f.views){const [channel,state]=view.webContents.sent.at(-1);assert.equal(channel,'tabs:changed');assert.equal(state.selected,A.workspaceId);assert.equal(view.bounds.y,0);assert.equal(view.bounds.height,1000);}
 assert.equal(f.rootSent.length,0);
});



test('closing the final studio marks only its sender retired and returns to a live Home',async t=>{
 const f=fixture(t);f.host.newHome();const a=f.views[0],sender=a.webContents.id;
 f.host.routeOpen(sender,path.join(f.root,'A'),'test');const A=f.host.owner(sender);
 assert.equal(f.host.isRetired(sender),false);assert.equal(f.host.isRetired(99999),false);
 await f.host.close(A.workspaceId);
 assert.equal(f.host.isRetired(sender),true);assert.equal(f.host.trusted(sender),false);
 const home=f.views.at(-1);assert.equal(f.host.isRetired(home.webContents.id),false);
 assert.equal(f.host.owner(home.webContents.id),null);assert.equal(home.visible,true);
});


test('Home navigation keeps the current project visible until Home has loaded',async t=>{
 const f=fixture(t);f.host.newHome();const a=f.views[0];f.host.routeOpen(a.webContents.id,path.join(f.root,'A'),'test');const A=f.host.owner(a.webContents.id);
 let ready;f.setNextLoad(()=>new Promise(resolve=>ready=resolve));const id=f.host.newHome();const home=f.views.at(-1);
 assert.equal(a.visible,true);assert.equal(home.visible,false);assert.equal(f.selected().workspaceId,A.workspaceId);
 ready();await new Promise(setImmediate);assert.equal(a.visible,false);assert.equal(home.visible,true);assert.equal(f.host.snapshot().selected,id);assert.equal(a.webContents.destroyed,false);
});
test('delayed Home cannot steal selection after the user selects another project',async t=>{
 const f=fixture(t);f.host.newHome();const a=f.views[0];f.host.routeOpen(a.webContents.id,path.join(f.root,'A'),'test');const A=f.host.owner(a.webContents.id);
 let ready;f.setNextLoad(()=>new Promise(resolve=>ready=resolve));f.host.newHome();f.host.select(A.workspaceId);ready();await new Promise(setImmediate);
 assert.equal(f.selected().workspaceId,A.workspaceId);assert.equal(a.visible,true);
});
test('a failed Home load leaves the project visible and is replaced on retry',async t=>{
 const f=fixture(t);f.host.newHome();const a=f.views[0];f.host.routeOpen(a.webContents.id,path.join(f.root,'A'),'test');
 f.setNextLoad(()=>Promise.reject(new Error('fixture navigation failed')));f.host.newHome();await new Promise(setImmediate);const failed=f.views.at(-1);
 assert.equal(a.visible,true);assert.equal(failed.visible,false);
 f.setNextLoad(()=>Promise.resolve());f.host.newHome();await new Promise(setImmediate);assert.equal(failed.webContents.destroyed,true);assert.equal(f.views.at(-1).visible,true);
});
