import { Battery, CircleGauge, Cpu, LocateFixed, Pause, Play, RotateCcw, Satellite, ShieldCheck, Square, Wifi } from 'lucide-react';
import type { Telemetry } from '../types';
import { MiniLineChart } from '../components/Charts';
import { DroneVisual, MapVisual } from '../components/Visuals';
import { Button, Metric, Panel, Progress, SelectBox, StatusDot, Tag } from '../components/UI';
import {useFlight} from '../services/FlightContext';

export default function MonitorPage({telemetry:t}:{telemetry:Telemetry}){
 const f=useFlight(), fix=(t.gpsFix||0)>=2, charts=f.chartData;
 const running=f.hilStatus.phase==='running',start=()=>f.startHil({dt:.002}),pause=()=>f.pauseHil(),reset=()=>f.resetHil();
 const rates=Object.values(f.link.messageRates).reduce((a,b)=>a+b,0);
 return <div className="monitor-layout page-fill">
  <div className="monitor-left">
   <Panel title="系统状态" action={<Tag kind={f.link.connected?'green':'red'}>{f.link.connected?'在线':'离线'}</Tag>}><div className="dense-list"><Metric label="飞控状态" value={t.armed?'已解锁':'已上锁'} accent={!t.armed}/><Metric label="心跳状态" value={f.link.connected?'正常':'等待 HEARTBEAT'} accent={f.link.connected}/><Metric label="MAVLink 速率" value={`${rates.toFixed(1)} Hz`}/><Metric label="活动端口" value={f.link.path||'未选择'}/><Metric label="模式编号" value={String(t.mode??0)}/></div></Panel>
   <Panel title="电池"><div className="battery-main"><Battery/><b>{t.voltage.toFixed(1)} <small>V</small></b><strong>{Math.max(0,t.battery).toFixed(0)}%</strong></div><Progress value={Math.max(0,t.battery)}/><div className="dense-list"><Metric label="电流" value={`${t.current.toFixed(1)} A`}/><Metric label="数据来源" value="BATTERY_STATUS / SYS_STATUS"/><Metric label="状态" value={f.link.connected?'实时':'无数据'}/></div></Panel>
   <Panel title="GPS" action={<Tag kind={fix?'green':'orange'}>{fix?`${t.gpsFix}D 定位`:'无定位'}</Tag>}><div className="icon-title"><Satellite/><span>卫星数量</span><b>{t.satellites??0}</b></div><div className="dense-list"><Metric label="纬度" value={fix?`${t.lat?.toFixed(7)}°`:'—'}/><Metric label="经度" value={fix?`${t.lon?.toFixed(7)}°`:'—'}/><Metric label="相对高度" value={`${t.altitude.toFixed(1)} m`}/></div></Panel>
   <Panel title="姿态估计"><div className="dense-list"><Metric label="横滚 (Roll)" value={`${t.roll.toFixed(1)}°`}/><Metric label="俯仰 (Pitch)" value={`${t.pitch.toFixed(1)}°`}/><Metric label="航向 (Yaw)" value={`${t.yaw.toFixed(1)}°`}/><Metric label="EKF 标志" value={`0x${(t.ekfFlags||0).toString(16)}`}/></div></Panel>
   <Panel title="遥测"><div className="dense-list"><Metric label="接收 / 发送" value={`${(f.link.rxBytes/1024).toFixed(1)} / ${(f.link.txBytes/1024).toFixed(1)} KiB`}/><Metric label="丢包率 / 接收帧" value={`${f.link.lossRate.toFixed(2)}% / ${f.link.rxPackets.toLocaleString()}`}/><Metric label="设备源" value={`${f.link.sources?.length||0} 个 system/component`}/><Metric label="TX 队列 / 过期帧" value={`${f.link.txQueueBytes||0} B / ${f.link.droppedTx||0}`}/><Metric label="时间同步 RTT" value={`${((f.link.timeRttUs||0)/1000).toFixed(2)} ms`}/></div></Panel>
  </div>
  <div className="monitor-center">
   <Panel title="飞行姿态 / 3D 视图" className="flight-panel"><DroneVisual roll={t.roll} pitch={t.pitch} yaw={t.yaw}/></Panel>
   <Panel title="实时曲线" action={<SelectBox>最近 {Math.min(charts.length,1200)} 点</SelectBox>} className="multi-chart"><div className="chart-tabs"><b>实时数据</b><span>IMU</span><span>姿态角</span><span>执行器</span></div><div className="four-charts"><MiniLineChart data={charts} keys={['x','y','z']} height={130} title="陀螺仪 (rad/s)"/><MiniLineChart data={charts} keys={['roll','pitch','yaw']} height={130} title="姿态角 (°)"/><MiniLineChart data={charts} keys={['altitude','speed']} height={130} title="高度 / 速度"/><MiniLineChart data={charts} keys={['m1','m2','m3','m4']} height={130} title="控制输出 (%)"/></div></Panel>
   <Panel title="系统架构　统一监控 + MAVLink 2 + HIL 仿真" className="architecture"><div className="arch-flow"><div><Cpu/>飞控固件<small>STM32H7 / FreeRTOS</small></div><b>→ MAVLink 2 →</b><div><CircleGauge/>上位机监控<small>遥测 · 参数 · 日志</small></div><b>→ Worker →</b><div><LocateFixed/>HIL 仿真引擎<small>500 Hz 固定步长</small></div><b>↔</b><div><Wifi/>虚拟传感器与执行器<small>IMU / GPS / 气压计 / 电机</small></div></div></Panel>
  </div>
  <div className="monitor-right">
   <Panel title="位置 / 轨迹" className="map-panel"><MapVisual points={f.gpsTrail} hasFix={fix}/><div className="map-metrics"><Metric label="高度" value={`${t.altitude.toFixed(1)} m`}/><Metric label="地速" value={`${t.speed.toFixed(1)} m/s`}/><Metric label="航向" value={`${t.yaw.toFixed(0)}°`}/><Metric label="轨迹点" value={f.gpsTrail.length}/></div></Panel>
   <Panel title="HIL 仿真"><div className="button-row"><Button kind="primary" disabled={!f.link.connected||running} onClick={()=>void start()}><Play/> 闭环启动</Button><Button disabled={!running} onClick={()=>void pause()}><Pause/> 暂停</Button><Button onClick={()=>void reset()}><RotateCcw/> 复位</Button><Button disabled={f.hilStatus.phase==='idle'} onClick={()=>void f.stopHil()}><Square/> 退出</Button></div><div className="form-grid"><span>闭环协议</span><b>MAVLink HIL</b><span>仿真步长</span><b>2 ms / 500 Hz</b><span>仿真时间</span><b>{new Date((f.hilState?.simTime||0)*1000).toISOString().slice(11,23)}</b><span>状态</span><StatusDot label={f.hilStatus.phase==='fault'?f.hilStatus.reason:f.hilStatus.phase} warn={!running}/></div></Panel>
   <Panel title="执行器输出"><div className="motor-grid">{t.motors.map((m,i)=><div key={i}><small>电机 {i+1}</small><i style={{height:Math.max(0,Math.min(100,m))+'%'}}/><b>{m}%</b><span>{1000+Math.round(m*10)} μs</span></div>)}</div></Panel>
   <Panel title="传感器状态"><div className="sensor-grid">{[[Cpu,'IMU',f.link.messageRates.HIGHRES_IMU?'实时':'无数据'],[Satellite,'GPS',fix?`${t.satellites} 星`:'无定位'],[CircleGauge,'姿态',f.link.messageRates.ATTITUDE_QUATERNION||f.link.messageRates.ATTITUDE?'实时':'无数据'],[ShieldCheck,'EKF',t.ekfFlags?'已报告':'无数据']].map(([I,n,d]:any)=><div key={n}><I/><b>{n}</b><StatusDot label={d==='实时'||d==='已报告'?'正常':d} warn={d==='无数据'||d==='无定位'}/><span>{d}</span></div>)}</div></Panel>
  </div>
 </div>
}
