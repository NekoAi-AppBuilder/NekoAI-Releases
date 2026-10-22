const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),http=require('node:http');
const {WorkspaceRegistry}=require('../dist/main/workspaces/workspace-registry');const {WorkspaceState,scopedFields}=require('../dist/main/workspaces/workspace-state');const {WorkspaceServices}=require('../dist/main/workspaces/workspace-services');const {WorkspaceResources}=require('../dist/main/workspaces/workspace-resources');
const source=fs.readFileSync(path.join(__dirname,'../dist/main/main.js'),'utf8');
const {ConversationStore}=require('../dist/main/conversations/conversation-store');
const {ProjectConversations}=require('../dist/main/conversations/project-conversations');
function extract(name){const start=source.indexOf('function '+name+'(');assert(start>=0,name);return (source.slice(start-6,start)==='async '?'async ':'')+source.slice(start,source.indexOf('\n}',start)+2)}
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'neko-two-engines-'));for(const name of ['A','B'])fs.mkdirSync(path.join(root,name));const servers=new Map(),statesByPath=new Map();t.after(async()=>{for(const server of servers.values())await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true})});
 const registry=new WorkspaceRegistry();const factory=vm.runInNewContext(extract('createWorkspaceTaskState')+';createWorkspaceTaskState',{Map,Set});const states=new WorkspaceState(registry,factory,()=>null),runtime=scopedFields(()=>states.current()),services=new WorkspaceServices(registry),resources=new WorkspaceResources(registry);const stops=[];let launches=0;
 const manager={initialize:async()=>{},setProject:async()=>{},getState:()=>({projectPath:registry.current().projectPath})};
 const ctx={traceProjectOpen:()=>{},workspaceRegistry:registry,workspaceRuntime:runtime,workspaceTaskStates:states,workspaceServices:services,workspaceResources:resources,
 workspaceResults:new Map(),workspaceOpenPromises:new Map(),workspaceStartupTail:Promise.resolve(),projectTransitionGeneration:0,currentWorkspaceLease:null,
 workspaceVisibility:{select:()=>{}},workspacePorts:{releaseAll:()=>{}},license_manager_1:{licenseManager:{assertAccess:()=>{}}},
 node_fs_1:{default:fs},node_path_1:{default:path},assertProjectRootSafe:p=>path.resolve(p),
 chatgpt_manager_1:{chatGptManager:{attachWorkspace:()=>{},detachWorkspace:()=>{}}},
 supabase_manager_1:{supabaseManager:manager},vercel_manager_1:{vercelManager:manager},lovable_cloud_manager_1:{lovableCloudManager:{...manager,setProject:async()=>({isLovableProject:false})}},
 lovable_mcp_server_1:{lovableMcpServer:{},removeLovableOpenCodeConfig:async()=>{}},
 migration_manager_1:{migrationManager:{getPendingProposals:()=>[]}},workspace_objects_1:{closeWorkspaceObjects:async()=>{}},
 recent_projects_manager_1:{recentProjectsManager:{touchRecentProject:async()=>{},getRecentProjectsWithStatus:async()=>[]}},app_preferences_manager_1:{appPreferencesManager:{saveLastProjectDirectoryFromProjectPath:async()=>{},getProjectAutoCommit:async()=>false}},
 getWorkspaceLease:()=>registry.contextLease()??null,cancelCurrentPublishOperation:()=>{},resetTaskRuntime:()=>{},cancelSseReconnect:()=>{},
 startOpenCodeInternal:async(project,generation)=>{
  launches++;const engine={project,generation,completed:false};statesByPath.set(project,engine);
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/session'){res.end(JSON.stringify({id:'session-'+path.basename(project)}));return}if(req.url==='/work'){setTimeout(()=>engine.completed=true,80);res.end('{"started":true}');return}res.end(JSON.stringify({project,completed:engine.completed}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));servers.set(project,server);runtime.opencodeUrl='http://127.0.0.1:'+server.address().port;runtime.serviceReady=true;runtime.opencodeProcess={pid:launches};return {ok:true};
 },getOpencodeClient:async()=>{const url=runtime.opencodeUrl;return {session:{create:async()=>({data:await (await fetch(url+'/session',{method:'POST'})).json()})}}},
 ownWorkspaceContext:(lease,context)=>{const server=servers.get(context.projectPath);resources.track(lease,'engine',server,()=>new Promise(resolve=>server.close(()=>{servers.delete(context.projectPath);resolve()})));},
 readTreeWithSettling:async project=>[{name:path.basename(project)}],getGitStatus:async()=>({branch:'main'}),startPreview:async()=>{},
 stopPreview:async()=>{},stopOpenCode:async()=>stops.push(registry.current().projectPath),sendWorkspaceRenderer:()=>{},logPreviewLifecycle:()=>{},logService:()=>{},console:{log(){},warn(){},error(){}},Map,Set,Promise,Error,setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref();return timer}
 };
 ctx.conversationStore=new ConversationStore(()=>path.join(root,'history'));
 ctx.projectConversations=new ProjectConversations(registry,ctx.conversationStore,async()=>{
  const directory=registry.current().projectPath,client=await ctx.getOpencodeClient();
  return {create:async()=>({...((await client.session.create()).data),directory}),get:async id=>({id,directory}),list:async()=>[],messages:async()=>[]};
 });
 const context=vm.createContext(ctx);vm.runInContext(extract('switchWorkspaceInternal')+'\n'+extract('closeWorkspaceIdentity'),context);
 return {root,registry,states,runtime,services,ctx,stops,statesByPath,launches:()=>launches,open:project=>vm.runInContext('switchWorkspaceInternal',context)(project),close:lease=>vm.runInContext('closeWorkspaceIdentity',context)(lease)};
}
test('actual workspace initializer keeps engine A running while opening B and keeps sessions distinct',async t=>{
 const f=await fixture(t);const A=await f.open(path.join(f.root,'A'));await fetch(A.opencodeUrl+'/work');const B=await f.open(path.join(f.root,'B'));await new Promise(resolve=>setTimeout(resolve,100));
 assert.equal(f.stops.length,0);assert.notEqual(A.session.id,B.session.id);assert.notEqual(A.opencodeUrl,B.opencodeUrl);assert.equal((await (await fetch(A.opencodeUrl)).json()).completed,true);assert.equal((await (await fetch(B.opencodeUrl)).json()).completed,false);
 assert.equal(f.registry.forSession(A.session.id).workspaceId,A.workspaceId);assert.equal(f.registry.forSession(B.session.id).workspaceId,B.workspaceId);
});
test('actual close B releases only B engine and A remains responsive',async t=>{
 const f=await fixture(t);const A=await f.open(path.join(f.root,'A')),B=await f.open(path.join(f.root,'B'));await f.close(f.registry.get(B.workspaceId));assert.equal(f.registry.list().length,1);assert.equal((await (await fetch(A.opencodeUrl)).json()).project,A.path);assert.deepEqual(f.stops,[B.path]);assert.throws(()=>f.registry.forSession(B.session.id));
});
test('two simultaneous opens of same folder create only one engine and one root session',async t=>{
 const f=await fixture(t);const [first,second]=await Promise.all([f.open(path.join(f.root,'A')),f.open(path.join(f.root,'A','.'))]);assert.equal(first.workspaceId,second.workspaceId);assert.equal(first.session.id,second.session.id);assert.equal(f.launches(),1);
});


