const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { WorkspaceRegistry } = require('../dist/main/workspaces/workspace-registry.js');
const { WorkspaceState, scopedCollection, scopedFields } = require('../dist/main/workspaces/workspace-state.js');
const { WorkspaceEvents } = require('../dist/main/workspaces/workspace-events.js');
const { WorkspaceIpc } = require('../dist/main/workspaces/workspace-ipc.js');
const { normalizeOpenCodeEvent, clearStatusCacheForSession } = require('../dist/main/events/normalizer.js');
const { resolveRootSessionId } = require('../dist/main/session-tree.js');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = new WorkspaceRegistry(); const a = path.join(root,'A'), b = path.join(root,'B'); fs.mkdirSync(a);fs.mkdirSync(b);
  const A=registry.open(a),B=registry.open(b);registry.bindSession(A,'session-A');registry.bindSession(B,'session-B');
  let selected=A;
  const states=new WorkspaceState(registry,()=>({tasks:new Map(),retries:new Set(),cache:new Map(),parents:new Map(),engine:null,ready:false}),()=>selected);
  return { registry,A,B,states,select:lease=>{selected=lease},events:new WorkspaceEvents(registry) };
}

test('async task mutations remain in A after selecting B',async t=>{
 const {registry,A,B,states,select}=fixture(t);const tasks=scopedCollection(()=>states.current().tasks);
 let resume;const barrier=new Promise(r=>{resume=r});
 const pending=registry.run(A,async()=>{tasks.set('task','running');await barrier;tasks.set('task','completed')});
 select(B);tasks.set('task','waiting_for_user');resume();await pending;
 assert.equal(states.get(A).tasks.get('task'),'completed');assert.equal(states.get(B).tasks.get('task'),'waiting_for_user');
});

test('clear and Set operations affect only their scoped bucket',t=>{
 const {registry,A,B,states}=fixture(t);const tasks=scopedCollection(()=>states.current().tasks),retries=scopedCollection(()=>states.current().retries);
 for(const lease of [A,B])registry.run(lease,()=>{tasks.set('same-key','value');retries.add('retry')});
 registry.run(A,()=>{tasks.clear();retries.clear()});
 assert.equal(states.get(A).tasks.size,0);assert.equal(states.get(B).tasks.size,1);assert.equal(states.get(B).retries.size,1);
});

test('Map iterators and size bind to owning workspace',t=>{
 const {registry,A,B,states}=fixture(t);const tasks=scopedCollection(()=>states.current().tasks);
 states.get(A).tasks.set('A',1);states.get(B).tasks.set('B',2);
 assert.deepEqual(registry.run(A,()=>[...tasks.entries()]),[['A',1]]);
 assert.deepEqual(registry.run(B,()=>[...tasks.keys()]),['B']);assert.equal(registry.run(B,()=>tasks.size),1);
});

test('a closed async context cannot fall back to selected B',async t=>{
 const {registry,A,B,states,select}=fixture(t);let resume;const barrier=new Promise(r=>{resume=r});
 const pending=registry.run(A,async()=>{await barrier;states.current().tasks.set('late',1)});
 registry.close(A);states.discard(A);select(B);resume();await assert.rejects(pending,/encerrado/);
 assert.equal(states.get(B).tasks.size,0);
});

test('engine pointer and readiness fields follow scope across await',async t=>{
 const {registry,A,B,states,select}=fixture(t);const fields=scopedFields(()=>states.current());
 const engineA={pid:1},engineB={pid:2};registry.run(A,()=>{fields.engine=engineA;fields.ready=true});
 select(B);fields.engine=engineB;fields.ready=false;
 const actual=await registry.run(A,async()=>{await Promise.resolve();return [fields.engine,fields.ready]});
 assert.deepEqual(actual,[engineA,true]);assert.equal(fields.engine,engineB);assert.equal(fields.ready,false);
});

test('status deduplication is independent for two projects including default session key',t=>{
 const {states,A,B}=fixture(t);const event={type:'session.status',properties:{status:{type:'busy'}}};
 assert(normalizeOpenCodeEvent(event,states.get(A).cache));assert.equal(normalizeOpenCodeEvent(event,states.get(A).cache),null);
 assert(normalizeOpenCodeEvent(event,states.get(B).cache));clearStatusCacheForSession('session-A',states.get(A).cache);
 assert.equal(normalizeOpenCodeEvent(event,states.get(B).cache),null);
});

test('parent routing accepts separate parent maps without changing legacy global tree',t=>{
 const {states,A,B}=fixture(t);states.get(A).parents.set('child','root-A');states.get(B).parents.set('child','root-B');
 assert.equal(resolveRootSessionId('child',id=>id==='root-A',states.get(A).parents),'root-A');
 assert.equal(resolveRootSessionId('child',id=>id==='root-B',states.get(B).parents),'root-B');
});

test('event envelope names origin without modifying original payload',t=>{
 const {events,A}=fixture(t);const event={type:'neko.task.state',properties:{sessionID:'session-A',state:'running',generation:99}};
 const wrapped=events.envelope(A,event);assert.equal(wrapped.properties.workspaceId,A.workspaceId);
 assert.equal(wrapped.properties.workspaceGeneration,A.generation);assert.equal(wrapped.properties.generation,99);
 assert.equal(event.properties.workspaceId,undefined);
});

test('foreign session, parent and workspace claims are refused',t=>{
 const {events,A,B}=fixture(t);
 for(const event of [
  {type:'session.status',properties:{sessionID:'session-B'}},
  {type:'session.created',properties:{info:{id:'child',parentID:'session-B'}}},
  {type:'tool.updated',properties:{workspaceId:B.workspaceId}}
 ])assert.throws(()=>events.accept(A,event),/outro|errado/);
});

