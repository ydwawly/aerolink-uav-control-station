import type { ChartPoint, Telemetry } from '../types';

export const initialTelemetry: Telemetry = { roll:2.1, pitch:-1.3, yaw:128.7, altitude:25.6, speed:8.6, voltage:15.8, current:4.6, battery:82, latency:28, cpu:21, motors:[62,58,61,59], simTime:168 };

export function nextTelemetry(prev: Telemetry, running:boolean): Telemetry {
  if (!running) return prev;
  const wave = Math.sin(Date.now()/1100);
  return { ...prev, roll:2.1+wave*.6, pitch:-1.3+Math.cos(Date.now()/900)*.4, yaw:(prev.yaw+.07)%360,
    altitude:25.6+Math.sin(Date.now()/2500)*1.3, speed:8.6+wave*.25, voltage:Math.max(14.2, prev.voltage-.0004),
    current:4.6+Math.random()*.3, battery:Math.max(0,prev.battery-.0008), latency:24+Math.round(Math.random()*6),
    cpu:20+Math.round(Math.random()*4), motors:prev.motors.map((m,i)=>Math.round(m+Math.sin(Date.now()/450+i)*1.2)), simTime:prev.simTime+.1 };
}

export function seedCharts(count=120): ChartPoint[] {
  return Array.from({length:count},(_,i)=>{
    const n=(s=1)=>(Math.sin(i/s)+Math.sin(i*.43))*s;
    return {t:i-count,x:n(4)+Math.random()*5,y:n(5)-5,z:n(3)+2,roll:n(3),pitch:n(4)-3,yaw:35+n(8),m1:60+n(5),m2:56+n(4),m3:61+n(3),m4:58+n(4),altitude:18+n(2),voltage:16.4-i*.006,speed:8+n(1)};
  });
}