function projectCreateHandler(f,tabs){
 let handler;f.ctx.workspaceTabs=tabs;f.ctx.electron_1={ipcMain:{handle:(name,callback)=>{assert.equal(name,'project:create');handler=callback}}};
 const start=source.indexOf('ipcMain.handle("project:create",');assert(start>=0);const end=source.indexOf('\n});',start)+4;
 vm.runInContext(source.slice(source.lastIndexOf("\n",start)+1,end),vm.createContext(f.ctx));return handler;
}
test('project chooser request initializes sibling B without waiting for its renderer to request startup',async t=>{
 const f=await fixture(t);const A=await f.open(path.join(f.root,'A'));let ready;const gate=new Promise(resolve=>ready=resolve);let acknowledged=0;
 const handler=projectCreateHandler(f,{owner:()=>f.registry.get(A.workspaceId),routeOpen:()=>false,whenReady:()=>gate,finishBootstrap:()=>acknowledged++,select:()=>{}});
 const pending=f.registry.run(f.registry.get(A.workspaceId),()=>handler({sender:{id:10}},{projectPath:path.join(f.root,'B'),source:'ProjectChooser'}));
 assert.equal(f.launches(),1);ready();const result=await pending;
 assert.equal(result.openedInTab,true);assert.equal(result.path,path.join(f.root,'B'));assert.equal(f.launches(),2);assert.equal(f.stops.length,0);assert.equal(acknowledged,0);
 assert.equal(f.registry.forSession('session-B').workspaceId,result.workspaceId);assert.equal((await f.open(A.path)).session.id,A.session.id);
});
test('sibling startup errors return to originating project and concurrent bootstrap does not retry automatically',async t=>{
 const f=await fixture(t);const A=await f.open(path.join(f.root,'A'));let attempts=0,selected=null;
 const start=f.ctx.startOpenCodeInternal;f.ctx.startOpenCodeInternal=async(project,...args)=>{if(path.basename(project)==='B'){attempts++;throw new Error('Fixture engine unavailable')}return start(project,...args)};
 const handler=projectCreateHandler(f,{owner:()=>f.registry.get(A.workspaceId),routeOpen:()=>false,whenReady:async()=>{},finishBootstrap:()=>{},select:id=>selected=id});
 const chooser=f.registry.run(f.registry.get(A.workspaceId),()=>handler({sender:{id:10}},{projectPath:path.join(f.root,'B'),source:'ProjectChooser'}));
 await Promise.resolve();
 const bootstrap=f.open(path.join(f.root,'B'));
 const results=await Promise.allSettled([chooser,bootstrap]);assert.equal(results[0].status,'rejected');assert.match(results[0].reason.message,/Fixture engine unavailable/);assert.equal(results[1].status,'rejected');assert.equal(attempts,1);assert.equal(selected,A.workspaceId);
 assert.equal((await (await fetch(A.opencodeUrl)).json()).project,A.path);
});
test('opening from Home returns its project result and acknowledges bootstrap only after initialization',async t=>{
 const f=await fixture(t);let acknowledged=0;
 const handler=projectCreateHandler(f,{owner:()=>null,routeOpen:()=>true,whenReady:async()=>{},finishBootstrap:()=>acknowledged++,select:()=>{}});
 const result=await handler({sender:{id:10}},{projectPath:path.join(f.root,'A'),source:'ProjectChooser'});
 assert.equal(result.session.id,'session-A');assert.equal(result.openedInTab,undefined);assert.equal(acknowledged,1);
});
