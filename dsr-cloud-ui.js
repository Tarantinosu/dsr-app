/* Authentication and first-import UI; no automatic upload of local business data. */
(function(root){
  'use strict';
  var state=null, pendingImport=null, loading=false;
  var cloudMode=false;
  try {cloudMode=root.localStorage.getItem('DSR_storage_mode')==='cloud';}catch(ignore){}
  root.dsrCloudMode=cloudMode;
  function setText(id,text){var el=document.getElementById(id);if(el)el.textContent=text;}
  function error(text){setText('dsr-cloud-message',text);}
  function sdk(){return root.dataSdk;}
  function canLeave(){
    if(root.dsrHasPendingDraft() || sdk().isBusy() || (sdk().hasUnresolvedSave&&sdk().hasUnresolvedSave())) {root.showToast('กรุณาบันทึกทั้งหมดก่อนเปลี่ยนโหมด · ฉบับร่างยังอยู่','error');return false;}
    return true;
  }
  root.dsrSwitchStorage=function(mode){
    if(!canLeave())return;
    root.localStorage.setItem('DSR_storage_mode',mode);root.location.reload();
  };
  root.dsrCloudSignOut=async function(){
    if(!canLeave())return;
    var result=await sdk().signOut();if(!result.isOk)root.showToast(result.error,'error');
  };
  root.dsrCloudDownloadDraft=async function(){
    if(sdk().isBusy())return;
    await root.dsrPrepareDraftsForSave();
    var cfg=root.elementSdk?root.elementSdk.config:{};
    await sdk().downloadDraft(root.dsrGetCurrentRecords(),cfg);
    root.showToast('ดาวน์โหลดรายการฉบับร่างแล้ว · ข้อมูลที่ยังไม่ได้กดเพิ่มในฟอร์มไม่รวมในไฟล์');
  };
  root.dsrCloudReload=function(){
    if(sdk().isBusy())return;
    if(root.confirm('โหลดข้อมูลล่าสุดจากฐานกลาง? ฉบับร่างที่ยังไม่บันทึกจะหาย กรุณาดาวน์โหลดฉบับร่างไว้ก่อน'))root.location.reload();
  };
  root.dsrShowCloudState=function(next){state=next;render();};
  function render(){
    var dialog=document.getElementById('dsr-cloud-dialog');if(!dialog)return;
    var cloud=cloudMode&&sdk()&&sdk().isCloud;
    setText('dsr-cloud-mode',cloud?'ข้อมูลร่วมกันผ่าน Supabase':'ข้อมูลแยกในเบราว์เซอร์นี้');
    document.getElementById('dsr-cloud-connect').hidden=cloud;
    document.getElementById('dsr-cloud-account').hidden=!cloud;
    if(!cloud)return;
    var s=state||{ready:false,loginRequired:true};
    setText('dsr-cloud-email',s.email||'ยังไม่ได้เข้าสู่ระบบ');
    document.getElementById('dsr-cloud-conflict').hidden=!s.conflict;
    document.getElementById('dsr-cloud-draft-download').hidden=!s.ready;
    if(s.ready&&!s.empty){if(dialog.open)dialog.close();return;}
    if(!dialog.open)dialog.showModal();
    var importing=s.ready&&s.empty;
    document.getElementById('dsr-cloud-login-form').hidden=importing;
    document.getElementById('dsr-cloud-migration').hidden=!importing;
    document.getElementById('dsr-cloud-select-data').hidden=importing&&s.role!=='owner';
    setText('dsr-cloud-import-note',s.role==='owner'?'ฐานกลางยังว่าง เลือกข้อมูลเดิมหนึ่งชุดเพื่อนำเข้า ข้อมูลในเครื่องจะยังอยู่':'ฐานกลางยังว่าง รอให้เจ้าของนำเข้าข้อมูลก่อน');
    if(s.error)error(s.error);
    document.querySelectorAll('#dsr-cloud-dialog button:not([data-allow-busy]), #dsr-cloud-dialog input').forEach(function(el){el.disabled=loading||!!s.pending;});
    document.getElementById('dsr-cloud-confirm-import').disabled=loading||!!s.pending||!pendingImport;
  }
  async function preview(backup){
    pendingImport=null;
    var valid=root.createDSRSupabase.validateBackup(backup);
    if(!valid.records.length)throw new Error('ไฟล์นี้ไม่มีข้อมูล กรุณาเลือก Backup เดิม');
    pendingImport=valid;
    setText('dsr-cloud-import-preview','ตรวจพบ '+valid.records.length+' รายการ · '+(valid.config.company_name||'ยังไม่มีชื่อบริษัท')+' · สำรองเมื่อ '+(valid.exported_at||'ไม่ระบุ'));
    error('ตรวจชื่อบริษัทและจำนวนรายการก่อนกดยืนยัน ถ้าไม่ใช่ชุดล่าสุด ให้เลือกไฟล์อื่น');render();
  }
  document.addEventListener('DOMContentLoaded',function(){
    var dialog=document.createElement('dialog');dialog.id='dsr-cloud-dialog';dialog.setAttribute('aria-labelledby','dsr-cloud-title');
    dialog.innerHTML='<div class="dsr-cloud-sheet"><h1 id="dsr-cloud-title">DSR · ข้อมูลร่วมกัน</h1>'+
      '<p>ใช้บัญชีเดียวกันบนเครื่องอื่น เพื่อเปิดข้อมูลจากฐานกลางชุดเดียวกัน</p>'+
      '<form id="dsr-cloud-login-form"><label for="dsr-cloud-login-email">อีเมล</label><input id="dsr-cloud-login-email" name="email" type="email" autocomplete="username" required>'+
      '<label for="dsr-cloud-login-password">รหัสผ่าน DSR</label><input id="dsr-cloud-login-password" name="password" type="password" autocomplete="current-password" required>'+
      '<p class="dsr-cloud-note">ใช้รหัสที่ตั้งตอนสร้างผู้ใช้ DSR ไม่ใช่รหัส Gmail · ต้องเข้าสู่ระบบใหม่เมื่อเปิดหรือรีโหลดหน้านี้</p>'+
      '<button type="submit" id="dsr-cloud-login-submit">เข้าสู่ระบบ</button></form>'+
      '<section id="dsr-cloud-migration" hidden><h2>นำข้อมูลเดิมเข้าครั้งแรก</h2><p id="dsr-cloud-import-note"></p>'+
      '<div id="dsr-cloud-select-data"><label for="dsr-cloud-import-file">เลือกไฟล์ Backup JSON ล่าสุด</label><input id="dsr-cloud-import-file" type="file" accept=".json,application/json">'+
      '<button type="button" id="dsr-cloud-import-local" class="dsr-cloud-secondary">อ่านข้อมูลเดิมในเบราว์เซอร์นี้</button>'+
      '<p id="dsr-cloud-import-preview" role="status"></p><button type="button" id="dsr-cloud-confirm-import" disabled>ยืนยันนำเข้าข้อมูลชุดนี้</button></div></section>'+
      '<p id="dsr-cloud-message" role="status" aria-live="polite"></p>'+
      '<button type="button" id="dsr-cloud-back-local" class="dsr-cloud-secondary">กลับไปใช้ข้อมูลเดิมในเครื่อง</button></div>';
    document.body.appendChild(dialog);
    dialog.addEventListener('cancel',function(e){e.preventDefault();});
    document.getElementById('dsr-cloud-back-local').onclick=function(){root.dsrSwitchStorage('local');};
    document.getElementById('dsr-cloud-login-form').onsubmit=async function(e){
      e.preventDefault();if(loading)return;loading=true;error('กำลังเข้าสู่ระบบ…');render();
      var password=document.getElementById('dsr-cloud-login-password');
      try{var result=await sdk().signIn(document.getElementById('dsr-cloud-login-email').value,password.value);if(!result.isOk)error(result.error);else error('');}
      finally{password.value='';loading=false;render();}
    };
    document.getElementById('dsr-cloud-import-file').onchange=async function(e){
      try{var file=e.target.files[0];if(!file)return;if(file.size>8*1024*1024)throw new Error('ไฟล์ใหญ่เกิน 8 MB');await preview(JSON.parse(await file.text()));}
      catch(err){pendingImport=null;error(err.message);render();}finally{e.target.value='';}
    };
    document.getElementById('dsr-cloud-import-local').onclick=async function(){
      if(loading)return;loading=true;render();
      try{var local=root.createDSRLocal({mirrorFolder:false});var init=await local.init({onDataChanged:function(){}});if(!init.isOk)throw new Error(init.error);await preview(await local.exportBackup());}
      catch(err){pendingImport=null;error(err.message);}finally{loading=false;render();}
    };
    document.getElementById('dsr-cloud-confirm-import').onclick=async function(){
      if(!pendingImport||loading)return;loading=true;error('กำลังนำเข้า กรุณาอย่าปิดหน้านี้…');render();
      try{var result=await sdk().importBackup(new Blob([JSON.stringify(pendingImport)],{type:'application/json'}));
        if(!result.isOk)error(result.error);else{pendingImport=null;error('');root.renderPage();root.showToast('นำเข้าฐานกลางแล้ว · '+result.count+' รายการ');}}
      finally{loading=false;render();}
    };
    render();
    // A revision check only while idle. Never apply a background snapshot over drafts/forms.
    if(cloudMode)setInterval(async function(){
      if(document.visibilityState!=='visible'||!navigator.onLine||!state||!state.ready||state.empty||
          sdk().isBusy()||root.dsrHasPendingDraft()||document.querySelector('#main-content form'))return;
      var result=await sdk().refresh();if(result.isOk&&!result.unchanged)root.dsrRenderActionWhenIdle();
    },30000);
  });
})(window);
