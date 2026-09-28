const fs=require('node:fs');
const path=require('node:path');

const file=path.resolve(__dirname,'../electron/mavlink/generated.js');
let source=fs.readFileSync(file,'utf8');
const patches=[
 [
  'var orderedfields = [ this.time_usec, this.flags, this.controls, this.mode];',
  'var orderedfields = [ this.time_usec, this.flags].concat(this.controls, [this.mode]);'
 ],
 [
  'var orderedfields = [ this.time_usec, this.attitude_quaternion, this.rollspeed, this.pitchspeed, this.yawspeed, this.lat, this.lon, this.alt, this.vx, this.vy, this.vz, this.ind_airspeed, this.true_airspeed, this.xacc, this.yacc, this.zacc];',
  'var orderedfields = [this.time_usec].concat(this.attitude_quaternion, [this.rollspeed, this.pitchspeed, this.yawspeed, this.lat, this.lon, this.alt, this.vx, this.vy, this.vz, this.ind_airspeed, this.true_airspeed, this.xacc, this.yacc, this.zacc]);'
 ]
];
for(const[from,to]of patches){if(source.includes(to))continue;if(!source.includes(from))throw new Error(`找不到待修补的 MAVLink 生成代码：${from}`);source=source.replace(from,to)}
fs.writeFileSync(file,source,'utf8');
console.log('已修补 JavaScript_NextGen 数组字段打包代码。');
