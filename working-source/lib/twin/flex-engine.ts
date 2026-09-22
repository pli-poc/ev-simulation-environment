import {clock,defaults,simulate,type Config,type Event as BaseEvent} from './engine';

export type FlexScenarioId='congestion'|'battery-derate'|'early-departure'|'telemetry-loss'|'solar-drop';
export type FlexQuality='good'|'degraded'|'stale';
export type AssetKind='battery'|'ev'|'cold'|'hvac'|'workshop';
export type AssetState='normal'|'limited'|'warning'|'critical'|'stale';

export type FlexScenario={
 id:FlexScenarioId;
 name:string;
 description:string;
 requestKw:number;
 start:number;
 duration:number;
};

export const flexScenarios:FlexScenario[]=[
 {id:'congestion',name:'DSO congestion request',description:'Reduce grid import for 30 minutes while protecting EV departure commitments and thermal limits.',requestKw:70,start:780,duration:30},
 {id:'battery-derate',name:'Battery thermal derating',description:'A larger flexibility commitment is challenged when the battery warms and its discharge ceiling falls.',requestKw:105,start:780,duration:35},
 {id:'early-departure',name:'Three early departures',description:'Three drivers unexpectedly leave earlier, shrinking EV flexibility during an active congestion event.',requestKw:90,start:780,duration:35},
 {id:'telemetry-loss',name:'Battery telemetry stale',description:'Battery telemetry stops refreshing. The controller withdraws uncertain flexibility instead of assuming it is still available.',requestKw:85,start:780,duration:35},
 {id:'solar-drop',name:'Solar forecast miss',description:'Cloud cover removes expected PV output during a grid-flexibility commitment and forces rapid redispatch.',requestKw:75,start:780,duration:40},
];

export type FlexConfig={
 scenario:FlexScenarioId;
 requestKw:number;
 start:number;
 duration:number;
 grid:number;
 solar:number;
 demand:number;
 chargers:number;
 seed:number;
};

export const flexDefaults:FlexConfig={scenario:'congestion',requestKw:70,start:780,duration:30,grid:160,solar:70,demand:1.08,chargers:20,seed:42};

export type FlexAsset={
 id:string;
 name:string;
 kind:AssetKind;
 currentKw:number;
 availableDownKw:number;
 dispatchedKw:number;
 sustainableMinutes:number;
 telemetryAgeSec:number;
 state:AssetState;
 reason:string;
};

export type FlexAlarm={time:number;severity:'info'|'warning'|'critical'|'success';asset:string;text:string};

export type FlexFrame={
 time:number;
 baselineGrid:number;
 controlledGrid:number;
 gridLimit:number;
 building:number;
 solar:number;
 ev:number;
 requestKw:number;
 availableKw:number;
 deliveredKw:number;
 shortfallKw:number;
 reboundKw:number;
 batteryPower:number;
 batteryKwh:number;
 batterySoc:number;
 batteryTemp:number;
 coldPower:number;
 coldTemp:number;
 hvacPower:number;
 telemetryAgeSec:number;
 telemetryQuality:FlexQuality;
 envelope5:number;
 envelope15:number;
 envelope30:number;
 envelope60:number;
 deferredKwh:number;
 recoveredKwh:number;
 assets:FlexAsset[];
};

export type FlexResult={config:FlexConfig;frames:FlexFrame[];events:FlexAlarm[];baseEvents:BaseEvent[];final:FlexFrame};

const clamp=(v:number,min:number,max:number)=>Math.max(min,Math.min(max,v));

function scenarioFor(id:FlexScenarioId){return flexScenarios.find(s=>s.id===id)??flexScenarios[0];}

export function withScenario(config:FlexConfig,id:FlexScenarioId):FlexConfig{
 const s=scenarioFor(id);
 return {...config,scenario:id,requestKw:s.requestKw,start:s.start,duration:s.duration};
}

