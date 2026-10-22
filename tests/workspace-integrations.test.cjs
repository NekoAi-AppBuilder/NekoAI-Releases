const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {WorkspaceRegistry}=require('../dist/main/workspaces/workspace-registry');
const {WorkspaceIpc}=require('../dist/main/workspaces/workspace-ipc');
const source=fs.readFileSync(path.join(__dirname,'../dist/main/main.js'),'utf8');
function helper(name,ctx){const start=source.indexOf('function '+name+'(');assert(start>=0);const end=source.indexOf('\n}',start)+2;ctx.sendWorkspaceRenderer ??= (...args)=>ctx.mainWindow?.webContents.send(...args);return vm.runInNewContext(source.slice(start,end)+';'+name,ctx)}
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'neko-integration-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const name of ['A','B'])fs.mkdirSync(path.join(root,name));
 const registry=new WorkspaceRegistry();const A=registry.open(path.join(root,'A')),B=registry.open(path.join(root,'B'));
 registry.bindSession(A,'session-A');registry.bindSession(B,'session-B');let selected=A;
 const router=new WorkspaceIpc(registry,()=>selected);return {registry,A,B,router,select:x=>selected=x,getSelected:()=>selected};
}
function proposalBridge(f,proposal){const handlers={};const wrapper=helper('handleWorkspaceProposalIpc',{
 workspaceRegistry:f.registry,workspaceIpc:f.router,migration_manager_1:{migrationManager:{getProposal:()=>proposal}},
 electron_1:{ipcMain:{handle:(channel,handler)=>handlers[channel]=handler}}
});return {handlers,wrapper}}

