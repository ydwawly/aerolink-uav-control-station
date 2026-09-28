export type LinkState = 'disconnected' | 'connecting' | 'connected' | 'error';
export interface Transport {
  readonly name: string;
  readonly state: LinkState;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(frame: Uint8Array): Promise<void>;
  onData(listener: (chunk: Uint8Array) => void): () => void;
}

export class MockUsbCdcTransport implements Transport {
  readonly name = 'USB CDC';
  state: LinkState = 'disconnected';
  private listeners = new Set<(chunk: Uint8Array) => void>();
  async connect(){ this.state='connecting'; await Promise.resolve(); this.state='connected'; }
  async disconnect(){ this.state='disconnected'; }
  async send(frame:Uint8Array){ if(this.state!=='connected') throw new Error('USB CDC is not connected'); this.listeners.forEach(fn=>fn(frame)); }
  onData(listener:(chunk:Uint8Array)=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener)}
}
