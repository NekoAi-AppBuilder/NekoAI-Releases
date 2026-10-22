const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../dist/main/chatgpt/chatgpt-manager.js'),'utf8');
function fixture(t,io=fsp){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'neko-chatgpt-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const A=path.join(root,'A'),B=path.join(root,'B');fs.mkdirSync(A);fs.mkdirSync(B);
 const module={exports:{}};let bridgeCount=0;
 const types={CHATGPT_PROVIDER_ID:'chatgpt-personal',CHATGPT_PROVIDER_NAME:'Meu ChatGPT',CHATGPT_BRIDGE_PORT:1234,CHATGPT_FALLBACK_MODELS:[{slug:'test-model',nome:'Test',niveis:['high']}]};
 const mocks={
 electron:{shell:{openExternal:async()=>{}}},'node:path':path,'node:os':{homedir:()=>root},'node:fs/promises':io,'node:fs':fs,
 './chatgpt-types':types,'./chatgpt-vault':{chatGptVault:{clearAccount:async()=>{}}},
 './chatgpt-auth':{ChatGptLoopbackServer:class{stop(){}},needsRefresh:()=>false,fetchCodexModels:async()=>[{slug:'updated-model',nome:'Updated',niveis:[]}]},
 './chatgpt-bridge':{ChatGptBridgeServer:class{constructor(){bridgeCount++}getRunning(){return false}stop(){}}}
 };
 vm.runInNewContext(source,{module,exports:module.exports,require:name=>{if(!(name in mocks))throw new Error('Unexpected dependency '+name);return mocks[name]},console:{log(){},warn(){},error(){}},fetch:async()=>{throw new Error('Network forbidden')},Map,Promise});
 // The module creates its legacy singleton. Test a separate instance without I/O at construction.
 const manager=new module.exports.ChatGptManager();manager.account={access:'fixture-only'};manager.status='connected';
 const read=async project=>JSON.parse(await fsp.readFile(path.join(project,'.opencode','opencode.json'),'utf8'));
 return {root,A,B,manager,read,bridgeCount:()=>bridgeCount};
}
test('shared account sync reaches A and B with independent configuration and preserved settings',async t=>{
 const f=fixture(t);for(const project of [f.A,f.B]){await fsp.mkdir(path.join(project,'.opencode'));await fsp.writeFile(path.join(project,'.opencode','opencode.json'),JSON.stringify({theme:path.basename(project),provider:{other:{keep:true}}}));}
 f.manager.attachWorkspace('A',1,f.A,()=>true);f.manager.attachWorkspace('B',1,f.B,()=>true);await f.manager.syncOpenCodeConfig();
 for(const project of [f.A,f.B]){const config=await f.read(project);assert.equal(config.theme,path.basename(project));assert(config.provider['chatgpt-personal']);assert(config.provider.other.keep)}
 assert.equal(f.bridgeCount(),2); // One module singleton and one tested manager; adding projects creates none.
});
test('queued sync drops closed A and keeps B without touching A files',async t=>{
 const f=fixture(t);let resume;f.manager.configSyncTail=new Promise(r=>resume=r);
 f.manager.attachWorkspace('A',1,f.A,()=>true);f.manager.attachWorkspace('B',1,f.B,()=>true);
 const pending=f.manager.syncOpenCodeConfig();f.manager.detachWorkspace('A',1);resume();await pending;
 assert.equal(fs.existsSync(path.join(f.A,'.opencode')),false);assert((await f.read(f.B)).provider['chatgpt-personal']);
});
test('old generation cannot detach a reopened project or receive its queued write',async t=>{
 const f=fixture(t);let resume;f.manager.configSyncTail=new Promise(r=>resume=r);
 f.manager.attachWorkspace('old',1,f.A,()=>true);const pending=f.manager.syncOpenCodeConfig();
 f.manager.detachWorkspace('old',1);f.manager.attachWorkspace('new',2,f.A,()=>true);f.manager.detachWorkspace('new',1);
 resume();await pending;assert.equal(fs.existsSync(path.join(f.A,'.opencode')),false);
 await f.manager.syncOpenCodeConfig();assert((await f.read(f.A)).provider['chatgpt-personal']);
});
test('explicit A sync does not modify B',async t=>{
 const f=fixture(t);f.manager.attachWorkspace('A',1,f.A,()=>true);f.manager.attachWorkspace('B',1,f.B,()=>true);
 await f.manager.syncOpenCodeConfig(f.A);assert((await f.read(f.A)).provider['chatgpt-personal']);assert.equal(fs.existsSync(path.join(f.B,'.opencode')),false);
});
test('disconnect removes provider in every attached project and keeps other settings',async t=>{
 const f=fixture(t);f.manager.attachWorkspace('A',1,f.A,()=>true);f.manager.attachWorkspace('B',1,f.B,()=>true);
 await f.manager.syncOpenCodeConfig();for(const project of [f.A,f.B]){const cfg=await f.read(project);cfg.keep=42;await fsp.writeFile(path.join(project,'.opencode','opencode.json'),JSON.stringify(cfg));}
 await f.manager.disconnect();for(const project of [f.A,f.B]){const cfg=await f.read(project);assert.equal(cfg.keep,42);assert.equal(cfg.provider?.['chatgpt-personal'],undefined)}
});
test('concurrent writes to global config are serialized',async t=>{
 let active=0,max=0;const io={...fsp,writeFile:async(...args)=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));try{return await fsp.writeFile(...args)}finally{active--}}};
 const f=fixture(t,io);f.manager.attachWorkspace('A',1,f.A,()=>true);f.manager.attachWorkspace('B',1,f.B,()=>true);
 await Promise.all([f.manager.syncOpenCodeConfig(f.A),f.manager.syncOpenCodeConfig(f.B),f.manager.syncOpenCodeConfig()]);assert.equal(max,1);
});
test('closing A while its config is being read prevents the write',async t=>{
 let manager;let project;const io={...fsp,readFile:async(file,...args)=>{const value=await fsp.readFile(file,...args);if(file===path.join(project,'.opencode','opencode.json'))manager.detachWorkspace('A',1);return value}};
 const f=fixture(t,io);manager=f.manager;project=f.A;await fsp.mkdir(path.join(f.A,'.opencode'));const cfg=path.join(f.A,'.opencode','opencode.json');await fsp.writeFile(cfg,'{"keep":true}');
 f.manager.attachWorkspace('A',1,f.A,()=>true);await f.manager.syncOpenCodeConfig();assert.equal(await fsp.readFile(cfg,'utf8'),'{"keep":true}');
});

