import { useEffect,useState } from 'react';
import { Flag, Pause, Play, Search, Trash2 } from 'lucide-react';
import type { ChartPoint,Telemetry } from '../types';
import { MiniLineChart } from '../components/Charts';
import { AttitudeGauge, MapVisual } from '../components/Visuals';
import { Button, Panel, SelectBox } from '../components/UI';
import {useFlight} from '../services/FlightContext';

const groups:Array<[string,string[]]>=[['陀螺仪 (rad/s)',['Gyro X','Gyro Y','Gyro Z']],['姿态角 (°)',['Roll','Pitch','Yaw']],['电机输出 (%)',['Motor 1','Motor 2','Motor 3','Motor 4']],['高度 (m)',['Altitude']],['电池',['Voltage (V)']],['GPS 速度 (m/s)',['GPS Speed']]];
export default function ChartsPage({telemetry:t}:{telemetry:Telemetry}){
 const f=useFlight();const[paused,setPaused]=useState(false),[frozen,setFrozen]=useState<ChartPoint[]>([]);useEffect(()=>{if(!paused)setFrozen(f.chartData)},[f.chartData,paused]);const data=paused?frozen:f.chartData;
 return <div className="charts-page page-fill">
 <div className="chart-toolbar"><h2>实时曲线</h2><button className="active">时域曲线</button><button title="后续版本实现窗口 FFT">频域分析 (FFT)</button><button>事件标记</button><span/><label>时间范围</label><SelectBox>最近 {data.length} 点</SelectBox><label>接收速率</label><SelectBox>{Object.values(f.link.messageRates).reduce((a,b)=>a+b,0).toFixed(1)} Hz</SelectBox><Button onClick={()=>setPaused(!paused)}>{paused?<Play/>:<Pause/>} {paused?'继续':'暂停显示'}</Button><Button disabled title="原始 MAVLink 在连接后自动写入 .tlog"><i className="rec"/> {f.link.connected?'原始记录中':'未记录'}</Button><Button onClick={f.clearCharts}><Trash2/> 清除缓存</Button></div>
 <div className="chart-body"><Panel title="信号列表" className="signal-list"><div className="search"><Search/>搜索信号</div>{groups.map(([g,items])=><div className="signal-group" key={g}><b>⌄ {g}</b>{items.map((x,i)=><label key={x}><input type="checkbox" defaultChecked/> {x}<i style={{background:['#f34b4f','#36d67b','#3099fa','#ffad29'][i]}}/></label>)}</div>)}<small>数据源：实时 MAVLink 路由</small></Panel>
 <div className="chart-stack">{[
  ['陀螺仪 (rad/s)',['x','y','z'],[-10,10]],['姿态角 (°)',['roll','pitch','yaw'],[-180,180]],['电机输出 (%)',['m1','m2','m3','m4'],[0,100]],['高度 (m)',['altitude'],undefined],['电池电压 (V)',['voltage'],[0,30]],['GPS 速度 (m/s)',['speed'],[0,30]]
 ].map(([title,keys,domain])=><MiniLineChart key={String(title)} data={data} title={String(title)} keys={keys as string[]} domain={domain as [number,number]|undefined} height={94}/>)}</div>
 <div className="chart-side"><Panel title="光标信息"><div className="dense-list"><span>最新时间　{data.length?new Date(data.at(-1)!.t).toLocaleTimeString('zh-CN',{hour12:false}):'—'}</span><span>采样点　　{data.length.toLocaleString()}</span><span>显示状态　{paused?'已暂停':'实时刷新'}</span></div><Button><Flag/> 添加标记</Button></Panel><Panel title="统计概览"><div className="dense-list"><span>已解析帧　{f.link.rxPackets.toLocaleString()}</span><span>丢失帧　　{f.link.lostPackets.toLocaleString()}</span><span>丢包率　　{f.link.lossRate.toFixed(3)}%</span><span>心跳　　　{(f.link.messageRates.HEARTBEAT||0).toFixed(1)} Hz</span></div></Panel><Panel title="姿态指示器"><div className="gauge-row"><AttitudeGauge roll={t.roll} pitch={t.pitch}/><div><p className="red">Roll　{t.roll.toFixed(1)}°</p><p className="green">Pitch　{t.pitch.toFixed(1)}°</p><p className="blue">Yaw　{t.yaw.toFixed(1)}°</p></div></div></Panel><Panel title="地图视图（实时轨迹）"><MapVisual points={f.gpsTrail} hasFix={(t.gpsFix||0)>=2}/></Panel></div>
 </div>
 <Panel title="事件标记" className="event-strip"><div className="event-line">{f.messages.length?f.messages.slice(0,8).map(m=>`${new Date(m.time).toLocaleTimeString('zh-CN',{hour12:false})} ${m.text}`).join('　｜　'):'暂无 STATUSTEXT 事件'}</div></Panel>
 <footer className="statusbar"><span>● 链路：{f.link.connected?'已连接':'未连接'}</span><span>RX：{(f.link.rxBytes/1024).toFixed(1)} KiB</span><span>TX：{(f.link.txBytes/1024).toFixed(1)} KiB</span><span>图表缓冲：{data.length} / 1200 点</span></footer>
 </div>
}
