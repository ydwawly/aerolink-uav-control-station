/** Native Electron implementation of the STM32H743 Bootloader v2 protocol. */
const fs=require('fs');
const crypto=require('crypto');
const zlib=require('zlib');
const {EventEmitter}=require('events');
const {SerialPort}=require('serialport');
const {PROTOCOL_VERSION,BOARD_ID,MAX_DATA_SIZE,COMMANDS,STATUSES,SLOTS}=require('./boot-protocol-generated.cjs');

const MAGIC=Buffer.from('BLDR'),RESPONSE_BIT=0x80,HEADER_SIZE=10,MAX_PAYLOAD=MAX_DATA_SIZE+4;
const SLOT_SIZE=768*1024,MANIFEST_MAX_SIZE=64*1024,PACKAGE_MAX_SIZE=4*1024*1024;
const PACKAGE_FILES=new Set(['manifest.json','slot_a.bin','slot_b.bin']);
const STATUS_NAMES=Object.fromEntries(Object.entries(STATUSES).map(([name,value])=>[value,name]));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function crc32(buffer){let crc=0xffffffff;for(const value of buffer){crc^=value;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}return(~crc)>>>0}
function buildFrame(command,sequence,payload=Buffer.alloc(0)){if(payload.length>MAX_PAYLOAD)throw new Error('Bootloader payload 过长');const frame=Buffer.alloc(HEADER_SIZE+payload.length+4);MAGIC.copy(frame);frame[4]=PROTOCOL_VERSION;frame[5]=command;frame.writeUInt16LE(sequence,6);frame.writeUInt16LE(payload.length,8);payload.copy(frame,10);frame.writeUInt32LE(crc32(frame.subarray(0,-4)),frame.length-4);return frame}

class FrameDecoder{
 constructor(){this.buffer=Buffer.alloc(0)}
 push(data){this.buffer=Buffer.concat([this.buffer,Buffer.from(data)]);const frames=[];for(;;){const start=this.buffer.indexOf(MAGIC);if(start<0){this.buffer=this.buffer.subarray(Math.max(0,this.buffer.length-3));break}if(start)this.buffer=this.buffer.subarray(start);if(this.buffer.length<HEADER_SIZE)break;const length=this.buffer.readUInt16LE(8),total=HEADER_SIZE+length+4;if(length>MAX_PAYLOAD){this.buffer=this.buffer.subarray(1);continue}if(this.buffer.length<total)break;const raw=this.buffer.subarray(0,total);this.buffer=this.buffer.subarray(total);if(raw[4]!==PROTOCOL_VERSION||raw.readUInt32LE(total-4)!==crc32(raw.subarray(0,total-4)))continue;frames.push({command:raw[5],sequence:raw.readUInt16LE(6),payload:raw.subarray(10,total-4)})}return frames}
}

function writePort(port,data){return new Promise((resolve,reject)=>port.write(data,error=>error?reject(error):port.drain(error2=>error2?reject(error2):resolve())))}
function openPort(path,timeout=1000){return new Promise((resolve,reject)=>{const port=new SerialPort({path,baudRate:115200,autoOpen:false,lock:true,highWaterMark:65536});const timer=setTimeout(()=>{port.close(()=>{});reject(new Error(`打开 ${path} 超时`))},timeout);port.open(error=>{clearTimeout(timer);error?reject(error):resolve(port)})})}
function closePort(port){return new Promise(resolve=>port?.isOpen?port.close(()=>resolve()):resolve())}

class BootClient{
 constructor(port,{timeout=1500,retries=3}={}){this.port=port;this.timeout=timeout;this.retries=retries;this.sequence=0;this.decoder=new FrameDecoder();this.frames=[];this.waiter=null;port.on('data',data=>{for(const frame of this.decoder.push(data))this.waiter?this.waiter(frame):this.frames.push(frame)})}
 async nextFrame(){if(this.frames.length)return this.frames.shift();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.waiter=null;reject(new Error('Bootloader 响应超时'))},this.timeout);this.waiter=frame=>{clearTimeout(timer);this.waiter=null;resolve(frame)}})}
 async request(command,payload=Buffer.alloc(0)){const sequence=this.sequence,frame=buildFrame(command,sequence,payload);let last;for(let attempt=0;attempt<=this.retries;attempt++){try{await writePort(this.port,frame);const response=await this.nextFrame();if(response.command!==(command|RESPONSE_BIT)||response.sequence!==sequence)throw new Error('Bootloader 响应命令或序号不匹配');if(!response.payload.length)throw new Error('Bootloader 响应缺少状态');const status=response.payload[0];if(status!==STATUSES.OK)throw new Error(`Bootloader 拒绝命令：${STATUS_NAMES[status]||status}`);this.sequence=(sequence+1)&0xffff;return response.payload.subarray(1)}catch(error){last=error}}throw new Error(`Bootloader 命令重试失败：${last?.message||last}`)}
 async info(){const b=await this.request(COMMANDS.GET_INFO);if(b.length!==56)throw new Error('GET_INFO 长度错误');const image=o=>({size:b.readUInt32LE(o),crc32:b.readUInt32LE(o+4),buildId:b.readBigUInt64LE(o+8).toString()});return{protocolVersion:b[0],boardId:b.readUInt32LE(1),maxChunk:b.readUInt16LE(5),metadataState:b[7],confirmedSlot:b[8],candidateSlot:b[9],sessionState:b[10],targetSlot:b[11],metadataSequence:b.readUInt32LE(12),receivedSize:b.readUInt32LE(16),slotA:image(20),slotB:image(36),platformFlags:b.readUInt32LE(52)}}
 async status(){const b=await this.request(COMMANDS.GET_STATUS);return{sessionState:b[0],targetSlot:b[1],metadataState:b[2],receivedSize:b.readUInt32LE(4),imageSize:b.readUInt32LE(8)}}
 abort(){return this.request(COMMANDS.ABORT)}
 reboot(){return this.request(COMMANDS.REBOOT)}
}

