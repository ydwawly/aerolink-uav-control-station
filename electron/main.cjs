const {app,BrowserWindow,ipcMain,dialog}=require('electron');
const path=require('path');
const fs=require('fs');
const {Worker}=require('worker_threads');
const {SerialLink}=require('./serial-link.cjs');
const {VehicleSession}=require('./vehicle-session.cjs');
const {FirmwareUpdater,identifyBootPort,closePort,loadPackage,sleep}=require('./bootloader-updater.cjs');

let mainWindow,link,session,hilWorker,hilPreviewMode=false,telemetryTimer=null,latestTelemetry=null,firmwareUpdateActive=false;
let firmwareUpdater=null;
let hilStatus={phase:'idle',mode:null,reason:'',startedAt:0};
const send=(channel,payload)=>{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send(channel,payload)};
const setHilStatus=patch=>{hilStatus={...hilStatus,...patch};send('aerolink:hilStatus',hilStatus);return hilStatus};
function createServices(){
 const logRoot=path.join(app.getPath('documents'),'AeroLink','Logs');link=new SerialLink();session=new VehicleSession(link,logRoot);link.on('close',()=>{if(!hilPreviewMode&&!firmwareUpdateActive){hilWorker?.postMessage({type:'pause'});setHilStatus({phase:'fault',reason:'USB CDC 连接中断'})}});
 for(const event of ['link','parameters','logs','statusText','commandProgress','logProgress','error'])session.on(event,data=>send(`aerolink:${event}`,event==='error'?{message:data.message}:data));
 session.on('telemetry',data=>{latestTelemetry=data;if(!telemetryTimer)telemetryTimer=setTimeout(()=>{telemetryTimer=null;if(latestTelemetry)send('aerolink:telemetry',latestTelemetry)},33)});
 session.on('hil-actuators',data=>hilWorker?.postMessage({type:'actuators',controls:data.controls,timeUsec:data.timeUsec}));
 ipcMain.handle('aerolink:listPorts',()=>SerialLink.list());
 ipcMain.handle('aerolink:connect',async(_e,cfg)=>{await link.open(cfg);return session.linkStats()});
 ipcMain.handle('aerolink:disconnect',async()=>{await link.close();return true});
 ipcMain.handle('aerolink:getLinkState',()=>session.linkStats());
 ipcMain.handle('aerolink:requestParameters',()=>session.requestParameters());
 ipcMain.handle('aerolink:setParameter',(_e,p)=>session.setParameter(p.id,p.value,p.type));
 ipcMain.handle('aerolink:exportParameters',()=>exportParameters());
 ipcMain.handle('aerolink:importParameters',()=>importParameters());
 ipcMain.handle('aerolink:sendCommand',(_e,p)=>session.command(p.command,p.params||[0,0,0,0,0,0,0]));
 ipcMain.handle('aerolink:setMessageInterval',(_e,p)=>session.setMessageInterval(p.messageId,p.hz));
 ipcMain.handle('aerolink:listLogs',()=>session.listLogs());
 ipcMain.handle('aerolink:downloadLog',(_e,p)=>session.downloadLog(p.entry,p.destination||path.join(logRoot,`flight-${p.entry.id}.bin`)));
 ipcMain.handle('aerolink:eraseLogs',()=>session.eraseLogs());
 ipcMain.handle('aerolink:listLocalLogs',()=>listLocalLogs(logRoot));
 ipcMain.handle('aerolink:loadReplay',(_e,file)=>loadReplay(file));
 ipcMain.handle('aerolink:startHil',(_e,cfg)=>startHil(cfg));
 ipcMain.handle('aerolink:getHilStatus',()=>hilStatus);
 ipcMain.handle('aerolink:sendRcOverride',(_e,p={})=>{if(!p.release&&(hilStatus.mode!=='closed-loop'||hilStatus.phase!=='running'))throw new Error('虚拟遥控器仅可在闭环 HIL 运行时启用');return session.sendRcOverride(p.channels,p.release)});
 ipcMain.handle('aerolink:selectFirmware',()=>selectFirmwarePackage());
 ipcMain.handle('aerolink:startFirmwareUpdate',(_e,p)=>startFirmwareUpdate(p));
 ipcMain.handle('aerolink:cancelFirmwareUpdate',()=>firmwareUpdater?.cancel()||false);
 ipcMain.handle('aerolink:pauseHil',()=>{hilWorker?.postMessage({type:'pause'});session.sendRcOverride([],true).catch(()=>{});setHilStatus({phase:'paused'});return true});
 ipcMain.handle('aerolink:resetHil',()=>{hilWorker?.postMessage({type:'reset'});session.sendRcOverride([],true).catch(()=>{});setHilStatus({phase:'paused',reason:''});return true});
 ipcMain.handle('aerolink:configureHil',(_e,cfg)=>{hilWorker?.postMessage({type:'configure',config:cfg||{}});return true});
 ipcMain.handle('aerolink:stopHil',()=>stopHil());
}
function onceWithTimeout(emitter,event,timeout,message){return new Promise((resolve,reject)=>{const onEvent=value=>{cleanup();resolve(value)},cleanup=()=>{clearTimeout(timer);emitter.off(event,onEvent)},timer=setTimeout(()=>{cleanup();reject(new Error(message))},timeout);emitter.once(event,onEvent)})}
async function findPortBySerial(serialNumber,timeout=10000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const ports=await SerialLink.list(),match=ports.find(port=>!serialNumber||port.serialNumber===serialNumber);if(match)return match;await sleep(250)}throw new Error('设备重枚举后未找到相同序列号的 CDC 端口')}
async function connectAndWaitHeartbeat(serialNumber,timeout=10000){const descriptor=await findPortBySerial(serialNumber,timeout),heartbeat=onceWithTimeout(session,'heartbeat',timeout,'重启后未收到飞控 HEARTBEAT');await link.open({path:descriptor.path,baudRate:921600,autoReconnect:true});await heartbeat;return descriptor}
async function selectFirmwarePackage(){const result=await dialog.showOpenDialog(mainWindow,{title:'选择 A/B 飞控固件包',properties:['openFile'],filters:[{name:'UAV firmware',extensions:['uavfw']}]});if(result.canceled||!result.filePaths[0])return{canceled:true};const pkg=loadPackage(result.filePaths[0]);return{canceled:false,path:result.filePaths[0],version:pkg.manifest.firmware_version,gitSha:pkg.manifest.git_sha,slots:Object.fromEntries(Object.entries(pkg.images).map(([slot,image])=>[slot,{size:image.data.length,crc32:`0x${image.crc32.toString(16).padStart(8,'0')}`}]))}}
async function startFirmwareUpdate({path:packagePath}={}){
 if(!packagePath)throw new Error('未选择 .uavfw 固件包');
 loadPackage(packagePath); // 先在飞控仍在应用态时完成包校验，避免无效包触发重启。
 if(!link.port?.isOpen||!session.connected)throw new Error('请先连接飞控并等待 HEARTBEAT');
 if(session.telemetry.armed)throw new Error('飞控已解锁，禁止固件升级');
 if(hilStatus.phase!=='idle')throw new Error('请先停止 HIL');
 const currentPath=link.config?.path,ports=await SerialLink.list(),current=ports.find(port=>port.path===currentPath),serialNumber=current?.serialNumber||'';
 if(!serialNumber)throw new Error('当前 CDC 设备没有稳定序列号，无法安全匹配重枚举设备');
 const report=state=>send('aerolink:firmwareProgress',state);
 firmwareUpdateActive=true;
 report({phase:'requesting-bootloader',percent:0,time:Date.now()});
 firmwareUpdater=new FirmwareUpdater();firmwareUpdater.on('progress',report);
 try{
  await session.command(246,[3,0,0,0,0,0,0]);
  await sleep(150);
  await link.close();
  const result=await firmwareUpdater.run({packagePath,serialNumber});
  report({phase:'waiting-trial',slot:result.slot,percent:100,time:Date.now()});
  await sleep(2300);
  await connectAndWaitHeartbeat(serialNumber,12000);
  report({phase:'trial-running',slot:result.slot,percent:100,time:Date.now()});
  const reset=onceWithTimeout(link,'close',13000,'候选固件未在确认窗口内复位');
  await reset;
  await onceWithTimeout(session,'heartbeat',12000,'确认复位后未恢复飞控 HEARTBEAT');

  /* 再进入一次 Bootloader，读取持久元数据确认最终分区，而不是仅凭心跳推断。 */
  report({phase:'verifying-confirmation',slot:result.slot,percent:100,time:Date.now()});
  await session.command(246,[3,0,0,0,0,0,0]);await sleep(150);await link.close();
  const verify=await identifyBootPort(serialNumber,12000);
  const expected=result.slot==='A'?1:2;
  if(verify.info.confirmedSlot!==expected){await closePort(verify.port);throw new Error(`固件未确认：期望 Slot ${result.slot}，元数据确认分区=${verify.info.confirmedSlot}`)}
  await verify.client.reboot();await closePort(verify.port);await sleep(2300);await connectAndWaitHeartbeat(serialNumber,12000);
  const completed={phase:'completed',slot:result.slot,version:result.version,gitSha:result.gitSha,percent:100,time:Date.now()};report(completed);return completed;
 }catch(error){report({phase:'failed',message:error.message,percent:0,time:Date.now()});throw error}
 finally{firmwareUpdater=null;firmwareUpdateActive=false}
}
async function exportParameters(){const result=await dialog.showSaveDialog(mainWindow,{title:'导出飞控参数',defaultPath:`vehicle-parameters-${new Date().toISOString().slice(0,10)}.json`,filters:[{name:'AeroLink 参数',extensions:['json']}]});if(result.canceled||!result.filePath)return{canceled:true};const parameters=[...session.params.values()].map(({id,value,type,componentId})=>({id,value,type,componentId}));fs.writeFileSync(result.filePath,JSON.stringify({schema:'aerolink.parameters.v1',exportedAt:new Date().toISOString(),target:session.target,parameters},null,2));return{canceled:false,path:result.filePath,count:parameters.length}}
async function importParameters(){const result=await dialog.showOpenDialog(mainWindow,{title:'导入飞控参数',properties:['openFile'],filters:[{name:'AeroLink 参数',extensions:['json']}]});if(result.canceled||!result.filePaths[0])return{canceled:true,parameters:[]};const parsed=JSON.parse(fs.readFileSync(result.filePaths[0],'utf8')),source=Array.isArray(parsed)?parsed:parsed.parameters;if(!Array.isArray(source))throw new Error('参数文件格式无效：缺少 parameters 数组');const parameters=source.map(item=>({id:String(item.id||''),value:Number(item.value),type:Number(item.type||9)})).filter(item=>item.id&&Buffer.byteLength(item.id,'utf8')<=16&&Number.isFinite(item.value)&&(item.type===6||item.type===9));if(!parameters.length)throw new Error('参数文件中没有可用的 REAL32/INT32 参数');return{canceled:false,path:result.filePaths[0],parameters}}
function listLocalLogs(root){try{fs.mkdirSync(root,{recursive:true});return fs.readdirSync(root).filter(x=>/\.(tlog|bin)$/i.test(x)).map(name=>{const file=path.join(root,name),s=fs.statSync(file);return{name,path:file,size:s.size,time:s.mtimeMs,source:'本地'}}).sort((a,b)=>b.time-a.time)}catch{return[]}}
function loadReplay(file){return new Promise((resolve,reject)=>{if(!file||!path.isAbsolute(file))return reject(new Error('回放文件路径无效'));const worker=new Worker(path.join(__dirname,'replay-worker.cjs'),{workerData:{file}});worker.once('message',m=>{worker.terminate();m.ok?resolve(m.data):reject(new Error(m.error))});worker.once('error',reject)})}
async function startHil(config={}){
 const estimatorOnly=!!config.estimatorOnly;
 const previewOnly=!estimatorOnly&&!!config.previewOnly;
 const mode=previewOnly?'preview':estimatorOnly?'estimator':'closed-loop';
 if(hilStatus.phase==='starting'||hilStatus.phase==='stopping')throw new Error(`HIL 正在${hilStatus.phase==='starting'?'启动':'停止'}`);
 setHilStatus({phase:'starting',mode,reason:''});
 try{
 if(!previewOnly){
  if(!link.port?.isOpen)throw new Error('闭环 HIL 未启动：请先在“设备连接”页连接 USB CDC');
  if(!session.connected)throw new Error('闭环 HIL 未启动：串口已打开，但尚未收到飞控 HEARTBEAT');
  if(session.telemetry.armed)throw new Error('闭环 HIL 未启动：飞控处于解锁状态，请先上锁');
  const requestedBase=(session.telemetry.baseMode||0)|32;
  await session.command(176,[requestedBase,session.telemetry.mode||0,0,0,0,0,0]);
  await session.waitForHilState(true,3000);
 }
 hilPreviewMode=previewOnly;
 if(!hilWorker){
  hilWorker=new Worker(path.join(__dirname,'hil-engine.cjs'));
  hilWorker.on('message',m=>{
   if(m.type==='sensor'&&!hilPreviewMode)session.sendHilSensor(m.data).catch(e=>send('aerolink:error',{message:`HIL_SENSOR 发送失败：${e.message}`}));
   else if(m.type==='gps'&&!hilPreviewMode)session.sendHilGps(m.data).catch(e=>send('aerolink:error',{message:`HIL_GPS 发送失败：${e.message}`}));
   else if(m.type==='truth'&&!hilPreviewMode)session.sendHilTruth(m.data).catch(e=>send('aerolink:error',{message:`HIL_STATE 发送失败：${e.message}`}));
   else if(m.type==='state'){send('aerolink:hilState',{...m.data,link:{txQueueBytes:link.stats.txQueueBytes,droppedTx:link.stats.droppedTx}});if(hilStatus.phase==='running'&&!m.data.running)setHilStatus({phase:'fault',reason:hilStatus.mode==='closed-loop'?'执行器输出超时':'仿真引擎已停止'})}
   else if(m.type==='warning'){setHilStatus({phase:'fault',reason:m.message});send('aerolink:statusText',{severity:4,text:m.message,time:Date.now()})}
  });
  hilWorker.on('error',e=>send('aerolink:error',{message:e.message}));
 }
 hilWorker.postMessage({type:'start',config:{...config,previewOnly}});
 setHilStatus({phase:'running',mode,reason:'',startedAt:Date.now()});
 const statusText=previewOnly?'离线动力学预览已启动（未建立飞控链路）':estimatorOnly?`估计器验证已启动：${config.trajectory||'combined'}（忽略执行器反馈）`:'MAVLink 2 闭环 HIL 已启动';
 send('aerolink:statusText',{severity:previewOnly?6:5,text:statusText,time:Date.now()});
 return{mode};
 }catch(error){setHilStatus({phase:'fault',reason:error.message});throw error}
}
async function stopHil(){
 if(!hilWorker&&hilStatus.phase==='idle')return true;
 setHilStatus({phase:'stopping',reason:''});hilWorker?.postMessage({type:'pause'});if(link.port?.isOpen)await session.sendRcOverride([],true).catch(()=>{});
 try{if(!hilPreviewMode&&session.connected){const base=(session.telemetry.baseMode||0)&~32;await session.command(176,[base,session.telemetry.mode||0,0,0,0,0,0]);await session.waitForHilState(false,3000)}}finally{if(hilWorker)await hilWorker.terminate();hilWorker=null;hilPreviewMode=false;setHilStatus({phase:'idle',mode:null,reason:'',startedAt:0})}return true
}
function createWindow(){mainWindow=new BrowserWindow({width:1680,height:945,minWidth:1280,minHeight:720,backgroundColor:'#03101c',titleBarStyle:'hiddenInset',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}});if(!app.isPackaged)mainWindow.loadURL('http://localhost:5173');else mainWindow.loadFile(path.join(__dirname,'../dist/index.html'))}
app.whenReady().then(()=>{createServices();createWindow();app.on('activate',()=>BrowserWindow.getAllWindows().length||createWindow())});
app.on('before-quit',()=>{if(telemetryTimer)clearTimeout(telemetryTimer);hilWorker?.terminate();session?.dispose();link?.close()});
app.on('window-all-closed',()=>process.platform!=='darwin'&&app.quit());
