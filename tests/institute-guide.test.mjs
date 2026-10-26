import {test} from 'node:test';
import assert from 'node:assert/strict';
import {authorizedArticles} from '../dist/modules/app-guide/app-guide.policy.js';
test('Nesta AI offers Institute onboarding and import instructions in both languages',()=>{
 for(const language of ['en','bn']){
  const articles=authorizedArticles('institute',['owner'],undefined,language);
  for(const id of ['setup','groups','subjects','teachers','students','routine']){
   const a=articles.find(a=>a.id===`institute_${id}`);assert.ok(a);assert.ok(a.steps.length>=3);
   if(language==='bn')assert.ok(a.steps.every(s=>/[\u0980-\u09ff]/.test(s)));
  }
 }
});
test('teacher, accountant, family and custom grants cannot gain Institute administration guides',()=>{
 for(const role of ['teacher','accountant','member','auditor']){
  const articles=authorizedArticles('institute',[role],undefined,'en');
  assert.ok(!articles.some(a=>a.id==='institute_setup'));assert.ok(!articles.some(a=>a.id==='institute_teachers'));
  assert.ok(articles.find(a=>a.id==='institute_routine')?.steps.some(s=>s.includes('viewing steps')));
 }
 assert.ok(!authorizedArticles('institute',['teacher'],undefined,'en').some(a=>a.id==='institute_fees'));
 const custom=authorizedArticles('institute',[],{institute_setup:{read:true,write:true},institute_teachers:{read:true,write:true}},'en');
 assert.deepEqual(custom.map(a=>a.id).sort(),['all_tools','overview']);
});
