const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),syncfs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ConversationStore}=require('../dist/main/conversations/conversation-store');
const {ProjectConversations,engineTranscript}=require('../dist/main/conversations/project-conversations');
const {WorkspaceRegistry}=require('../dist/main/workspaces/workspace-registry');
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'neko-history-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(const folder of ['A','B'])await fs.mkdir(path.join(root,folder));
 const directory=()=>path.join(root,'user-data','conversations');const store=new ConversationStore(directory),registry=new WorkspaceRegistry();
 const A=registry.open(path.join(root,'A')),B=registry.open(path.join(root,'B'));const sessions=new Map(),transcripts=new Map();let created=0;
 const engine=async()=>{const directory=registry.current().projectPath;return {
   create:async()=>{const session={id:'session-'+(++created),directory,title:'NekoAI Workspace',time:{created:Date.now(),updated:Date.now()}};sessions.set(session.id,session);return session;},
   get:async id=>{const session=sessions.get(id);if(!session)throw Object.assign(new Error('Session not found'),{status:404});return session;},
   list:async()=>[...sessions.values()],messages:async id=>transcripts.get(id)||[]
 }};
 const service=new ProjectConversations(registry,store,engine);
 const open=(lease,...args)=>registry.run(lease,()=>service.open(lease,...args));
 const save=(lease,conversation,messages,sequence=1)=>service.save(lease,{conversationId:conversation.id,sessionId:conversation.sessionId,writeToken:conversation.writeToken,sequence,messages});
 return {root,directory,store,registry,A,B,sessions,transcripts,service,engine,open,save,created:()=>created};
}
const message=(text,createdAt=Date.now())=>({role:'user',text,createdAt});
const engineMessage=(id,role,text,createdAt=Date.now())=>({info:{id,role,time:{created:createdAt}},parts:[{type:'text',text}]});

