const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {VehicleSession}=require('../electron/vehicle-session.cjs');
const {MAVLink20Processor}=require('../electron/mavlink/generated.js');

class LogLink extends EventEmitter{
 constructor(){super();this.port={isOpen:true};this.config={path:'LOG_MOCK'};this.stats={rxBytes:0,txBytes:0,txQueueBytes:0,droppedTx:0};this.frames=[]}
 write(data){this.frames.push(Buffer.from(data));return Promise.resolve({written:true})}
}

test('log list and chunked download preserve offsets and bytes',async()=>{
 const link=new LogLink();
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aerolink-log-'));
 const session=new VehicleSession(link,root,{replay:true});
 session.connected=true;
 session.onLogEntry({id:0,num_logs:0,last_log_num:0,time_utc:0,size:0});
 assert.equal(session.logEntries.size,0);
 session.onLogEntry({id:7,num_logs:1,last_log_num:7,time_utc:0,size:180});
 assert.equal(session.logEntries.get(7).size,180);
 const destination=path.join(root,'flight-7.bin');
 const done=session.downloadLog(session.logEntries.get(7),destination);
 const first=Buffer.alloc(90,0x11),second=Buffer.alloc(90,0xa5);
 session.onLogData({id:7,ofs:0,count:first.length,data:first});
 session.onLogData({id:7,ofs:90,count:second.length,data:second.toString('latin1')});
 const result=await done;
 assert.equal(result.size,180);
 assert.deepEqual(fs.readFileSync(destination),Buffer.concat([first,second]));
 assert.ok(link.frames.length>=2);
 session.dispose();
 fs.rmSync(root,{recursive:true,force:true});
});

test('log erase is sent only while the vehicle is disarmed',async()=>{
 const link=new LogLink();
 const session=new VehicleSession(link,'',{replay:true});
 session.telemetry.armed=true;
 await assert.rejects(session.eraseLogs(),/已解锁/);
 assert.equal(link.frames.length,0);
 session.telemetry.armed=false;
 await session.eraseLogs();
 const messages=new MAVLink20Processor(null,1,1).parseBuffer(link.frames[0])||[];
 assert.equal(messages[0]._name,'LOG_ERASE');
 assert.equal(messages[0].target_system,1);
 assert.equal(messages[0].target_component,1);
 session.dispose();
});
