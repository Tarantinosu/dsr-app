/* Supabase shared JSON adapter. Drafts remain in dsr-manual until explicit Save. */
(function(root){
  'use strict';
  var copy = function(x){return JSON.parse(JSON.stringify(x));};
  function validate(backup) {
    if (!backup || backup.format !== 'DSR_OFFLINE_BACKUP' || ![1,2].includes(backup.version) ||
        !Array.isArray(backup.records) || !backup.config || typeof backup.config !== 'object' || Array.isArray(backup.config))
      throw new Error('รูปแบบ JSON ไม่ถูกต้อง กรุณาใช้ไฟล์ Backup ของ DSR');
    if (backup.records.length > 10000) throw new Error('ข้อมูลเกิน 10,000 รายการ');
    var ids = new Set();
    backup.records.forEach(function(r){
      if (!r || typeof r !== 'object' || typeof r.__backendId !== 'string' || !r.__backendId.trim() ||
          ids.has(r.__backendId) || typeof r.record_type !== 'string' || !r.record_type.trim()) throw new Error('ข้อมูลมี ID ซ้ำหรือรายการไม่สมบูรณ์');
      ids.add(r.__backendId);
      if (r.record_type === 'quotation' && r.items_json && !Array.isArray(JSON.parse(r.items_json))) throw new Error('รายการใบเสนอราคาไม่ถูกต้อง');
    });
    var config = {};
    Object.keys(backup.config).forEach(function(k){if(k.indexOf('company_')===0)config[k]=backup.config[k];});
    var next = {format:'DSR_OFFLINE_BACKUP',version:2,exported_at:backup.exported_at || new Date().toISOString(),records:copy(backup.records),config:copy(config)};
    if (new TextEncoder().encode(JSON.stringify(next)).length > 8*1024*1024) throw new Error('JSON เกิน 8 MB กรุณาลดขนาดรูปบริษัทก่อน');
    return next;
  }
  function createCloud(options) {
    options = options || {};
    var client=options.client, handler=null, records=[], config={}, savedConfig={}, configVersion=0,
      version=0, role='', ready=false, active=false, lastError='', conflict=false, pendingIntent=null,
      loggedIn=false, email='', reservations=new Map(), counters=new Map();
    var files=options.fileTools;
    function state(){return {cloud:true,ready:ready,loginRequired:!loggedIn,email:email,role:role,version:version,
      empty:ready&&version===0,pending:active?1:0,failed:lastError?1:0,error:lastError,conflict:conflict,unknown:!!pendingIntent};}
    function emit(){if(options.onStatus)options.onStatus(state());}
    function publish(){if(options.setRecords)options.setRecords(copy(records));if(handler&&handler.onDataChanged)handler.onDataChanged(copy(records));emit();}
    function errorResult(error){
      var message=String(error && error.message || '');
      conflict=message.includes('DSR_VERSION_CONFLICT');
      if(conflict)lastError='เครื่องอื่นบันทึกข้อมูลใหม่แล้ว · ฉบับร่างยังอยู่ กรุณาดาวน์โหลดฉบับร่างก่อนโหลดข้อมูลล่าสุด';
      else if(message.includes('DSR_ACCESS_DENIED')){ready=false;lastError='บัญชีนี้ยังไม่มีสิทธิ์ใช้ข้อมูล DSR กรุณาติดต่อเจ้าของระบบ';}
      else if(message.includes('DSR_OWNER_REQUIRED'))lastError='เฉพาะเจ้าของระบบที่นำเข้าข้อมูลครั้งแรกได้';
      else if(message.includes('Invalid login credentials'))lastError='อีเมลหรือรหัสผ่านไม่ถูกต้อง';
      else if(message.includes('Email not confirmed'))lastError='บัญชียังไม่ได้ยืนยันอีเมล กรุณาตรวจใน Supabase Users';
      else if(error && (error.status===401 || error.code==='PGRST301')){loggedIn=false;ready=false;lastError='กรุณาเข้าสู่ระบบอีกครั้ง · ฉบับร่างยังอยู่';}
      else lastError=message.startsWith('DSR_')?'ข้อมูลไม่ผ่านการตรวจสอบ · ฉบับร่างยังอยู่':
        message && /JSON|รายการ|ID|ข้อมูลเกิน|MB|Backup/.test(message)?message:'เชื่อมต่อฐานกลางไม่สำเร็จ · ฉบับร่างยังอยู่ กดลองบันทึกอีกครั้งได้';
      return {isOk:false,error:lastError,conflict:conflict};
    }
    async function rpc(name,args){
      var result=await client.rpc(name,args);
      if(result.error)throw result.error;
      return result.data;
    }
    async function refresh(){
      if(active || pendingIntent || (options.hasPendingDraft&&options.hasPendingDraft())) return {isOk:false,error:'กรุณาบันทึกหรือสำรองฉบับร่างก่อนโหลดข้อมูลล่าสุด'};
      active=true;emit();
      try{
        var result=await rpc('dsr_read',{p_known_version:ready?version:-1});
        // Editing may have begun while the network request was in flight.
        if(options.hasPendingDraft&&options.hasPendingDraft())return {isOk:false,error:'มีฉบับร่างใหม่ จึงยังไม่โหลดข้อมูลมาทับ'};
        if(!result || !Number.isSafeInteger(result.version) || !['owner','editor'].includes(result.role) || typeof result.unchanged!=='boolean')throw new Error('DSR_BAD_RESPONSE');
        if(!result.unchanged){
          var data=result.version===0&&result.payload===null?{records:[],config:{}}:validate(result.payload);
          records=copy(data.records);config=copy(data.config);savedConfig=copy(config);configVersion++;version=result.version;
        }
        role=result.role;ready=true;lastError='';conflict=false;
        if(!result.unchanged)publish();
        return {isOk:true,count:records.length,unchanged:result.unchanged};
      }catch(error){return errorResult(error);}
      finally{active=false;emit();}
    }
    function snapshot(nextRecords,nextConfig){return {format:'DSR_OFFLINE_BACKUP',version:2,
      exported_at:new Date().toISOString(),records:copy(nextRecords),config:copy(nextConfig)};}
    function sameData(a,b){return JSON.stringify(a.records)===JSON.stringify(b.records)&&JSON.stringify(a.config)===JSON.stringify(b.config);}
    async function resolveIntent(){
      var intent=pendingIntent;
      var response=await rpc('dsr_save',{p_request_id:intent.id,p_expected_version:intent.expected,p_payload:intent.payload});
      if(!response || !Number.isSafeInteger(response.version) || response.version!==intent.expected+1)throw new Error('DSR_BAD_RESPONSE');
      records=copy(intent.payload.records);savedConfig=copy(intent.payload.config);version=response.version;
      // Preserve settings edited while the request was in flight.
      if(configVersion===intent.configVersion)config=copy(savedConfig);
      pendingIntent=null;lastError='';conflict=false;publish();
    }
    async function savePayload(payload){
      pendingIntent={id:root.crypto.randomUUID(),expected:version,payload:validate(payload),configVersion:configVersion};
      await resolveIntent();
    }
    async function commitOperations(operations){
      if(active)return {isOk:false,error:'กำลังบันทึก กรุณารอสักครู่'};
      if(!ready||!loggedIn)return {isOk:false,error:'กรุณาเข้าสู่ระบบก่อนบันทึก'};
      active=true;emit();
      try{
        if(pendingIntent)await resolveIntent();
        var next=new Map(records.map(function(r){return [r.__backendId,copy(r)];}));
        operations.forEach(function(op){
          if(!op.record || !op.record.__backendId || !['create','update','delete'].includes(op.action))throw new Error('DSR_INVALID_RECORDS');
          if(op.action==='delete')next.delete(op.record.__backendId);else next.set(op.record.__backendId,copy(op.record));
        });
        var payload=snapshot(Array.from(next.values()),config);
        if(!sameData(payload,{records:records,config:savedConfig}) || version===0)await savePayload(payload);
        return {isOk:true,saved:operations.length};
      }catch(error){
        // A definite database rejection has no unknown effect; drafts keep their original version.
        if(error.code && error.code!=='PGRST301')pendingIntent=null;
        return errorResult(error);
      }finally{active=false;emit();}
    }
    async function importBackup(file){
      if(!ready||role!=='owner')return {isOk:false,error:'กรุณาเข้าสู่ระบบด้วยบัญชีเจ้าของก่อนนำเข้า'};
      if(version!==0)return {isOk:false,error:'ฐานกลางมีข้อมูลแล้ว ไม่อนุญาตให้นำเข้าทับ กรุณาใช้ข้อมูลกลางที่มีอยู่'};
      if(active)return {isOk:false,error:'กำลังนำเข้าข้อมูล'};
      active=true;emit();
      try{
        var payload=validate(JSON.parse(await file.text()));
        if(!payload.records.length)throw new Error('Backup ไม่มีข้อมูล กรุณาเลือกชุดข้อมูลเดิม');
        if(pendingIntent){await resolveIntent();return {isOk:true,count:records.length};}
        config=copy(payload.config);configVersion++;
        await savePayload(payload);return {isOk:true,count:records.length};
      }catch(error){if(error.code)pendingIntent=null;return errorResult(error);}
      finally{active=false;emit();}
    }
    async function signIn(user,password){
      if(active)return {isOk:false,error:'กรุณารอสักครู่'};
      try{
        var result=await client.auth.signInWithPassword({email:user.trim(),password:password});
        if(result.error)throw result.error;
        loggedIn=true;email=result.data.user.email||user;lastError='';
        if(pendingIntent || (options.hasPendingDraft&&options.hasPendingDraft())) {
          // Re-authenticate without replacing the baseline underneath existing drafts.
          var access=await rpc('dsr_read',{p_known_version:version});
          if(!access||!Number.isSafeInteger(access.version)||!['owner','editor'].includes(access.role))throw new Error('DSR_BAD_RESPONSE');
          role=access.role;ready=true;
          if(access.version!==version&&!pendingIntent)errorResult({message:'DSR_VERSION_CONFLICT'});
          emit();return {isOk:true};
        }
        return await refresh();
      }catch(error){var failure=errorResult(error);emit();return failure;}
    }
    async function download(data,name){
      var url=root.URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
      var a=root.document.createElement('a');a.href=url;a.download=name;root.document.body.appendChild(a);a.click();a.remove();
      setTimeout(function(){root.URL.revokeObjectURL(url);},1000);return {isOk:true,count:data.records.length};
    }
    var api={
      isCloud:true, getCloudState:state, signIn:signIn,
      hasUnresolvedSave:function(){return !!pendingIntent;},
      init:async function(next){handler=next;var session=await client.auth.getSession();
        loggedIn=!!(session.data&&session.data.session);email=loggedIn?session.data.session.user.email:'';
        if(loggedIn)return refresh();emit();return {isOk:false,loginRequired:true};},
      signOut:async function(){
        if(active||pendingIntent||(options.hasPendingDraft&&options.hasPendingDraft()))return {isOk:false,error:'กรุณาบันทึกหรือดาวน์โหลดฉบับร่างก่อนออกจากระบบ'};
        var result=await client.auth.signOut({scope:'local'});if(result.error)return errorResult(result.error);
        ready=false;loggedIn=false;records=[];config={};savedConfig={};configVersion++;email='';publish();return {isOk:true};
      },
      refresh:refresh,commitOperations:commitOperations,importBackup:importBackup,
      isBusy:function(){return active;},
      getDeviceConfig:function(){return copy(config);},getDeviceConfigVersion:function(){return configVersion;},
      saveDeviceConfig:async function(next){var allowed={};Object.keys(next).forEach(function(k){if(k.startsWith('company_'))allowed[k]=next[k];});config=copy(allowed);configVersion++;return {isOk:true};},
      exportBackup:async function(){return snapshot(records,savedConfig);},
      downloadBackup:async function(){return download(await api.exportBackup(),'DSR_Cloud_Backup_'+new Date().toISOString().slice(0,10)+'.json');},
      downloadDraft:async function(nextRecords,nextConfig){return download(snapshot(nextRecords,nextConfig),'DSR_UNSAVED_DRAFT_'+new Date().toISOString().slice(0,10)+'.json');},
      reserveDocumentNumber:async function(prefix,field,id,suggested){
        var existing=records.find(function(r){return r.__backendId===id;});if(existing&&existing[field])return existing[field];
        var key=prefix+':'+id;if(reservations.has(key))return reservations.get(key);
        var max=Math.max(suggested||0,counters.get(prefix)||0);
        records.forEach(function(r){['doc_number','invoice_number','receipt_number'].forEach(function(k){var n=String(r[k]||'');if(n.startsWith(prefix+'-'))max=Math.max(max,parseInt(n.slice(prefix.length+1),10)||0);});});
        var number=prefix+'-'+String(max+1).padStart(3,'0');counters.set(prefix,max+1);reservations.set(key,number);return number;
      },
      jsonFileStatus:function(){return files?files.jsonFileStatus():Promise.resolve({configured:false,supported:false});},
      chooseJsonFile:function(){return files.chooseJsonFile();},disconnectJsonFile:function(){return files.disconnectJsonFile();},
      saveJsonFile:async function(){return files.saveJsonFile(await api.exportBackup());},
      getUrl:function(){return 'supabase://dsr-main';}
    };
    return api;
  }
  createCloud.validateBackup=validate;
  if(typeof module!=='undefined'&&module.exports)module.exports=createCloud;else root.createDSRSupabase=createCloud;
})(typeof window==='undefined'?globalThis:window);
