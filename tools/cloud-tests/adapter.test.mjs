import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const createCloud = require('../../dsr-cloud.js');
const manual = require('../../dsr-manual.js');
const clone = x => JSON.parse(JSON.stringify(x));
const backup = (name='old') => ({format:'DSR_OFFLINE_BACKUP',version:2,config:{company_name:name},records:[{__backendId:'p1',record_type:'project',project_name:name}]});
function backend(initial=backup()) {
  let version=initial?1:0, data=initial, loseResponse=false;
  const receipts=new Map();
  const client={auth:{
    getSession:async()=>({data:{session:{user:{email:'owner@example.com'}}},error:null}),
    signInWithPassword:async()=>({data:{user:{email:'owner@example.com'}},error:null}),
    signOut:async()=>({error:null}), onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})
  }, rpc:async(name,p)=>{
    if(name==='dsr_read')return {data:{version,payload:version===p.p_known_version?null:clone(data),unchanged:version===p.p_known_version,role:'owner'},error:null};
    if(receipts.has(p.p_request_id))return {data:clone(receipts.get(p.p_request_id)),error:null};
    if(p.p_expected_version!==version)return {data:null,error:{message:'DSR_VERSION_CONFLICT',code:'40001'}};
    data=clone(p.p_payload);version++;
    const receipt={version,replayed:false};receipts.set(p.p_request_id,receipt);
    if(loseResponse){loseResponse=false;throw new Error('network timeout');}
    return {data:receipt,error:null};
  }};
  return {client,get data(){return data;},get version(){return version;},loseNext(){loseResponse=true;},external(next){data=clone(next);version++;}};
}
async function app(b) {
  let records=[];
  const sdk=manual(createCloud,{client:b.client,setRecords:r=>{records=r;},hasPendingDraft:()=>false});
  await sdk.init({onDataChanged:r=>{records=r;}});
  return {sdk,get records(){return records;}};
}
test('explicit Save commits centrally; draft editing does not upload',async()=>{
  const b=backend(),a=await app(b);
  await a.sdk.update({...a.records[0],project_name:'new'});
  assert.equal(b.data.records[0].project_name,'old');
  assert.equal((await a.sdk.commitDrafts()).isOk,true);
  assert.equal(b.data.records[0].project_name,'new');
  assert.equal(a.sdk.draftCount(),0);
});
test('two machines read the same saved dataset',async()=>{
  const b=backend(),a=await app(b),c=await app(b);
  await a.sdk.update({...a.records[0],project_name:'shared'});await a.sdk.commitDrafts();
  await c.sdk.refresh();assert.equal(c.records[0].project_name,'shared');
});
test('stale writer fails without losing draft or overwriting newer central data',async()=>{
  const b=backend(),a=await app(b);
  await a.sdk.update({...a.records[0],project_name:'my draft'});
  b.external(backup('other machine'));
  const saved=await a.sdk.commitDrafts();
  assert.equal(saved.isOk,false);assert.equal(saved.conflict,true);
  assert.equal(a.sdk.draftCount(),1);assert.equal(a.records[0].project_name,'my draft');
  assert.equal(b.data.records[0].project_name,'other machine');
  assert.equal((await a.sdk.refresh()).isOk,false);
});
test('lost response retries the same intent exactly once',async()=>{
  const b=backend(),a=await app(b);
  await a.sdk.update({...a.records[0],project_name:'once'});b.loseNext();
  assert.equal((await a.sdk.commitDrafts()).isOk,false);assert.equal(b.version,2);
  assert.equal((await a.sdk.commitDrafts()).isOk,true);assert.equal(b.version,2);
  assert.equal(a.sdk.draftCount(),0);
});
test('edits after a lost response are preserved and saved after resolving the old intent',async()=>{
  const b=backend(),a=await app(b);
  await a.sdk.update({...a.records[0],project_name:'first'});b.loseNext();
  await a.sdk.commitDrafts();await a.sdk.update({...a.records[0],project_name:'second'});
  assert.equal((await a.sdk.commitDrafts()).isOk,true);
  assert.equal(b.data.records[0].project_name,'second');assert.equal(b.version,3);
});
test('cloud import is explicit and only allowed for an empty workspace',async()=>{
  const b=backend(null),a=await app(b);
  assert.equal(b.version,0);
  assert.equal((await a.sdk.importBackup({text:async()=>JSON.stringify(backup())})).isOk,true);
  assert.equal(b.data.records[0].__backendId,'p1');
  assert.equal((await a.sdk.importBackup({text:async()=>JSON.stringify(backup('overwrite'))})).isOk,false);
  assert.equal(b.data.config.company_name,'old');
});
test('deleting a create after an unknown save does not silently resurrect the record',async()=>{
  const b=backend(),a=await app(b);
  const added={__backendId:'new-p',record_type:'project',project_name:'new'};
  await a.sdk.create(added);b.loseNext();
  assert.equal((await a.sdk.commitDrafts()).isOk,false);
  await a.sdk.delete(added);
  assert.equal(a.sdk.draftCount(),1);
  assert.equal((await a.sdk.commitDrafts()).isOk,true);
  assert.equal(b.data.records.some(r=>r.__backendId==='new-p'),false);
});
test('document numbers in the draft are stable and increase within the same edit session',async()=>{
  const a=await app(backend());
  assert.equal(await a.sdk.reserveDocumentNumber('INV2569','invoice_number','i1',10),'INV2569-011');
  assert.equal(await a.sdk.reserveDocumentNumber('INV2569','invoice_number','i1',10),'INV2569-011');
  assert.equal(await a.sdk.reserveDocumentNumber('INV2569','invoice_number','i2',10),'INV2569-012');
});
test('a refresh response arriving after editing starts cannot advance the draft baseline',async()=>{
  const b=backend(),a=await app(b),original=b.client.rpc;
  let releaseRead;
  b.external(backup('external'));
  b.client.rpc=async(name,p)=>{
    const response=await original(name,p);
    if(name==='dsr_read')await new Promise(resolve=>{releaseRead=resolve;});
    return response;
  };
  const reading=a.sdk.refresh();
  await new Promise(resolve=>setImmediate(resolve));
  await a.sdk.update({...a.records[0],project_name:'draft from old data'});
  releaseRead();assert.equal((await reading).isOk,false);
  assert.equal(a.sdk.getCloudState().version,1);
  assert.equal((await a.sdk.commitDrafts()).conflict,true);
  assert.equal(b.data.records[0].project_name,'external');
});
