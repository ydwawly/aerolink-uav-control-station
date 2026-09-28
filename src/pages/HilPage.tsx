import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { AlertTriangle, Cable, CheckCircle2, Gamepad2, Pause, Play, Power, RotateCcw, Square, X } from 'lucide-react';
import type { HilMode, HilTrajectory, Telemetry } from '../types';
import { MiniLineChart } from '../components/Charts';
import { DroneVisual } from '../components/Visuals';
import { Button, Metric, Panel, StatusDot, Tag } from '../components/UI';
import { useFlight } from '../services/FlightContext';

type Props={telemetry:Telemetry};
type StickValue={x:number;y:number};
const channelNames=['前左 · CCW','前右 · CW','后右 · CCW','后左 · CW'];
const clamp=(value:number,min=-1,max=1)=>Math.max(min,Math.min(max,value));
const centeredPwm=(value:number)=>Math.round(1500+clamp(value)*500);
const throttlePwm=(value:number)=>Math.round(1000+(clamp(value)+1)*500);

function RcStick({value,onChange,holdY=false,xLabel,yLabel}:{value:StickValue;onChange:(value:StickValue)=>void;holdY?:boolean;xLabel:string;yLabel:string}){
 const pad=useRef<HTMLDivElement>(null);
 const update=(event:ReactPointerEvent<HTMLDivElement>)=>{const rect=pad.current?.getBoundingClientRect();if(!rect)return;onChange({x:clamp((event.clientX-(rect.left+rect.width/2))/(rect.width*.38)),y:clamp(((rect.top+rect.height/2)-event.clientY)/(rect.height*.38))})};
 const release=(event:ReactPointerEvent<HTMLDivElement>)=>{if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);onChange({x:0,y:holdY?value.y:0})};
 return <div className="rc-stick-wrap"><span>{yLabel}</span><div ref={pad} className="rc-stick" onPointerDown={event=>{event.currentTarget.setPointerCapture(event.pointerId);update(event)}} onPointerMove={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))update(event)}} onPointerUp={release} onPointerCancel={release}><i className="rc-cross horizontal"/><i className="rc-cross vertical"/><b style={{left:`${50+value.x*38}%`,top:`${50-value.y*38}%`}}/></div><footer><span>← {xLabel}</span><span>{xLabel} →</span></footer></div>
}

