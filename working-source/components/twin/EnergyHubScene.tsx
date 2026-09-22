"use client";
import {useEffect,useRef} from 'react';
import * as THREE from 'three';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import type {FlexFrame} from '@/lib/twin/flex-engine';

type Props={frame:FlexFrame;showFlows:boolean;onSelect:(id:string)=>void;reset:number};

export default function EnergyHubScene({frame,showFlows,onSelect,reset}:Props){
 const host=useRef<HTMLDivElement>(null);const latest=useRef({frame,showFlows,onSelect,reset});latest.current={frame,showFlows,onSelect,reset};
 useEffect(()=>{const el=host.current;if(!el)return;const scene=new THREE.Scene();scene.fog=new THREE.Fog('#101820',55,115);const camera=new THREE.PerspectiveCamera(42,1,.1,250);camera.position.set(54,48,62);
 const renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.6));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;el.appendChild(renderer.domElement);
 const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.target.set(0,0,0);controls.maxPolarAngle=Math.PI*.48;controls.minDistance=28;controls.maxDistance=110;
 const ambient=new THREE.HemisphereLight('#b9d7e1','#1b252b',1.4);scene.add(ambient);const sun=new THREE.DirectionalLight('#fff2cf',2.5);sun.position.set(-28,55,25);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);scene.add(sun);
 const material=(color:string,emissive?:string)=>new THREE.MeshStandardMaterial({color,roughness:.72,metalness:.12,emissive:emissive??'#000000',emissiveIntensity:emissive?.8:0});const pickables:THREE.Object3D[]=[];
 const box=(w:number,h:number,d:number,x:number,y:number,z:number,color:string,parent:THREE.Object3D=scene,id?:string)=>{const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material(color));m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;if(id){m.userData.id=id;pickables.push(m);}parent.add(m);return m;};
 const ground=box(78,.5,58,0,-.35,0,'#24343a');ground.receiveShadow=true;
 // Main office building with PV roof.
 box(31,7,12,-6,3.5,-12,'#294a58',scene,'building');box(32,.35,13,-6,7.2,-12,'#728c91');for(let i=0;i<10;i++)for(let r=0;r<3;r++)box(2.3,.12,2.5,-18+i*2.7,7.55,-16+r*3.8,'#173d59',scene,'solar');
 // Cold store gives the energy hub a second thermal asset.
 box(18,6,13,20,3,-10,'#647b84',scene,'cold');for(let i=0;i<4;i++)box(3.2,3.8,.15,14.5+i*3.3,2.5,-3.43,'#aebec1');
 // BESS containers.
 for(let i=0;i<3;i++){box(2.2,3.7,6,-27+i*2.5,1.85,-9,'#c7d2cc',scene,'battery');box(1.1,.45,.08,-27+i*2.5,2.7,-5.95,'#376b66');}
 // Grid point of common coupling.
 box(4.5,5,4,-29,2.5,8,'#6e858e',scene,'grid');box(2.3,.9,.08,-29,3.2,10.05,'#1d3543');
 // Chargers and representative vehicles.
 for(let i=0;i<12;i++){const x=-20+(i%6)*7,z=i<6?9:19;box(5.5,.04,6,x,.02,z,'#2c444c');box(.65,1.8,.5,x+2.1,.9,z-2.3,'#b6c8c4',scene,'ev');if(i<8){box(1.9,.7,3.8,x,.55,z,'#557b8e',scene,'ev');box(1.55,.55,1.9,x,1.12,z-.15,'#3c6876',scene,'ev');}}
 // HVAC rooftop units.
 for(let i=0;i<4;i++)box(3.2,1.2,2.2,-16+i*6,8.15,-10,'#8da1a5',scene,'hvac');
 // Flexible workshop annex.
 box(13,4.4,8,20,2.2,12,'#4a626d',scene,'workshop');
 // Threshold beacons turn the 3D scene into a situational-awareness view rather than decoration.
 const beacons:Record<string,THREE.Mesh>={};
 const beacon=(id:string,x:number,y:number,z:number)=>{const mesh=new THREE.Mesh(new THREE.SphereGeometry(.34,14,14),new THREE.MeshStandardMaterial({color:'#70e3bb',emissive:'#70e3bb',emissiveIntensity:1.2}));mesh.position.set(x,y,z);scene.add(mesh);beacons[id]=mesh;};
 beacon('battery',-24,6.3,-9);beacon('cold',20,8.1,-10);beacon('ev',-2,4.3,14);beacon('hvac',-6,10.2,-10);beacon('workshop',20,5.5,12);
 // Energy flow paths.
 const flowGroup=new THREE.Group();scene.add(flowGroup);const paths=[{id:'grid',color:'#91a7fc',pts:[[-29,.3,8],[-23,.3,2],[0,.3,2]]},{id:'solar',color:'#f6c66b',pts:[[-6,8,-12],[-6,9,0],[0,.3,2]]},{id:'battery',color:'#66c1e8',pts:[[-24,.3,-6],[-16,.3,2],[0,.3,2]]},{id:'ev',color:'#70e3bb',pts:[[0,.3,2],[0,.3,12],[-2,.3,14]]},{id:'cold',color:'#b99cf4',pts:[[0,.3,2],[12,.3,-1],[20,.3,-4]]}];const particles:{mesh:THREE.Mesh;curve:THREE.CatmullRomCurve3;offset:number;id:string}[]=[];
 for(const p of paths){const curve=new THREE.CatmullRomCurve3(p.pts.map(v=>new THREE.Vector3(...v as [number,number,number])));const geo=new THREE.TubeGeometry(curve,24,.035,5,false);flowGroup.add(new THREE.Mesh(geo,new THREE.MeshBasicMaterial({color:p.color,transparent:true,opacity:.45})));for(let i=0;i<5;i++){const dot=new THREE.Mesh(new THREE.SphereGeometry(.13,8,8),new THREE.MeshBasicMaterial({color:p.color}));flowGroup.add(dot);particles.push({mesh:dot,curve,offset:i/5,id:p.id});}}
 const labels:{id:string;el:HTMLDivElement;pos:THREE.Vector3}[]=[];const label=(id:string,text:string,pos:[number,number,number])=>{const d=document.createElement('div');d.className='scene-label';d.textContent=text;el.appendChild(d);labels.push({id,el:d,pos:new THREE.Vector3(...pos)});};label('grid','Grid PCC',[-29,7,8]);label('battery','BESS-01',[-24,6,-9]);label('building','Office / BEMS',[-6,10,-12]);label('cold','Cold store',[20,8,-10]);label('ev','EV charging',[-2,4,14]);
 let down={x:0,y:0};const onDown=(e:PointerEvent)=>down={x:e.clientX,y:e.clientY};const onUp=(e:PointerEvent)=>{if(Math.abs(e.clientX-down.x)+Math.abs(e.clientY-down.y)>6)return;const rect=renderer.domElement.getBoundingClientRect();const ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1),camera);const hit=ray.intersectObjects(pickables)[0];if(hit)latest.current.onSelect(hit.object.userData.id);};renderer.domElement.addEventListener('pointerdown',onDown);renderer.domElement.addEventListener('pointerup',onUp);
 let lastReset=-1;const resize=()=>{const w=el.clientWidth,h=el.clientHeight;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();};const ro=new ResizeObserver(resize);ro.observe(el);resize();let raf=0;
 const animate=()=>{const p=latest.current,f=p.frame;if(p.reset!==lastReset){camera.position.set(54,48,62);controls.target.set(0,0,0);lastReset=p.reset;}controls.update();flowGroup.visible=p.showFlows;const powers:Record<string,number>={grid:f.controlledGrid,solar:f.solar,battery:f.batteryPower,ev:f.ev,cold:f.coldPower};for(const dot of particles){const power=powers[dot.id]??0;dot.mesh.visible=Math.abs(power)>.2;const phase=((f.time*.18*(power<0?-1:1))+dot.offset+1000)%1;dot.mesh.position.copy(dot.curve.getPointAt(phase));}
 const stateColor=(state:string)=>state==='critical'||state==='stale'?'#fa948d':state==='warning'||state==='limited'?'#f6c66b':'#70e3bb';for(const a of f.assets){const b=beacons[a.id];if(!b)continue;const c=stateColor(a.state);(b.material as THREE.MeshStandardMaterial).color.set(c);(b.material as THREE.MeshStandardMaterial).emissive.set(c);}
 for(const l of labels){const projected=l.pos.clone().project(camera);l.el.style.left=`${(projected.x*.5+.5)*el.clientWidth}px`;l.el.style.top=`${(-projected.y*.5+.5)*el.clientHeight}px`;l.el.style.display=projected.z>1?'none':'block';l.el.textContent=l.id==='grid'?`Grid · ${f.controlledGrid.toFixed(0)} kW`:l.id==='battery'?`BESS · ${f.batterySoc.toFixed(0)}% · ${f.batteryTemp.toFixed(1)} °C`:l.id==='cold'?`Cold store · ${f.coldTemp.toFixed(1)} °C`:l.id==='ev'?`EV · ${f.ev.toFixed(0)} kW`:`Office · ${f.building.toFixed(0)} kW`;}
 renderer.render(scene,camera);raf=requestAnimationFrame(animate);};animate();
 return()=>{cancelAnimationFrame(raf);ro.disconnect();controls.dispose();renderer.domElement.removeEventListener('pointerdown',onDown);renderer.domElement.removeEventListener('pointerup',onUp);scene.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry.dispose();const mats=Array.isArray(o.material)?o.material:[o.material];mats.forEach(m=>m.dispose());}});renderer.dispose();renderer.domElement.remove();labels.forEach(l=>l.el.remove());};
 },[]);
 return <div ref={host} className="scene" role="img" aria-label="Interactive 3D energy hub with office, cold store, battery storage, solar roof, EV charging and grid connection."/>;
}
