const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const text=fs.readFileSync(path.join(__dirname,'../src/renderer/main.tsx'),'utf8');
function callback(name,context){
 const start=text.indexOf('  const '+name+' = React.useCallback(');assert(start>=0,name);
 const last=text.indexOf('\n  }, [',start),end=text.indexOf(');',last)+2;
 const declaration=text.slice(start,end).replace(/: string/g,'').replace(/: any/g,'');
 return vm.runInNewContext(declaration+';'+name,context);
}
function fixture(options={}){const calls=[],intent=[],modals=[];let prepared=0;const git={linkedRepo:options.linked===false?null:'owner/repo'};const context={React:{useCallback:fn=>fn},directPublishBusyRef:{current:false},project:'C:/projects/A',githubPublishBusy:false,githubCommitBusy:false,githubStatus:{connected:options.connected!==false,activeAccount:{id:'account-A'},repos:options.access===false?[]:[{fullName:'owner/repo'}]},githubLinkStatus:git,
 window:{neko:{githubGitStatus:async project=>{calls.push(['status',project]);return git},githubCommitPush:async(...args)=>{calls.push(['push',...args]);if(options.pushError)throw new Error(options.pushError);return options.pushResult || {ok:true}},githubCheckRepoAccess:async args=>{calls.push(['access',args]);return {accessible:options.access!==false,canWrite:options.access!==false&&options.readonly!==true}}}},
 showToast:()=>{},setGithubCommitError:()=>{},setGithubCommitBusy:()=>{},setGithubPublishBusy:()=>{},setGithubCommitSuccess:()=>{},syncGithubContext:()=>{},setGithubLinkStatus:()=>{},prepareGithubPublish:()=>prepared++,setGithubIntent:value=>intent.push(value),setModal:value=>modals.push(value),startGithubConnect:value=>calls.push(['connect',value]),alert:()=>{},console,setTimeout:()=>0};
 context.executeDirectPublish=callback('executeDirectPublish',context);return {context,calls,intent,modals,prepared:()=>prepared,run:callback('handleDirectPublish',context)};}
test('linked project uses the real positional preload commit/push contract',async()=>{const f=fixture();await f.run();const push=f.calls.find(x=>x[0]==='push');assert.deepEqual(Array.from(push),['push','Atualização pelo NekoAI',undefined,'C:/projects/A',true]);});
test('unpublished project enters repository review without an invalid publish request',async()=>{const f=fixture({linked:false});await f.run();assert.equal(f.prepared(),1);assert.equal(f.calls.some(x=>x[0]==='push'),false);});
test('no account saves project intent and opens connection without publishing',async()=>{const f=fixture({connected:false});await f.run();assert.equal(f.intent[0].projectPath,'C:/projects/A');assert.equal(f.intent[0].type,'publish');assert.equal(f.calls[0][0],'connect');assert.equal(f.calls.some(x=>x[0]==='push'),false);});
test('account without write access opens resolution and never pushes',async()=>{const f=fixture({access:false});await f.run();const check=f.calls.find(x=>x[0]==='access')[1];assert.equal(check.accountId,'account-A');assert.equal(check.projectPath,'C:/projects/A');assert.deepEqual(f.modals,['github']);assert.equal(f.calls.some(x=>x[0]==='push'),false);});


test('the Portuguese repository exception opens the existing account modal without native alerts',async()=>{
 const f=fixture({pushError:"Error invoking remote method github:commitPush: O repositório não foi encontrado ou o NekoAI não tem acesso a ele."});
 f.context.alert=()=>assert.fail('native alert is forbidden in publication');await f.run();assert.deepEqual(f.modals,['github']);
});
test('read-only access cannot trigger a push even if the cached repository exists',async()=>{
 const f=fixture({readonly:true});await f.run();assert.deepEqual(f.modals,['github']);assert.equal(f.calls.some(x=>x[0]==='push'),false);
});
test('expired credentials resume the existing account connection flow',async()=>{
 const f=fixture({pushResult:{ok:false,status:401,error:'expired'}});f.context.alert=()=>assert.fail('native alert');await f.run();assert.equal(f.intent[0].projectPath,'C:/projects/A');assert(f.calls.some(x=>x[0]==='connect'));
});
test('a locally committed push failure opens Git Center without native alerts',async()=>{
 const f=fixture({pushResult:{ok:false,committed:true,pushed:false,error:'network unavailable'}});f.context.alert=()=>assert.fail('native alert');await f.run();assert.deepEqual(f.modals,['gitCenter']);
});
