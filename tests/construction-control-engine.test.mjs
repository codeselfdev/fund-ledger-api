import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calculateSchedule,scheduleFraction,micro,proportional,priceBoq,compareBoq} from '../dist/modules/construction/construction.control.engine.js';
const cal={weekdays:[1,2,3,4,5],holidays:['2026-01-05']};
const t=(id,duration,dependencies=[],extra={})=>({task_id:id,duration,dependencies,...extra});
test('working calendar skips weekends and holidays and identifies critical path and float',()=>{
 const p=calculateSchedule('2026-01-02',[t('a',2),t('b',2,[{task_id:'a',type:'FS',lag:0}]),t('c',1)],cal);
 assert.equal(p.finish,'2026-01-08');assert.deepEqual(p.tasks.map(x=>[x.start,x.end,x.float_days,x.critical]),[['2026-01-02','2026-01-06',0,true],['2026-01-07','2026-01-08',0,true],['2026-01-02','2026-01-02',3,false]]);
 assert.equal(scheduleFraction('2026-01-02','2026-01-06','2026-01-05',cal),.5);
 assert.equal(scheduleFraction('2026-01-02','2026-01-06','2026-01-01',cal),0);
 assert.equal(scheduleFraction('2026-01-02','2026-01-06','2026-01-06',cal),1);
});
test('FS SS FF SF and negative lag use working-day boundaries',()=>{
 const all={weekdays:[0,1,2,3,4,5,6],holidays:[]};
 for(const[type,lag,expected]of [['FS',0,'2026-01-06'],['SS',1,'2026-01-02'],['FF',1,'2026-01-05'],['SF',5,'2026-01-04'],['FS',-2,'2026-01-04']]){
  const p=calculateSchedule('2026-01-01',[t('a',5),t('b',2,[{task_id:'a',type,lag}])],all);assert.equal(p.tasks[1].start,expected,type);
 }
});
test('schedules reject cycles, missing and duplicate tasks, empty calendars and excessive horizons',()=>{
 assert.throws(()=>calculateSchedule('2026-01-01',[t('a',1,[{task_id:'b',type:'FS',lag:0}]),t('b',1,[{task_id:'a',type:'FS',lag:0}])],cal),/cycle/);
 assert.throws(()=>calculateSchedule('2026-01-01',[t('a',1,[{task_id:'x',type:'FS',lag:0}])],cal),/unscheduled/);
 assert.throws(()=>calculateSchedule('2026-01-01',[t('a',1),t('a',2)],cal),/once/);
 assert.throws(()=>calculateSchedule('2026-01-01',[t('a',1)],{weekdays:[],holidays:[]}),/weekday/);
 assert.throws(()=>calculateSchedule('2026-01-01',[t('a',10002)],cal),/horizon/);
});
test('resource recipes price fractional material and labor quantities without posting actuals',()=>{
 const line=priceBoq({id:'x',cost_head_id:'h',name:'Concrete',unit:'m3',quantity:2.5,rate:0,rate_mode:'recipe',resources:[{kind:'material',name:'Cement',unit:'bag',quantity_per_unit:1.25,rate:500},{kind:'labor',name:'Mason',unit:'day',quantity_per_unit:.5,rate:800}]});
 assert.equal(line.rate,1025);assert.equal(line.estimated,2563);assert.equal(line.recipe_unit_cost,1025);
 const c=compareBoq([line],[priceBoq({...line,quantity:3})])[0];assert.equal(c.quantity_change,.5);assert.equal(c.cost_change,512);
 assert.throws(()=>priceBoq({...line,resources:[]}),/resources/);
});
test('micro valuation allocation conserves every unit through fractional pool drains and returns',()=>{
 assert.equal(micro(.123456),123456n);assert.throws(()=>micro(.1234567),/six/);
 const original=1000000n,part=proportional(original,1,3);assert.equal(part,333333n);assert.equal(part+proportional(original-part,2,2),original);
 let returned=0n;for(let i=0;i<3;i++)returned+=proportional(original,i+1,3)-proportional(original,i,3);assert.equal(returned,original);
});
