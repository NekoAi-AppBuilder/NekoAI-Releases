const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { PromptQueue, PromptQueueGate } = require('../dist/shared/prompt-queue');
const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/main.tsx'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '../src/main/main.ts'), 'utf8');
const ref = current => ({ current });
const item = (id, sessionId = 'session-A', projectPath = 'C:/A') => ({ id, sessionId, projectPath, text: id, displayText: id, attachments: [], request: { sessionId, text: id, model: { providerID: 'test', modelID: 'model-a' }, planMode: false, effort: 'High' } });
function callbackSource(name) {
  const start = renderer.indexOf('  const ' + name + ' = React.useCallback(');
  const end = renderer.indexOf('\n  }, [', start);
  assert(start > 0 && end > start, name);
  return renderer.slice(start, renderer.indexOf(']);', end) + 3);
}
function loadCallback(name, context) {
  return vm.runInNewContext(stripTypeScriptTypes(callbackSource(name)) + '\n' + name, { React: { useCallback: fn => fn }, console: { log() {} }, Date, ...context });
}
function sendFixture(overrides = {}) {
  const queue = new PromptQueue();
  const context = {
    sessionId: 'session-A', project: 'C:/A', conversationChanging: false, conversationChangingRef: ref(false), input: 'Criar cabeçalho', attachments: [],
    selectedModel: { providerID: 'test', modelID: 'model-a' }, getEffectiveModel: base => ({ ...base, variant: 'high' }),
    planMode: false, effort: 'High', previewUrl: '', previewStatus: 'ready', previewFramework: '', previewMessage: '',
    tree: [], githubLinkStatus: {}, terminalLines: [], consoleEntries: [], promptQueue: queue,
    pendingQuestionRef: ref(null), answerQuestionRef: ref(async () => {}),
    crypto: { randomUUID: () => 'queued-1' },
    resolveChatMessage: text => ({ userDisplayText: text, agentPromptText: text + ' [contexto]', filePaths: ['src/App.tsx'], semanticContexts: [], command: null }),
    ...overrides
  };
  for (const name of ['setInput','setAttachments','setUploadErrors','setEditingMessageIndex','setShowSlashMenu','setShowContextMenu','setAutocompleteMode','setAutocompleteTrigger']) context[name] = () => {};
  return { queue, context, send: loadCallback('send', context) };
}
function executorFixture(api = async () => ({ accepted: true, taskId: 'backend-1' })) {
  const queue = new PromptQueue(); const first = item('one'); queue.enqueue(first); queue.take(first.sessionId, first.projectPath);
  const context = { promptQueue: queue, console: { log() {} }, queueHistoryRef: ref([]), window: { neko: { promptQueueDispatch: api } }, sanitizeUserFacingText: String, upsertActivity() {}, applyPromptQueueGate() {}, pauseQueuesOnError() { queue.pause('erro'); queue.finish(first.id); } };
  for (const match of callbackSource('executeQueuedPrompt').matchAll(/\b(\w+Ref)\.current/g)) if (!(match[1] in context)) context[match[1]] = ref(null);
  context.handledQuestionIdsRef.current = new Set(); context.shownQueuedPromptsRef.current = new Set(); context.attemptedErrorSignaturesRef.current = new Set();
  context.taskPhaseRef.current = 'none'; context.repairAttemptsRef.current = 0;
  for (const match of callbackSource('executeQueuedPrompt').matchAll(/\b(set[A-Z]\w+)\(/g)) context[match[1]] = () => {};
  context.setTaskTimelines = updater => updater(new Map());
  context.setMessages = updater => { context.queueHistoryRef.current = updater(context.queueHistoryRef.current); };
  return { queue, first, context, execute: loadCallback('executeQueuedPrompt', context) };
}
function dispatchFixture() {
  const gate = new PromptQueueGate(), records = new Map(), locks = new Set(); let handler; const calls = [];
  const context = {
    handleWorkspaceSessionIpc(_name, fn) { handler = fn; },
    assertCurrentSessionWorkspace: sessionId => { if (sessionId !== 'session-A') throw Error('foreign session'); return { workspaceId: 'A' }; },
    promptQueueGate: gate, promptQueueDispatching: locks, taskRecords: records,
    conversationTransitions:new Set(),projectConversations:{isSwitching:()=>false,recordUser:async()=>{}},
    workspaceIpc: { invoke: async (...args) => { calls.push(args); return { accepted: true, taskId: 't1' }; } },
    pausePromptQueues: () => gate.pause('erro', 'A'),
    newTaskCorrelationId: () => 'command-1',
    setTaskState: (sessionId, state) => { records.get(sessionId).state = state; }
  };
  const start = main.indexOf('handleWorkspaceSessionIpc("prompt-queue:dispatch",');
  const code = main.slice(start, main.indexOf('\n});', start) + 4);
  vm.runInNewContext(stripTypeScriptTypes(code), context);
  return { gate, records, locks, calls, context, dispatch: payload => handler({}, { ...item('one').request, revision: gate.snapshot().revision, ...payload }) };
}

test('FIFO keeps one active task until explicit completion, never just the HTTP acknowledgement', () => {
  const q = new PromptQueue(); ['one','two','three'].forEach(id => q.enqueue(item(id)));
  assert.equal(q.take('session-A','C:/A').id, 'one'); assert.equal(q.take('session-A','C:/A'), null);
  assert.equal(q.finish('late-other-task'), false); assert.equal(q.snapshot().pending.length, 2);
  q.finish('one'); assert.equal(q.take('session-A','C:/A').id, 'two');
});
test('project A and B keep independent active items and pending order', () => {
  const a = new PromptQueue(), b = new PromptQueue();
  a.enqueue(item('a1')); a.enqueue(item('a2')); b.enqueue(item('b1','session-B','C:/B'));
  assert.equal(a.take('session-A','C:/A').id,'a1'); assert.equal(b.take('session-B','C:/B').id,'b1');
  b.finish('b1'); assert.equal(a.snapshot().active.id,'a1'); assert.equal(a.snapshot().pending[0].id,'a2');
});
test('a replaced session or project cannot consume prompts from its predecessor', () => {
  const q = new PromptQueue(); q.enqueue(item('one'));
  assert.equal(q.take('session-B','C:/A'),null); assert.equal(q.snapshot().pending.length,1); assert(q.snapshot().pauseReason);
  q.resume(); assert.equal(q.take('session-A','C:/B'),null);
});
test('pause preserves pending items, resume is explicit, and a blocked admission returns to the front', () => {
  const q = new PromptQueue(); q.enqueue(item('one')); q.enqueue(item('two'));
  q.take('session-A','C:/A'); q.defer('one'); q.pause('erro'); assert.equal(q.take('session-A','C:/A'),null);
  q.resume(); assert.equal(q.take('session-A','C:/A').id,'one');
});
test('editing/removing and clearing pending items do not cancel the active task', () => {
  const q = new PromptQueue(); ['one','two','three'].forEach(id=>q.enqueue(item(id))); q.take('session-A','C:/A');
  assert.equal(q.remove('two').id,'two'); q.clearPending(); assert.equal(q.snapshot().active.id,'one');
});
test('global failures stop all admissions and stale resume cannot clear a newer failure', () => {
  const gate = new PromptQueueGate(); const old = gate.snapshot();
  const failure = gate.pause('modelo indisponível','A'); assert(!gate.permits(old.revision));
  const newer = gate.pause('sem conexão','B'); assert(gate.resume(failure.revision).paused);
  const resumed = gate.resume(newer.revision); assert(!resumed.paused); assert(gate.permits(resumed.revision));
});
test('composer submission while a task runs captures immutable model, mode, effort, attachments and file context', async () => {
  const attachment = {path:'C:/A/ref.png',name:'ref.png',mime:'image/png',size:10,kind:'image'};
  const f = sendFixture({ attachments:[attachment], requestInFlightRef:ref(true), busy:true, planMode:true });
  await f.send(); attachment.name='changed'; f.context.selectedModel.modelID='different';
  const queued = f.queue.snapshot().pending[0]; assert.equal(queued.attachments[0].name,'ref.png');
  assert.equal(queued.request.model.modelID,'model-a'); assert.equal(queued.request.model.variant,'high');
  assert.equal(queued.request.planMode,true); assert.equal(queued.request.effort,'High'); assert.equal(queued.request.contextPaths[0],'src/App.tsx');
});
test('question responses continue the current task instead of consuming or extending the queue', async () => {
  let answer; const f=sendFixture({pendingQuestionRef:ref({id:'question'}),answerQuestionRef:ref(async value=>{answer=value;})});
  await f.send('Minha resposta'); assert.equal(answer,'Minha resposta'); assert.equal(f.queue.snapshot().pending.length,0);
});
test('attachments-only submissions are queued and empty submissions are ignored', async () => {
  const empty=sendFixture({input:''}); await empty.send(); assert.equal(empty.queue.snapshot().pending.length,0);
  const file=sendFixture({input:'',attachments:[{path:'C:/A/a.txt',name:'a.txt',mime:'text/plain',kind:'text'}]}); await file.send(); assert.equal(file.queue.snapshot().pending.length,1);
});
test('prompt acknowledgement keeps queue ownership until task lifecycle finalization', async () => {
  const f=executorFixture(); await f.execute(f.first,0);
  assert.equal(f.queue.snapshot().active.id,'one'); assert.equal(f.context.currentTaskIdRef.current,'backend-1');
  assert.equal(f.context.queueDispatchingRef.current,false);
});
test('blocked admission preserves the full prompt in its original position without dispatching again', async () => {
  const f=executorFixture(async()=>({queueBlocked:true,gate:{revision:1,paused:true}})); f.queue.enqueue(item('two'));
  await f.execute(f.first,0); assert.equal(f.queue.snapshot().active,null); assert.equal(f.queue.snapshot().pending[0].id,'one');
  assert.equal(f.context.requestInFlightRef.current,false);
});
test('model/provider rejection pauses the queue and preserves pending prompts', async () => {
  const f=executorFixture(async()=>{throw Error('modelo indisponível');}); f.queue.enqueue(item('two'));
  await f.execute(f.first,0); assert.equal(f.queue.snapshot().active,null); assert.equal(f.queue.snapshot().pending[0].id,'two'); assert(f.queue.snapshot().pauseReason);
});
test('late acknowledgement of a cancelled prompt cannot revive its task or open a connection modal', async () => {
  let resolve; const f=executorFixture(()=>new Promise(r=>{resolve=r;})); const run=f.execute(f.first,0);
  f.queue.pause('cancelado'); f.queue.finish('one'); f.context.taskPhaseRef.current='cancelled';
  resolve({waitingForLovableCloud:true,taskId:'late'}); await run; assert.equal(f.context.taskPhaseRef.current,'cancelled'); assert.equal(f.context.pendingJITRef.current,null);
});
test('main validates session ownership before admitting a queued request', async () => {
  const f=dispatchFixture(); await assert.rejects(f.dispatch({sessionId:'foreign'}), /foreign/); assert.equal(f.calls.length,0);
});
test('main atomically rejects paused/stale admission and concurrent requests in the same session', async () => {
  const f=dispatchFixture(); f.gate.pause('erro'); assert((await f.dispatch()).queueBlocked); assert.equal(f.calls.length,0);
  f.gate.resume(f.gate.snapshot().revision); f.locks.add('session-A'); assert((await f.dispatch()).queueBlocked);
  f.locks.clear(); f.records.set('session-A',{state:'waiting_for_user'}); assert((await f.dispatch()).queueBlocked);
});
test('main routes admitted prompts to the session workspace and pauses globally on dispatch exceptions', async () => {
  const f=dispatchFixture(); await f.dispatch(); assert.equal(f.calls[0][0].workspaceId,'A'); assert.equal(f.calls[0][1],'opencode:prompt');
  f.context.workspaceIpc.invoke=async()=>{throw Error('conexão perdida');};
  await assert.rejects(f.dispatch(), /conexão/); assert(f.gate.snapshot().paused); assert.equal(f.locks.size,0);
});
test('a command failure cannot be overwritten by a later successful command acknowledgement', async () => {
  const f=dispatchFixture(); f.context.workspaceIpc.invoke=async()=>{f.records.get('session-A').state='failed';return {ok:true};};
  await f.dispatch({command:{name:'test',args:''}}); assert.equal(f.records.get('session-A').state,'failed');
});

function conclusionFixture() {
  const queue = new PromptQueue(); queue.enqueue(item('one')); queue.enqueue(item('two')); queue.take('session-A','C:/A');
  let resolveOutput, resolveValidation, resolveCommit;
  const output = new Promise(r=>{resolveOutput=r;}), validation=new Promise(r=>{resolveValidation=r;}), commit=new Promise(r=>{resolveCommit=r;});
  const context = {
    promptQueue:queue, busy:true, currentErrorSignature:null,
    taskPhaseRef:ref('running'), currentTaskIdRef:ref('t1'), sessionIdRef:ref('session-A'),
    retryActiveRef:ref(false), completionTimer:ref(null), requestInFlightRef:ref(true), requestObservedBusyRef:ref(true),
    attemptedErrorSignaturesRef:ref(new Set()), previewRuntimeErrorRef:ref(null), repairAttemptsRef:ref(0),
    validationRunningRef:ref(false), queueWrappingRef:ref(false),
    finishActivity(){},completeTaskTimeline(){},notifyOnce(){},
    syncSessionOutput:()=>output,loadPreviewRoutes:async()=>{},triggerAutoCommitIfEligible:()=>commit,runTaskValidation:()=>validation,
    pauseQueuesOnError:()=>queue.pause('erro'),setQueuePumpVersion(){},setCurrentErrorSignature(){},setRepairState(){},setBusy(){},setWorkingStatus(){}
  };
  return {queue,context,conclude:loadCallback('concludeCurrentTask',context),resolveOutput,resolveValidation,resolveCommit};
}
const settled = () => new Promise(resolve=>setImmediate(resolve));
test('completion holds the next prompt until answer sync, validation and Auto Commit all finish', async () => {
  const f=conclusionFixture(); f.conclude('completed');
  assert.equal(f.queue.snapshot().active.id,'one'); assert(f.context.queueWrappingRef.current);
  f.resolveOutput(); f.resolveValidation(); await settled(); assert.equal(f.queue.snapshot().active.id,'one');
  f.resolveCommit(); await settled(); assert.equal(f.queue.snapshot().active,null); assert.equal(f.queue.take('session-A','C:/A').id,'two');
});
test('a wrap-up failure leaves the following prompt paused', async () => {
  const f=conclusionFixture(); f.context.runTaskValidation=async()=>{throw Error('build failed');};
  const conclude=loadCallback('concludeCurrentTask',f.context); conclude('completed'); f.resolveOutput(); f.resolveCommit(); await settled();
  assert(f.queue.snapshot().pauseReason); assert.equal(f.queue.take('session-A','C:/A'),null); assert.equal(f.queue.snapshot().pending[0].id,'two');
});
test('cancellation preserves pending prompts and refuses to advance them automatically', () => {
  const f=conclusionFixture(); f.conclude('cancelled'); assert.equal(f.queue.snapshot().active,null);
  assert.equal(f.queue.snapshot().pending[0].id,'two'); assert.equal(f.queue.take('session-A','C:/A'),null);
});
test('stale task IDs, old timestamps and events for another session cannot complete the active prompt', () => {
  let completions=0;
  const context={sessionIdRef:ref('session-A'),currentTaskIdRef:ref('t-current'),requestStartedAtRef:ref(100),
    concludeCurrentTask:()=>{completions++;},completeTaskTimeline(){},isTaskTerminal:()=>false,upsertActivity(){},finishActivity(){},pendingPermissions:[],pendingMigration:null,pauseQueuesOnError(){},
    taskPhaseRef:ref('running'),pendingPlanRef:ref(false),planAwaitingRef:ref(false)};
  const apply=loadCallback('applyTaskState',context);
  apply('completed',{sessionID:'session-B',taskId:'t-current',at:150});
  apply('completed',{sessionID:'session-A',taskId:'t-old',at:150});
  apply('completed',{sessionID:'session-A',taskId:'t-current',at:99}); assert.equal(completions,0);
  apply('completed',{sessionID:'session-A',taskId:'t-current',at:150}); assert.equal(completions,1);
});

test('queue admission broadcasts global pauses to both visible and hidden studios', () => {
  const sent=[];
  const start=main.indexOf('function sendWorkspaceRenderer('), end=main.indexOf('\nfunction handleWorkspaceIpc(',start);
  const send=vm.runInNewContext(stripTypeScriptTypes(main.slice(start,end))+'\nsendWorkspaceRenderer', {
    mainWindow:{isDestroyed:()=>false},getWorkspaceLease:()=>({workspaceId:'A'}),
    workspaceTabs:{contents:()=>['A','B'].map(id=>({isDestroyed:()=>false,send:(channel,state)=>sent.push({id,channel,state})}))}
  });
  send('prompt-queue:changed',{paused:true,revision:1}); assert.equal(sent.length,2); assert.deepEqual(sent.map(value=>value.id),['A','B']);
});
test('retry and tool errors pause pending admissions while retaining the current task', () => {
  let pauses=0; const queue=new PromptQueue();queue.enqueue(item('one'));queue.take('session-A','C:/A');
  const records=new Map([['session-A',{state:'running'}]]);
  const start=main.indexOf('function emitWorkspaceEvent('),end=main.indexOf('\nfunction handleWorkspaceSessionIpc(',start);
  const emit=vm.runInNewContext(stripTypeScriptTypes(main.slice(start,end))+'\nemitWorkspaceEvent',{
    taskRecords:records,pausePromptQueues:()=>{pauses++;},workspaceRegistry:{hasContext:()=>true,contextLease:()=>({workspaceId:'A'})},
    projectConversations:{activeSession:()=>undefined,ownsRoot:()=>false},resolveRootSessionId:id=>id,
    sendWorkspaceRenderer(){},workspaceEvents:{envelope:(_lease,event)=>event}
  });
  emit({type:'neko.agent.retrying',properties:{sessionID:'session-A'}});
  emit({type:'message.part.updated',properties:{sessionID:'session-A',part:{type:'tool',state:{status:'error'}}}});
  assert.equal(pauses,2);assert.equal(queue.snapshot().active.id,'one');
  records.get('session-A').state='cancelled';emit({type:'neko.process.error',properties:{sessionID:'session-A'}});assert.equal(pauses,2);
});
test('a native answer received before the next render uses the latest question ref and preserves pending prompts', async () => {
  const queue=new PromptQueue();queue.enqueue(item('one'));queue.enqueue(item('two'));queue.take('session-A','C:/A');
  let reply;
  const context={sessionId:'session-A',pendingQuestion:null,pendingQuestionRef:ref({questionId:'q',isNativeTool:true,requestId:'request-1'}),
    promptQueue:queue,selectedModel:{providerID:'other',modelID:'draft-model'},getEffectiveModel:base=>base,
    sanitizeUserFacingText:String,sanitizeTimelineDetail:String,upsertActivity(){},pauseQueuesOnError(){throw Error('unexpected failure');},
    window:{neko:{questionReply:async(...args)=>{reply=args;}}},
    requestInFlightRef:ref(false),requestObservedBusyRef:ref(false),taskPhaseRef:ref('waiting_for_user'),retryActiveRef:ref(false),
    setPendingQuestion(){},setWorkingStatus(){},setMessages(){},setBusy(){}};
  await loadCallback('answerQuestion',context)('Resposta'); assert.equal(reply[1],'request-1');assert.equal(context.taskPhaseRef.current,'running');assert.equal(queue.snapshot().pending[0].id,'two');
});

test('a failed native reply retains the question and active queue ownership for a safe retry', async () => {
  const queue=new PromptQueue();queue.enqueue(item('one'));queue.enqueue(item('two'));queue.take('session-A','C:/A');
  const question={questionId:'q',isNativeTool:true,requestId:'request-1'};let finishActive;
  const context={sessionId:'session-A',pendingQuestion:null,pendingQuestionRef:ref(question),promptQueue:queue,
    selectedModel:undefined,getEffectiveModel:base=>base,sanitizeUserFacingText:String,sanitizeTimelineDetail:String,upsertActivity(){},
    pauseQueuesOnError:finish=>{finishActive=finish;},window:{neko:{questionReply:async()=>{throw Error('offline');}}},
    requestInFlightRef:ref(false),requestObservedBusyRef:ref(false),taskPhaseRef:ref('waiting_for_user'),retryActiveRef:ref(false),
    setPendingQuestion(){},setWorkingStatus(){},setMessages(){},setBusy(){}};
  await loadCallback('answerQuestion',context)('Resposta');assert.equal(finishActive,false);assert.equal(context.pendingQuestionRef.current,question);
  assert.equal(context.taskPhaseRef.current,'waiting_for_user');assert.equal(queue.snapshot().active.id,'one');assert.equal(queue.snapshot().pending[0].id,'two');
});
