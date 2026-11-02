const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
function extract(start, end) { return html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start))); }
function fixture({cloud = true, status, write, commit} = {}) {
  const button = {disabled:false, textContent:'บันทึกทั้งหมด'};
  const info = {isConnected:true};
  const messages = [];
  let drafts = 1, commits = 0;
  const sdk = {
    isCloud:cloud,
    commitDrafts:async()=>{commits++; const result = commit || {isOk:true}; if(result.isOk) drafts=0; return result;},
    draftCount:()=>drafts,
    jsonFileStatus:status || (async()=>({configured:false})),
    saveJsonFile:write || (async()=>({isOk:true, fileName:'backup.json'}))
  };
  const ctx = vm.createContext({
    window:{dataSdk:sdk},
    document:{getElementById:id=>id==='dsr-save-all'?button:id==='dsr-json-file-info'?info:null, querySelectorAll:()=>[]},
    currentPage:'dashboard', _dsrEditVersion:0, _dsrManualPending:new Set(), _dsrDirty:true,
    _qt:{}, _dsrLastSyncState:{},
    dsrPrepareDraftsForSave:async()=>{}, showToast:message=>messages.push(message),
    dsrShowSyncStatus:()=>{},
    // Advance only the production deadline; never wait 8/15 seconds per test.
    setTimeout:fn=>setTimeout(fn, 5), clearTimeout
  });
  vm.runInContext(extract('function dsrWaitForJson(', 'async function dsrChooseJsonFile('),ctx);
  vm.runInContext(extract('async function dsrSaveAll(', '// Editing actions apply drafts only.'),ctx);
  return {ctx,button,info,messages,get drafts(){return drafts;},get commits(){return commits;}};
}
const pending = ()=>new Promise(()=>{});
for (const cloud of [true,false]) {
  test(`hung JSON lookup releases Save after successful ${cloud?'cloud':'local'} commit`,async()=>{
    const f=fixture({cloud,status:pending});
    await f.ctx.dsrSaveAll(true);
    assert.equal(f.button.disabled,false);
    assert.equal(f.drafts,0);
    assert.equal(f.commits,1);
    assert.match(f.messages.at(-1),cloud?/บันทึกฐานกลางแล้ว/:/บันทึกในเบราว์เซอร์แล้ว/);
    assert.match(f.messages.at(-1),/JSON ไม่ตอบสนอง/);
  });
}
test('hung JSON write releases Save without retrying the committed data',async()=>{
  const f=fixture({status:async()=>({configured:true}),write:pending});
  await f.ctx.dsrSaveAll(true);
  assert.equal(f.button.disabled,false);
  assert.equal(f.drafts,0);
  assert.equal(f.commits,1);
  assert.match(f.messages.at(-1),/บันทึกฐานกลางแล้ว/);
});
test('settings file status reports a timeout instead of checking forever',async()=>{
  const f=fixture({status:pending});
  await f.ctx.dsrUpdateJsonFileInfo();
  assert.match(f.info.textContent,/ตรวจไฟล์ไม่ได้/);
});
test('primary commit failure retains drafts and never claims a successful save',async()=>{
  const f=fixture({commit:{isOk:false,error:'network unavailable'},status:pending});
  await f.ctx.dsrSaveAll(true);
  assert.equal(f.button.disabled,false);
  assert.equal(f.drafts,1);
  assert.deepEqual(f.messages,['network unavailable']);
});
test('normal JSON backup still reports its filename',async()=>{
  const f=fixture({status:async()=>({configured:true})});
  await f.ctx.dsrSaveAll(true);
  assert.equal(f.button.disabled,false);
  assert.equal(f.messages[0],'บันทึกแล้ว · backup.json');
});
