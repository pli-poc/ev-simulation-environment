import {clock,defaults,simulate,vehiclesFor,type CarState,type Config,type Frame,type Result,type Vehicle} from './engine';

export type OptimizerStrategy='immediate'|'energy'|'peak'|'total'|'carbon'|'flex';
export type Market='nl'|'flanders'|'wallonia'|'brussels';
export type OptimizerConfig={strategy:OptimizerStrategy;market:Market;grid:number;solar:number;chargers:number;seed:number;peakThreshold:number;carbonWeight:number;flexWeight:number};
export const optimizerDefaults:OptimizerConfig={strategy:'total',market:'nl',grid:120,solar:90,chargers:20,seed:42,peakThreshold:95,carbonWeight:.25,flexWeight:.35};
export const strategies:{id:OptimizerStrategy;name:string;description:string}[]=[
 {id:'immediate',name:'Immediate',description:'Charge at maximum power as soon as a vehicle is connected.'},
 {id:'energy',name:'Cheapest energy',description:'Shift flexible charging toward low wholesale-price quarters.'},
 {id:'peak',name:'Peak aware',description:'Protect a site peak threshold before pursuing energy price.'},
 {id:'total',name:'Total-cost optimizer',description:'Balance energy, grid/peak cost, deadlines and site headroom.'},
 {id:'carbon',name:'Carbon aware',description:'Prefer lower-carbon periods while still meeting departures.'},
 {id:'flex',name:'Flexibility first',description:'Preserve headroom in grid-stress windows and recover later.'}
];
export const markets:{id:Market;name:string;note:string}[]=[
 {id:'nl',name:'Netherlands',note:'Dynamic energy signal; illustrative retail adders.'},
 {id:'flanders',name:'Flanders',note:'Dynamic energy plus monthly-peak sensitivity.'},
 {id:'wallonia',name:'Wallonia',note:'Dynamic energy plus 11–17 / 22–07 off-peak windows.'},
 {id:'brussels',name:'Brussels',note:'Dynamic energy plus day/night network signal.'}
];
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
const q=(t:number)=>Math.floor(t/15);
const wholesale=(qi:number)=>{const h=qi/4;return .075+.055*Math.sin((h-7)/24*Math.PI*2)+.045*Math.exp(-Math.pow((h-19)/2.3,2))-.035*Math.exp(-Math.pow((h-13)/2.5,2));};
const carbon=(qi:number)=>{const h=qi/4;return 310-105*Math.max(0,Math.sin((h-6)/13*Math.PI))+55*Math.exp(-Math.pow((h-19)/2.5,2));};
function gridAdder(m:Market,qi:number){const h=qi/4;if(m==='wallonia')return (h>=11&&h<17)||(h>=22||h<7)?.025:.085;if(m==='brussels')return h>=7&&h<22?.065:.028;return .035;}
function retail(m:Market,qi:number){return Math.max(.01,wholesale(qi)+.095+gridAdder(m,qi));}
function stress(qi:number){const h=qi/4;return Math.exp(-Math.pow((h-18)/1.8,2));}
function score(c:OptimizerConfig,qi:number,projected:number){const e=retail(c.market,qi),co2=carbon(qi)/1000,pk=Math.max(0,projected-c.peakThreshold);if(c.strategy==='immediate')return qi/10000;if(c.strategy==='energy')return e;if(c.strategy==='peak')return pk*2+e*.2;if(c.strategy==='carbon')return co2*c.carbonWeight+e*.35;if(c.strategy==='flex')return stress(qi)*c.flexWeight*2+pk+e*.25;const marketPeak=c.market==='flanders'?pk*2.6:pk*.8;return e+marketPeak+stress(qi)*.12;}
export type Quarter={quarter:number;time:string;price:number;carbon:number;gridAdder:number;stress:number;plannedEv:number;projectedGrid:number};
export type OptimizerResult=Result&{quarters:Quarter[];strategy:OptimizerStrategy;market:Market;explanations:Record<number,string>;scorecard:{energyCost:number;peakCost:number;totalCost:number;peak:number;readyPct:number;carbonKg:number;flexHeadroom:number}};
export function simulateOptimizer(c:OptimizerConfig):OptimizerResult{
 const baseConfig:Config={...defaults,preset:'office',policy:'balanced',grid:c.grid,solar:c.solar,chargers:c.chargers,seed:c.seed,battery:false,flexible:false};
 const baseline=simulate(baseConfig);const vehicles=vehiclesFor(baseConfig);const quarters:Quarter[]=Array.from({length:96},(_,qi)=>{const f=baseline.frames[qi*15];return{quarter:qi,time:clock(qi*15),price:retail(c.market,qi),carbon:carbon(qi),gridAdder:gridAdder(c.market,qi),stress:stress(qi),plannedEv:0,projectedGrid:f.building-f.solar};});
 const allocations=vehicles.map(()=>new Array(96).fill(0));const deliveredPlan=vehicles.map(()=>0);
 // Earliest-deadline vehicles are planned first; each vehicle ranks only quarters in which it is actually present.
 for(const v of [...vehicles].sort((a,b)=>a.departure-b.departure)){
  let need=v.need/.9;const start=Math.ceil(v.arrival/15),end=Math.floor((v.departure-1)/15);const candidates=[] as {qi:number;s:number}[];
  for(let qi=start;qi<=end;qi++){const projected=quarters[qi].projectedGrid+quarters[qi].plannedEv;candidates.push({qi,s:score(c,qi,projected)});}
  candidates.sort((a,b)=>a.s-b.s||a.qi-b.qi);
  for(const x of candidates){if(need<=.0001)break;const head=Math.max(0,c.grid-quarters[x.qi].projectedGrid-quarters[x.qi].plannedEv);const peakHead=c.strategy==='immediate'||c.strategy==='energy'?head:Math.max(0,Math.max(6,c.peakThreshold)-quarters[x.qi].projectedGrid-quarters[x.qi].plannedEv);let kw=Math.min(v.maxKw,head);if(kw<1.4&&need>.4)continue;const kwh=Math.min(need,kw*.25);kw=kwh/.25;allocations[v.id][x.qi]=kw;quarters[x.qi].plannedEv+=kw;need-=kwh;}
  // Feasibility recovery: if the preferred plan cannot meet the request, fill remaining physical headroom by deadline.
  if(need>.0001)for(let qi=start;qi<=end&&need>.0001;qi++){const head=Math.max(0,c.grid-quarters[qi].projectedGrid-quarters[qi].plannedEv),kw=Math.min(v.maxKw,head),kwh=Math.min(need,kw*.25);allocations[v.id][qi]+=kwh/.25;quarters[qi].plannedEv+=kwh/.25;need-=kwh;}
  deliveredPlan[v.id]=v.need-Math.max(0,need*.9);
 }
 quarters.forEach(x=>x.projectedGrid+=x.plannedEv);
 const cars:CarState[]=vehicles.map(v=>({id:v.id,bay:v.id<c.chargers?v.id:-1,parkedAt:v.arrival,delivered:0,power:0,status:'Expected',reason:'Not on site yet'}));const frames:Frame[]=[];let cost=0,imp=0,exp=0,del=0,peak=0,ready=0,departed=0,shortfall=0,carbonKg=0;
 for(let t=0;t<1440;t++){const bf=baseline.frames[t],qi=q(t);for(const v of vehicles){const s=cars[v.id];s.power=0;if(t<v.arrival){s.status='Expected';s.reason='Not on site yet';continue;}if(t>=v.departure){if(t===v.departure){departed++;const gap=Math.max(0,v.need-s.delivered);shortfall+=gap;if(gap<.05)ready++;}s.status='Departed';s.reason='Vehicle has left the site';continue;}if(v.id>=c.chargers){s.status='Queued';s.reason='Waiting for a charging bay';continue;}const remaining=Math.max(0,v.need-s.delivered);let power=Math.min(allocations[v.id][qi],remaining*60/.9);s.power=power;const add=power*.9/60;s.delivered+=add;del+=add;if(remaining<.01||s.delivered>=v.need-.01){s.status='Ready';s.reason='Departure energy target met';s.power=0;}else if(power>0){s.status='Charging';s.reason=c.strategy==='total'?'Selected by total-cost plan for this 15-minute interval':c.strategy==='peak'?'Charging within protected peak envelope':c.strategy==='energy'?'Low-cost interval selected':c.strategy==='carbon'?'Lower-carbon interval selected':c.strategy==='flex'?'Charging outside protected flexibility window':'Immediate charging';}else{s.status='Paused';const urgent=(v.departure-t)<90;s.reason=urgent?'Reserved energy is scheduled before departure':'Deferred: a better feasible interval is available';}}
  const ev=cars.reduce((a,s)=>a+s.power,0),grid=bf.building+ev-bf.solar;imp+=Math.max(0,grid)/60;exp+=Math.max(0,-grid)/60;cost+=Math.max(0,grid)*retail(c.market,qi)/60;carbonKg+=Math.max(0,grid)*carbon(qi)/1000/60;peak=Math.max(peak,grid);
  frames.push({...bf,ev,grid,limit:c.grid,cost,importKwh:imp,exportKwh:exp,delivered:del,peak,ready,departed,shortfall,cars:cars.map(s=>({...s})),price:retail(c.market,qi),violations:grid>c.grid?1:0,excess:Math.max(0,grid-c.grid)/60});
 }
 const final=frames[1439],peakCost=c.market==='flanders'?Math.max(0,peak-c.peakThreshold)*4.45:Math.max(0,peak-c.peakThreshold)*1.2,totalCost=cost+peakCost,readyPct=vehicles.length?ready/vehicles.length*100:100,flexHeadroom=quarters.filter(x=>x.stress>.45).reduce((a,x)=>a+Math.max(0,c.grid-x.projectedGrid),0)/Math.max(1,quarters.filter(x=>x.stress>.45).length);
 const explanations:Record<number,string>={};vehicles.forEach(v=>{const best=allocations[v.id].map((p,i)=>({p,i})).filter(x=>x.p>0).sort((a,b)=>a.i-b.i);explanations[v.id]=best.length?`Planned across ${best.length} quarter-hours from ${clock(best[0].i*15)} to ${clock((best.at(-1)!.i+1)*15)}; target ${v.need.toFixed(0)} kWh by ${clock(v.departure)}.`:'No feasible charging allocation found.';});
 return{config:baseConfig,vehicles,frames,events:[],final,quarters,strategy:c.strategy,market:c.market,explanations,scorecard:{energyCost:cost,peakCost,totalCost,peak,readyPct,carbonKg,flexHeadroom}};
}
export function compareStrategies(c:OptimizerConfig){return strategies.map(s=>({strategy:s.id,name:s.name,result:simulateOptimizer({...c,strategy:s.id})}));}
