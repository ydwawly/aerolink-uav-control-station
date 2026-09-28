const {parentPort}=require('worker_threads');
const {performance}=require('perf_hooks');
const G=9.80665;
const defaults={dt:.002,mass:1.65,arm:.23,inertia:[.031,.033,.055],maxRpm:9200,kThrust:1.85e-7,kTorque:2.8e-9,motorTau:.035,drag:.16,groundFriction:.82,wind:[0,0,0],motorEfficiency:[1,1,1,1],originLat:31.230123,originLon:121.473456,originAltMsl:4.2,startAltitude:0,previewOnly:false,estimatorOnly:false,trajectory:'combined',dropoutRate:0,sensorDelayMs:0,gpsDriftMps:[0,0],bias:{accel:[0,0,0],gyro:[0,0,0],mag:[0,0,0]},noise:{accel:.025,gyro:.0015,mag:.002,baro:.12,gps:.35}};
let cfg={...defaults,noise:{...defaults.noise},bias:{...defaults.bias}},running=false,simTime=0,state,controls=[0,0,0,0],motor=[0,0,0,0],delayed=[],lastWall=performance.now(),accumulator=0,lastActuatorAt=0,graceUntil=0,lastUi=0,lastGps=0,lastTruth=0,warned=false;
const timing={samples:[],maxJitterMs:0,overruns:0,droppedSteps:0,lastStepAt:0};
const finite=value=>Number.isFinite(Number(value))?Number(value):0;
const finiteState=()=>[...state.p,...state.v,...state.q,...state.w,...motor,...controls].every(Number.isFinite);
const actuatorControls=value=>Array.from({length:4},(_,index)=>Math.max(0,Math.min(1,finite(value?.[index]))));
const gauss=()=>{let u=0,v=0;while(!u)u=Math.random();while(!v)v=Math.random();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v)};
const qMul=(a,b)=>[a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3],a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2],a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1],a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0]];
const qNorm=q=>{const n=Math.hypot(...q)||1;return q.map(x=>x/n)};
const qFromEuler=(roll,pitch,yaw)=>{const cr=Math.cos(roll/2),sr=Math.sin(roll/2),cp=Math.cos(pitch/2),sp=Math.sin(pitch/2),cy=Math.cos(yaw/2),sy=Math.sin(yaw/2);return qNorm([cr*cp*cy+sr*sp*sy,sr*cp*cy-cr*sp*sy,cr*sp*cy+sr*cp*sy,cr*cp*sy-sr*sp*cy])};
const rotate=(q,v)=>qMul(qMul(q,[0,...v]),[q[0],-q[1],-q[2],-q[3]]).slice(1);
const invRotate=(q,v)=>rotate([q[0],-q[1],-q[2],-q[3]],v);
const euler=q=>({roll:Math.atan2(2*(q[0]*q[1]+q[2]*q[3]),1-2*(q[1]**2+q[2]**2)),pitch:Math.asin(Math.max(-1,Math.min(1,2*(q[0]*q[2]-q[3]*q[1])))),yaw:Math.atan2(2*(q[0]*q[3]+q[1]*q[2]),1-2*(q[2]**2+q[3]**2))});
const percentile=(values,p)=>{if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))]};
const post=(type,data)=>{if((type==='sensor'||type==='gps')&&Math.random()<cfg.dropoutRate)return;if(cfg.sensorDelayMs>0&&(type==='sensor'||type==='gps')){delayed.push({at:performance.now()+cfg.sensorDelayMs,type,data});delayed.sort((a,b)=>a.at-b.at)}else parentPort.postMessage({type,data})};
function reset(){simTime=0;state={p:[0,0,-cfg.startAltitude],v:[0,0,0],q:[1,0,0,0],w:[0,0,0],onGround:cfg.startAltitude<=0};controls=[0,0,0,0];motor=[0,0,0,0];delayed=[];warned=false;lastGps=lastTruth=lastUi=0;accumulator=0;lastWall=performance.now();lastActuatorAt=lastWall;graceUntil=lastActuatorAt+1500;timing.samples=[];timing.maxJitterMs=timing.overruns=timing.droppedSteps=0;timing.lastStepAt=0;emitState()}
function previewControl(){const maxTotal=4*cfg.kThrust*cfg.maxRpm**2,alt=-state.p[2],upSpeed=-state.v[2],collective=Math.max(.06,Math.min(.72,(cfg.mass*G+2.4*(cfg.startAltitude-alt)+1.5*(0-upSpeed))/maxTotal)),r=-state.q[1]*.08-state.w[0]*.025,p=-state.q[2]*.08-state.w[1]*.025,y=-state.w[2]*.012;controls=[collective-r+p+y,collective-r-p-y,collective+r-p+y,collective+r+p-y].map(x=>Math.max(0,Math.min(1,x)))}
function estimatorTrajectory(){
 const t=simTime+cfg.dt,deg=Math.PI/180,twoPi=2*Math.PI,profile=cfg.trajectory||'combined';
 let roll=0,pitch=0,yaw=0,rollRate=0,pitchRate=0,yawRate=0;
 const wave=(amplitude,hz)=>({value:amplitude*Math.sin(twoPi*hz*t),rate:amplitude*twoPi*hz*Math.cos(twoPi*hz*t)});
 if(profile==='roll'||profile==='combined'||profile==='figure8'){const x=wave(15*deg,.20);roll=x.value;rollRate=x.rate}
 if(profile==='pitch'||profile==='combined'||profile==='figure8'){const x=wave(10*deg,.13);pitch=x.value;pitchRate=x.rate}
 if(profile==='yaw'||profile==='combined'||profile==='figure8'){const x=wave(30*deg,.08);yaw=x.value;yawRate=x.rate}
 const altitude=Math.max(.5,finite(cfg.startAltitude)||2),p=[0,0,-altitude],v=[0,0,0],a=[0,0,0];
 if(profile==='figure8'){
  const w=twoPi*.025;
  p[0]=8*Math.sin(w*t);p[1]=4*Math.sin(2*w*t);p[2]=-(altitude+1.2*Math.sin(.5*w*t));
  v[0]=8*w*Math.cos(w*t);v[1]=8*w*Math.cos(2*w*t);v[2]=-.6*w*Math.cos(.5*w*t);
  a[0]=-8*w*w*Math.sin(w*t);a[1]=-16*w*w*Math.sin(2*w*t);a[2]=.3*w*w*Math.sin(.5*w*t);
 }
 const bodyRates=[rollRate-yawRate*Math.sin(pitch),pitchRate*Math.cos(roll)+yawRate*Math.sin(roll)*Math.cos(pitch),-pitchRate*Math.sin(roll)+yawRate*Math.cos(roll)*Math.cos(pitch)];
 state={p,v,q:qFromEuler(roll,pitch,yaw),w:bodyRates,onGround:false};controls=[0,0,0,0];motor=[0,0,0,0];simTime=t;
 publish(invRotate(state.q,[a[0],a[1],a[2]-G]));
}
function step(){
 if(cfg.estimatorOnly){estimatorTrajectory();return}
 if(cfg.previewOnly)previewControl();
 const dt=cfg.dt,L=cfg.arm/Math.sqrt(2),positions=[[L,-L],[L,L],[-L,L],[-L,-L]],spin=[1,-1,1,-1];let thrust=0,tau=[0,0,0];
 for(let i=0;i<4;i++){const target=Math.sqrt(Math.max(0,Math.min(1,controls[i]||0)))*cfg.maxRpm;motor[i]+=(target-motor[i])*Math.min(1,dt/cfg.motorTau);const efficiency=cfg.motorEfficiency[i]??1,T=cfg.kThrust*motor[i]**2*efficiency;thrust+=T;tau[0]+=-positions[i][1]*T;tau[1]+=positions[i][0]*T;tau[2]+=spin[i]*cfg.kTorque*motor[i]**2*efficiency}
 const forceBody=[0,0,-thrust],forceNed=rotate(state.q,forceBody),relative=state.v.map((value,index)=>value-(cfg.wind[index]||0)),accel=[forceNed[0]/cfg.mass-cfg.drag*relative[0]/cfg.mass,forceNed[1]/cfg.mass-cfg.drag*relative[1]/cfg.mass,G+forceNed[2]/cfg.mass-cfg.drag*relative[2]/cfg.mass];
 for(let i=0;i<3;i++){state.v[i]+=accel[i]*dt;state.p[i]+=state.v[i]*dt}
 state.onGround=false;if(state.p[2]>=0){state.p[2]=0;state.onGround=true;if(state.v[2]>0)state.v[2]=0;state.v[0]*=cfg.groundFriction;state.v[1]*=cfg.groundFriction;accel[2]=0;if(Math.abs(state.v[0])<.002){state.v[0]=0;accel[0]=0}if(Math.abs(state.v[1])<.002){state.v[1]=0;accel[1]=0}}
 const [Ix,Iy,Iz]=cfg.inertia,[wx,wy,wz]=state.w,alpha=[(tau[0]-(Iz-Iy)*wy*wz)/Ix,(tau[1]-(Ix-Iz)*wx*wz)/Iy,(tau[2]-(Iy-Ix)*wx*wy)/Iz];for(let i=0;i<3;i++)state.w[i]+=alpha[i]*dt;const qd=qMul(state.q,[0,...state.w]).map(value=>value*.5);state.q=qNorm(state.q.map((value,index)=>value+qd[index]*dt));simTime+=dt;if(!finiteState()){running=false;if(!warned){warned=true;parentPort.postMessage({type:'warning',message:'HIL 动力学状态出现非有限值，仿真已安全暂停'})}emitState();return}
 const specificBody=invRotate(state.q,[accel[0],accel[1],accel[2]-G]);publish(specificBody);
}
function timingSnapshot(){return{maxJitterMs:timing.maxJitterMs,p95JitterMs:percentile(timing.samples,.95),overruns:timing.overruns,droppedSteps:timing.droppedSteps}}
function statePayload(){const angles=euler(state.q),altitude=-state.p[2],mode=cfg.previewOnly?'preview':cfg.estimatorOnly?'estimator':'closed-loop';return{running,mode,simTime,position:state.p,velocity:state.v,quaternion:state.q,roll:angles.roll*180/Math.PI,pitch:angles.pitch*180/Math.PI,yaw:(angles.yaw*180/Math.PI+360)%360,altitude,speed:Math.hypot(state.v[0],state.v[1]),motors:motor.map(value=>value/cfg.maxRpm),controls,onGround:state.onGround,timing:timingSnapshot(),config:{previewOnly:cfg.previewOnly,estimatorOnly:cfg.estimatorOnly,trajectory:cfg.trajectory,originAltMsl:cfg.originAltMsl,wind:cfg.wind,motorEfficiency:cfg.motorEfficiency,dropoutRate:cfg.dropoutRate,sensorDelayMs:cfg.sensorDelayMs}}}
function emitState(){if(state)post('state',statePayload())}
function publish(specific){
 const timeUsec=Math.round(simTime*1e6),relativeAlt=-state.p[2],altMsl=cfg.originAltMsl+relativeAlt,mag=invRotate(state.q,[.22,.02,.43]),pressure=1013.25*Math.pow(Math.max(.01,1-altMsl/44330),5.255),ba=cfg.bias.accel||[0,0,0],bg=cfg.bias.gyro||[0,0,0],bm=cfg.bias.mag||[0,0,0];
 post('sensor',{timeUsec,xacc:specific[0]+ba[0]+gauss()*cfg.noise.accel,yacc:specific[1]+ba[1]+gauss()*cfg.noise.accel,zacc:specific[2]+ba[2]+gauss()*cfg.noise.accel,xgyro:state.w[0]+bg[0]+gauss()*cfg.noise.gyro,ygyro:state.w[1]+bg[1]+gauss()*cfg.noise.gyro,zgyro:state.w[2]+bg[2]+gauss()*cfg.noise.gyro,xmag:mag[0]+bm[0]+gauss()*cfg.noise.mag,ymag:mag[1]+bm[1]+gauss()*cfg.noise.mag,zmag:mag[2]+bm[2]+gauss()*cfg.noise.mag,absPressure:pressure+gauss()*cfg.noise.baro,diffPressure:0,pressureAlt:altMsl,temperature:27});
 if(simTime-lastGps>=.1){lastGps=simTime;const drift=cfg.gpsDriftMps||[0,0],north=state.p[0]+drift[0]*simTime+gauss()*cfg.noise.gps,east=state.p[1]+drift[1]*simTime+gauss()*cfg.noise.gps,angles=euler(state.q);post('gps',{timeUsec,fixType:3,lat:Math.round((cfg.originLat+north/111111)*1e7),lon:Math.round((cfg.originLon+east/(111111*Math.cos(cfg.originLat*Math.PI/180)))*1e7),alt:Math.round(altMsl*1000),eph:80,epv:120,vn:Math.round(state.v[0]*100),ve:Math.round(state.v[1]*100),vd:Math.round(state.v[2]*100),vel:Math.round(Math.hypot(state.v[0],state.v[1])*100),cog:Math.round((angles.yaw*180/Math.PI+360)%360*100),satellites:18})}
 if(simTime-lastTruth>=.02){lastTruth=simTime;post('truth',{timeUsec,q:state.q,w:state.w,p:state.p,v:state.v,specific,originLat:cfg.originLat,originLon:cfg.originLon,originAltMsl:cfg.originAltMsl})}
 if(simTime-lastUi>=.04){lastUi=simTime;emitState()}
}
function recordStepTiming(now){if(timing.lastStepAt){const interval=now-timing.lastStepAt,jitter=Math.abs(interval-cfg.dt*1000);timing.maxJitterMs=Math.max(timing.maxJitterMs,jitter);timing.samples.push(jitter);if(timing.samples.length>1000)timing.samples.shift();if(interval>cfg.dt*1500)timing.overruns++}timing.lastStepAt=now}
function loop(){const now=performance.now(),elapsed=Math.min(.05,(now-lastWall)/1000);lastWall=now;while(delayed.length&&delayed[0].at<=now){const item=delayed.shift();parentPort.postMessage({type:item.type,data:item.data})}if(running){if(!cfg.previewOnly&&!cfg.estimatorOnly&&now>graceUntil&&now-lastActuatorAt>100){running=false;emitState();if(!warned){warned=true;parentPort.postMessage({type:'warning',message:'HIL 执行器输出超过 100 ms 未更新，仿真已暂停'})}}else{accumulator+=elapsed;let count=0;while(running&&accumulator>=cfg.dt&&count<25){recordStepTiming(performance.now());step();accumulator-=cfg.dt;count++}if(accumulator>=cfg.dt){const dropped=Math.floor(accumulator/cfg.dt);timing.droppedSteps+=dropped;accumulator-=dropped*cfg.dt}}}if(running||delayed.length)setImmediate(loop);else setTimeout(loop,10)}
parentPort.on('message',message=>{if(message.type==='start'){cfg={...defaults,...(message.config||{}),noise:{...defaults.noise,...(message.config?.noise||{})},bias:{...defaults.bias,...(message.config?.bias||{})}};reset();running=true;lastActuatorAt=performance.now();graceUntil=lastActuatorAt+1500;emitState()}else if(message.type==='configure'){cfg={...cfg,...(message.config||{}),noise:{...cfg.noise,...(message.config?.noise||{})},bias:{...cfg.bias,...(message.config?.bias||{})}};emitState()}else if(message.type==='pause'){running=false;emitState()}else if(message.type==='reset'){running=false;reset()}else if(message.type==='actuators'){controls=actuatorControls(message.controls);lastActuatorAt=performance.now();warned=false}});
reset();loop();
