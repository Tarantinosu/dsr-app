const createManual=require('./dsr-manual.js'),assert=require('assert/strict');
function fixture(){
 let rows=[{__backendId:'r1',record_type:'installment',amount:10}],writes=[],sends=0,display=[],events=[],opts,handler,fail=false,gate=null;
 function factory(o){opts=o;function publish(){o.setRecords(rows);handler.onDataChanged(rows);}
  return {init:async h=>{handler=h;publish();return {isOk:true};},
   create:async r=>write('create',r),update:async r=>write('update',r),delete:async r=>write('delete',r),
   getSyncInfo:async()=>({enabled:true,configured:true,pending:0}),flushGoogle:async()=>{sends++;return {isOk:true,pending:0};},refresh:async()=>({isOk:true}),syncNow:async()=>({isOk:true})};
  async function write(action,r){writes.push({action,record:JSON.parse(JSON.stringify(r))});if(gate)await gate;if(fail)return {isOk:false,error:'disk-full'};
    rows=rows.filter(x=>x.__backendId!==r.__backendId);if(action!=='delete')rows.push(JSON.parse(JSON.stringify(r)));publish();return {isOk:true};}
 }
 const api=createManual(factory,{setRecords:r=>display=r,onStaged:a=>events.push(a)});
 return {api,init:()=>api.init({onDataChanged:r=>display=r}),get writes(){return writes},get sends(){return sends},get view(){return display},get events(){return events},set fail(v){fail=v},set gate(v){gate=v},remap:(a,b)=>{opts.onRemap(a,b);rows=rows.map(r=>r.__backendId===a?{...r,__backendId:b}:r);opts.setRecords(rows);handler.onDataChanged(rows);},get blocked(){return opts.hasPendingDraft()}};
}
(async()=>{
 let f=fixture();await f.init();await f.api.updateLocal({__backendId:'r1',amount:20});assert.equal(f.view[0].amount,20);assert.equal(f.writes.length,0);assert.equal(f.sends,0);assert(f.blocked);assert.equal((await f.api.refresh()).error,'unsaved-changes');console.log('PASS edit is visible with no persistence, queue, or send; refresh blocked');
 await f.api.delete({__backendId:'r1'});assert.equal(f.view.length,0);assert.equal(f.writes.length,0);await f.api.commitDrafts();assert.equal(f.writes[0].action,'delete');assert.equal(f.sends,0);assert.equal(f.api.draftCount(),0);assert.equal(f.sends,0);console.log('PASS delete disappears immediately; only Save commits deletion');
 f=fixture();await f.init();let r={record_type:'project'};await f.api.create(r);await f.api.update({...r,name:'edited'});await f.api.delete(r);assert.equal(f.api.draftCount(),0);assert.equal(f.writes.length,0);console.log('PASS add/edit/delete before Save cancels without writes');
 f=fixture();await f.init();await f.api.update({__backendId:'r1',amount:30});f.fail=true;assert.equal((await f.api.commitDrafts()).isOk,false);assert.equal(f.api.draftCount(),1);assert.equal(f.view[0].amount,30);f.fail=false;await f.api.commitDrafts();assert.equal(f.api.draftCount(),0);console.log('PASS save failure keeps draft for retry');
 f=fixture();await f.init();await f.api.update({__backendId:'r1',amount:40});let release;f.gate=new Promise(r=>release=r);const saving=f.api.commitDrafts();await f.api.update({__backendId:'r1',amount:50});release();await saving;assert.equal(f.api.draftCount(),1);assert.equal(f.view[0].amount,50);assert.equal(f.writes[0].record.amount,40);console.log('PASS editing during Save keeps newer edit unsaved');
 f=fixture();await f.init();r={name:'new'};await f.api.create(r);let release2;f.gate=new Promise(r=>release2=r);const saving2=f.api.commitDrafts();await f.api.delete(r);release2();await saving2;assert.equal(f.api.draftCount(),1);assert.equal(f.view.length,1);assert.equal(f.view[0].__backendId,'r1');console.log('PASS deleting a new item during Save retains deletion');
 f=fixture();await f.init();await f.api.update({__backendId:'r1',amount:60});f.remap('r1','server1');assert.equal(f.view.length,1);assert.equal(f.view[0].__backendId,'server1');assert.equal(f.view[0].amount,60);await f.api.update({__backendId:'r1',amount:70});assert.equal(f.view.length,1);assert.equal(f.view[0].amount,70);console.log('PASS server ID remap preserves newer drafts and stale UI IDs');
})();

