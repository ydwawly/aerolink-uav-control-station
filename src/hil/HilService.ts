import type { Telemetry } from '../types';
import { nextTelemetry } from '../services/telemetry';

export class HilService {
  private worker=new Worker(new URL('./hil.worker.ts',import.meta.url),{type:'module'});
  private listeners=new Set<(telemetry:Telemetry)=>void>();
  private telemetry:Telemetry;
  constructor(initial:Telemetry){
    this.telemetry=initial;
    this.worker.onmessage=(event:MessageEvent<{type:string;simulationTimeUs:number}>)=>{
      if(event.data.type!=='tick')return;
      this.telemetry={...nextTelemetry(this.telemetry,true),simTime:event.data.simulationTimeUs/1_000_000};
      this.listeners.forEach(listener=>listener(this.telemetry));
    };
    this.worker.postMessage({type:'configure',stepUs:2000});
  }
  subscribe(listener:(telemetry:Telemetry)=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener)}
  start(){this.worker.postMessage({type:'start'})}
  pause(){this.worker.postMessage({type:'pause'})}
  reset(){this.worker.postMessage({type:'reset'})}
  dispose(){this.worker.terminate();this.listeners.clear()}
}
