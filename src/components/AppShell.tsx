import type { ReactNode } from 'react';
import { Activity, BarChart3, Box, ChevronLeft, FileClock, Gauge, Link2, Menu, Monitor, Radio, Settings, SlidersHorizontal, Wifi } from 'lucide-react';
import type { AppMode, PageKey, Telemetry } from '../types';

const nav:[PageKey,string,typeof Monitor][]=[['monitor','飞控监控',Monitor],['parameters','参数配置',SlidersHorizontal],['charts','实时曲线',Activity],['logs','日志管理',FileClock],['hil','HIL 仿真',Box],['replay','回放分析',Gauge],['devices','设备连接',Link2]];
export function AppShell({children,page,onNavigate,mode,connected,telemetry}:{children:ReactNode;page:PageKey;onNavigate:(p:PageKey)=>void;mode:AppMode;connected:boolean;telemetry:Telemetry}){
 const link=telemetry.link, quality=Math.max(0,100-(link?.lossRate||0));
 const rate=link?.messageRates?Object.values(link.messageRates).reduce((a,b)=>a+b,0):0;
 return <div className="app-shell">
  <header className="topbar">
   <Menu size={22}/><div className={'top-pill '+(connected?'ok':'bad')}><span className="dot"/>USB CDC <b>{connected?'已连接':'未连接'}</b></div>
   <div className="top-stat"><span>链路质量</span><Wifi size={19}/><b>{quality.toFixed(1)}%</b><BarChart3 size={21}/></div>
   <div className="top-stat"><span>MAVLink 状态</span><Radio size={15}/><b>{connected?`已连接 ${rate.toFixed(1)} Hz`:'等待心跳'}</b></div>
   <div className="top-stat"><span>当前模式</span><b className="blue">{mode==='HIL'?'HIL 模式':mode==='REPLAY'?'回放模式':'监控模式'}</b></div>
   <div className="top-stat" title={`MAVLink PING 往返时延的一半（RTT/2），表示链路单向延迟估计；不包含飞控计算和动力学积分。当前 RTT 约 ${(telemetry.latency*2).toFixed(0)} ms`}><span>链路单向延迟</span><b>{telemetry.latency.toFixed(0)} ms</b></div>
   <div className="top-stat grow"><span>丢包率</span><b>{(link?.lossRate||0).toFixed(2)}%</b><span className="spark">▁▃▂▅▃▆</span></div>
   <div className="clock"><span>当前时间</span><b>{new Date().toLocaleDateString('zh-CN')} {new Date().toLocaleTimeString('zh-CN',{hour12:false})}</b></div><Settings size={22}/>
  </header>
  <aside className="sidebar"><nav>{nav.map(([key,label,Icon])=><button key={key} data-page={key} className={page===key?'active':''} onClick={()=>onNavigate(key)}><Icon size={19}/><span>{label}</span></button>)}</nav><button className="collapse"><ChevronLeft size={18}/></button></aside>
  <main className="workspace">{children}</main>
 </div>
}