function extractZipEntries(file){
 const data=fs.readFileSync(file);
 if(data.length>PACKAGE_MAX_SIZE)throw new Error(`固件包超过 ${PACKAGE_MAX_SIZE/(1024*1024)} MiB 上限`);
 if(data.length<22)throw new Error('不是有效的 .uavfw ZIP');
 let eocd=-1;
 for(let i=data.length-22;i>=Math.max(0,data.length-65557);i--)if(data.readUInt32LE(i)===0x06054b50){eocd=i;break}
 if(eocd<0)throw new Error('不是有效的 .uavfw ZIP');
 const count=data.readUInt16LE(eocd+10),centralSize=data.readUInt32LE(eocd+12),central=data.readUInt32LE(eocd+16);
 if(count!==3||central+centralSize>eocd)throw new Error('ZIP central directory 范围非法');
 const entries=new Map();let offset=central;
 for(let index=0;index<count;index++){
  if(offset+46>eocd||data.readUInt32LE(offset)!==0x02014b50)throw new Error('ZIP central directory 损坏');
  const flags=data.readUInt16LE(offset+8),method=data.readUInt16LE(offset+10),expectedCrc=data.readUInt32LE(offset+16),compressedSize=data.readUInt32LE(offset+20),size=data.readUInt32LE(offset+24),nameLength=data.readUInt16LE(offset+28),extraLength=data.readUInt16LE(offset+30),commentLength=data.readUInt16LE(offset+32),localOffset=data.readUInt32LE(offset+42),recordEnd=offset+46+nameLength+extraLength+commentLength;
  if(recordEnd>eocd||(flags&1)!==0||(method!==0&&method!==8))throw new Error('ZIP 条目结构或压缩算法不受支持');
  const name=data.subarray(offset+46,offset+46+nameLength).toString('utf8');
  if(!PACKAGE_FILES.has(name)||entries.has(name))throw new Error(`ZIP 条目 ${name} 非法或重复`);
  const maxSize=name==='manifest.json'?MANIFEST_MAX_SIZE:SLOT_SIZE,minSize=name==='manifest.json'?1:32;
  if(size<minSize||size>maxSize||compressedSize>PACKAGE_MAX_SIZE)throw new Error(`ZIP 条目 ${name} 长度越界`);
  if(localOffset+30>central||data.readUInt32LE(localOffset)!==0x04034b50)throw new Error('ZIP local header 损坏');
  const localMethod=data.readUInt16LE(localOffset+8),localNameLength=data.readUInt16LE(localOffset+26),localExtra=data.readUInt16LE(localOffset+28),start=localOffset+30+localNameLength+localExtra,end=start+compressedSize;
  if(localMethod!==method||end>central)throw new Error(`ZIP 条目 ${name} 本地记录越界`);
  const localName=data.subarray(localOffset+30,localOffset+30+localNameLength).toString('utf8');
  if(localName!==name)throw new Error(`ZIP 条目 ${name} 名称不一致`);
  const compressed=data.subarray(start,end),content=method===0?Buffer.from(compressed):zlib.inflateRawSync(compressed,{maxOutputLength:size});
  if(content.length!==size||crc32(content)!==expectedCrc)throw new Error(`ZIP 条目 ${name} 长度或 CRC32 错误`);
  entries.set(name,content);offset=recordEnd;
 }
 if(offset!==central+centralSize||entries.size!==PACKAGE_FILES.size)throw new Error('ZIP central directory 长度不一致');
 return entries;
}
function parseInteger(value){return typeof value==='number'?value:Number.parseInt(String(value),0)}
function loadPackage(file){const entries=extractZipEntries(file),manifest=JSON.parse(entries.get('manifest.json').toString('utf8'));if(!manifest||manifest.schema!=='stm32h743.uavfw.v1'||parseInteger(manifest.board_id)!==BOARD_ID||manifest.protocol_version!==PROTOCOL_VERSION)throw new Error('固件包板卡、schema 或协议版本不匹配');const images={};for(const [name,address,filename] of [['A',0x08020000,'slot_a.bin'],['B',0x08100000,'slot_b.bin']]){const item=manifest.slots?.[name];if(item?.file!==filename)throw new Error(`Slot ${name} 文件名非法`);const data=entries.get(filename);if(!data||parseInteger(item.address)!==address||data.length!==item.size||data.length<32||data.length>SLOT_SIZE)throw new Error(`Slot ${name} 描述或大小非法`);const crc=crc32(data),sha=crypto.createHash('sha256').update(data).digest('hex');if(crc!==parseInteger(item.crc32)||sha.toLowerCase()!==String(item.sha256).toLowerCase())throw new Error(`Slot ${name} CRC32/SHA-256 校验失败`);images[name]={data,crc32:crc,buildId:BigInt(item.build_id)}}return{path:file,manifest,images}}

