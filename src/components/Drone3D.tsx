import { useEffect, useRef, useState } from 'react';
import { Expand, Focus, Rotate3D } from 'lucide-react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

type Props={roll:number;pitch:number;yaw:number;active:boolean;motors:number[];velocity?:number[];wind?:number[];compact?:boolean};
type LiveState={roll:number;pitch:number;yaw:number;active:boolean;motors:number[];velocity:number[];wind:number[]};

const deg=(value:number)=>THREE.MathUtils.degToRad(value);

export function Drone3D({roll,pitch,yaw,active,motors,velocity=[0,0,0],wind=[0,0,0],compact=false}:Props){
 const hostRef=useRef<HTMLDivElement>(null),cameraRef=useRef<THREE.PerspectiveCamera|null>(null),controlsRef=useRef<OrbitControls|null>(null);
 const liveRef=useRef<LiveState>({roll,pitch,yaw,active,motors,velocity,wind}),[autoOrbit,setAutoOrbit]=useState(false),[webglError,setWebglError]=useState('');
 useEffect(()=>{liveRef.current={roll,pitch,yaw,active,motors,velocity,wind}},[roll,pitch,yaw,active,motors,velocity,wind]);
 useEffect(()=>{if(controlsRef.current)controlsRef.current.autoRotate=autoOrbit},[autoOrbit]);
 useEffect(()=>{
  const host=hostRef.current;if(!host)return;
  let renderer:THREE.WebGLRenderer;
  try{renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'high-performance'})}catch(error){setWebglError(error instanceof Error?error.message:'WebGL 初始化失败');return}
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.domElement.className='drone-webgl';host.prepend(renderer.domElement);
  const scene=new THREE.Scene();scene.fog=new THREE.FogExp2(0x061521,.035);
  const camera=new THREE.PerspectiveCamera(38,1,.1,100);camera.position.set(5.8,3.5,7.2);cameraRef.current=camera;
  const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.dampingFactor=.07;controls.target.set(0,.15,0);controls.minDistance=4;controls.maxDistance=14;controls.maxPolarAngle=Math.PI*.48;controls.autoRotateSpeed=.8;controlsRef.current=controls;
  scene.add(new THREE.HemisphereLight(0x8fd4ff,0x081018,2.2));const key=new THREE.DirectionalLight(0xd9f2ff,4.2);key.position.set(4,8,5);key.castShadow=true;key.shadow.mapSize.set(1024,1024);scene.add(key);const rim=new THREE.PointLight(0x168cff,22,16);rim.position.set(-4,2,-3);scene.add(rim);

  const floor=new THREE.Mesh(new THREE.PlaneGeometry(70,70),new THREE.MeshStandardMaterial({color:0x06131d,roughness:.92,metalness:.05}));floor.rotation.x=-Math.PI/2;floor.position.y=-1.48;floor.receiveShadow=true;scene.add(floor);
  const grid=new THREE.GridHelper(48,48,0x1e86af,0x12344a);grid.position.y=-1.46;(grid.material as THREE.Material).transparent=true;(grid.material as THREE.Material).opacity=.46;scene.add(grid);
  const city=new THREE.Group();const cityMaterial=new THREE.MeshStandardMaterial({color:0x0a2537,emissive:0x09243a,emissiveIntensity:.45,roughness:.8});for(let index=0;index<30;index++){const angle=index/30*Math.PI*2,radius=9+(index%4)*1.15,height=1.2+(index*17%9)*.42,building=new THREE.Mesh(new THREE.BoxGeometry(.65+(index%3)*.25,height,.65+(index%4)*.18),cityMaterial);building.position.set(Math.cos(angle)*radius,height/2-1.48,Math.sin(angle)*radius);city.add(building)}scene.add(city);

  const drone=new THREE.Group();drone.position.y=.25;scene.add(drone);const carbon=new THREE.MeshPhysicalMaterial({color:0x1b2831,metalness:.6,roughness:.28,clearcoat:.65,clearcoatRoughness:.22}),shell=new THREE.MeshPhysicalMaterial({color:0x405564,metalness:.72,roughness:.22,clearcoat:1}),armMaterial=new THREE.MeshStandardMaterial({color:0x263944,metalness:.7,roughness:.34}),dark=new THREE.MeshStandardMaterial({color:0x071017,metalness:.5,roughness:.3}),glass=new THREE.MeshPhysicalMaterial({color:0x07121b,metalness:.45,roughness:.08,transmission:.22}),propMaterial=new THREE.MeshPhysicalMaterial({color:0x738994,transparent:true,opacity:.7,metalness:.25,roughness:.32});
  const body=new THREE.Mesh(new RoundedBoxGeometry(1.18,.48,1.55,5,.16),carbon);body.castShadow=true;drone.add(body);const canopy=new THREE.Mesh(new THREE.SphereGeometry(.64,32,16,0,Math.PI*2,0,Math.PI*.52),shell);canopy.scale.set(.82,.42,1.05);canopy.position.set(0,.22,-.06);canopy.castShadow=true;drone.add(canopy);const battery=new THREE.Mesh(new RoundedBoxGeometry(.72,.12,.76,3,.07),dark);battery.position.set(0,.42,.12);drone.add(battery);
  const positions:[number,number,number][]=[[-1.55,.08,-1.24],[1.55,.08,-1.24],[1.55,.08,1.24],[-1.55,.08,1.24]],propellers:THREE.Group[]=[];
  const yAxis=new THREE.Vector3(0,1,0);positions.forEach((position,index)=>{const end=new THREE.Vector3(...position),start=new THREE.Vector3(index<2?0:0,0,index<2?-.3:.3),direction=end.clone().sub(start),arm=new THREE.Mesh(new THREE.CylinderGeometry(.085,.105,direction.length(),12),armMaterial);arm.position.copy(start.clone().add(end).multiplyScalar(.5));arm.quaternion.setFromUnitVectors(yAxis,direction.clone().normalize());arm.castShadow=true;drone.add(arm);const motor=new THREE.Mesh(new THREE.CylinderGeometry(.22,.19,.32,24),dark);motor.position.copy(end);motor.position.y=.14;motor.castShadow=true;drone.add(motor);const ring=new THREE.Mesh(new THREE.TorusGeometry(.19,.035,8,24),new THREE.MeshStandardMaterial({color:index===0||index===3?0x22e487:0xff4e59,emissive:index===0||index===3?0x0a9a58:0xa51125,emissiveIntensity:2}));ring.rotation.x=Math.PI/2;ring.position.copy(end);ring.position.y=.2;drone.add(ring);const prop=new THREE.Group();prop.position.copy(end);prop.position.y=.36;const blade=new THREE.Mesh(new RoundedBoxGeometry(1.75,.035,.13,2,.04),propMaterial);blade.castShadow=true;prop.add(blade);const hub=new THREE.Mesh(new THREE.CylinderGeometry(.11,.14,.09,20),shell);hub.position.y=.04;prop.add(hub);drone.add(prop);propellers[index]=prop});
  const nose=new THREE.Mesh(new RoundedBoxGeometry(.72,.33,.42,4,.11),shell);nose.position.set(0,-.05,-.84);nose.castShadow=true;drone.add(nose);const gimbal=new THREE.Group();gimbal.position.set(0,-.35,-.74);const cameraBody=new THREE.Mesh(new RoundedBoxGeometry(.42,.32,.34,4,.07),dark),lens=new THREE.Mesh(new THREE.CylinderGeometry(.115,.115,.08,24),glass);lens.rotation.x=Math.PI/2;lens.position.z=-.2;cameraBody.add(lens);gimbal.add(cameraBody);drone.add(gimbal);
  const railGeometry=new THREE.CylinderGeometry(.045,.045,1.65,10);[-.45,.45].forEach(x=>{const rail=new THREE.Mesh(railGeometry,dark);rail.rotation.z=Math.PI/2;rail.position.set(x,-.69,.08);rail.scale.y=.65;drone.add(rail);[-.48,.48].forEach(z=>{const leg=new THREE.Mesh(new THREE.CylinderGeometry(.04,.05,.65,10),dark);leg.rotation.z=x<0?-.35:.35;leg.position.set(x,-.43,z);drone.add(leg)})});
  const statusLed=new THREE.Mesh(new THREE.SphereGeometry(.055,16,8),new THREE.MeshStandardMaterial({color:0x28ef8c,emissive:0x16de79,emissiveIntensity:4}));statusLed.position.set(0,.18,.82);drone.add(statusLed);
  const velocityArrow=new THREE.ArrowHelper(new THREE.Vector3(1,0,0),new THREE.Vector3(0,.7,0),1,0x29a9ff,.25,.12),windArrow=new THREE.ArrowHelper(new THREE.Vector3(1,0,0),new THREE.Vector3(0,1.05,0),1,0x35e38b,.25,.12);scene.add(velocityArrow,windArrow);

  const clock=new THREE.Clock();let frame=0,visible=!document.hidden;const render=()=>{frame=requestAnimationFrame(render);if(!visible)return;const dt=Math.min(clock.getDelta(),.05),state=liveRef.current;drone.rotation.set(deg(state.pitch),deg(state.yaw),deg(-state.roll),'YXZ');propellers.forEach((prop,index)=>{const power=Math.max(0,Math.min(1,state.motors[index]||0));if(state.active||power>.02)prop.rotation.y+=(18+power*95)*dt*(index%2?-1:1)});const setArrow=(arrow:THREE.ArrowHelper,vector:number[])=>{const direction=new THREE.Vector3(vector[1]||0,-(vector[2]||0),-(vector[0]||0)),length=direction.length();arrow.visible=length>.05;if(length>.05){arrow.setDirection(direction.normalize());arrow.setLength(Math.min(3,.45+length*.25),.24,.12)}};setArrow(velocityArrow,state.velocity);setArrow(windArrow,state.wind);statusLed.visible=Math.sin(performance.now()*.006)>-.7;controls.update();renderer.render(scene,camera)};
  const resize=()=>{const width=Math.max(1,host.clientWidth),height=Math.max(1,host.clientHeight);renderer.setPixelRatio(Math.min(window.devicePixelRatio,width>900?1.5:1.8));renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix()},onVisibility=()=>{visible=!document.hidden;if(visible)clock.getDelta()};const observer=new ResizeObserver(resize),intersection=new IntersectionObserver(entries=>{visible=!document.hidden&&!!entries[0]?.isIntersecting});observer.observe(host);intersection.observe(host);document.addEventListener('visibilitychange',onVisibility);resize();render();
  return()=>{cancelAnimationFrame(frame);observer.disconnect();intersection.disconnect();document.removeEventListener('visibilitychange',onVisibility);controls.dispose();renderer.dispose();renderer.domElement.remove();scene.traverse(object=>{const mesh=object as THREE.Mesh;mesh.geometry?.dispose();if(mesh.material){const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];materials.forEach(material=>material.dispose())}});cameraRef.current=null;controlsRef.current=null};
 },[]);
 const resetView=()=>{cameraRef.current?.position.set(5.8,3.5,7.2);controlsRef.current?.target.set(0,.15,0);controlsRef.current?.update()};
 const fullscreen=()=>void hostRef.current?.requestFullscreen?.();
 return <div ref={hostRef} className={'drone-3d-host '+(compact?'compact':'')}>
  {webglError&&<div className="webgl-error">WebGL 3D 初始化失败：{webglError}</div>}
  <div className="view-help">左键旋转 · 滚轮缩放 · 右键平移</div>
  <div className="view-tools"><button className={autoOrbit?'active':''} onClick={()=>setAutoOrbit(value=>!value)} title="自动环绕"><Rotate3D/></button><button onClick={resetView} title="复位视角"><Focus/></button><button onClick={fullscreen} title="全屏视景"><Expand/></button></div>
 </div>
}
