import {useEffect,useRef} from 'react';
import {type GeoJSONSource,LngLatBounds,Map,NavigationControl,setWorkerUrl,type StyleSpecification} from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

// MapLibre GL JS v6 使用 ES Module Worker。由 Vite 将 Worker 及其依赖打包为独立资源，
// 避免 Electron 在 file:// 页面中加载未打包的相对模块失败。
setWorkerUrl(maplibreWorkerUrl);

type Point={lat:number;lon:number};
const style:StyleSpecification={version:8,sources:{osm:{type:'raster',tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],tileSize:256,attribution:'© OpenStreetMap contributors'}},layers:[{id:'osm',type:'raster',source:'osm',paint:{'raster-saturation':-1,'raster-brightness-max':.42,'raster-contrast':.25,'raster-opacity':.86}}]};
const featureCollection=(points:Point[])=>({type:'FeatureCollection' as const,features:points.length?[{type:'Feature' as const,properties:{},geometry:{type:'LineString' as const,coordinates:points.map(point=>[point.lon,point.lat])}},{type:'Feature' as const,properties:{kind:'home'},geometry:{type:'Point' as const,coordinates:[points[0].lon,points[0].lat]}},{type:'Feature' as const,properties:{kind:'vehicle'},geometry:{type:'Point' as const,coordinates:[points.at(-1)!.lon,points.at(-1)!.lat]}}]:[]});

export default function RealMap({points,hasFix,large=false}:{points:Point[];hasFix:boolean;large?:boolean}){
 const host=useRef<HTMLDivElement>(null),mapRef=useRef<Map|null>(null),fitted=useRef(false),pointsRef=useRef<Point[]>([]);
 const valid=points.filter(point=>Number.isFinite(point.lat)&&Number.isFinite(point.lon));
 pointsRef.current=valid;
 useEffect(()=>{if(!host.current)return;fitted.current=false;const map=new Map({container:host.current,style,center:[121.473456,31.230123],zoom:13,pitch:large?34:20,bearing:-12,attributionControl:false,maxZoom:19});map.addControl(new NavigationControl({showCompass:true,visualizePitch:true}),'top-right');map.on('load',()=>{map.addSource('vehicle-data',{type:'geojson',data:featureCollection(pointsRef.current)});map.addLayer({id:'trail-glow',type:'line',source:'vehicle-data',filter:['==',['geometry-type'],'LineString'],paint:{'line-color':'#0b8fff','line-width':7,'line-opacity':.22}});map.addLayer({id:'trail',type:'line',source:'vehicle-data',filter:['==',['geometry-type'],'LineString'],paint:{'line-color':'#2da9ff','line-width':3}});map.addLayer({id:'points',type:'circle',source:'vehicle-data',filter:['==',['geometry-type'],'Point'],paint:{'circle-radius':['match',['get','kind'],'vehicle',7,5],'circle-color':['match',['get','kind'],'vehicle','#ffcc42','#27df8a'],'circle-stroke-width':2,'circle-stroke-color':'#07131d'}})});mapRef.current=map;return()=>{mapRef.current=null;map.remove()}},[large]);
 useEffect(()=>{const map=mapRef.current;if(!map||!map.loaded())return;(map.getSource('vehicle-data') as GeoJSONSource|undefined)?.setData(featureCollection(valid));if(valid.length&&!fitted.current){const bounds=new LngLatBounds();valid.forEach(point=>bounds.extend([point.lon,point.lat]));if(valid.length===1)map.easeTo({center:[valid[0].lon,valid[0].lat],zoom:16,duration:400});else map.fitBounds(bounds,{padding:45,maxZoom:17,duration:500});fitted.current=true}else if(valid.length){const last=valid.at(-1)!;map.easeTo({center:[last.lon,last.lat],duration:250})}},[valid.length,valid.at(-1)?.lat,valid.at(-1)?.lon]);
 return <div className={'map-visual real-map '+(large?'large':'')}><div ref={host} className="maplibre-host"/>{!hasFix&&<div className="map-no-fix">无定位 · 等待 GPS_RAW_INT / GLOBAL_POSITION_INT</div>}</div>
}
