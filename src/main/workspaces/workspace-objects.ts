import type { WorkspaceRegistry, WorkspaceLease } from "./workspace-registry";
let registry: WorkspaceRegistry | null = null;
let selection: () => WorkspaceLease | null = () => null;
const pools = new Set<WorkspaceObjects<any>>();
const proxies = new WeakMap<object, WorkspaceObjects<any>>();
export function configureWorkspaceObjects(value: WorkspaceRegistry, selected: () => WorkspaceLease | null) { registry = value; selection = selected; }
function leaseNow() { return registry?.hasContext() ? registry.contextLease() : selection(); }
export async function closeWorkspaceObjects(lease: WorkspaceLease) { for (const pool of [...pools].reverse()) await pool.close(lease); }
export function concreteWorkspaceObject<T extends object>(proxy: T): T { return proxies.get(proxy)?.current() ?? proxy; }
/** A serialized shared vault preserves one cache and prevents concurrent .tmp writes. */
export function serializedObject<T extends object>(object: T): T {
 let tail: Promise<any> = Promise.resolve();
 return new Proxy(object, { get(target, key) { const value = Reflect.get(target,key,target); if(typeof value !== "function") return value;
   return (...args: any[]) => { const task=tail.then(()=>value.apply(target,args));tail=task.catch(()=>{});return task; }; } });
}
export class WorkspaceObjects<T extends object> {
 readonly proxy: T;
 private bootstrap: T;
 private accountBusy=false;
 private objects = new Map<string, { lease: WorkspaceLease; object: T }>();
 private listeners = new Map<string, Set<(...args: any[]) => void>>();
 private configuration = new Map<PropertyKey, any[]>();
 constructor(private create: () => T, private options: { events?: string[]; configure?: string[]; dispose?: (object:T)=>void|Promise<void>; accountActions?:string[]; accountRefresh?:(object:T)=>void|Promise<any> } = {}) {
  this.bootstrap=create();this.connect(this.bootstrap,null);pools.add(this);
  this.proxy=new Proxy({} as T,{get:(_target,key)=>{
   if(key==="on" || key==="addListener")return (name:string,fn:(...args:any[])=>void)=>{let set=this.listeners.get(name);if(!set)this.listeners.set(name,set=new Set());set.add(fn);return this.proxy;};
   if(key==="off" || key==="removeListener")return (name:string,fn:(...args:any[])=>void)=>{this.listeners.get(name)?.delete(fn);return this.proxy;};
   if(this.options.configure?.includes(String(key)))return (...args:any[])=>{this.configuration.set(key,args);this.configure(this.bootstrap,key,args,null);for(const entry of this.objects.values())this.configure(entry.object,key,args,entry.lease);};
   const object=this.current();const value=Reflect.get(object,key,object);
   if(this.options.accountActions?.includes(String(key)) && typeof value === "function")return async(...args:any[])=>{
    if(this.accountBusy)throw new Error("Já existe uma alteração de conta em andamento. Aguarde ou cancele na aba de origem.");
    this.accountBusy=true;
    try{const result=await value.apply(object,args);
     if(this.options.accountRefresh){const others=[{object:this.bootstrap,lease:null as WorkspaceLease|null},...this.objects.values()].filter(entry=>entry.object!==object);
      await Promise.allSettled(others.map(entry=>{try{return this.run(entry.lease,()=>this.options.accountRefresh!(entry.object));}catch{return Promise.resolve();}}));}
     return result;
    }finally{this.accountBusy=false;}
   };
   return typeof value === "function"?value.bind(object):value;
  }});proxies.set(this.proxy,this);
 }
 private run(lease:WorkspaceLease|null,fn:()=>any){if(!registry)return fn();return lease?registry.run(lease,fn):registry.runBootstrap(fn);}
 private configure(object:T,key:PropertyKey,args:any[],lease:WorkspaceLease|null){const bound=args.map(arg=>typeof arg==="function"?(...values:any[])=>this.run(lease,()=>arg(...values)):arg);(object as any)[key](...bound);}
 private connect(object:T,lease:WorkspaceLease|null){for(const name of this.options.events??[])(object as any).on(name,(...args:any[])=>{
   if(lease){try{registry?.assertLive(lease);}catch{return;}}
   this.run(lease,()=>{for(const fn of this.listeners.get(name)??[]){try{const result=fn(...args) as any;if(result?.catch)result.catch((error:any)=>console.warn("[Workspace integration listener]",error));}catch(error){console.warn("[Workspace integration listener]",error);}}});
  });for(const [key,args]of this.configuration)this.configure(object,key,args,lease);}
 current():T {const lease=leaseNow();if(!lease)return this.bootstrap;registry!.assertLive(lease);let entry=this.objects.get(lease.workspaceId);if(!entry){entry={lease:{...lease},object:this.create()};this.objects.set(lease.workspaceId,entry);this.connect(entry.object,entry.lease);}return entry.object;}
 async close(lease:WorkspaceLease){const entry=this.objects.get(lease.workspaceId);if(!entry||entry.lease.generation!==lease.generation)return;await this.options.dispose?.(entry.object);this.objects.delete(lease.workspaceId);}
}

