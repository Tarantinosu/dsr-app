/* In-memory editing layer. Only commitDrafts/flushGoogle may persist a draft. */
(function(root){
  'use strict';
  function copy(value){ return JSON.parse(JSON.stringify(value)); }
  function createDSRManual(factory, options){
    options=options||{};
    var durable=[], drafts=new Map(), aliases=new Map(), inflight=new Set(), version=0, handler=null, saving=null;
    function idOf(id){ var seen=new Set(); while(aliases.has(id)&&!seen.has(id)){seen.add(id);id=aliases.get(id);}return id; }
    function view(){
      var next=durable.slice(), positions=new Map(next.map(function(r,i){return [r.__backendId,i];}));
      drafts.forEach(function(op,id){
        var at=positions.get(id);
        if(op.action==='delete'){if(at!==undefined)next[at]=null;}
        else if(at!==undefined)next[at]=copy(op.record);
        else next.push(copy(op.record));
      });
      return next.filter(Boolean);
    }
    function publish(){
      var records=view();
      if(options.setRecords)options.setRecords(records);
      if(handler&&handler.onDataChanged)handler.onDataChanged(records);
      if(options.onDraftStatus)options.onDraftStatus(drafts.size,!!saving);
    }
    function remap(oldId,newId){
      oldId=idOf(oldId);aliases.set(oldId,newId);
      var op=drafts.get(oldId);
      if(op){drafts.delete(oldId);op.record.__backendId=newId;drafts.set(newId,op);}
      if(inflight.has(oldId)){inflight.delete(oldId);inflight.add(newId);}
    }
    var baseOptions=Object.assign({},options,{
      getRecords:function(){return durable;},
      setRecords:function(records){durable=copy(records);if(options.setRecords)options.setRecords(view());},
      hasPendingDraft:function(){return drafts.size>0||!!saving||(options.hasPendingDraft&&options.hasPendingDraft());},
      onRemap:remap
    });
    var base=factory(baseOptions);
    function stage(action,record){
      var payload=copy(record||{}), id=idOf(payload.__backendId);
      if(!id){id='local-'+(root.crypto&&root.crypto.randomUUID?root.crypto.randomUUID():Date.now()+'-'+Math.random().toString(36).slice(2));if(record)record.__backendId=id;}
      payload.__backendId=id;
      var previous=drafts.get(id);
      if(action==='delete'&&previous&&previous.action==='create'&&!inflight.has(id))drafts.delete(id);
      else drafts.set(id,{action:previous&&previous.action==='create'&&action!=='delete'?'create':action,record:payload,version:++version});
      publish();
      if(options.onStaged)options.onStaged(action,payload);
      return Promise.resolve({isOk:true,isDraft:true,__backendId:id,record:copy(payload),syncQueued:false});
    }
    function commitDrafts(){
      if(saving)return saving;
      var snapshot=Array.from(drafts.values()).map(copy);
      saving=(async function(){
        for(var i=0;i<snapshot.length;i++){
          var op=snapshot[i],id=idOf(op.record.__backendId);op.record.__backendId=id;
          inflight.add(id);
          var result;
          try{result=await base[op.action](op.record);}catch(error){result={isOk:false,error:error.message||'save-failed'};}
          id=idOf(id);inflight.delete(id);
          if(!result||!result.isOk)return result||{isOk:false,error:'save-failed'};
          var latest=drafts.get(id);
          if(latest&&latest.version===op.version)drafts.delete(id);
          else if(latest&&op.action==='create'&&latest.action==='create')latest.action='update';
        }
        return {isOk:true,saved:snapshot.length};
      })().finally(function(){saving=null;publish();});
      return saving;
    }
    var api=Object.assign({},base,{
      init:function(next){handler=next;return base.init({onDataChanged:function(records){durable=copy(records);publish();}});},
      create:function(r){return stage('create',r);},update:function(r){return stage('update',r);},delete:function(r){return stage('delete',r);},
      createLocal:function(r){return stage('create',r);},updateLocal:function(r){return stage('update',r);},deleteLocal:function(r){return stage('delete',r);},
      sendSavedToGoogle:function(){return base.flushGoogle();},
      resolveId:idOf,
      draftCount:function(){return drafts.size;},isSavingDrafts:function(){return !!saving;},commitDrafts:commitDrafts,
      flushGoogle:async function(){var result=await commitDrafts();return result&&result.isOk?base.flushGoogle():result;},
      getSyncInfo:async function(){var info=await base.getSyncInfo();return Object.assign({},info,{drafts:drafts.size});},
      refresh:function(){return drafts.size?Promise.resolve({isOk:false,error:'unsaved-changes'}):base.refresh();},
      syncNow:function(){return drafts.size?Promise.resolve({isOk:false,error:'unsaved-changes'}):base.syncNow();},
      importBackup:function(){return drafts.size?Promise.resolve({isOk:false,error:'unsaved-changes'}):base.importBackup.apply(base,arguments);},
      restoreFromStorageFolder:function(){return drafts.size?Promise.resolve({isOk:false,error:'unsaved-changes'}):base.restoreFromStorageFolder.apply(base,arguments);}
    });
    return api;
  }
  if(typeof module!=='undefined'&&module.exports)module.exports=createDSRManual;else root.createDSRManual=createDSRManual;
})(typeof window==='undefined'?globalThis:window);