const {WorkspaceRegistry}=require('../dist/main/workspaces/workspace-registry');
const {WorkspaceIpc}=require('../dist/main/workspaces/workspace-ipc');
const mainSource=fs.readFileSync(path.join(__dirname,'../dist/main/main.js'),'utf8');
function accountHandler(t,channel,selectedInitially){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'neko-account-ipc-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const registry=new WorkspaceRegistry();const A=registry.open(root);let selected=selectedInitially?A:null;
 const router=new WorkspaceIpc(registry,()=>selected);let handler,resume;const barrier=new Promise(r=>resume=r);const restarts=[];let reads=0;
 const runtime=new Proxy({}, {get:(_target,key)=>{const owner=registry.contextLease()??selected;if(owner)registry.assertLive(owner);reads++;return key==='currentProject'?root:{pid:1}}});
 const context={handleWorkspaceIpc:(name,fn)=>{router.register(name,fn);handler=(...args)=>router.current(name,...args)},
 chatgpt_manager_1:{chatGptManager:{startLogin:async()=>{await barrier;return {success:true}},disconnect:async()=>{await barrier},syncOpenCodeConfig:async()=>{}}},
 getWorkspaceLease:()=>registry.contextLease()??selected,workspaceRegistry:registry,workspaceRuntime:runtime,
 startOpenCode:async p=>restarts.push(p),console:{log(){}},Promise
 };
 const start=mainSource.indexOf('handleWorkspaceIpc("'+channel+'",');assert(start>=0);
 const end=mainSource.indexOf('\n    });',start)+7;vm.runInNewContext(mainSource.slice(start,end),context);
 return {invoke:()=>handler({},[]),resume,registry,A,select:x=>selected=x,restarts,reads:()=>reads};
}
test('login started on Home never restarts a project opened while authorization waits',async t=>{
 const f=accountHandler(t,'chatgpt:connect',false);const pending=f.invoke();f.select(f.A);f.resume();await pending;assert.equal(f.restarts.length,0);assert.equal(f.reads(),0);
});
test('closing origin while account login waits skips restarting selected project',async t=>{
 const f=accountHandler(t,'chatgpt:connect',true);const pending=f.invoke();f.registry.close(f.A);f.select(null);f.resume();await pending;assert.equal(f.restarts.length,0);assert.equal(f.reads(),0);
});
test('logout of a closed origin completes without reading its stale runtime',async t=>{
 const f=accountHandler(t,'chatgpt:disconnect',true);const pending=f.invoke();f.registry.close(f.A);f.select(null);f.resume();await pending;assert.equal(f.restarts.length,0);assert.equal(f.reads(),0);
});

test('registering same live identity twice preserves pending configuration work',async t=>{
 const f=fixture(t);let resume;f.manager.configSyncTail=new Promise(r=>resume=r);
 f.manager.attachWorkspace('A',1,f.A,()=>true);const pending=f.manager.syncOpenCodeConfig();
 f.manager.attachWorkspace('A',1,f.A,()=>true);resume();await pending;
 assert((await f.read(f.A)).provider['chatgpt-personal']);
 assert.throws(()=>f.manager.attachWorkspace('A',2,f.A,()=>true),/já registrada/);
});