export default function HilPage({telemetry}:Props){
 const f=useFlight(),h=f.hilState;
 const [motorFault,setMotorFault]=useState(false),[gpsDrift,setGpsDrift]=useState(false),[imuNoise,setImuNoise]=useState(false),[launchIssue,setLaunchIssue]=useState('');
 const [runMode,setRunMode]=useState<HilMode>('estimator'),[trajectory,setTrajectory]=useState<HilTrajectory>('combined');
 const [rcOpen,setRcOpen]=useState(false),[rcEnabled,setRcEnabled]=useState(false),[leftStick,setLeftStick]=useState<StickValue>({x:0,y:-1}),[rightStick,setRightStick]=useState<StickValue>({x:0,y:0}),[modePwm,setModePwm]=useState(1000),[auxHigh,setAuxHigh]=useState(false);
 const controls=(h?.controls||telemetry.motors.map(value=>value/100)).slice(0,4);
 const motors=controls.map((value:number)=>Math.round(Math.max(0,Math.min(1,value))*100));
 const t={...telemetry,...h,motors},actualRunning=f.hilStatus.phase==='running'&&Boolean(h?.running??true),previewMode=f.hilStatus.mode==='preview',estimatorMode=f.hilStatus.mode==='estimator';
 const heartbeatAge=f.link.lastHeartbeat?Date.now()-f.link.lastHeartbeat:Number.POSITIVE_INFINITY;
 const connectedReady=f.link.connected&&heartbeatAge<5000&&!telemetry.armed;
 const blockedReason=!f.link.connected?'USB CDC 未连接或尚未收到 HEARTBEAT':telemetry.armed?'飞控已解锁，请先上锁':heartbeatAge>=5000?'飞控心跳已超时':'';
 const shownMode=f.hilStatus.mode||runMode,shownEstimator=shownMode==='estimator',shownPreview=shownMode==='preview';
 const latest=f.chartData.at(-1),attitudeError=latest?.attitudeError,positionError=latest?.positionError;
 const startTitle=runMode==='preview'?'启动本地预览':blockedReason||(runMode==='estimator'?'发送预设运动传感器，忽略执行器输出':'启动真实 MAVLink 闭环');
 const run=async()=>{setLaunchIssue('');f.clearCharts();const previewOnly=runMode==='preview',estimatorOnly=runMode==='estimator';try{await f.startHil({dt:.002,startAltitude:previewOnly?1.5:estimatorOnly?2:0,previewOnly,estimatorOnly,trajectory})}catch(error){setLaunchIssue(error instanceof Error?error.message:String(error))}};
 const pause=async()=>{try{await f.pauseHil()}catch(error){setLaunchIssue(error instanceof Error?error.message:String(error))}};
 const reset=async()=>{try{await f.resetHil()}catch(error){setLaunchIssue(error instanceof Error?error.message:String(error))}};
 const toggleMotor=async()=>{const on=!motorFault;setMotorFault(on);await f.configureHil({motorEfficiency:on?[1,.8,1,1]:[1,1,1,1]})};
 const toggleGps=async()=>{const on=!gpsDrift;setGpsDrift(on);await f.configureHil({gpsDriftMps:on?[.15,.08]:[0,0]})};
 const toggleImu=async()=>{const on=!imuNoise;setImuNoise(on);await f.configureHil({noise:{accel:on ? .12 : .025,gyro:on ? .008 : .0015}})};
 const messageRate=f.link.messageRates.HIL_ACTUATOR_CONTROLS||0;
 const rcChannels=[centeredPwm(rightStick.x),centeredPwm(rightStick.y),throttlePwm(leftStick.y),centeredPwm(leftStick.x),modePwm,auxHigh?2000:1000,65535,65535];
 const rcChannelsRef=useRef(rcChannels),sendRcRef=useRef(f.sendRcOverride);
 useEffect(()=>{rcChannelsRef.current=rcChannels},[rightStick,leftStick,modePwm,auxHigh]);
 useEffect(()=>{sendRcRef.current=f.sendRcOverride},[f.sendRcOverride]);
 useEffect(()=>{if(!rcEnabled)return;let mounted=true;const send=()=>{if(mounted)void sendRcRef.current(rcChannelsRef.current).catch(error=>{setLaunchIssue(error instanceof Error?error.message:String(error));setRcEnabled(false)})};send();const timer=setInterval(send,40);return()=>{mounted=false;clearInterval(timer);void sendRcRef.current([],true).catch(()=>{})}},[rcEnabled]);
 useEffect(()=>{if(rcEnabled&&(!actualRunning||f.hilStatus.mode!=='closed-loop'))setRcEnabled(false)},[rcEnabled,actualRunning,f.hilStatus.mode]);
 const resetRc=()=>{setLeftStick({x:0,y:-1});setRightStick({x:0,y:0});setModePwm(1000);setAuxHigh(false)};
 const closeRc=()=>{setRcEnabled(false);setRcOpen(false)};

 return <div className="hil-page page-fill">
  <div className="hil-title"><h2>HIL 仿真控制中心</h2><span>Quad-X · 6DOF · MAVLink 2</span><button className={'virtual-rc-launch '+(rcEnabled?'active':'')} disabled={!actualRunning||f.hilStatus.mode!=='closed-loop'} onClick={()=>setRcOpen(true)} title={actualRunning&&f.hilStatus.mode==='closed-loop'?'打开 MAVLink 虚拟遥控器':'虚拟遥控器仅用于闭环 HIL'}><Gamepad2/>虚拟遥控器{rcEnabled&&<em>发送中</em>}</button></div>
  <Panel className="hil-controls">
   <div className="hil-model"><label>运行模式</label><select className="hil-mode-select" value={runMode} disabled={actualRunning} onChange={event=>setRunMode(event.target.value as HilMode)}><option value="estimator">估计器验证</option><option value="closed-loop">完整闭环</option><option value="preview">离线预览</option></select>{runMode==='estimator'?<select className="hil-mode-select trajectory" value={trajectory} disabled={actualRunning} onChange={event=>setTrajectory(event.target.value as HilTrajectory)}><option value="static">静止对准</option><option value="roll">单轴横滚</option><option value="pitch">单轴俯仰</option><option value="yaw">单轴偏航</option><option value="combined">三轴组合</option><option value="figure8">8 字位置轨迹</option></select>:<span className="model-name">Quad-X 六自由度</span>}<span className="model-note">固定步长 2.0 ms / 500 Hz</span></div>
   <div className="hil-actions">
    <Button kind="success" disabled={actualRunning||(runMode!=='preview'&&!connectedReady)} onClick={()=>void run()} title={startTitle}><Play/>{runMode==='estimator'?'启动验证':runMode==='preview'?'启动预览':'启动闭环'}</Button>
    <Button disabled={!actualRunning} onClick={()=>void pause()}><Pause/>暂停</Button><Button onClick={()=>void reset()}><RotateCcw/>重置</Button><Button disabled={f.hilStatus.phase==='idle'} onClick={()=>void f.stopHil()}><Square/>退出 HIL</Button>
   </div>
   <div className="hil-run-metrics"><Metric label="仿真时间" value={new Date((h?.simTime||0)*1000).toISOString().slice(11,23)}/><Metric label="时间倍率" value="1.00×"/><Metric label="仿真步数" value={Math.round((h?.simTime||0)*500).toLocaleString()}/></div>
   <div className="hil-state"><span>仿真状态</span><StatusDot label={f.hilStatus.phase==='fault'?f.hilStatus.reason:actualRunning?(previewMode?'离线预览中':estimatorMode?'估计器验证中':'闭环运行中'):f.hilStatus.phase==='idle'?'未启动':'已暂停'} warn={!actualRunning||previewMode}/></div>
  </Panel>
  <div className={'hil-readiness '+(connectedReady?'ready':'blocked')}>
   {connectedReady?<CheckCircle2/>:<AlertTriangle/>}<b>{connectedReady?'飞控连接条件已满足':'在线 HIL 暂不可用'}</b>
   <span>{connectedReady?'可运行估计器验证或完整闭环；估计器验证不要求执行器反馈。':'原因：'+blockedReason+'。离线预览仍可使用。'}</span>
   <span className="readiness-check"><Cable/>USB {f.link.connected?'正常':'未连接'} · HEARTBEAT {heartbeatAge<5000?'正常':'等待'} · 安全状态 {telemetry.armed?'已解锁':'未解锁'}</span>
  </div>
  {launchIssue&&<div className="hil-launch-error"><AlertTriangle/>{launchIssue}</div>}
  {rcOpen&&<div className="virtual-rc-overlay"><section className="virtual-rc-panel"><header><div><Gamepad2/><span><b>虚拟遥控器</b><small>Mode 2 · MAVLink RC_CHANNELS_OVERRIDE · 25 Hz</small></span></div><button onClick={closeRc} title="关闭并释放遥控器覆盖"><X/></button></header><div className="rc-safety"><AlertTriangle/><span>仅用于 HIL。关闭窗口、暂停或退出 HIL 会自动释放通道覆盖；油门默认最低。</span><i className={rcEnabled?'online':''}>{rcEnabled?'正在发送':'未启用'}</i></div><div className="rc-body"><RcStick value={leftStick} onChange={setLeftStick} holdY xLabel="偏航" yLabel="油门"/><div className="rc-center"><div className="rc-channel-grid">{rcChannels.slice(0,6).map((value,index)=><div key={index}><span>CH{index+1}</span><b>{value===65535?'忽略':value}</b></div>)}</div><label>CH5 飞行模式<select value={modePwm} onChange={event=>setModePwm(Number(event.target.value))}><option value={1000}>低档 1000</option><option value={1500}>中档 1500</option><option value={2000}>高档 2000</option></select></label><label className="rc-aux">CH6 辅助开关<button className={auxHigh?'active':''} onClick={()=>setAuxHigh(value=>!value)}>{auxHigh?'高位 2000':'低位 1000'}</button></label></div><RcStick value={rightStick} onChange={setRightStick} xLabel="横滚" yLabel="俯仰"/></div><footer className="rc-footer"><Button onClick={resetRc}><RotateCcw/>安全复位</Button><Button kind={rcEnabled?'danger':'success'} onClick={()=>setRcEnabled(value=>!value)}>{rcEnabled?<><Power/>停用并释放</>:<><Play/>启用虚拟 RC</>}</Button></footer></section></div>}

  <div className="hil-upper">
   <div className="hil-settings">
    <Panel title="环境与模型"><div className="dense-list"><Metric label="风速 N/E/D" value={(h?.config?.wind||[0,0,0]).join(' / ')+' m/s'}/><Metric label="空气阻力" value="0.16 N/(m/s)"/><Metric label="地面约束" value="启用"/><Metric label="质量 / 轴距" value="1.65 kg / 0.46 m"/></div></Panel>
    <Panel title="故障注入" action={<Tag kind={motorFault||gpsDrift?'orange':'green'}>{Number(motorFault)+Number(gpsDrift)} 项</Tag>}><div className="fault-row"><span>电机 2 效率下降 20%</span><Button onClick={()=>void toggleMotor()}>{motorFault?'停止':'注入'}</Button></div><div className="fault-row"><span>GPS 漂移 0.17 m/s</span><Button onClick={()=>void toggleGps()}>{gpsDrift?'停止':'注入'}</Button></div></Panel>
    <Panel title="传感器注入" action={<Tag kind={imuNoise?'orange':'green'}>{imuNoise?'已启用':'未启用'}</Tag>}><div className="fault-row"><span>IMU 噪声增强</span><Button onClick={()=>void toggleImu()}>{imuNoise?'停止':'注入'}</Button></div><div className="sensor-options"><span>延迟 {h?.config?.sensorDelayMs||0} ms</span><span>丢包 {((h?.config?.dropoutRate||0)*100).toFixed(1)}%</span></div></Panel>
   </div>
   <Panel title="仿真视景" className="hil-scene" action={<Tag kind={shownPreview?'orange':shownEstimator?'green':'blue'}>{shownPreview?'离线预览':shownEstimator?'估计器验证':'MAVLink 闭环'}</Tag>}>
    <DroneVisual roll={Number(t.roll)||0} pitch={Number(t.pitch)||0} yaw={Number(t.yaw)||0} active={actualRunning} motors={controls} velocity={h?.velocity} wind={h?.config.wind}/>
    <div className="flight-strip"><Metric label="高度 (AMSL)" value={`${Number(t.altitude||0).toFixed(1)} m`}/><Metric label="地速" value={`${Number(t.speed||0).toFixed(1)} m/s`}/><Metric label="航向" value={`${Number(t.yaw||0).toFixed(0)}°`}/><Metric label="北 / 东 / 地" value={(h?.position||[0,0,0]).map((v:number)=>v.toFixed(1)).join(' / ')}/></div>
   </Panel>
   <div className="hil-output">
    <Panel title="执行器输出（虚拟）"><div className="actuator-cards">{motors.map((motor:number,index:number)=><div key={index}><div><b>M{index+1}</b><span>controls[{index}]</span></div><strong>{Math.round(motor/100*9200).toLocaleString()} <small>RPM</small></strong><i><em style={{width:`${motor}%`}}/></i><footer><span>{channelNames[index]}</span><b>{motor}%</b></footer></div>)}</div></Panel>
    <Panel title="通信与实时性"><div className="comms"><p><i className={f.link.connected?'ok':'off'}/>MAVLink 2：{f.link.connected?'已连接':'未连接'} · 丢包 {f.link.lossRate.toFixed(2)}%</p><p><i className={actualRunning?'ok':'off'}/>HIL_SENSOR：{previewMode?'本地生成':'TX 500 Hz'} · 队列 {f.link.txQueueBytes||0} B</p><p><i className={estimatorMode||messageRate>0?'ok':'off'}/>{estimatorMode?'执行器反馈：估计器验证模式不需要':`执行器 RX ${messageRate.toFixed(1)} Hz · 丢弃过期帧 ${f.link.droppedTx||0}`}</p><p><i className={(h?.timing.p95JitterMs||0)<3?'ok':'off'}/>调度抖动 P95 {(h?.timing.p95JitterMs||0).toFixed(2)} ms · 最大 {(h?.timing.maxJitterMs||0).toFixed(2)} ms</p></div></Panel>
   </div>
  </div>

  <div className="hil-middle">
   <Panel title="虚拟传感器数据" action={shownEstimator?<Tag kind={attitudeError!=null&&attitudeError<3?'green':'orange'}>{attitudeError==null?'等待姿态遥测':`姿态误差 ${attitudeError.toFixed(2)}°`} · {positionError==null?'等待位置遥测':`位置 ${positionError.toFixed(2)} m`}</Tag>:undefined}><div className="sensor-table">{[['IMU','速度 N/E/D',(h?.velocity||[0,0,0]).map((v:number)=>v.toFixed(2)).join(' / ')],['GPS','经纬度',`${Number(t.lat||0).toFixed(7)}, ${Number(t.lon||0).toFixed(7)}`],['磁力计','地磁场','模型 + 噪声 + 偏置'],['气压计','气压高度',`${Number(t.altitude||0).toFixed(2)} m`],['真值','四元数',(h?.quaternion||[1,0,0,0]).map((v:number)=>v.toFixed(3)).join(' / ')]].map(row=><div key={row[0]}><b>{row[0]}</b><span>{row[1]}</span><em>{row[2]}</em></div>)}</div></Panel>
   <Panel title={shownEstimator?'估计器验证数据流 (HIL)':'闭环数据流 (HIL)'} className="hil-flow">{shownEstimator?<><div className="arch-flow"><div><b>预设真值轨迹</b><small>{trajectory}</small></div><i>→</i><div><b>虚拟传感器</b><small>噪声 IMU / GPS</small></div><i>→</i><div className={!connectedReady?'inactive':''}><b>飞控固件</b><small>姿态解算 / ESKF</small></div><i>→</i><div><b>原有遥测</b><small>姿态 / 位置 / 状态</small></div><i>→</i><div><b>真值对比</b><small>不参与估计</small></div></div><div className="loop-line">单向传感器激励 · 忽略 HIL_ACTUATOR_CONTROLS</div></>:<><div className="arch-flow"><div><b>动力学引擎</b><small>6DOF / 风场</small></div><i>→</i><div><b>虚拟传感器</b><small>500 Hz</small></div><i>→</i><div className={!connectedReady?'inactive':''}><b>飞控固件</b><small>估计 / 控制 / 混控</small></div><i>→</i><div><b>执行器输出</b><small>500 Hz</small></div><i>→</i><div><b>电机模型</b><small>推力 / 反扭矩</small></div></div><div className="loop-line">← 同一 USB CDC / MAVLink 2 闭环反馈 →</div></>}</Panel>
  </div>

  <div className="hil-bottom"><Panel title={shownEstimator?'估计值与真值对比（实时）':'关键曲线（实时）'} className="key-charts"><div className="four-charts">{shownEstimator?<><MiniLineChart data={f.chartData} keys={['roll','truthRoll']} title="Roll 估计 / 真值 (°)" height={95}/><MiniLineChart data={f.chartData} keys={['pitch','truthPitch']} title="Pitch 估计 / 真值 (°)" height={95}/><MiniLineChart data={f.chartData} keys={['yaw','truthYaw']} title="Yaw 估计 / 真值 (°)" height={95}/><MiniLineChart data={f.chartData} keys={['attitudeError']} title="四元数姿态误差 (°)" height={95}/></>:<><MiniLineChart data={f.chartData} keys={['x','y','z']} title="角速度 (rad/s)" height={95}/><MiniLineChart data={f.chartData} keys={['roll','pitch','yaw']} title="姿态角 (°)" height={95}/><MiniLineChart data={f.chartData} keys={['m1','m2','m3','m4']} title="电机输出 (%)" height={95}/><MiniLineChart data={f.chartData} keys={['speed','altitude']} title="速度 / 高度" height={95}/></>}</div></Panel><Panel title="事件 / 消息控制台 (HIL)"><div className="console">{f.messages.length?f.messages.slice(0,6).map(message=><div key={`${message.time}-${message.text}`}>● {new Date(message.time).toLocaleTimeString('zh-CN',{hour12:false})}　{message.text}</div>):'等待飞控 STATUSTEXT 或 HIL 告警…'}</div></Panel></div>
 </div>
}
