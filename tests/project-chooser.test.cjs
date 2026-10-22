const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../dist/main/main.js'),'utf8');
function fixture(platform='win32'){
 let handler,resolve,reject;const calls=[],selected=[];let focused=0;
 const parent={isDestroyed:()=>false,focus:()=>focused++};
 const context={traceProjectOpen:()=>{},process:{platform},mainWindow:parent,workspaceTabs:{owner:id=>({workspaceId:'owner-'+id}),select:id=>selected.push(id)},
 electron_1:{ipcMain:{handle:(_name,fn)=>handler=fn},dialog:{showOpenDialog:(...args)=>{calls.push(args);return new Promise((a,b)=>{resolve=a;reject=b})}}},
 app_preferences_manager_1:{isValidDirectory:()=>true,appPreferencesManager:{getLastProjectDirectory:async()=>'/projects'}},recent_projects_manager_1:{normalizeProjectPath:p=>p}};
 const start=source.indexOf('let projectChooserPromise = null;'),end=source.indexOf('const workspaceResults',start);
 vm.runInNewContext(source.slice(start,end),context);
 return {open:id=>handler({sender:{id}}),calls,selected,parent,resolve:value=>resolve(value),reject:error=>reject(error)};
}
test('Windows folder chooser is unparented and returns selected path to the requesting studio',async()=>{
 const f=fixture(),pending=f.open(10);await new Promise(setImmediate);assert.equal(f.calls.length,1);assert.equal(f.calls[0].length,1);assert.equal(f.calls[0][0].defaultPath,'/projects');f.resolve({canceled:false,filePaths:['/projects/B']});assert.equal(await pending,'/projects/B');assert.deepEqual(f.selected,['owner-10']);
});
test('duplicate picker requests share one dialog; cancellation allows another attempt',async()=>{
 const f=fixture(),a=f.open(10),b=f.open(10);await new Promise(setImmediate);assert.equal(f.calls.length,1);f.resolve({canceled:true,filePaths:[]});assert.deepEqual(await Promise.all([a,b]),[null,null]);const c=f.open(10);await new Promise(setImmediate);assert.equal(f.calls.length,2);f.resolve({canceled:false,filePaths:['/B']});assert.equal(await c,'/B');
});
test('native picker failure releases the guard so the user can retry',async()=>{
 const f=fixture(),a=f.open(10);await new Promise(setImmediate);f.reject(new Error('native failure'));await assert.rejects(a,/native failure/);const b=f.open(10);await new Promise(setImmediate);assert.equal(f.calls.length,2);f.resolve({canceled:true,filePaths:[]});await b;
});
test('other platforms keep the native dialog attached to the host',async()=>{
 const f=fixture('darwin'),a=f.open(10);await new Promise(setImmediate);assert.equal(f.calls[0][0],f.parent);f.resolve({canceled:true,filePaths:[]});await a;
});
