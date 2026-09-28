const fs=require('fs');
const path=require('path');
const {performance}=require('perf_hooks');
const {SerialLink}=require('../electron/serial-link.cjs');
const {VehicleSession,mavlink20,uint64Pair}=require('../electron/vehicle-session.cjs');

const argument=name=>process.argv.find(value=>value.startsWith(`--${name}=`))?.split('=')[1];
const portPath=argument('port')||'COM11';
const durationSeconds=Math.max(5,Number(argument('seconds')||60));
const throttlePwm=Math.max(1000,Math.min(1200,Number(argument('throttle')||1120)));
const logRoot=path.join(__dirname,'../artifacts/pressure-test');
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const monoUs=()=>Math.round(performance.now()*1000);

async function waitFor(session,event,predicate,timeoutMs){
 return new Promise((resolve,reject)=>{
  const listener=value=>{if(predicate(value)){cleanup();resolve(value)}};
  const cleanup=()=>{clearTimeout(timer);session.off(event,listener)};
  const timer=setTimeout(()=>{cleanup();reject(new Error(`等待 ${event} 超时`))},timeoutMs);
  session.on(event,listener);
 });
}

async function main(){
 fs.mkdirSync(logRoot,{recursive:true});
 const link=new SerialLink();
 const session=new VehicleSession(link,logRoot);
 const errors=[];
 const statusTexts=[];
 let latestLogs=[];
 let pressureStartedAt=0;
 let rcTimer=null,pingTimer=null,timeSyncTimer=null,hilTimer=null,reportTimer=null;
 let pingSequence=0,hilSequence=0;
 let downloadedLog=null;

 session.on('error',error=>errors.push({time:Date.now(),message:error.message}));
 session.on('statusText',value=>statusTexts.push(value));
 session.on('logs',logs=>{latestLogs=logs});

 const stopTimers=()=>{
  for(const timer of [rcTimer,pingTimer,timeSyncTimer,hilTimer,reportTimer])if(timer)clearInterval(timer);
  rcTimer=pingTimer=timeSyncTimer=hilTimer=reportTimer=null;
 };
 const release=async()=>{
  stopTimers();
  try{await session.sendRcOverride([],true)}catch{}
  await delay(150);
 };
 const shutdown=async()=>{
  await release();
  session.dispose();
  await link.close();
 };
 process.once('SIGINT',()=>shutdown().finally(()=>process.exit(130)));
 process.once('SIGTERM',()=>shutdown().finally(()=>process.exit(143)));

 try{
  await link.open({path:portPath,baudRate:921600,autoReconnect:false});
  if(!session.connected)await waitFor(session,'heartbeat',()=>true,10000);

  session.listLogs();
  await delay(2500);
  const candidate=[...latestLogs].filter(entry=>entry.size>1024).sort((a,b)=>b.size-a.size)[0];

  /* 先用最低油门连续发送 1 秒，再拉高 CH8 解锁，避免解锁瞬间油门不安全。 */
  const safeChannels=[1500,1500,1000,1500,1000,1000,1000,1000];
  const armedLowChannels=[1500,1500,1000,1500,1000,1000,1000,2000];
  const loadedChannels=[1500,1500,throttlePwm,1500,1000,1000,1000,2000];
  rcTimer=setInterval(()=>session.sendRcOverride(safeChannels).catch(error=>errors.push({time:Date.now(),message:error.message})),40);
  await delay(1000);
  clearInterval(rcTimer);
  rcTimer=setInterval(()=>session.sendRcOverride(armedLowChannels).catch(error=>errors.push({time:Date.now(),message:error.message})),40);
  await delay(1500);
  if(!session.telemetry.armed)await waitFor(session,'heartbeat',telemetry=>telemetry.armed,2500);
  clearInterval(rcTimer);
  rcTimer=setInterval(()=>session.sendRcOverride(loadedChannels).catch(error=>errors.push({time:Date.now(),message:error.message})),40);

  pressureStartedAt=Date.now();

  /*
   * 1 kHz PING 产生等速回包，500 Hz TIMESYNC 与 500 Hz HIL_SENSOR 继续压满接收解析路径。
   * HIL 模式未开启，因此 HIL_SENSOR 只测试协议解析/消息分发，不替换真实姿态传感器。
   */
  pingTimer=setInterval(()=>{
   pingSequence=(pingSequence+1)>>>0;
   session.send(new mavlink20.messages.ping(uint64Pair(monoUs()),pingSequence,0,0),0)
    .catch(error=>errors.push({time:Date.now(),message:error.message}));
  },1);
  timeSyncTimer=setInterval(()=>{
   session.send(new mavlink20.messages.timesync(uint64Pair(0),uint64Pair(monoUs())),1)
    .catch(error=>errors.push({time:Date.now(),message:error.message}));
  },2);
  hilTimer=setInterval(()=>{
   hilSequence++;
   session.sendHilSensor({timeUsec:monoUs(),xacc:0,yacc:0,zacc:-9.80665,xgyro:0,xmag:.22,ymag:0,zmag:.43,
    absPressure:1013.25,temperature:25}).catch(error=>errors.push({time:Date.now(),message:error.message}));
  },2);

  /* 如果板上已有已关闭的大日志，则同时下载，制造 SD 读写与 USB TX 满载。 */
  let downloadPromise=null;
  if(candidate){
   const destination=path.join(logRoot,`pressure-download-${candidate.id}-${Date.now()}.bin`);
   downloadPromise=session.downloadLog(candidate,destination).then(result=>{downloadedLog={id:candidate.id,...result}})
    .catch(error=>errors.push({time:Date.now(),message:`日志下载：${error.message}`}));
  }

  reportTimer=setInterval(()=>{
   const stats=session.linkStats();
   console.log(JSON.stringify({elapsedSeconds:Math.round((Date.now()-pressureStartedAt)/1000),armed:session.telemetry.armed,
    rxBytes:stats.rxBytes,txBytes:stats.txBytes,rxPackets:stats.rxPackets,lostPackets:stats.lostPackets,
    txQueueBytes:stats.txQueueBytes,droppedTx:stats.droppedTx}));
  },5000);

  await delay(durationSeconds*1000);
  if(session.download)session.cancelDownload('压力测试到时，主动结束下载');
  if(downloadPromise)await Promise.race([downloadPromise,delay(500)]);
  await release();
  if(session.telemetry.armed){
   try{await waitFor(session,'heartbeat',telemetry=>!telemetry.armed,2500)}
   catch(error){errors.push({time:Date.now(),message:`上锁心跳确认：${error.message}`})}
  }

  const result={
   port:portPath,durationSeconds,throttlePwm,startedAt:new Date(pressureStartedAt).toISOString(),
   endedAt:new Date().toISOString(),telemetry:{armed:session.telemetry.armed,baseMode:session.telemetry.baseMode,
    hilEnabled:session.telemetry.hilEnabled,latencyMs:session.telemetry.latency},
   link:session.linkStats(),candidateLog:candidate||null,downloadedLog,statusTexts,errors:errors.slice(-50)
  };
  const resultPath=path.join(logRoot,`pressure-result-${Date.now()}.json`);
  fs.writeFileSync(resultPath,JSON.stringify(result,null,2));
  console.log(JSON.stringify({...result,resultPath},null,2));
 }finally{
  await shutdown();
 }
}

main().catch(error=>{console.error(error);process.exitCode=1});