export function simulateFlex(input:FlexConfig):FlexResult{
 const c={...input};
 if(!flexScenarios.some(s=>s.id===c.scenario))throw new Error('Unknown flexibility scenario');
 if(c.requestKw<0||c.requestKw>180||c.grid<60||c.grid>250||c.solar<0||c.solar>180||c.demand<.5||c.demand>2||c.duration<5||c.duration>180)throw new Error('Invalid flexibility configuration');
 const baseConfig:Config={...defaults,preset:c.scenario==='solar-drop'?'cloud':'office',policy:'ems',grid:c.grid,solar:c.solar,demand:c.demand,battery:false,chargers:c.chargers,seed:c.seed,flexible:true};
 const base=simulate(baseConfig);
 const frames:FlexFrame[]=[];const events:FlexAlarm[]=[];
 const startBattery=84;let batteryKwh=startBattery,batteryTemp=27,coldTemp=-20,telemetryAge=.2;
 let deferredEv=0,deferredCold=0,deferredHvac=0,recovered=0;
 let emittedDerate=false,emittedStale=false,emittedEarly=false,emittedShortfall=false,emittedRecovery=false;
 const emit=(time:number,severity:FlexAlarm['severity'],asset:string,text:string)=>events.push({time,severity,asset,text});
 emit(c.start,'info','Energy hub',`Flexibility commitment scheduled · ${c.requestKw.toFixed(0)} kW for ${c.duration} min from ${clock(c.start)}`);
 for(let t=0;t<1440;t++){
  const b=base.frames[t];
  const inEvent=t>=c.start&&t<c.start+c.duration;
  const afterEvent=t>=c.start+c.duration;
  const solarShock=(c.scenario==='solar-drop'&&t>=c.start&&t<c.start+55)?.38:1;
  const solar=b.solar*solarShock;
  const solarDelta=b.solar-solar;
  // Cold-store load is deliberately simple: a thermal buffer that can briefly trade compressor power for temperature drift.
  const coldNominal=t>=360&&t<1320?18:12;
  const coldSafeMargin=Math.max(0,-16-coldTemp);
  const coldSustain=clamp(coldSafeMargin/.028,0,90);
  const coldFlexBase=coldSafeMargin>.15?Math.min(15,coldNominal-3):0;
  // EV down-flex keeps enough average power to meet declared remaining energy by departure.
  let evFlex=0,evSustain=60;
  for(const s of b.cars){if(s.power<=0)continue;const v=base.vehicles[s.id];const remaining=Math.max(0,v.need-s.delivered);const mins=Math.max(1,v.departure-t);const requiredAc=remaining/(mins/60)/.9;const reducible=Math.max(0,s.power-Math.max(1.4,requiredAc*1.06));evFlex+=reducible;evSustain=Math.min(evSustain,clamp(mins-remaining/(Math.max(1.4,s.power)*.9)*60,5,60));}
  if(c.scenario==='early-departure'&&t>=c.start+10&&t<c.start+c.duration){evFlex=Math.max(0,evFlex-24);evSustain=Math.min(evSustain,15);if(!emittedEarly){emit(t,'warning','EV fleet','Three departure times advanced · 24 kW of previously flexible charging withdrawn');emittedEarly=true;}}
  const hvacMargin=Math.max(0,b.temp-20.1);const hvacFlex=hvacMargin>.05?Math.min(b.hvac*.58,20):0;const hvacSustain=clamp(hvacMargin/.015,5,50);
  const workshopFlex=b.task>0?Math.min(8,b.task):0;
  // Telemetry age is a control input: after two minutes of staleness the BESS is removed from dispatchable capacity.
  if(c.scenario==='telemetry-loss'&&t>=c.start+5&&t<c.start+c.duration+8)telemetryAge+=60;else telemetryAge=.2;
  const telemetryQuality:FlexQuality=telemetryAge>120?'stale':telemetryAge>30?'degraded':'good';
  if(telemetryQuality==='stale'&&!emittedStale){emit(t,'critical','BESS-01',`Telemetry stale (${Math.round(telemetryAge)} s) · battery flexibility withdrawn from dispatch`);emittedStale=true;}
  const thermalDerate=c.scenario==='battery-derate'?clamp(60-(batteryTemp-31)*6,18,60):60;
  const energyDerate=Math.max(0,(batteryKwh-24)*60*.95);
  const batteryAvailable=telemetryQuality==='stale'?0:Math.min(thermalDerate,energyDerate);
  if(c.scenario==='battery-derate'&&thermalDerate<50&&!emittedDerate){emit(t,'warning','BESS-01',`Thermal derating active · discharge ceiling reduced to ${thermalDerate.toFixed(0)} kW`);emittedDerate=true;}
  const request=inEvent?c.requestKw:0;
  const available=batteryAvailable+evFlex+coldFlexBase+hvacFlex+workshopFlex;
  let remaining=request,batteryDispatch=0,evDispatch=0,coldDispatch=0,hvacDispatch=0,workshopDispatch=0;
  // Service-preserving merit order: storage first, then charging slack, then thermal buffers, then workshop task.
  if(inEvent){batteryDispatch=Math.min(remaining,batteryAvailable);remaining-=batteryDispatch;evDispatch=Math.min(remaining,evFlex);remaining-=evDispatch;coldDispatch=Math.min(remaining,coldFlexBase);remaining-=coldDispatch;hvacDispatch=Math.min(remaining,hvacFlex);remaining-=hvacDispatch;workshopDispatch=Math.min(remaining,workshopFlex);remaining-=workshopDispatch;}
  const delivered=request-remaining;
  const shortfall=Math.max(0,request-delivered);
  if(inEvent&&shortfall>2&&!emittedShortfall){emit(t,'critical','Energy hub',`Flexibility shortfall · ${shortfall.toFixed(0)} kW cannot be delivered without breaching protected constraints`);emittedShortfall=true;}
  // Energy shifted away during a flex event is tracked and paid back later rather than treated as disappearing demand.
  deferredEv+=evDispatch/60;deferredCold+=coldDispatch/60;deferredHvac+=hvacDispatch/60;
  let rebound=0;
  if(afterEvent){const deferred=deferredEv+deferredCold+deferredHvac;const headroom=Math.max(0,c.grid-8-(b.grid+solarDelta));rebound=Math.min(34,headroom,deferred*60);if(rebound>0){const take=Math.min(deferredEv,rebound/60*.55);deferredEv-=take;let left=rebound/60-take;const coldTake=Math.min(deferredCold,left);deferredCold-=coldTake;left-=coldTake;const hvacTake=Math.min(deferredHvac,left);deferredHvac-=hvacTake;recovered+=rebound/60;}}
  // Battery energy and temperature respond to actual dispatch, then recover cautiously after the event.
  let batteryPower=batteryDispatch;
  if(afterEvent&&batteryKwh<startBattery-.05){const headroom=Math.max(0,c.grid-10-(b.grid+solarDelta+rebound));const charge=Math.min(32,headroom,(startBattery-batteryKwh)*60/.95);batteryPower=-charge;}
  if(batteryPower>=0)batteryKwh-=batteryPower/.95/60;else batteryKwh+=-batteryPower*.95/60;
  batteryKwh=clamp(batteryKwh,24,114);
  const heatingFactor=c.scenario==='battery-derate'?.009:.0032;batteryTemp+=(Math.max(0,batteryPower)*heatingFactor-(batteryTemp-27)*.018);
  // Thermal store response after dispatch; rebound restores the compressor load indirectly through deferred energy recovery.
  const coldPower=Math.max(0,coldNominal-coldDispatch+Math.min(rebound*.35,10));
  coldTemp+=.031-coldPower*.00172;coldTemp=clamp(coldTemp,-22,-12);
  const processLoad=t>=420&&t<1140?55:20;
  const baselineGrid=b.grid+coldNominal+processLoad+solarDelta;
  const controlledGrid=baselineGrid-delivered+rebound+(batteryPower<0?-batteryPower:0);
  const envelope=(horizon:number)=>{
   const batt=Math.min(batteryAvailable,energyDerate/Math.max(1,horizon));
   const ev=evFlex*Math.min(1,evSustain/horizon);
   const cold=coldFlexBase*Math.min(1,coldSustain/horizon);
   const hvac=hvacFlex*Math.min(1,hvacSustain/horizon);
   return batt+ev+cold+hvac+workshopFlex*Math.min(1,20/horizon);
  };
  const assets:FlexAsset[]=[
   {id:'battery',name:'BESS-01',kind:'battery',currentKw:batteryPower,availableDownKw:batteryAvailable,dispatchedKw:batteryDispatch,sustainableMinutes:batteryAvailable>0?clamp((batteryKwh-24)*60*.95/Math.max(1,batteryAvailable),0,180):0,telemetryAgeSec:telemetryAge,state:telemetryQuality==='stale'?'stale':batteryTemp>=43?'critical':batteryTemp>=38?'warning':thermalDerate<55?'limited':'normal',reason:telemetryQuality==='stale'?'Excluded: telemetry freshness outside operating threshold':thermalDerate<55?'Thermal ceiling is reducing dispatchable power':'Fast response buffer preserving customer charging commitments'},
   {id:'ev',name:'EV charging fleet',kind:'ev',currentKw:b.ev,availableDownKw:evFlex,dispatchedKw:evDispatch,sustainableMinutes:evSustain,telemetryAgeSec:.4,state:evFlex<8?'limited':'normal',reason:'Only charging power above the calculated departure-energy requirement is offered as flexibility'},
   {id:'cold',name:'Cold store',kind:'cold',currentKw:coldPower,availableDownKw:coldFlexBase,dispatchedKw:coldDispatch,sustainableMinutes:coldSustain,telemetryAgeSec:.7,state:coldTemp>-15?'critical':coldTemp>-16.5?'warning':'normal',reason:`Thermal buffer available until the -16 °C operating boundary is approached`},
   {id:'hvac',name:'Building HVAC',kind:'hvac',currentKw:Math.max(0,b.hvac-hvacDispatch),availableDownKw:hvacFlex,dispatchedKw:hvacDispatch,sustainableMinutes:hvacSustain,telemetryAgeSec:.6,state:b.temp<20?'warning':'normal',reason:'Comfort-band flexibility is constrained by occupied-space temperature'},
   {id:'workshop',name:'Flexible workshop load',kind:'workshop',currentKw:Math.max(0,b.task-workshopDispatch),availableDownKw:workshopFlex,dispatchedKw:workshopDispatch,sustainableMinutes:20,telemetryAgeSec:1.1,state:'normal',reason:'Deferrable process load with a same-day energy completion target'},
  ];
  if(afterEvent&&!emittedRecovery&&rebound>1){emit(t,'success','Energy hub',`Recovery started · deferred demand is being restored below the ${c.grid} kW import ceiling`);emittedRecovery=true;}
  frames.push({time:t,baselineGrid,controlledGrid,gridLimit:c.grid,building:b.building+coldPower+processLoad,solar,ev:b.ev-evDispatch,requestKw:request,availableKw:available,deliveredKw:delivered,shortfallKw:shortfall,reboundKw:rebound,batteryPower,batteryKwh,batterySoc:batteryKwh/120*100,batteryTemp,coldPower,coldTemp,hvacPower:Math.max(0,b.hvac-hvacDispatch),telemetryAgeSec:telemetryAge,telemetryQuality,envelope5:envelope(5),envelope15:envelope(15),envelope30:envelope(30),envelope60:envelope(60),deferredKwh:deferredEv+deferredCold+deferredHvac,recoveredKwh:recovered,assets});
 }
 const end=c.start+c.duration;const eventFrames=frames.slice(c.start,end);const avgDelivered=eventFrames.reduce((a,f)=>a+f.deliveredKw,0)/Math.max(1,eventFrames.length);const avgShort=eventFrames.reduce((a,f)=>a+f.shortfallKw,0)/Math.max(1,eventFrames.length);
 emit(end,avgShort<1?'success':'warning','Energy hub',`Flex event complete · average delivery ${avgDelivered.toFixed(0)} kW${avgShort>=1?` · average shortfall ${avgShort.toFixed(0)} kW`:''}`);
 return{config:c,frames,events:events.sort((a,b)=>a.time-b.time),baseEvents:base.events,final:frames[1439]};
}
