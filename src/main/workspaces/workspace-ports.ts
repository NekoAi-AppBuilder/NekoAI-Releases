import net from "node:net";
import type { WorkspaceLease } from "./workspace-registry";
export class WorkspacePorts {
 private ports=new Map<number,{lease:WorkspaceLease|null}>();
 async reserve(start:number,lease:WorkspaceLease|null,maxAttempts=100):Promise<number>{
  for(let offset=0;offset<maxAttempts;offset++){
   const port=start+offset;if(this.ports.has(port))continue;
   const available=await new Promise<boolean>(resolve=>{const server=net.createServer();server.once("error",()=>resolve(false));server.once("listening",()=>server.close(()=>resolve(true)));server.listen(port,"127.0.0.1");});
   if(available&&!this.ports.has(port)){this.ports.set(port,{lease:lease?{...lease}:null});return port;}
  }throw new Error(`Não encontrei uma porta livre a partir de ${start}.`);
 }
 releaseCallback(port:number){const entry=this.ports.get(port);return ()=>{if(this.ports.get(port)===entry)this.ports.delete(port);};}
 releaseAll(lease:WorkspaceLease){for(const [port,entry]of this.ports)if(entry.lease?.workspaceId===lease.workspaceId&&entry.lease.generation===lease.generation)this.ports.delete(port);}
}