test('closed-generation events cannot be delivered to reopened project',t=>{
 const {registry,events,A}=fixture(t);registry.close(A);const reopened=registry.open(A.projectPath);
 assert.throws(()=>events.envelope(A,{type:'neko.task.state'}));
 assert.throws(()=>events.envelope(reopened,{type:'neko.task.state',properties:{workspaceGeneration:A.generation}}),/anterior/);
});

test('unbound session creation and project-level events stay tagged by stream origin',t=>{
 const {events,A}=fixture(t);
 assert.equal(events.envelope(A,{type:'session.created',properties:{info:{id:'new-session'}}}).properties.workspaceId,A.workspaceId);
 assert.equal(events.envelope(A,{type:'neko.project.changed',properties:{path:'src/a.ts'}}).properties.workspaceId,A.workspaceId);
});

test('discarding a live project is refused and bootstrap state is independent',t=>{
 const {registry,states,A,B,select}=fixture(t);assert.throws(()=>states.discard(A));
 select(null);states.current().tasks.set('bootstrap',true);select(B);assert.equal(states.current().tasks.size,0);
 registry.close(A);states.discard(A);assert.equal(states.get(B).tasks.size,0);
});

// Execute the actual compiled main helper functions without importing Electron,
// initializing real managers, reading userData or starting personal projects.
const vm = require('node:vm');
const compiledMain = fs.readFileSync(path.join(__dirname,'../dist/main/main.js'),'utf8');
function mainFunction(name, context) {
  const start=compiledMain.indexOf('function '+name+'(');assert(start>=0,name);
  const end=compiledMain.indexOf('\n}',start)+2;assert(end>start,name);
  context.sendWorkspaceRenderer ??= (...args)=>context.mainWindow?.webContents.send(...args);return vm.runInNewContext(compiledMain.slice(start,end)+';'+name,context);
}

test('actual main state factory initializes distinct task maps and engine fields',t=>{
 const factory=mainFunction('createWorkspaceTaskState',{Map,Set});const a=factory(),b=factory();
 for(const key of ['activeAgentRequests','taskRecords','sessionParentMap','statusCache','idleRecheckTimers','recentToolInputs']){
  assert(a[key] instanceof Map);assert.notEqual(a[key],b[key]);a[key].set('only-A',true);assert.equal(b[key].size,0);
 }
 assert.equal(a.opencodeProcess,null);assert.equal(a.serviceReady,false);assert.equal(a.sseReconnectTimer,null);
 a.opencodeUrl='http://localhost:1234';assert.notEqual(a.opencodeUrl,b.opencodeUrl);
});

test('actual main IPC wrapper preserves session owner over async suspension',async t=>{
 const f=fixture(t);const handlers={};const wrapper=mainFunction('handleWorkspaceSessionIpc',{
  electron_1:{ipcMain:{handle:(channel,handler)=>{handlers[channel]=handler}}},workspaceRegistry:f.registry,workspaceIpc:new WorkspaceIpc(f.registry,()=>f.A)
 });let resume;const barrier=new Promise(r=>{resume=r});
 wrapper('opencode:prompt',async()=>{await barrier;f.states.current().tasks.set('task','completed')});
 const pending=handlers['opencode:prompt']({}, {sessionId:'session-A'});f.select(f.B);resume();await pending;
 assert.equal(f.states.get(f.A).tasks.get('task'),'completed');assert.equal(f.states.get(f.B).tasks.size,0);
});

test('actual main event emitter tags A when selected project is B and drops closed A',t=>{
 const f=fixture(t);const sent=[];const emitter=mainFunction('emitWorkspaceEvent',{
  workspaceRegistry:f.registry,workspaceEvents:f.events,currentWorkspaceLease:f.B,
  projectConversations:{activeSession:()=> 'session-A',ownsRoot:()=>true},resolveRootSessionId:id=>id,taskRecords:new Map(),
  mainWindow:{webContents:{send:(channel,event)=>sent.push({channel,event})}}
 });
 f.registry.run(f.A,()=>emitter({type:'neko.task.state',properties:{sessionID:'session-A'}}));
 assert.equal(sent[0].event.properties.workspaceId,f.A.workspaceId);
 f.registry.run(f.A,()=>{f.registry.close(f.A);emitter({type:'neko.task.state',properties:{sessionID:'session-A'}})});
 assert.equal(sent.length,1);
});

test('session.created cannot claim a known session of another project via info.id',t=>{
 const {events,A}=fixture(t);
 assert.throws(()=>events.accept(A,{type:'session.created',properties:{info:{id:'session-B'}}}),/errado/);
});

test('actual explicit session IPC refuses session B through workspace A before handler runs', t => {
 const f=fixture(t);let calls=0;
 const router=new WorkspaceIpc(f.registry,()=>f.A);
 const wrapper=mainFunction('handleWorkspaceSessionIpc',{
  electron_1:{ipcMain:{handle:()=>{}}},workspaceRegistry:f.registry,workspaceIpc:router
 });
 wrapper('opencode:prompt',()=>{calls++});
 assert.throws(()=>router.invoke(f.A,'opencode:prompt',{},[{sessionId:'session-B'}]),/não pertence/);
 assert.equal(calls,0);
 router.invoke(f.B,'opencode:prompt',{},[{sessionId:'session-B'}]);
 assert.equal(calls,1);
});