test('migration reply captures proposal A even when B is selected during await',async t=>{
 const f=fixture(t);const {wrapper,handlers}=proposalBridge(f,{sessionId:'session-A'});let resume;
 const barrier=new Promise(r=>resume=r);let seen;
 wrapper('migration:test',async()=>{await barrier;seen=f.registry.current().workspaceId});
 const pending=handlers['migration:test']({}, {proposalId:'proposal-A'});f.select(f.B);resume();await pending;
 assert.equal(seen,f.A.workspaceId);
});
test('explicit workspace B cannot approve proposal owned by A',t=>{
 const f=fixture(t);let calls=0;const {wrapper}=proposalBridge(f,{sessionId:'session-A'});
 wrapper('migration:test',()=>calls++);
 assert.throws(()=>f.router.invoke(f.B,'migration:test',{},[{proposalId:'proposal-A'}]),/outro workspace/);assert.equal(calls,0);
});
test('closed proposal owner and missing origin are rejected before mutation',t=>{
 const f=fixture(t);let calls=0;const {wrapper,handlers}=proposalBridge(f,{sessionId:'session-A'});
 wrapper('migration:test',()=>calls++);f.registry.close(f.A);f.select(f.B);
 assert.throws(()=>handlers['migration:test']({}, {proposalId:'proposal-A'}),/workspace aberto/);assert.equal(calls,0);
 const empty=proposalBridge(f,null);empty.wrapper('migration:missing',()=>calls++);
 assert.throws(()=>empty.handlers['migration:missing']({},{}),/sessão de origem/);assert.equal(calls,0);
});
test('Skills resolves A inside captured context while selected project is B',t=>{
 const f=fixture(t);f.select(f.B);const resolve=helper('resolveWorkspaceProjectPath',{
 getWorkspaceLease:()=>f.registry.contextLease()??f.getSelected(),workspaceRegistry:f.registry,
 node_fs_1:{default:fs},node_path_1:{default:path},process
 });
 assert.equal(f.registry.run(f.A,()=>resolve()),f.A.projectPath);
 assert.equal(f.registry.run(f.A,()=>resolve(path.join(f.A.projectPath,'.'))),f.A.projectPath);
 assert.throws(()=>f.registry.run(f.A,()=>resolve(f.B.projectPath)),/outro workspace/);
});
test('closed Skills context cannot fall back to selected B',t=>{
 const f=fixture(t);const resolve=helper('resolveWorkspaceProjectPath',{
 getWorkspaceLease:()=>f.registry.contextLease()??f.getSelected(),workspaceRegistry:f.registry,
 node_fs_1:{default:fs},node_path_1:{default:path},process
 });
 f.registry.run(f.A,()=>{f.registry.close(f.A);f.select(f.B);assert.throws(()=>resolve(),/encerrado/)});
});
function actualReply(f,options={}){
 let callback;const requests=[];const errors=[];const target=Object.freeze({workspaceId:f.A.workspaceId,engine:'A'});
 const ctx={
 handleWorkspaceProposalIpc:(_channel,fn)=>callback=fn,
 license_manager_1:{licenseManager:{assertAccess:()=>{}}},migration_manager_1:{migrationManager:{
  getProposal:()=>({id:'proposal-A',sessionId:'session-A',permissionId:'permission-A'}),
  replyProposal:async()=>{f.select(f.B);await Promise.resolve();return {success:true}}
 }},captureSessionService:()=>target,
 taskRecords:new Map(),resolveRootSessionId:x=>x,setTaskState:()=>{},
 workspaceServices:{headers:()=>({'x-opencode-directory':'A'}),request:async(captured,endpoint,init)=>{
  requests.push({captured,endpoint,init});if(options.fail)throw new Error('stale engine');
  return {status:requests.length===1?(options.status??200):200,ok:requests.length===1?!(options.status>=400):true};
 }},opencodeAuthHeaders:()=>({}),console:{log:()=>{},warn:(...args)=>errors.push(args)},encodeURIComponent,JSON,Error
 };
 const start=source.indexOf('handleWorkspaceProposalIpc("supabase:reply-migration",');assert(start>=0);
 const end=source.indexOf('\n});',start)+4;vm.runInNewContext(source.slice(start,end),ctx);
 return {callback,requests,errors,target};
}
test('actual migration permission reply uses captured engine A after selection B',async t=>{
 const f=fixture(t);const x=actualReply(f);await x.callback({}, {proposalId:'proposal-A',approved:true});
 assert.equal(x.requests.length,1);assert.equal(x.requests[0].captured,x.target);
 assert.equal(x.requests[0].endpoint,'/session/session-A/permissions/permission-A');
 assert.equal(JSON.parse(x.requests[0].init.body).response,'once');
});
test('actual migration reply falls back only for an unavailable permission route',async t=>{
 const f=fixture(t);for(const status of [404,405]){
  const x=actualReply(f,{status});await x.callback({}, {proposalId:'proposal-A',approved:false});
  assert.equal(x.requests.length,2);assert.equal(x.requests[1].captured,x.target);
  assert.equal(x.requests[1].endpoint,'/permission/permission-A/reply');
  assert.equal(JSON.parse(x.requests[1].init.body).response,'reject');
 }
});
test('transport failure or HTTP 500 never retries permission on another route',async t=>{
 const f=fixture(t);for(const options of [{fail:true},{status:500}]){
  const x=actualReply(f,options);await x.callback({}, {proposalId:'proposal-A',approved:true});
  assert.equal(x.requests.length,1);assert.equal(x.errors.length,1);
 }
});


test('migration events name owner A even when B is selected and preserve payload',t=>{
 const f=fixture(t);f.select(f.B);const sent=[];
 const forward=helper('forwardWorkspaceMigrationEvent',{
  workspaceRegistry:f.registry,mainWindow:{isDestroyed:()=>false,webContents:{send:(channel,event)=>sent.push({channel,event})}}
 });
 const proposal={id:'proposal-A',sessionId:'session-A'};
 for(const payload of [proposal,{proposal,approved:true}])forward('replied',payload);
 assert.equal(sent.length,2);assert.equal(sent[0].event.workspaceId,f.A.workspaceId);
 assert.equal(sent[1].event.workspaceGeneration,f.A.generation);
 assert.equal(sent[1].event.payload.proposal,proposal);
});
test('migration events from closed or unknown sessions never fall back to B',t=>{
 const f=fixture(t);const sent=[];const forward=helper('forwardWorkspaceMigrationEvent',{
  workspaceRegistry:f.registry,mainWindow:{isDestroyed:()=>false,webContents:{send:(...args)=>sent.push(args)}}
 });
 f.registry.close(f.A);f.select(f.B);
 forward('completed',{proposal:{sessionId:'session-A'}});forward('asked',{sessionId:'unknown'});forward('failed',{});
 assert.equal(sent.length,0);
});
