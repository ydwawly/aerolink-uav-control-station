let running=false;
let simulationTimeUs=0;
let stepUs=2000;
let lastWallTime=performance.now();
let lastPublish=lastWallTime;

function loop(){
  const now=performance.now();
  if(running){
    const elapsedUs=Math.min(50000,(now-lastWallTime)*1000);
    const steps=Math.max(1,Math.floor(elapsedUs/stepUs));
    simulationTimeUs+=steps*stepUs;
    if(now-lastPublish>=100){ postMessage({type:'tick',simulationTimeUs,wallJitterMs:(now-lastPublish)-100}); lastPublish=now; }
  }
  lastWallTime=now;
  setTimeout(loop,10);
}
self.onmessage=(event:MessageEvent<{type:string;stepUs?:number}>)=>{
  if(event.data.type==='start')running=true;
  if(event.data.type==='pause')running=false;
  if(event.data.type==='reset')simulationTimeUs=0;
  if(event.data.type==='configure'&&event.data.stepUs)stepUs=event.data.stepUs;
};
loop();