async function identifyBootPort(serialNumber,deadlineMs=12000){const deadline=Date.now()+deadlineMs;while(Date.now()<deadline){const ports=await SerialPort.list();for(const descriptor of ports){if(serialNumber&&descriptor.serialNumber!==serialNumber)continue;let port;try{port=await openPort(descriptor.path,700);const client=new BootClient(port,{timeout:500,retries:0}),info=await client.info();if(info.boardId===BOARD_ID&&info.protocolVersion===PROTOCOL_VERSION)return{descriptor,port,client,info}}catch{}await closePort(port)}await sleep(200)}throw new Error('未找到同一序列号且能完成 Bootloader v2 握手的端口')}

class FirmwareUpdater extends EventEmitter{
 constructor({packageLoader=loadPackage,portIdentifier=identifyBootPort,portCloser=closePort}={}){super();this.cancelled=false;this.committing=false;this.client=null;this.port=null;this.packageLoader=packageLoader;this.portIdentifier=portIdentifier;this.portCloser=portCloser}
 progress(phase,detail={}){const state={phase,...detail,time:Date.now()};this.emit('progress',state);return state}
 async cancel(){if(this.committing)return false;this.cancelled=true;this.progress('cancelled');return true}
 checkCancelled(){if(this.cancelled)throw new Error('升级已由用户取消')}
 async run({packagePath,serialNumber}){this.cancelled=false;this.committing=false;const pkg=this.packageLoader(packagePath);this.progress('waiting-bootloader',{percent:0});const found=await this.portIdentifier(serialNumber);this.port=found.port;this.client=found.client;this.client.timeout=Math.max(this.client.timeout||0,5000);this.client.retries=Math.max(this.client.retries||0,3);try{this.checkCancelled();if((found.info.platformFlags&0x0f)!==0x0f)throw new Error(`Option Bytes/平台检查失败，flags=0x${found.info.platformFlags.toString(16)}`);const slot=found.info.confirmedSlot===SLOTS.A?'B':'A',image=pkg.images[slot],begin=Buffer.alloc(24);begin[0]=SLOTS[slot];begin.writeUInt32LE(image.data.length,4);begin.writeUInt32LE(image.crc32,8);begin.writeBigUInt64LE(image.buildId,12);begin.writeUInt32LE(BOARD_ID,20);this.progress('erasing',{slot,percent:0,total:image.data.length});await this.client.request(COMMANDS.BEGIN_UPDATE,begin);this.checkCancelled();let offset=0;while(offset<image.data.length){this.checkCancelled();const chunk=image.data.subarray(offset,offset+Math.min(found.info.maxChunk,MAX_DATA_SIZE)),payload=Buffer.alloc(4+chunk.length);payload.writeUInt32LE(offset);chunk.copy(payload,4);const ack=await this.client.request(COMMANDS.WRITE_CHUNK,payload);this.checkCancelled();offset+=chunk.length;if(ack.length!==4||ack.readUInt32LE()!==offset)throw new Error('设备写入进度不一致');this.progress('uploading',{slot,completed:offset,total:image.data.length,percent:Math.floor(offset*100/image.data.length)})}this.checkCancelled();this.committing=true;this.progress('verifying',{slot,percent:100});await this.client.request(COMMANDS.FINALIZE);await this.client.reboot();this.progress('rebooting',{slot,version:pkg.manifest.firmware_version,percent:100});return{slot,version:pkg.manifest.firmware_version,gitSha:pkg.manifest.git_sha}}catch(error){if(this.cancelled){try{await this.client.abort()}catch{}}throw error}finally{this.committing=false;await this.portCloser(this.port);this.port=null;this.client=null}}
}
module.exports={BootClient,FirmwareUpdater,FrameDecoder,buildFrame,crc32,loadPackage,identifyBootPort,closePort,sleep};
