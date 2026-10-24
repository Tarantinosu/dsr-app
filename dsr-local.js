/* DSR Offline transport. Records stay on this computer and can be mirrored to a user-selected folder. */
(function (root) {
  'use strict';

  var DB_NAME = 'DSR_Offline_DB';
  var DB_VERSION = 2;
  var STORE_NAME = 'records';
  var META_STORE_NAME = 'meta';
  var LIVE_FILE_NAME = 'DSR_LIVE_DATA.json';
  var BACKUP_DIRECTORY_NAME = 'DSR_Backups';

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function makeId() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return 'local-' + root.crypto.randomUUID();
    return 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 12);
  }

  function openDatabase() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) {
        reject(new Error('เบราว์เซอร์นี้ไม่รองรับฐานข้อมูล Offline'));
        return;
      }
      var request = root.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          var store = db.createObjectStore(STORE_NAME, { keyPath: '__backendId' });
          store.createIndex('record_type', 'record_type', { unique: false });
          store.createIndex('project_id', 'project_id', { unique: false });
        }
        if (!db.objectStoreNames.contains(META_STORE_NAME)) {
          db.createObjectStore(META_STORE_NAME, { keyPath: 'key' });
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('เปิดฐานข้อมูลไม่ได้')); };
      request.onblocked = function () { reject(new Error('ฐานข้อมูลกำลังถูกใช้งานจากหน้าต่างอื่น กรุณาปิด DSR หน้าอื่นก่อน')); };
    });
  }

  function requestResult(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('ทำรายการฐานข้อมูลไม่สำเร็จ')); };
    });
  }

  function transactionDone(transaction) {
    return new Promise(function (resolve, reject) {
      transaction.oncomplete = function () { resolve(); };
      transaction.onerror = function () { reject(transaction.error || new Error('บันทึกฐานข้อมูลไม่สำเร็จ')); };
      transaction.onabort = function () { reject(transaction.error || new Error('ยกเลิกการบันทึกฐานข้อมูล')); };
    });
  }

  function createDSRLocal(options) {
    options = options || {};
    var handler = null;
    var databasePromise = null;
    var pending = 0;
    var reading = false;
    var lastError = null;
    var folderWriteActive = false;
    var folderSaveScheduled = false;
    var folderSaveTimer = null;
    var folderSaveChain = Promise.resolve();
    var folderLastError = null;
    var folderName = '';
    var directoryHandleCache = null;
    var deviceConfigCache = {};
    try { folderName = root.localStorage.getItem('DSR_storage_folder_name') || ''; } catch (ignore) {}
    var folderPermission = folderName ? 'prompt' : 'missing';

    function db() {
      if (!databasePromise) databasePromise = openDatabase();
      return databasePromise;
    }

    function emitStatus() {
      if (typeof options.onStatus === 'function') {
        options.onStatus({ pending: pending, reading: reading, failed: lastError ? 1 : 0,
          configured: true, error: !!lastError, uncertain: false, offline: true,
          folderSaving: folderWriteActive || folderSaveScheduled, folderConfigured: !!folderName,
          folderName: folderName, folderPermission: folderPermission,
          folderError: !!folderLastError });
      }
    }

    async function getAll() {
      var database = await db();
      var transaction = database.transaction(STORE_NAME, 'readonly');
      return requestResult(transaction.objectStore(STORE_NAME).getAll());
    }

    async function getMeta(key) {
      var database = await db();
      var transaction = database.transaction(META_STORE_NAME, 'readonly');
      return requestResult(transaction.objectStore(META_STORE_NAME).get(key));
    }

    async function setMeta(key, value) {
      var database = await db();
      var transaction = database.transaction(META_STORE_NAME, 'readwrite');
      transaction.objectStore(META_STORE_NAME).put({ key: key, value: value });
      await transactionDone(transaction);
    }

    async function deleteMeta(key) {
      var database = await db();
      var transaction = database.transaction(META_STORE_NAME, 'readwrite');
      transaction.objectStore(META_STORE_NAME).delete(key);
      await transactionDone(transaction);
    }

    async function loadDeviceConfig() {
      var stored = await getMeta('deviceConfig');
      if (stored && stored.value && typeof stored.value === 'object') {
        deviceConfigCache = clone(stored.value);
        return deviceConfigCache;
      }

      // Migrate older builds that kept images in localStorage. IndexedDB has a
      // much larger quota and does not fail when several document images exist.
      var legacy = {};
      try { legacy = JSON.parse(root.localStorage.getItem('DSR_config') || '{}'); } catch (ignore) {}
      ['company_logo_data','company_signature_data','company_stamp_data','company_payment_qr_data'].forEach(function (key) {
        if (legacy[key]) return;
        try { legacy[key] = root.localStorage.getItem('DSR_' + key) || ''; } catch (ignore) {}
      });
      deviceConfigCache = legacy && typeof legacy === 'object' ? clone(legacy) : {};
      if (Object.keys(deviceConfigCache).length) await setMeta('deviceConfig', deviceConfigCache);
      return deviceConfigCache;
    }

    async function saveDeviceConfig(config) {
      try {
        deviceConfigCache = clone(config && typeof config === 'object' ? config : {});
        await setMeta('deviceConfig', deviceConfigCache);
        scheduleLiveFolderSave();
        return { isOk: true, config: clone(deviceConfigCache) };
      } catch (error) {
        lastError = error;
        emitStatus();
        return { isOk: false, error: error.message || 'บันทึกการตั้งค่าในเครื่องไม่สำเร็จ' };
      }
    }

    function getDeviceConfig() {
      return clone(deviceConfigCache || {});
    }

    async function replaceAll(records) {
      var database = await db();
      var transaction = database.transaction(STORE_NAME, 'readwrite');
      var store = transaction.objectStore(STORE_NAME);
      store.clear();
      records.forEach(function (record) {
        var next = clone(record || {});
        if (!next.__backendId) next.__backendId = makeId();
        store.put(next);
      });
      await transactionDone(transaction);
    }

    function setMemory(records) {
      if (typeof options.setRecords === 'function') options.setRecords(clone(records));
    }

    function getMemory() {
      return typeof options.getRecords === 'function' ? options.getRecords() : [];
    }

    function upsert(records, record) {
      var next = records.slice();
      var index = next.findIndex(function (item) { return item.__backendId === record.__backendId; });
      if (index < 0) next.push(clone(record));
      else next[index] = clone(record);
      return next;
    }

    async function migrateLegacyCache() {
      var cached = [];
      try {
        cached = JSON.parse(root.localStorage.getItem('DSR_data') || '[]');
      } catch (error) { cached = []; }
      if (!Array.isArray(cached) || !cached.length) return [];
      cached = cached.map(function (record) {
        var next = clone(record || {});
        if (!next.__backendId) next.__backendId = makeId();
        return next;
      });
      await replaceAll(cached);
      return cached;
    }

    async function refresh() {
      if (pending || (options.hasPendingDraft && options.hasPendingDraft())) {
        return { isOk: false, error: 'unsaved-changes' };
      }
      reading = true;
      emitStatus();
      try {
        var records = await getAll();
        setMemory(records);
        if (handler && typeof handler.onDataChanged === 'function') handler.onDataChanged(clone(records));
        lastError = null;
        return { isOk: true, records: records };
      } catch (error) {
        lastError = error;
        return { isOk: false, error: error.message || 'local-database' };
      } finally {
        reading = false;
        emitStatus();
      }
    }

    async function write(action, record) {
      pending++;
      lastError = null;
      emitStatus();
      var payload = clone(record || {});
      if (!payload.__backendId) payload.__backendId = makeId();
      if (action === 'create' && record && typeof record === 'object') record.__backendId = payload.__backendId;
      try {
        var database = await db();
        var transaction = database.transaction(STORE_NAME, 'readwrite');
        var store = transaction.objectStore(STORE_NAME);
        if (action === 'delete') store.delete(payload.__backendId);
        else store.put(payload);
        await transactionDone(transaction);

        var records = getMemory();
        if (action === 'delete') {
          records = records.filter(function (item) { return item.__backendId !== payload.__backendId; });
        } else records = upsert(records, payload);
        setMemory(records);
        try { root.localStorage.setItem('DSR_data', JSON.stringify(records)); } catch (ignore) {}
        // Keep the app's in-memory model current without forcing a page change.
        // The page-level handler deliberately avoids re-rendering after the first
        // load, so forms keep their focus while payment previews can still read
        // the just-saved status/date immediately.
        if (handler && typeof handler.onDataChanged === 'function') handler.onDataChanged(clone(records));
        if (typeof options.onSaved === 'function') options.onSaved(action, clone(payload));
        scheduleLiveFolderSave();
        return { isOk: true, __backendId: payload.__backendId, record: clone(payload),
          folderSaveScheduled: !!folderName };
      } catch (error) {
        lastError = error;
        if (typeof options.onFailure === 'function') options.onFailure({ isOk: false, error: error.message || 'local-database' });
        return { isOk: false, error: error.message || 'local-database' };
      } finally {
        pending--;
        emitStatus();
      }
    }

    function cacheRecords(records) {
      try { root.localStorage.setItem('DSR_data', JSON.stringify(records)); }
      catch (ignore) { try { root.localStorage.removeItem('DSR_data'); } catch (ignoreRemove) {} }
    }

    // IndexedDB serializes read/write transactions across tabs. Reserve numbers
    // separately from drafts so abandoned documents can leave gaps, never duplicates.
    async function reserveDocumentNumber(prefix, field, recordId, suggestedMax) {
      var database = await db();
      var tx = database.transaction([STORE_NAME, META_STORE_NAME], 'readwrite');
      var done = transactionDone(tx);
      var recordsRequest = tx.objectStore(STORE_NAME).getAll();
      var meta = tx.objectStore(META_STORE_NAME);
      var counterRequest = meta.get('documentCounter:' + prefix);
      var ownerKey = 'documentReservation:' + prefix + ':' + recordId;
      var ownerRequest = meta.get(ownerKey);
      var result;
      var reservationError;
      var ready = 0;
      function collect() {
        if (++ready !== 3) return;
        try {
          var existing = (recordsRequest.result || []).find(function (r) { return r.__backendId === recordId; });
          if (existing && existing[field]) { result = existing[field]; return; }
          if (ownerRequest.result) { result = ownerRequest.result.value; return; }
          var maximum = Math.max(Number(suggestedMax) || 0, Number(counterRequest.result && counterRequest.result.value) || 0);
          (recordsRequest.result || []).forEach(function (r) {
            ['doc_number', 'invoice_number', 'receipt_number'].forEach(function (key) {
              var number = String(r[key] || '');
              if (number.indexOf(prefix + '-') === 0) maximum = Math.max(maximum, parseInt(number.slice(prefix.length + 1), 10) || 0);
            });
          });
          result = prefix + '-' + String(maximum + 1).padStart(3, '0');
          meta.put({ key: 'documentCounter:' + prefix, value: maximum + 1 });
          meta.put({ key: ownerKey, value: result });
        } catch (error) {
          reservationError = error;
          tx.abort();
        }
      }
      recordsRequest.onsuccess = collect;
      counterRequest.onsuccess = collect;
      ownerRequest.onsuccess = collect;
      await done.catch(function(error) { throw reservationError || error; });
      return result;
    }

    async function commitOperations(operations) {
      if (!operations.length) return { isOk: true, saved: 0 };
      pending++;
      emitStatus();
      try {
        var database = await db();
        var tx = database.transaction(STORE_NAME, 'readwrite');
        var done = transactionDone(tx);
        try {
          operations.forEach(function (operation) {
            var record = clone(operation.record);
            if (!record || !record.__backendId || ['create', 'update', 'delete'].indexOf(operation.action) < 0) throw new Error('ข้อมูลรายการบันทึกไม่ถูกต้อง');
            if (operation.action === 'delete') tx.objectStore(STORE_NAME).delete(record.__backendId);
            else tx.objectStore(STORE_NAME).put(record);
          });
        } catch (error) {
          tx.abort();
          await done.catch(function () {});
          throw error;
        }
        await done;
        var records = await getAll();
        setMemory(records);
        cacheRecords(records);
        if (handler && handler.onDataChanged) handler.onDataChanged(clone(records));
        lastError = null;
        scheduleLiveFolderSave();
        return { isOk: true, saved: operations.length };
      } catch (error) {
        lastError = error;
        return { isOk: false, error: error.message || 'local-database' };
      } finally {
        pending--;
        emitStatus();
      }
    }

    async function exportBackup() {
      var records = await getAll();
      var config = getDeviceConfig();
      if (!Object.keys(config).length) {
        try { config = JSON.parse(root.localStorage.getItem('DSR_config') || '{}'); } catch (ignore) {}
      }
      return {
        format: 'DSR_OFFLINE_BACKUP',
        version: 2,
        exported_at: new Date().toISOString(),
        storage_file: LIVE_FILE_NAME,
        records: records,
        config: config
      };
    }

    async function getDirectoryHandle() {
      if (directoryHandleCache) return directoryHandleCache;
      var meta = await getMeta('storageDirectory');
      directoryHandleCache = meta && meta.value ? meta.value : null;
      return directoryHandleCache;
    }

    async function directoryPermission(handle, requestAccess) {
      if (!handle) return 'missing';
      var permission = 'prompt';
      if (typeof handle.queryPermission === 'function') {
        permission = await handle.queryPermission({ mode: 'readwrite' });
      }
      if (permission !== 'granted' && requestAccess && typeof handle.requestPermission === 'function') {
        permission = await handle.requestPermission({ mode: 'readwrite' });
      }
      return permission;
    }

    async function writeJsonFile(directoryHandle, fileName, payload) {
      var fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
      var writable = await fileHandle.createWritable();
      try {
        await writable.write(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }));
        await writable.close();
      } catch (error) {
        try { if (typeof writable.abort === 'function') await writable.abort(); } catch (ignore) {}
        throw error;
      }
    }

    async function saveLiveToFolder(requestAccess, suppliedHandle, suppliedBackup) {
      var handle = suppliedHandle || null;
      if (!handle) {
        try { handle = await getDirectoryHandle(); }
        catch (error) {
          folderLastError = error;
          emitStatus();
          return { isOk: false, error: error.message || 'อ่านค่าโฟลเดอร์ไม่สำเร็จ' };
        }
      }
      if (!handle) return { isOk: false, notConfigured: true, error: 'ยังไม่ได้เลือกโฟลเดอร์จัดเก็บข้อมูล' };
      folderWriteActive = true;
      folderLastError = null;
      emitStatus();
      try {
        var permission = await directoryPermission(handle, !!requestAccess);
        folderPermission = permission;
        if (permission !== 'granted') {
          throw new Error(permission === 'denied' ? 'ไม่ได้รับอนุญาตให้เขียนไฟล์ในโฟลเดอร์นี้' : 'กรุณายืนยันสิทธิ์เข้าถึงโฟลเดอร์อีกครั้ง');
        }
        var backup = suppliedBackup || await exportBackup();
        await writeJsonFile(handle, LIVE_FILE_NAME, backup);
        folderName = handle.name || folderName || 'โฟลเดอร์ที่เลือก';
        var savedAt = new Date().toISOString();
        try {
          root.localStorage.setItem('DSR_storage_folder_name', folderName);
          root.localStorage.setItem('DSR_storage_last_saved_at', savedAt);
        } catch (ignore) {}
        folderLastError = null;
        return { isOk: true, count: backup.records.length, folderName: folderName, fileName: LIVE_FILE_NAME, savedAt: savedAt };
      } catch (error) {
        folderLastError = error;
        return { isOk: false, error: error.message || 'บันทึกลงโฟลเดอร์ไม่สำเร็จ' };
      } finally {
        folderWriteActive = false;
        emitStatus();
      }
    }

    function scheduleLiveFolderSave() {
      if (options.mirrorFolder === false) return;
      if (!folderName) return;
      folderSaveScheduled = true;
      emitStatus();
      if (folderSaveTimer) clearTimeout(folderSaveTimer);
      folderSaveTimer = setTimeout(function () {
        folderSaveTimer = null;
        folderSaveScheduled = false;
        emitStatus();
        folderSaveChain = folderSaveChain.catch(function () { return null; }).then(function () {
          return saveLiveToFolder(false);
        });
      }, 350);
    }

    async function chooseStorageFolder() {
      if (typeof root.showDirectoryPicker !== 'function') {
        return { isOk: false, unsupported: true, error: 'กรุณาใช้ Microsoft Edge หรือ Google Chrome เวอร์ชันล่าสุด' };
      }
      try {
        var handle = await root.showDirectoryPicker({ id: 'dsr-offline-storage', mode: 'readwrite', startIn: 'documents' });
        var permission = await directoryPermission(handle, true);
        folderPermission = permission;
        if (permission !== 'granted') throw new Error('ไม่ได้รับอนุญาตให้ใช้โฟลเดอร์นี้');
        await setMeta('storageDirectory', handle);
        directoryHandleCache = handle;
        folderName = handle.name || 'โฟลเดอร์ที่เลือก';
        try { root.localStorage.setItem('DSR_storage_folder_name', folderName); } catch (ignore) {}
        var saved = await saveLiveToFolder(false, handle);
        if (!saved.isOk) return saved;
        return { isOk: true, folderName: folderName, fileName: LIVE_FILE_NAME, count: saved.count, savedAt: saved.savedAt };
      } catch (error) {
        if (error && error.name === 'AbortError') return { isOk: false, cancelled: true };
        folderLastError = error;
        emitStatus();
        return { isOk: false, error: error.message || 'เลือกโฟลเดอร์ไม่สำเร็จ' };
      }
    }

    async function reconnectStorageFolder() {
      try {
        var handle = await getDirectoryHandle();
        if (!handle) return { isOk: false, notConfigured: true, error: 'กรุณาเลือกโฟลเดอร์ก่อน' };
        return saveLiveToFolder(true, handle);
      } catch (error) {
        folderLastError = error;
        emitStatus();
        return { isOk: false, error: error.message || 'เชื่อมต่อโฟลเดอร์ไม่สำเร็จ' };
      }
    }

    async function saveFolderSnapshot() {
      try {
        var handle = await getDirectoryHandle();
        if (!handle) return { isOk: false, notConfigured: true, error: 'กรุณาเลือกโฟลเดอร์ก่อน' };
        var permission = await directoryPermission(handle, true);
        if (permission !== 'granted') throw new Error('ไม่ได้รับอนุญาตให้เขียนไฟล์ในโฟลเดอร์นี้');
        var backup = await exportBackup();
        var liveResult = await saveLiveToFolder(false, handle, backup);
        if (!liveResult.isOk) return liveResult;
        var backupDirectory = await handle.getDirectoryHandle(BACKUP_DIRECTORY_NAME, { create: true });
        var now = new Date();
        var stamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') + '_' + String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0') + String(now.getSeconds()).padStart(2, '0');
        var fileName = 'DSR_Backup_' + stamp + '.json';
        await writeJsonFile(backupDirectory, fileName, backup);
        return { isOk: true, count: backup.records.length, folderName: folderName, fileName: BACKUP_DIRECTORY_NAME + '/' + fileName, savedAt: liveResult.savedAt };
      } catch (error) {
        folderLastError = error;
        emitStatus();
        return { isOk: false, error: error.message || 'สร้าง Backup ในโฟลเดอร์ไม่สำเร็จ' };
      }
    }

    async function disconnectStorageFolder() {
      try {
        if (folderSaveTimer) clearTimeout(folderSaveTimer);
        folderSaveTimer = null;
        folderSaveScheduled = false;
        await deleteMeta('storageDirectory');
        directoryHandleCache = null;
        folderName = '';
        folderPermission = 'missing';
        folderLastError = null;
        try {
          root.localStorage.removeItem('DSR_storage_folder_name');
          root.localStorage.removeItem('DSR_storage_last_saved_at');
        } catch (ignore) {}
        emitStatus();
        return { isOk: true };
      } catch (error) {
        return { isOk: false, error: error.message || 'ยกเลิกโฟลเดอร์ไม่สำเร็จ' };
      }
    }

    async function storageFolderInfo() {
      var supported = typeof root.showDirectoryPicker === 'function';
      var lastSavedAt = '';
      try { lastSavedAt = root.localStorage.getItem('DSR_storage_last_saved_at') || ''; } catch (ignore) {}
      try {
        var handle = await getDirectoryHandle();
        if (!handle) {
          folderPermission = 'missing';
          return { supported: supported, configured: false, name: folderName, permission: 'missing', lastSavedAt: lastSavedAt, fileName: LIVE_FILE_NAME };
        }
        folderName = handle.name || folderName;
        var permission = await directoryPermission(handle, false);
        folderPermission = permission;
        return { supported: supported, configured: true, name: folderName, permission: permission, lastSavedAt: lastSavedAt, fileName: LIVE_FILE_NAME, error: folderLastError ? folderLastError.message : '' };
      } catch (error) {
        folderPermission = 'error';
        return { supported: supported, configured: !!folderName, name: folderName, permission: 'error', lastSavedAt: lastSavedAt, fileName: LIVE_FILE_NAME, error: error.message || 'อ่านสถานะโฟลเดอร์ไม่สำเร็จ' };
      }
    }

    async function downloadBackup() {
      var backup = await exportBackup();
      var blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      var now = new Date();
      var stamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') + '_' + String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
      link.href = url;
      link.download = 'DSR_Offline_Backup_' + stamp + '.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      return { isOk: true, count: backup.records.length };
    }

    async function applyBackupObject(backup) {
      if (!backup || backup.format !== 'DSR_OFFLINE_BACKUP' || !Array.isArray(backup.records)) {
        throw new Error('รูปแบบไฟล์ Backup ไม่ถูกต้อง');
      }
      if (backup.version != null && backup.version !== 1 && backup.version !== 2) throw new Error('ไม่รองรับรุ่นไฟล์ Backup นี้');
      var ids = new Set();
      var records = backup.records.map(function (record) {
        if (!record || typeof record !== 'object' || Array.isArray(record) ||
            typeof record.__backendId !== 'string' || !record.__backendId.trim() ||
            typeof record.record_type !== 'string' || !record.record_type.trim() || ids.has(record.__backendId)) {
          throw new Error('รายการใน Backup ไม่ถูกต้องหรือมีรหัสซ้ำ · ข้อมูลเดิมยังไม่ถูกเปลี่ยน');
        }
        ids.add(record.__backendId);
        if (record.record_type === 'quotation' && record.items_json != null) {
          var items;
          try { items = JSON.parse(record.items_json); } catch (ignore) {}
          if (!Array.isArray(items)) throw new Error('รายการใบเสนอราคาใน Backup ไม่ถูกต้อง');
        }
        return clone(record);
      });
      if (backup.config != null && (typeof backup.config !== 'object' || Array.isArray(backup.config))) throw new Error('ค่าบริษัทใน Backup ไม่ถูกต้อง');
      var config = backup.config == null ? null : clone(backup.config);
      var database = await db();
      var tx = database.transaction([STORE_NAME, META_STORE_NAME], 'readwrite');
      var done = transactionDone(tx);
      try {
        var store = tx.objectStore(STORE_NAME);
        store.clear();
        records.forEach(function (record) { store.put(record); });
        if (config) tx.objectStore(META_STORE_NAME).put({ key: 'deviceConfig', value: config });
      } catch (error) {
        tx.abort();
        await done.catch(function () {});
        throw error;
      }
      await done;
      if (config) {
        deviceConfigCache = clone(config);
        var compactConfig = clone(config);
        ['company_logo_data','company_signature_data','company_stamp_data','company_payment_qr_data'].forEach(function (key) { delete compactConfig[key]; });
        try { root.localStorage.setItem('DSR_config', JSON.stringify(compactConfig)); } catch (ignore) {}
        if (root.elementSdk) root.elementSdk.config = clone(config);
      }
      cacheRecords(records);
      setMemory(records);
      if (handler && typeof handler.onDataChanged === 'function') handler.onDataChanged(clone(records));
      lastError = null;
      return records;
    }

    async function importBackup(file) {
      try {
        if (!file) throw new Error('กรุณาเลือกไฟล์ Backup');
        var raw = await file.text();
        var backup = JSON.parse(raw);
        var records = await applyBackupObject(backup);
        if (options.mirrorFolder !== false) await saveLiveToFolder(false);
        emitStatus();
        return { isOk: true, count: records.length };
      } catch (error) {
        lastError = error;
        emitStatus();
        return { isOk: false, error: error.message || 'นำเข้า Backup ไม่สำเร็จ' };
      }
    }

    async function restoreFromStorageFolder() {
      try {
        var handle = await getDirectoryHandle();
        if (!handle) return { isOk: false, notConfigured: true, error: 'กรุณาเลือกโฟลเดอร์ก่อน' };
        var permission = await directoryPermission(handle, true);
        if (permission !== 'granted') throw new Error('ไม่ได้รับอนุญาตให้อ่านไฟล์ในโฟลเดอร์นี้');
        var fileHandle = await handle.getFileHandle(LIVE_FILE_NAME);
        var file = await fileHandle.getFile();
        var backup = JSON.parse(await file.text());
        var records = await applyBackupObject(backup);
        folderLastError = null;
        emitStatus();
        return { isOk: true, count: records.length, folderName: folderName, fileName: LIVE_FILE_NAME };
      } catch (error) {
        folderLastError = error;
        emitStatus();
        return { isOk: false, error: error.message || 'กู้ข้อมูลจากโฟลเดอร์ไม่สำเร็จ' };
      }
    }

    async function storageInfo() {
      var result = { count: (await getAll()).length, usage: 0, quota: 0, persisted: false, folder: await storageFolderInfo() };
      if (root.navigator && root.navigator.storage) {
        try {
          var estimate = await root.navigator.storage.estimate();
          result.usage = estimate.usage || 0;
          result.quota = estimate.quota || 0;
          if (root.navigator.storage.persisted) result.persisted = await root.navigator.storage.persisted();
        } catch (ignore) {}
      }
      return result;
    }

    async function replaceFromSync(records) {
      try {
        var nextRecords = (Array.isArray(records) ? records : []).map(function (record) {
          var next = clone(record || {});
          if (!next.__backendId) next.__backendId = makeId();
          return next;
        });
        await replaceAll(nextRecords);
        try { root.localStorage.setItem('DSR_data', JSON.stringify(nextRecords)); } catch (ignore) {}
        setMemory(nextRecords);
        if (handler && typeof handler.onDataChanged === 'function') handler.onDataChanged(clone(nextRecords));
        scheduleLiveFolderSave();
        lastError = null;
        emitStatus();
        return { isOk: true, count: nextRecords.length };
      } catch (error) {
        lastError = error;
        emitStatus();
        return { isOk: false, error: error.message || 'รวมข้อมูล Google ไม่สำเร็จ' };
      }
    }

    async function remapBackendId(oldId, newId) {
      if (!oldId || !newId || oldId === newId) return { isOk: true };
      try {
        var database = await db();
        var readTransaction = database.transaction(STORE_NAME, 'readonly');
        var current = await requestResult(readTransaction.objectStore(STORE_NAME).get(oldId));
        if (!current) return { isOk: true, missing: true };
        var next = clone(current);
        next.__backendId = newId;
        var writeTransaction = database.transaction(STORE_NAME, 'readwrite');
        var store = writeTransaction.objectStore(STORE_NAME);
        store.delete(oldId);
        store.put(next);
        await transactionDone(writeTransaction);
        var records = getMemory().map(function (record) {
          return record.__backendId === oldId ? clone(next) : record;
        });
        setMemory(records);
        try { root.localStorage.setItem('DSR_data', JSON.stringify(records)); } catch (ignore) {}
        if (handler && typeof handler.onDataChanged === 'function') handler.onDataChanged(clone(records));
        scheduleLiveFolderSave();
        return { isOk: true, record: next };
      } catch (error) {
        return { isOk: false, error: error.message || 'อัปเดตรหัสข้อมูลไม่สำเร็จ' };
      }
    }

    return {
      init: async function (nextHandler) {
        handler = nextHandler;
        emitStatus();
        try {
          if (root.navigator && root.navigator.storage && root.navigator.storage.persist) {
            try { await root.navigator.storage.persist(); } catch (ignore) {}
          }
          var records = await getAll();
          if (!records.length) records = await migrateLegacyCache();
          await loadDeviceConfig();
          setMemory(records);
          handler.onDataChanged(clone(records));
          var folderInfo = await storageFolderInfo();
          if (options.mirrorFolder !== false && folderInfo.configured && folderInfo.permission === 'granted') {
            await saveLiveToFolder(false);
          }
          lastError = null;
          emitStatus();
          return { isOk: true };
        } catch (error) {
          lastError = error;
          emitStatus();
          return { isOk: false, error: error.message || 'local-database' };
        }
      },
      create: function (record) { return write('create', record); },
      update: function (record) { return write('update', record); },
      delete: function (record) { return write('delete', record); },
      createLocal: function (record) { return write('create', record); },
      updateLocal: function (record) { return write('update', record); },
      deleteLocal: function (record) { return write('delete', record); },
      flushGoogle: function () { return Promise.resolve({ isOk: false, error: 'not-configured', offline: true }); },
      refresh: refresh,
      getUrl: function () { return folderName ? 'local-folder://' + folderName + '/' + LIVE_FILE_NAME : 'local://indexeddb'; },
      setUrl: function () { return Promise.resolve({ isOk: true, offline: true }); },
      isBusy: function () { return pending > 0 || reading || folderWriteActive || folderSaveScheduled; },
      retryUpdates: function () { return Promise.resolve([]); },
      commitOperations: commitOperations,
      reserveDocumentNumber: reserveDocumentNumber,
      exportBackup: exportBackup,
      downloadBackup: downloadBackup,
      importBackup: importBackup,
      storageInfo: storageInfo,
      chooseStorageFolder: chooseStorageFolder,
      reconnectStorageFolder: reconnectStorageFolder,
      saveFolderSnapshot: saveFolderSnapshot,
      restoreFromStorageFolder: restoreFromStorageFolder,
      disconnectStorageFolder: disconnectStorageFolder,
      storageFolderInfo: storageFolderInfo,
      saveLiveToFolder: function () { return saveLiveToFolder(true); },
      saveDeviceConfig: saveDeviceConfig,
      getDeviceConfig: getDeviceConfig,
      replaceFromSync: replaceFromSync,
      remapBackendId: remapBackendId
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = createDSRLocal;
  else root.createDSRLocal = createDSRLocal;
})(typeof window === 'undefined' ? this : window);
