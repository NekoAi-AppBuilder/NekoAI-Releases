import type { WorkspaceTabsSnapshot } from "../../shared/workspace-tabs";
import { BrowserWindow, WebContentsView } from "electron";
import path from "node:path";
import type { WorkspaceLease, WorkspaceRegistry } from "./workspace-registry";
export const TAB_HEIGHT = 0;
interface Tab { id:string;label:string;view:WebContentsView;lease:WorkspaceLease|null;initialPath?:string;source?:string;closing:boolean;busy:boolean;ready?:Promise<void>;failed?:boolean }
export class WorkspaceTabs {
 private retiredSenders=new Set<number>();
 isRetired(sender:number){return this.retiredSenders.has(sender);}
 private tabs=new Map<string,Tab>();private selected:string|null=null;private counter=0;private selectionRevision=0;private homeRecoveryAttempted=false;
 constructor(private window:BrowserWindow,private registry:WorkspaceRegistry,private options:{preload:string;index:string;devUrl?:string;created?:(contents:Electron.WebContents)=>void;select:(lease:WorkspaceLease|null)=>void;close:(lease:WorkspaceLease)=>Promise<void>;busy:(lease:WorkspaceLease)=>boolean;confirmClose:(label:string)=>Promise<boolean>}){window.on("resize",()=>this.layout());}
 trusted(sender:number){return sender===this.window.webContents.id||[...this.tabs.values()].some(tab=>tab.view.webContents.id===sender);}
 owner(sender:number){return [...this.tabs.values()].find(tab=>tab.view.webContents.id===sender)?.lease??null;}
 sender(lease:WorkspaceLease){return [...this.tabs.values()].find(tab=>tab.lease?.workspaceId===lease.workspaceId&&tab.lease.generation===lease.generation)?.view.webContents;}
 content(lease:WorkspaceLease|null){return lease?[...this.tabs.values()].find(tab=>tab.lease?.workspaceId===lease.workspaceId)?.view:this.tabs.get(this.selected??"")?.view;}
 contents(){return [...this.tabs.values()].map(tab=>tab.view.webContents);}
 snapshot(): WorkspaceTabsSnapshot {return {selected:this.selected,tabs:[...this.tabs.values()].map(tab=>({id:tab.id,label:tab.label,busy:tab.busy,closing:tab.closing,projectPath:tab.lease?this.registry.assertLive(tab.lease).projectPath:null}))};}
 publish() {
  if (this.window.isDestroyed()) return;
  const snapshot = this.snapshot();
  for (const contents of this.contents()) {
    if (!contents.isDestroyed()) contents.send("tabs:changed", snapshot);
  }
 }
 newHome(recovering=false){
  if(!recovering)this.homeRecoveryAttempted=false;
  const existing=[...this.tabs.values()].find(tab=>!tab.lease&&!tab.closing&&!tab.failed&&!tab.view.webContents.isDestroyed());
  if(existing){this.activateHome(existing);return existing.id;}
  for(const tab of [...this.tabs.values()])if(!tab.lease&&!tab.closing&&(tab.failed||tab.view.webContents.isDestroyed())){
   this.retiredSenders.add(tab.view.webContents.id);this.tabs.delete(tab.id);this.window.contentView.removeChildView(tab.view);
   if(!tab.view.webContents.isDestroyed())tab.view.webContents.close();
  }
  return this.create(null);
 }
 private activateHome(tab:Tab){
  const revision=this.selectionRevision;
  void Promise.resolve(tab.ready).then(()=>{
   if(this.window.isDestroyed()||this.tabs.get(tab.id)!==tab||tab.closing||tab.failed||tab.view.webContents.isDestroyed()||revision!==this.selectionRevision)return;
   this.select(tab.id);
  }).catch(error=>console.error("[Workspace Home load]",error));
 }
 private create(lease:WorkspaceLease|null,initialPath?:string,source?:string){
 const id=lease?.workspaceId??`home-${++this.counter}`;const view=new WebContentsView({webPreferences:{preload:this.options.preload,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,additionalArguments:initialPath ? [`--neko-opening-project=${encodeURIComponent(initialPath)}`] : []}});
 const tab:Tab={id,label:initialPath?path.basename(initialPath):"Início",view,lease,initialPath,source,closing:false,busy:false};this.tabs.set(id,tab);this.window.contentView.addChildView(view);this.options.created?.(view.webContents);view.setBackgroundColor("#100d17");const deferHome=!lease&&this.selected!==null;if(deferHome){view.setVisible(false);this.layout();}else this.select(id);
 view.webContents.on("before-input-event",(event,input)=>{
 if(!(input.control||input.meta)||input.type!=="keyDown")return;
 if(input.key.toLowerCase()==="w"){event.preventDefault();void this.close(tab.id).catch(console.error);}
 if(input.key==="Tab"){event.preventDefault();const ids=[...this.tabs.keys()];const index=ids.indexOf(this.selected??"");this.select(ids[(index+(input.shift?-1:1)+ids.length)%ids.length]);}
});
 view.webContents.setWindowOpenHandler(()=>({action:"deny"}));view.webContents.on("render-process-gone",(_event,details)=>{tab.failed=true;console.error("[Workspace renderer]",id,details.reason);if(!tab.lease&&this.selected===tab.id&&!this.homeRecoveryAttempted){this.homeRecoveryAttempted=true;this.newHome(true);}});
 const load=this.options.devUrl?view.webContents.loadURL(this.options.devUrl):view.webContents.loadFile(this.options.index);tab.ready=load;void load.catch(error=>{tab.failed=true;console.error("[Workspace load]",id,error);});if(deferHome)this.activateHome(tab);return id;
 }
 routeOpen(sender:number,projectPath:string,source:string):boolean{
 const lease=this.registry.open(projectPath);const existing=[...this.tabs.values()].find(tab=>tab.lease?.workspaceId===lease.workspaceId);const origin=[...this.tabs.values()].find(tab=>tab.view.webContents.id===sender);
 if(existing){this.select(existing.id);return existing===origin;}
 if(origin&&!origin.lease){this.tabs.delete(origin.id);origin.id=lease.workspaceId;this.tabs.set(origin.id,origin);this.selected=origin.id;origin.lease=lease;origin.label=path.basename(lease.projectPath);this.options.select(lease);this.publish();return true;}
 this.create(lease,lease.projectPath,source);return false;
 }
 bootstrap(sender:number) {
  const tab=[...this.tabs.values()].find(tab=>tab.view.webContents.id===sender);
  if(!tab?.initialPath)return null;
  return {projectPath:tab.initialPath,source:tab.source??"ProjectTab"};
 }
 finishBootstrap(sender:number) {
  const tab=[...this.tabs.values()].find(tab=>tab.view.webContents.id===sender);
  if(tab)tab.initialPath=undefined;
 }
 async whenReady(workspaceId:string) {
  const tab=this.tabs.get(workspaceId);
  if(!tab||tab.closing)throw new Error("A aba do projeto foi fechada durante a abertura.");
  await tab.ready;
  if(this.tabs.get(workspaceId)!==tab||tab.closing)throw new Error("A aba do projeto foi fechada durante a abertura.");
  if(tab.lease)this.registry.assertLive(tab.lease);
 }

