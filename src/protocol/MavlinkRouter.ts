export interface MavlinkMessage<T=unknown>{msgId:number;systemId:number;componentId:number;payload:T;timestampUs:number}
export class MavlinkRouter {
  private handlers=new Map<number,Set<(message:MavlinkMessage)=>void>>();
  subscribe(msgId:number,handler:(message:MavlinkMessage)=>void){const set=this.handlers.get(msgId)??new Set();set.add(handler);this.handlers.set(msgId,set);return()=>set.delete(handler)}
  route(message:MavlinkMessage){this.handlers.get(message.msgId)?.forEach(handler=>handler(message))}
}