test('closing/reopening the store preserves Portuguese text, attachments and the stable project identity',async t=>{
 const f=await fixture(t),opened=await f.open(f.A);
 await f.save(f.A,opened,[{...message('Olá André 🐈'),attachments:[{path:'C:/ref.png',name:'ref.png',mime:'image/png',kind:'image',size:20,previewUrl:'data:image/png;base64,transient'}]}]);
 const restarted=new ConversationStore(f.directory),record=await restarted.active(f.A.projectKey);
 assert.equal(record.messages[0].text,'Olá André 🐈');assert.equal(record.messages[0].attachments[0].name,'ref.png');assert.equal(record.messages[0].attachments[0].previewUrl,undefined);
 assert.equal((await fs.readdir(path.join(f.root,'A'))).length,0);assert((await fs.readdir(f.directory())).every(file=>/^[a-f0-9]{64}\.json(\.bak)?$/.test(file)));
});
test('a new runtime restores the engine session and the conversation without creating another session',async t=>{
 const f=await fixture(t),first=await f.open(f.A);await f.save(f.A,first,[message('Manter meu contexto')]);
 f.service.release(f.A);f.registry.close(f.A);const reopened=f.registry.open(path.join(f.root,'A'));
 const service=new ProjectConversations(f.registry,new ConversationStore(f.directory),f.engine);
 const restored=await f.registry.run(reopened,()=>service.initialize(reopened));
 assert.equal(restored.id,first.id);assert.equal(restored.sessionId,first.sessionId);assert.equal(restored.messages[0].text,'Manter meu contexto');assert.equal(f.created(),1);
 assert.notEqual(restored.writeToken,first.writeToken);assert.equal(f.registry.forSession(restored.sessionId).workspaceId,reopened.workspaceId);
});
test('projects A and B cannot see, save or open one another conversations',async t=>{
 const f=await fixture(t),a=await f.open(f.A),b=await f.open(f.B);await Promise.all([f.save(f.A,a,[message('Só A')]),f.save(f.B,b,[message('Só B')])]);
 assert.equal((await f.service.current(f.A)).messages[0].text,'Só A');assert.equal((await f.service.current(f.B)).messages[0].text,'Só B');
 await assert.rejects(f.open(f.A,b.id),/não encontrada/);await assert.rejects(f.save(f.A,b,[message('wrong')]),/anterior/);
 assert.equal((await f.service.current(f.A)).id,a.id);
});
test('concurrent appends and saves are serialized, with no half-written JSON',async t=>{
 const f=await fixture(t),a=await f.open(f.A);
 await Promise.all(Array.from({length:12},(_,i)=>f.store.append(f.A.projectKey,a.id,a.sessionId,{...message('item '+i),clientRequestId:'q'+i})));
 const current=await f.store.active(f.A.projectKey);assert.equal(current.messages.length,12);assert.deepEqual(current.messages.map(m=>m.text),Array.from({length:12},(_,i)=>'item '+i));
 assert((await fs.readdir(f.directory())).every(name=>!name.endsWith('.tmp')));
});
test('a corrupt primary file recovers the latest committed backup',async t=>{
 const f=await fixture(t),a=await f.open(f.A);await f.save(f.A,a,[message('Última gravação válida')]);
 const file=(await fs.readdir(f.directory())).find(name=>name.endsWith('.json'));await fs.writeFile(path.join(f.directory(),file),'{broken');
 const record=await new ConversationStore(f.directory).active(f.A.projectKey);assert.equal(record.messages[0].text,'Última gravação válida');
});
test('corrupt primary and backup are preserved and never silently replaced by an empty conversation',async t=>{
 const f=await fixture(t),a=await f.open(f.A),file=(await fs.readdir(f.directory())).find(name=>name.endsWith('.json'));
 await fs.writeFile(path.join(f.directory(),file),'corrupt-main');await fs.writeFile(path.join(f.directory(),file+'.bak'),'corrupt-backup');
 await assert.rejects(new ConversationStore(f.directory).active(f.A.projectKey),/preservados/);
 assert.equal(await fs.readFile(path.join(f.directory(),file),'utf8'),'corrupt-main');assert.equal(await fs.readFile(path.join(f.directory(),file+'.bak'),'utf8'),'corrupt-backup');
});
test('a failed atomic replacement keeps the previous primary transcript intact',async t=>{
 const f=await fixture(t),a=await f.open(f.A);await f.save(f.A,a,[message('Antes')]);
 const atomic=f.store.atomic.bind(f.store);f.store.atomic=async(file,text)=>{if(file.endsWith('.json'))throw Error('disk unavailable');return atomic(file,text);};
 await assert.rejects(f.store.save(f.A.projectKey,a.id,a.sessionId,[message('Depois')]),/disk/);
 assert.equal((await new ConversationStore(f.directory).active(f.A.projectKey)).messages[0].text,'Antes');
});
test('engine session absence preserves the local transcript and explicitly restores context as ordinary data',async t=>{
 const f=await fixture(t),a=await f.open(f.A);await f.save(f.A,a,[message('Meu pedido original')]);f.sessions.delete(a.sessionId);
 const restored=await f.open(f.A,a.id);assert.equal(restored.id,a.id);assert.notEqual(restored.sessionId,a.sessionId);assert(restored.needsContextRestore);assert(restored.notice);
 const context=await f.service.restoredContext(f.A,restored.sessionId);assert(context.includes('Meu pedido original'));assert(context.includes('dados da conversa'));
 await f.service.contextDelivered(f.A);assert.equal(await f.service.restoredContext(f.A,restored.sessionId),'');
});
test('a temporary engine failure never replaces the saved session',async t=>{
 const f=await fixture(t),a=await f.open(f.A);const failing=async()=>({...await f.engine(),get:async()=>{throw Object.assign(Error('temporarily offline'),{status:503});}});
 const service=new ProjectConversations(f.registry,f.store,failing);
 await assert.rejects(f.registry.run(f.A,()=>service.initialize(f.A)),/histórico foi preservado/);assert.equal((await f.store.active(f.A.projectKey)).sessionId,a.sessionId);assert.equal(f.created(),1);
});
test('session IDs resolving to another directory cannot leak that engine transcript',async t=>{
 const f=await fixture(t),a=await f.open(f.A);await f.save(f.A,a,[message('A salvo')]);
 f.sessions.set(a.sessionId,{id:a.sessionId,directory:f.B.projectPath});f.transcripts.set(a.sessionId,[engineMessage('foreign','assistant','Segredo de B')]);
 const restored=await f.open(f.A,a.id);assert.notEqual(restored.sessionId,a.sessionId);assert(!JSON.stringify(restored.messages).includes('Segredo de B'));assert.equal(restored.messages[0].text,'A salvo');
});
test('legacy discovery imports only root sessions whose canonical directory matches the project',async t=>{
 const f=await fixture(t);f.sessions.set('legacy-A',{id:'legacy-A',directory:f.A.projectPath,title:'Conversa antiga',time:{created:1,updated:3}});
 f.sessions.set('child-A',{id:'child-A',directory:f.A.projectPath,parentID:'legacy-A',time:{created:1,updated:10}});
 f.sessions.set('foreign-B',{id:'foreign-B',directory:f.B.projectPath,time:{created:1,updated:20}});
 f.transcripts.set('legacy-A',[engineMessage('u','user','Pedido anterior',1),engineMessage('a','assistant','Resposta anterior',2)]);
 const restored=await f.open(f.A);assert.equal(restored.sessionId,'legacy-A');assert.equal(restored.messages.length,2);assert.equal((await f.service.list(f.A)).length,1);assert.equal(f.created(),0);
});
test('late writes from an older conversation/token and stale sequence numbers cannot overwrite newer history',async t=>{
 const f=await fixture(t),a=await f.open(f.A);await f.save(f.A,a,[message('Primeira')],2);await f.save(f.A,a,[message('Stale')],1);
 assert.equal((await f.service.current(f.A)).messages[0].text,'Primeira');
 const next=await f.open(f.A,undefined,true);await assert.rejects(f.save(f.A,a,[message('Late')],3),/anterior/);
 const back=await f.open(f.A,a.id);await assert.rejects(f.save(f.A,a,[message('Old token')],4),/anterior/);assert.notEqual(back.writeToken,a.writeToken);assert.notEqual(next.id,a.id);
});
test('backend capture recovers an assistant answer when the renderer closed before saving it',async t=>{
 const f=await fixture(t),a=await f.open(f.A);await f.save(f.A,a,[message('Pergunta',10)]);
 f.transcripts.set(a.sessionId,[engineMessage('u','user','Pergunta',10),engineMessage('answer','assistant','Resposta salva pelo motor',20)]);
 await f.registry.run(f.A,()=>f.service.capture(f.A));const record=await f.service.current(f.A);assert.equal(record.messages.length,2);assert.equal(record.messages[1].engineMessageId,'answer');
 await f.registry.run(f.A,()=>f.service.capture(f.A));assert.equal((await f.service.current(f.A)).messages.length,2);
});
test('two identical answers from distinct tasks remain distinct messages',async t=>{
 const f=await fixture(t),a=await f.open(f.A);await f.save(f.A,a,[message('Pergunta 1',1),{role:'assistant',text:'Concluído',engineMessageId:'a1',createdAt:2},message('Pergunta 2',3)]);
 f.transcripts.set(a.sessionId,[engineMessage('a1','assistant','Concluído',2),engineMessage('a2','assistant','Concluído',4)]);await f.registry.run(f.A,()=>f.service.capture(f.A));
 assert.equal((await f.service.current(f.A)).messages.filter(m=>m.text==='Concluído').length,2);
});
test('queued user messages are durably recorded once before engine dispatch',async t=>{
 const f=await fixture(t),a=await f.open(f.A);await f.service.recordUser(f.A,a.sessionId,'Pedido único','q1');await f.service.recordUser(f.A,a.sessionId,'Pedido único','q1');
 assert.equal((await new ConversationStore(f.directory).active(f.A.projectKey)).messages.length,1);
});
test('closing a workspace invalidates runtime ownership but never deletes its transcript',async t=>{
 const f=await fixture(t),a=await f.open(f.A);await f.save(f.A,a,[message('Não apagar')]);f.service.release(f.A);f.registry.close(f.A);
 await assert.rejects(f.service.current(f.A));assert.equal((await new ConversationStore(f.directory).active(f.A.projectKey)).messages[0].text,'Não apagar');
});
test('engine transcript excludes reasoning, tools and synthetic instructions',()=>{
 const messages=engineTranscript([{info:{id:'a',role:'assistant',time:{created:1}},parts:[{type:'reasoning',text:'private'},{type:'tool',text:'tool'},{type:'text',text:'system',synthetic:true},{type:'text',text:'Resposta'}]}]);
 assert.equal(messages.length,1);assert.equal(messages[0].text,'Resposta');
});
test('a separate process can read the exact committed conversation without any runtime memory',async t=>{
 const f=await fixture(t),a=await f.open(f.A);await f.save(f.A,a,[message('Persistiu após encerrar o processo 🐈')]);
 const storeModule=path.resolve(__dirname,'../dist/main/conversations/conversation-store.js');
 const code="const {ConversationStore}=require(process.argv[1]); new ConversationStore(()=>process.argv[2]).active(process.argv[3]).then(record=>process.stdout.write(JSON.stringify(record.messages)));";
 const output=require('node:child_process').execFileSync(process.execPath,['-e',code,storeModule,f.directory(),f.A.projectKey],{encoding:'utf8',windowsHide:true});
 assert.equal(JSON.parse(output)[0].text,'Persistiu após encerrar o processo 🐈');
});
test('a late context acknowledgement for another session cannot clear a new recovery requirement',async t=>{
 const f=await fixture(t),a=await f.open(f.A);await f.save(f.A,a,[message('A')]);f.sessions.delete(a.sessionId);const restoredA=await f.open(f.A,a.id);
 const b=await f.open(f.A,undefined,true);await f.save(f.A,b,[message('B')]);f.sessions.delete(b.sessionId);const restoredB=await f.open(f.A,b.id);assert(restoredB.needsContextRestore);
 await f.service.contextDelivered(f.A,restoredA.sessionId);assert((await f.service.current(f.A)).needsContextRestore);
});
test('engine events from another saved conversation are dropped before reaching the active chat or pausing its queue',async t=>{
 const f=await fixture(t),a=await f.open(f.A),b=await f.open(f.A,undefined,true);let sent=0,paused=0;
 const source=syncfs.readFileSync(path.join(__dirname,'../src/main/main.ts'),'utf8');const start=source.indexOf('function emitWorkspaceEvent('),end=source.indexOf('\nfunction handleWorkspaceSessionIpc(',start);
 const code=require('node:module').stripTypeScriptTypes(source.slice(start,end))+'\nemitWorkspaceEvent';
 const emit=require('node:vm').runInNewContext(code,{workspaceRegistry:f.registry,projectConversations:f.service,resolveRootSessionId:id=>id,taskRecords:new Map(),pausePromptQueues:()=>{paused++;},sendWorkspaceRenderer:()=>{sent++;},workspaceEvents:{envelope:(_lease,event)=>event}});
 f.registry.run(f.A,()=>emit({type:'neko.process.error',properties:{sessionID:a.sessionId}}));assert.equal(sent,0);assert.equal(paused,0);
 f.registry.run(f.A,()=>emit({type:'message.part.updated',properties:{part:{sessionID:b.sessionId,type:'text',text:'Atual'}}}));assert.equal(sent,1);
});
