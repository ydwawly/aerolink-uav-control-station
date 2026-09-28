const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {FirmwareUpdater,FrameDecoder,buildFrame,crc32,loadPackage}=require('../electron/bootloader-updater.cjs');
const {COMMANDS,SLOTS}=require('../electron/boot-protocol-generated.cjs');

test('IEEE CRC32 matches the standard vector',()=>{
 assert.equal(crc32(Buffer.from('123456789')),0xcbf43926);
});

test('decoder handles noise and fragmented frames',()=>{
 const decoder=new FrameDecoder(),frame=buildFrame(1,0x1234,Buffer.from([1,2,3]));
 assert.deepEqual(decoder.push(Buffer.concat([Buffer.from([0xaa,0xbb]),frame.subarray(0,7)])),[]);
 const result=decoder.push(frame.subarray(7));
 assert.equal(result.length,1);
 assert.equal(result[0].command,1);
 assert.equal(result[0].sequence,0x1234);
 assert.deepEqual([...result[0].payload],[1,2,3]);
});

test('decoder rejects a corrupt frame and resynchronizes',()=>{
 const decoder=new FrameDecoder(),bad=buildFrame(1,2);bad[bad.length-1]^=1;
 const good=buildFrame(6,3,Buffer.from([9]));
 const result=decoder.push(Buffer.concat([bad,good]));
 assert.equal(result.length,1);
 assert.equal(result[0].command,6);
 assert.equal(result[0].sequence,3);
});

test('package parser rejects oversized input before ZIP decoding',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uavfw-test-')),file=path.join(root,'oversized.uavfw');
 try{
  fs.writeFileSync(file,Buffer.alloc(4*1024*1024+1));
  assert.throws(()=>loadPackage(file),/4 MiB/);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});

function makeUpdater({confirmedSlot=SLOTS.A,platformFlags=0x0f,maxChunk=4,writeFailure=false}={}){
 const calls=[];
 const image=Buffer.from([0,1,2,3,4,5,6,7,8]);
 const pkg={manifest:{firmware_version:'test-2.0',git_sha:'0123456'},images:{
  A:{data:image,crc32:crc32(image),buildId:1n},B:{data:image,crc32:crc32(image),buildId:2n},
 }};
 const client={
  aborted:false,rebooted:false,
  async request(command,payload){
   calls.push({command,payload:Buffer.from(payload||[])});
   if(command===COMMANDS.WRITE_CHUNK){
    if(writeFailure)throw new Error('injected write failure');
    const ack=Buffer.alloc(4);ack.writeUInt32LE(payload.readUInt32LE(0)+payload.length-4);return ack;
   }
   return Buffer.alloc(0);
  },
  async abort(){this.aborted=true},
  async reboot(){this.rebooted=true},
 };
 let closed=false;
 const updater=new FirmwareUpdater({
  packageLoader:()=>pkg,
  portIdentifier:async()=>({port:{},client,info:{confirmedSlot,platformFlags,maxChunk}}),
  portCloser:async()=>{closed=true},
 });
 return{updater,client,calls,wasClosed:()=>closed};
}

test('updater always writes the inactive slot in contiguous chunks',async()=>{
 const fixture=makeUpdater({confirmedSlot:SLOTS.A,maxChunk:4});
 const progress=[];fixture.updater.on('progress',event=>progress.push(event));
 const result=await fixture.updater.run({packagePath:'injected.uavfw',serialNumber:'SERIAL'});
 assert.equal(result.slot,'B');
 assert.equal(fixture.client.timeout,5000);
 assert.equal(fixture.client.retries,3);
 assert.equal(fixture.calls[0].command,COMMANDS.BEGIN_UPDATE);
 assert.equal(fixture.calls[0].payload[0],SLOTS.B);
 const offsets=fixture.calls.filter(call=>call.command===COMMANDS.WRITE_CHUNK).map(call=>call.payload.readUInt32LE(0));
 assert.deepEqual(offsets,[0,4,8]);
 assert.equal(fixture.calls.at(-1).command,COMMANDS.FINALIZE);
 assert.equal(fixture.client.rebooted,true);
 assert.equal(fixture.wasClosed(),true);
 assert.equal(progress.at(-1).phase,'rebooting');
});

test('updater rejects unsafe Option Bytes before erase and closes the port',async()=>{
 const fixture=makeUpdater({platformFlags:0x07});
 await assert.rejects(
  fixture.updater.run({packagePath:'injected.uavfw',serialNumber:'SERIAL'}),
  /Option Bytes\/平台检查失败/,
 );
 assert.equal(fixture.calls.length,0);
 assert.equal(fixture.wasClosed(),true);
});

test('updater propagates write errors and still closes the port',async()=>{
 const fixture=makeUpdater({writeFailure:true});
 await assert.rejects(
  fixture.updater.run({packagePath:'injected.uavfw',serialNumber:'SERIAL'}),
  /injected write failure/,
 );
 assert.equal(fixture.client.rebooted,false);
 assert.equal(fixture.wasClosed(),true);
});

test('cancel aborts the device session and stops before finalize',async()=>{
 let releasePort;
 const gate=new Promise(resolve=>{releasePort=resolve});
 const fixture=makeUpdater();
 const originalIdentifier=fixture.updater.portIdentifier;
 fixture.updater.portIdentifier=async serial=>{await gate;return originalIdentifier(serial)};
 const run=fixture.updater.run({packagePath:'injected.uavfw',serialNumber:'SERIAL'});
 await fixture.updater.cancel();
 releasePort();
 await assert.rejects(run,/升级已由用户取消/);
 assert.equal(fixture.client.aborted,true);
 assert.equal(fixture.calls.some(call=>call.command===COMMANDS.FINALIZE),false);
 assert.equal(fixture.wasClosed(),true);
});

test('cancel is rejected once metadata commit has started',async()=>{
 const fixture=makeUpdater();
 fixture.updater.committing=true;
 assert.equal(await fixture.updater.cancel(),false);
 assert.equal(fixture.updater.cancelled,false);
 assert.equal(fixture.client.aborted,false);
});
