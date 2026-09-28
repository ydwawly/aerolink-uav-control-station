const {EventEmitter}=require('events');
const {mavlink20,MAVLink20Processor}=require('../../electron/mavlink/generated.js');
class LoopbackLink extends EventEmitter{constructor(){super();this.port={isOpen:true};this.config={path:'MOCK_FC'};this.stats={rxBytes:0,txBytes:0,txQueueBytes:0,droppedTx:0};this.peer=null}write(data){const frame=Buffer.from(data);this.stats.txBytes+=frame.length;queueMicrotask(()=>this.peer?.receive(frame));return Promise.resolve({written:true})}}
class MockFlightController{
 constructor(){this.link=new LoopbackLink();this.link.peer=this;this.rx=new MAVLink20Processor(null,255,190);this.tx=new MAVLink20Processor(null,1,1);this.baseMode=0;this.params=[{id:'MC_ROLL_P',value:4.2,type:9},{id:'SYS_ID',value:1,type:6}];this.sensorFrames=0}
 start(){this.heartbeat();this.timer=setInterval(()=>this.heartbeat(),100)}
 stop(){clearInterval(this.timer)}
 send(message){const frame=Buffer.from(message.pack(this.tx));this.tx.seq=(this.tx.seq+1)&255;this.link.stats.rxBytes+=frame.length;this.link.emit('data',frame)}
 heartbeat(){this.send(new mavlink20.messages.heartbeat(2,0,this.baseMode,0,4))}
 receive(frame){for(const message of this.rx.parseBuffer(frame)||[]){if(message._name==='COMMAND_LONG'){if(message.command===176)this.baseMode=Math.trunc(message.param1);this.send(new mavlink20.messages.command_ack(message.command,0,100,0,255,190));this.heartbeat()}else if(message._name==='PARAM_REQUEST_LIST'){this.params.forEach((parameter,index)=>this.send(new mavlink20.messages.param_value(parameter.id,parameter.value,parameter.type,this.params.length,index)))}else if(message._name==='PARAM_SET'){const id=String(message.param_id).replace(/\0.*$/,''),parameter=this.params.find(value=>value.id===id);if(parameter){parameter.value=message.param_value;this.send(new mavlink20.messages.param_value(parameter.id,parameter.value,parameter.type,this.params.length,this.params.indexOf(parameter)))}}else if(message._name==='HIL_SENSOR'){this.sensorFrames++;this.send(new mavlink20.messages.hil_actuator_controls(message.time_usec,[.25,.25,.25,.25,0,0,0,0,0,0,0,0,0,0,0,0],this.baseMode,[0,0,true]))}}}
}
module.exports={MockFlightController};
