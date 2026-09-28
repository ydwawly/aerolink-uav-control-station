import type {HilMode,HilRuntimeStatus,HilState,LinkStats,PortDescriptor,Telemetry,VehicleLog,VehicleParameter} from './types';
type Off=()=>void;
export interface AeroLinkApi {
 listPorts():Promise<PortDescriptor[]>;connect(config:{path:string;baudRate:number;autoReconnect:boolean}):Promise<LinkStats>;disconnect():Promise<boolean>;getLinkState():Promise<LinkStats>;
 requestParameters():Promise<{started:boolean}>;setParameter(p:{id:string;value:number;type:number}):Promise<VehicleParameter>;exportParameters():Promise<{canceled:boolean;path?:string;count?:number}>;importParameters():Promise<{canceled:boolean;path?:string;parameters:{id:string;value:number;type:number}[]}>;sendCommand(p:{command:number;params:number[]}):Promise<{command:number;result:number;progress:number}>;setMessageInterval(p:{messageId:number;hz:number}):Promise<unknown>;
 listLogs():Promise<{started:boolean}>;downloadLog(p:{entry:VehicleLog;destination?:string}):Promise<{path:string;size:number}>;eraseLogs():Promise<unknown>;listLocalLogs():Promise<{name:string;path:string;size:number;time:number;source:string}[]>;loadReplay(file:string):Promise<any>;
 startHil(config?:Record<string,unknown>):Promise<{mode:HilMode}>;pauseHil():Promise<boolean>;resetHil():Promise<boolean>;configureHil(config:Record<string,unknown>):Promise<boolean>;stopHil():Promise<boolean>;getHilStatus():Promise<HilRuntimeStatus>;sendRcOverride(p:{channels:number[];release:boolean}):Promise<unknown>;
 selectFirmware():Promise<FirmwareSelection>;startFirmwareUpdate(p:{path:string}):Promise<FirmwareProgress>;cancelFirmwareUpdate():Promise<boolean>;
 onLink(cb:(v:LinkStats)=>void):Off;onTelemetry(cb:(v:Telemetry)=>void):Off;onParameters(cb:(v:VehicleParameter[])=>void):Off;onLogs(cb:(v:VehicleLog[])=>void):Off;onStatusText(cb:(v:{severity:number;text:string;time:number})=>void):Off;onCommandProgress(cb:(v:unknown)=>void):Off;onLogProgress(cb:(v:{id:number;received:number;total:number})=>void):Off;onHilState(cb:(v:HilState)=>void):Off;onHilStatus(cb:(v:HilRuntimeStatus)=>void):Off;onFirmwareProgress(cb:(v:FirmwareProgress)=>void):Off;onError(cb:(v:{message:string})=>void):Off;
}
export interface FirmwareSelection{canceled:boolean;path?:string;version?:string;gitSha?:string;slots?:Record<string,{size:number;crc32:string}>}
export interface FirmwareProgress{phase:string;slot?:string;version?:string;gitSha?:string;completed?:number;total?:number;percent:number;message?:string;time:number}
declare global { interface Window { aeroLink?:AeroLinkApi } }
export {};
