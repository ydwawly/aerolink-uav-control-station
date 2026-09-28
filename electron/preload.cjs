const {contextBridge,ipcRenderer}=require('electron');
const invoke=(name,payload)=>ipcRenderer.invoke(`aerolink:${name}`,payload);
const subscribe=name=>listener=>{const fn=(_event,payload)=>listener(payload);ipcRenderer.on(`aerolink:${name}`,fn);return()=>ipcRenderer.removeListener(`aerolink:${name}`,fn)};
contextBridge.exposeInMainWorld('aeroLink',{
 listPorts:()=>invoke('listPorts'),connect:c=>invoke('connect',c),disconnect:()=>invoke('disconnect'),getLinkState:()=>invoke('getLinkState'),
 requestParameters:()=>invoke('requestParameters'),setParameter:p=>invoke('setParameter',p),exportParameters:()=>invoke('exportParameters'),importParameters:()=>invoke('importParameters'),sendCommand:p=>invoke('sendCommand',p),setMessageInterval:p=>invoke('setMessageInterval',p),
 listLogs:()=>invoke('listLogs'),downloadLog:p=>invoke('downloadLog',p),eraseLogs:()=>invoke('eraseLogs'),listLocalLogs:()=>invoke('listLocalLogs'),loadReplay:file=>invoke('loadReplay',file),
 startHil:c=>invoke('startHil',c),pauseHil:()=>invoke('pauseHil'),resetHil:()=>invoke('resetHil'),configureHil:c=>invoke('configureHil',c),stopHil:()=>invoke('stopHil'),getHilStatus:()=>invoke('getHilStatus'),sendRcOverride:p=>invoke('sendRcOverride',p),
 selectFirmware:()=>invoke('selectFirmware'),startFirmwareUpdate:p=>invoke('startFirmwareUpdate',p),cancelFirmwareUpdate:()=>invoke('cancelFirmwareUpdate'),
 onLink:subscribe('link'),onTelemetry:subscribe('telemetry'),onParameters:subscribe('parameters'),onLogs:subscribe('logs'),onStatusText:subscribe('statusText'),onCommandProgress:subscribe('commandProgress'),onLogProgress:subscribe('logProgress'),onHilState:subscribe('hilState'),onHilStatus:subscribe('hilStatus'),onFirmwareProgress:subscribe('firmwareProgress'),onError:subscribe('error')
});