 select(id:string){const tab=this.tabs.get(id);if(!tab||tab.closing||tab.failed||tab.view.webContents.isDestroyed())return false;if(tab.lease)this.registry.assertLive(tab.lease);this.selectionRevision++;this.selected=id;for(const candidate of this.tabs.values())candidate.view.setVisible(candidate===tab);this.options.select(tab.lease);this.layout();tab.view.webContents.focus();this.publish();return true;}
 layout(){const bounds=this.window.getContentBounds();for(const tab of this.tabs.values())tab.view.setBounds({x:0,y:TAB_HEIGHT,width:bounds.width,height:Math.max(1,bounds.height-TAB_HEIGHT)});}
 setBusy(sender:number,busy:boolean){const tab=[...this.tabs.values()].find(tab=>tab.view.webContents.id===sender);if(tab){tab.busy=busy;this.publish();}}
 async closeProjects(){for(const tab of [...this.tabs.values()])if(tab.lease)await this.close(tab.id,true);}
 async close(id:string,force=false){const tab=this.tabs.get(id);if(!tab||tab.closing)return false;tab.closing=true;this.publish();
 if(!force&&tab.lease&&(tab.busy||this.options.busy(tab.lease))&&!await this.options.confirmClose(tab.label)){tab.closing=false;this.publish();return false;}
 // Mark the studio before disposing its runtime: cleanup IPC may already be queued.
 const senderId=tab.view.webContents.id;this.retiredSenders.add(senderId);
 if(this.retiredSenders.size>256)this.retiredSenders.delete(this.retiredSenders.values().next().value!);
 try{if(tab.lease)await this.options.close(tab.lease);}catch(error){this.retiredSenders.delete(senderId);tab.closing=false;this.publish();throw error;}
 this.tabs.delete(id);this.window.contentView.removeChildView(tab.view);if(!tab.view.webContents.isDestroyed())tab.view.webContents.close();if(this.selected===id){this.selected=null;const next=[...this.tabs.values()].at(-1);if(next)this.select(next.id);else this.newHome();}else this.publish();return true;
 }
}
