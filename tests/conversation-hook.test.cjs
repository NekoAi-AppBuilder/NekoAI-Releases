const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const source=fs.readFileSync(path.join(__dirname,'../src/renderer/conversations/useConversationHistory.ts'),'utf8').replace(/^import .*\n/gm,'').replace('export function','function');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 const slots=[],effects=[];let cursor=0,props={project:null,sessionId:null},view;const saved=[];
 const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));
 const React={
  useState(initial){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return [slots[index],value=>{slots[index]=typeof value==='function'?value(slots[index]):value;}];},
  useRef(initial){const index=cursor++;if(!(index in slots))slots[index]={current:initial};return slots[index];},
  useCallback(fn,deps){const index=cursor++;if(!slots[index]||!equal(slots[index].deps,deps))slots[index]={deps,fn};return slots[index].fn;},
  useEffect(fn,deps){const index=cursor++;if(!slots[index]||!equal(slots[index].deps,deps)){slots[index]={deps};effects.push(fn);}}
 };
 const api={conversationsSave:async payload=>{saved.push(payload);},conversationsList:async()=>[]};
 const hook=vm.runInNewContext(stripTypeScriptTypes(source)+'\nuseConversationHistory',{React,window:{neko:api},Set,Promise,JSON});
 const render=(next=props)=>{props=next;cursor=0;view=hook(props.project,props.sessionId);while(effects.length)effects.shift()();return view;};
 return {api,saved,render,get view(){return view;}};
}
const record=(id='conversation-A',sessionId='session-A')=>({id,sessionId,writeToken:'token-'+id,title:'Conversa',createdAt:1,updatedAt:1,messages:[{role:'user',text:'Mensagem anterior',createdAt:1}],messageCount:1,needsContextRestore:false});
test('hydration never saves an empty startup state over an existing conversation',async()=>{
 const f=fixture();f.render();f.view.restore(record(),'C:/A');f.render({project:'C:/A',sessionId:'session-A'});await settle();assert.equal(f.saved.length,0);assert.equal(f.view.messages[0].text,'Mensagem anterior');
});
test('message updates save to the precise conversation/session/token and flushing awaits durability',async()=>{
 const f=fixture();f.render();f.view.restore(record(),'C:/A');f.render({project:'C:/A',sessionId:'session-A'});
 f.view.setMessages(prev=>[...prev,{role:'assistant',text:'Resposta',createdAt:2}]);f.render();await f.view.flush();
 assert.equal(f.saved.length,1);assert.equal(f.saved[0].conversationId,'conversation-A');assert.equal(f.saved[0].sessionId,'session-A');assert.equal(f.saved[0].writeToken,'token-conversation-A');assert.equal(f.saved[0].messages.length,2);
});
test('project/session transitions cannot save old messages into the new project',async()=>{
 const f=fixture();f.render();f.view.restore(record(),'C:/A');f.render({project:'C:/A',sessionId:'session-A'});
 f.view.setMessages(prev=>[...prev,{role:'assistant',text:'Antes da troca'}]);f.render({project:'C:/B',sessionId:'session-B'});await settle();assert.equal(f.saved.length,0);
});
test('failed writes remain visible and retry with a newer sequence',async()=>{
 const f=fixture();let attempts=0;f.api.conversationsSave=async payload=>{f.saved.push(payload);if(++attempts===1)throw Error('disco indisponível');};
 f.render();f.view.restore(record(),'C:/A');f.render({project:'C:/A',sessionId:'session-A'});
 f.view.setMessages(prev=>[...prev,{role:'assistant',text:'Salvar resposta'}]);f.render();await settle();f.render();assert.equal(f.view.error,'disco indisponível');
 await f.view.flush();f.render();assert.equal(f.view.error,'');assert.equal(f.saved.at(-1).sequence,2);
});
test('late failures of a previous writer never replace the new conversation error state',async()=>{
 const f=fixture();let reject;f.api.conversationsSave=()=>new Promise((_resolve,fail)=>{reject=fail;});
 f.render();f.view.restore(record(),'C:/A');f.render({project:'C:/A',sessionId:'session-A'});f.view.setMessages(prev=>[...prev,{role:'assistant',text:'A'}]);f.render();
 f.view.restore(record('conversation-B','session-B'),'C:/B');f.render({project:'C:/B',sessionId:'session-B'});reject(Error('erro antigo'));await settle();f.render();assert.equal(f.view.error,'');assert.equal(f.view.conversation.id,'conversation-B');
});
test('restoring a cached conversation continues its server write sequence instead of silently dropping new saves',async()=>{
 const f=fixture();f.render();f.view.restore({...record(),writeSequence:14},'C:/A');f.render({project:'C:/A',sessionId:'session-A'});
 f.view.setMessages(prev=>[...prev,{role:'assistant',text:'Nova mensagem'}]);f.render();await f.view.flush();assert.equal(f.saved[0].sequence,15);
});
