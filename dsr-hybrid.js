/* DSR Hybrid transport: edit locally first, then synchronize Google Apps Script on an explicit Save. */
(function (root) {
  'use strict';

  var QUEUE_DB_NAME = 'DSR_Hybrid_Sync_DB';
  var QUEUE_DB_VERSION = 1;
  var QUEUE_STORE = 'operations';

  function copy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function openQueueDatabase() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) return reject(new Error('เบราว์เซอร์นี้ไม่รองรับคิว Offline'));
      var request = root.indexedDB.open(QUEUE_DB_NAME, QUEUE_DB_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(QUEUE_STORE)) {
          var store = db.createObjectStore(QUEUE_STORE, { keyPath: 'seq', autoIncrement: true });
          store.createIndex('localId', 'localId', { unique: false });
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('เปิดคิวซิงก์ไม่ได้')); };
    });
  }

  function requestResult(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('อ่านคิวซิงก์ไม่ได้')); };
    });
  }

  function transactionDone(transaction) {
    return new Promise(function (resolve, reject) {
      transaction.oncomplete = function () { resolve(); };
      transaction.onerror = function () { reject(transaction.error || new Error('บันทึกคิวซิงก์ไม่ได้')); };
      transaction.onabort = function () { reject(transaction.error || new Error('ยกเลิกคิวซิงก์')); };
    });
  }

  function createDSRHybrid(options) {
    options = options || {};
    var fetcher = options.fetch || (root.fetch ? root.fetch.bind(root) : null);
    var storage = options.storage || root.localStorage;
    var handler = null;
    var queueDatabasePromise = null;
    var localStatus = {};
    var queueCount = 0;
    var syncActive = false;
    var syncError = '';
    var syncErrorCode = '';
    var syncErrorDetail = '';
    var syncErrorAt = '';
    var syncUncertain = false;
    var syncTimer = null;
    var heartbeatTimer = null;
    var syncPromise = null;
    var pullRequested = false;
    var lastSyncAt = '';
    var url = '';
    var syncEnabled = false;
    var transportMode = 'direct';

    try {
      url = storage.getItem('DSR_script_url') || '';
      var enabledValue = storage.getItem('DSR_google_sync_enabled');
      syncEnabled = enabledValue == null ? !!url : enabledValue === 'true';
      lastSyncAt = storage.getItem('DSR_google_last_sync_at') || '';
    } catch (ignore) {}

    var localOptions = {};
    Object.keys(options).forEach(function (key) { localOptions[key] = options[key]; });
    localOptions.onStatus = function (state) {
      localStatus = state || {};
      emitStatus();
    };
    var local = root.createDSRLocal(localOptions);

    function isLocalDesktop() {
      if (!root.location) return false;
      return root.location.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/i.test(root.location.hostname || '');
    }

    function utf8Base64(value) {
      var bytes = new TextEncoder().encode(String(value || ''));
      var binary = '';
      for (var offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
      }
      return root.btoa(binary);
    }

    async function remoteFetch(target, method, body, signal) {
      if (!isLocalDesktop()) {
        transportMode = 'direct';
        return fetcher(target, {
          method: method,
          headers: method === 'POST' ? { 'Content-Type': 'text/plain;charset=utf-8' } : undefined,
          body: method === 'POST' ? body : undefined,
          redirect: 'follow',
          cache: method === 'GET' ? 'no-store' : undefined,
          signal: signal
        });
      }

      // The local DSR launcher forwards Apps Script traffic. This avoids browser
      // cross-origin blocks on Windows while the actual data still goes only to
      // the user's configured Google Apps Script deployment.
      transportMode = 'local-proxy';
      var form = 'target_b64=' + encodeURIComponent(utf8Base64(target)) +
        '&method=' + encodeURIComponent(method) +
        (method === 'POST' ? '&body_b64=' + encodeURIComponent(utf8Base64(body)) : '');
      return fetcher('/__dsr_google_proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: form,
        cache: 'no-store',
        signal: signal
      });
    }

    function cleanDetail(value) {
      return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
    }

    async function parseRemoteResponse(response) {
      var raw = await response.text();
      var parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch (ignore) {}
      if (!response.ok) {
        return { isOk: false, error: (parsed && parsed.error) || ('http-' + response.status),
          detail: cleanDetail((parsed && parsed.detail) || raw || ('HTTP ' + response.status)), httpStatus: response.status };
      }
      if (!parsed) {
        var looksLikeLogin = /accounts\.google\.com|ServiceLogin|sign in/i.test(raw);
        return { isOk: false, error: looksLikeLogin ? 'google-login-required' : 'invalid-json',
          detail: looksLikeLogin ? 'Apps Script ขอให้เข้าสู่ระบบ Google' : 'Apps Script ไม่ได้ตอบกลับเป็น JSON' };
      }
      if (Array.isArray(parsed)) parsed = { isOk: true, records: parsed };
      if (!parsed.isOk && (parsed.ok === true || parsed.success === true || parsed.status === 'success')) parsed.isOk = true;
      if (parsed.isOk && !parsed.__backendId && parsed.id) parsed.__backendId = parsed.id;
      if (!parsed.isOk) return { isOk: false, error: parsed.error || 'save-failed', detail: cleanDetail(parsed.detail || parsed.message || '') };
      return parsed;
    }

    function describeSyncError(result) {
      var code = result && result.error || 'connection';
      if (result && result.offline || code === 'offline') return 'ไม่มีอินเทอร์เน็ต · เก็บคิวไว้ในเครื่องแล้ว';
      if (code === 'timeout') return 'Google ตอบช้าเกินไป · เก็บคิวไว้ในเครื่องแล้ว';
      if (code === 'proxy-failed') return 'ตัวส่ง Google บนเครื่องเชื่อมต่อไม่สำเร็จ';
      if (code === 'proxy-invalid-target' || code === 'invalid-url') return 'URL Apps Script ไม่ถูกต้อง';
      if (code === 'google-login-required' || code === 'http-401' || code === 'http-403') return 'Apps Script ยังไม่อนุญาตให้โปรแกรมเข้าถึง';
      if (code === 'http-404') return 'ไม่พบ Apps Script Deployment นี้';
      if (code === 'invalid-json') return 'Apps Script ตอบกลับผิดรูปแบบ';
      if (code === 'missing-id') return 'Apps Script ไม่ส่งรหัสรายการกลับมา';
      if (isMissingRecord(result)) return 'ไม่พบรายการเดิมบน Google · ระบบจะสร้างรายการใหม่ให้อัตโนมัติ';
      return 'Google Sync ยังไม่สำเร็จ';
    }

    function isMissingRecord(result) {
      var message = String(result && result.error || '') + ' ' + String(result && result.detail || '');
      return /record\s+not\s+found|ไม่พบรายการ/i.test(message);
    }

    function rememberSyncError(result) {
      syncErrorCode = result && result.error || 'connection';
      syncErrorDetail = cleanDetail(result && result.detail || '');
      syncErrorAt = new Date().toISOString();
      syncError = describeSyncError(result || {});
    }

    function clearSyncError() {
      syncError = '';
      syncErrorCode = '';
      syncErrorDetail = '';
      syncErrorAt = '';
    }

    function queueDb() {
      if (!queueDatabasePromise) queueDatabasePromise = openQueueDatabase();
      return queueDatabasePromise;
    }

    function emitStatus() {
      if (typeof options.onStatus !== 'function') return;
      var state = {};
      Object.keys(localStatus || {}).forEach(function (key) { state[key] = localStatus[key]; });
      state.syncEnabled = syncEnabled;
      state.syncConfigured = !!url;
      state.syncPending = queueCount;
      state.syncActive = syncActive;
      state.syncError = !!syncError;
      state.syncErrorMessage = syncError;
      state.syncErrorCode = syncErrorCode;
      state.syncErrorDetail = syncErrorDetail;
      state.syncErrorAt = syncErrorAt;
      state.syncUncertain = syncUncertain;
      state.syncLastAt = lastSyncAt;
      state.syncTransport = transportMode;
      options.onStatus(state);
    }

    async function listOperations() {
      var database = await queueDb();
      var transaction = database.transaction(QUEUE_STORE, 'readonly');
      var rows = await requestResult(transaction.objectStore(QUEUE_STORE).getAll());
      return (rows || []).sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
    }

    async function updateQueueCount() {
      var database = await queueDb();
      var transaction = database.transaction(QUEUE_STORE, 'readonly');
      queueCount = Number(await requestResult(transaction.objectStore(QUEUE_STORE).count())) || 0;
      emitStatus();
      return queueCount;
    }

    async function putOperation(operation) {
      var database = await queueDb();
      var transaction = database.transaction(QUEUE_STORE, 'readwrite');
      transaction.objectStore(QUEUE_STORE).put(operation);
      await transactionDone(transaction);
    }

    async function addOperation(operation) {
      var database = await queueDb();
      var transaction = database.transaction(QUEUE_STORE, 'readwrite');
      transaction.objectStore(QUEUE_STORE).add(operation);
      await transactionDone(transaction);
    }

    async function deleteOperation(seq) {
      var database = await queueDb();
      var transaction = database.transaction(QUEUE_STORE, 'readwrite');
      transaction.objectStore(QUEUE_STORE).delete(seq);
      await transactionDone(transaction);
    }

    async function deleteOperations(sequences) {
      if (!sequences.length) return;
      var database = await queueDb();
      var transaction = database.transaction(QUEUE_STORE, 'readwrite');
      var store = transaction.objectStore(QUEUE_STORE);
      sequences.forEach(function (seq) { store.delete(seq); });
      await transactionDone(transaction);
    }

    async function enqueue(action, record) {
      if (!syncEnabled || !url) return { isOk: true, queued: false };
      var payload = copy(record || {});
      var localId = payload.__backendId || '';
      var now = new Date().toISOString();

      if (!syncActive && localId) {
        var operations = await listOperations();
        var matching = operations.filter(function (item) { return item.localId === localId; });
        if (action === 'update' && matching.length) {
          var latest = matching[matching.length - 1];
          if (latest.action === 'create' || latest.action === 'update') {
            latest.record = payload;
            latest.updatedAt = now;
            latest.error = '';
            latest.uncertain = false;
            await putOperation(latest);
            await updateQueueCount();
            scheduleSync();
            return { isOk: true, queued: true, coalesced: true };
          }
        }
        if (action === 'delete' && matching.length) {
          var pendingCreate = matching.find(function (item) { return item.action === 'create'; });
          if (pendingCreate) {
            await deleteOperations(matching.map(function (item) { return item.seq; }));
            await updateQueueCount();
            return { isOk: true, queued: false, cancelledCreate: true };
          }
          await deleteOperations(matching.filter(function (item) { return item.action === 'update'; }).map(function (item) { return item.seq; }));
        }
      }

      await addOperation({
        action: action,
        localId: localId,
        record: payload,
        createdAt: now,
        updatedAt: now,
        attempts: 0,
        error: '',
        uncertain: false
      });
      await updateQueueCount();
      scheduleSync();
      return { isOk: true, queued: true };
    }

    function scheduleSync(delay) {
      if (!syncEnabled || !url) return;
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = setTimeout(function () {
        syncTimer = null;
        syncNow(false);
      }, typeof delay === 'number' ? delay : 1500);
    }

    async function apiRequest(body) {
      if (!url) return { isOk: false, error: 'not-configured' };
      if (!fetcher) return { isOk: false, error: 'fetch-unavailable' };
      if (root.navigator && root.navigator.onLine === false) return { isOk: false, error: 'offline', offline: true };
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, 35000) : null;
      try {
        var response = await remoteFetch(url, 'POST', JSON.stringify(body), controller ? controller.signal : undefined);
        return await parseRemoteResponse(response);
      } catch (error) {
        return { isOk: false, error: error && error.name === 'AbortError' ? 'timeout' : 'connection',
          detail: cleanDetail(error && error.message || ''), uncertain: true };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    async function fetchServerRecords() {
      if (!url) return { isOk: false, error: 'not-configured' };
      if (!fetcher) return { isOk: false, error: 'fetch-unavailable' };
      if (root.navigator && root.navigator.onLine === false) return { isOk: false, error: 'offline', offline: true };
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, 35000) : null;
      try {
        var target = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'action=read&_=' + Date.now();
        var response = await remoteFetch(target, 'GET', '', controller ? controller.signal : undefined);
        var result = await parseRemoteResponse(response);
        if (!result.isOk) return result;
        if (!Array.isArray(result.records)) return { isOk: false, error: 'invalid-records', detail: 'ไม่พบ records ในคำตอบของ Apps Script' };
        return { isOk: true, records: result.records };
      } catch (error) {
        return { isOk: false, error: error && error.name === 'AbortError' ? 'timeout' : 'connection',
          detail: cleanDetail(error && error.message || '') };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    async function remapQueuedIds(oldId, newId) {
      if (!oldId || !newId || oldId === newId) return;
      var operations = await listOperations();
      var affected = operations.filter(function (item) { return item.localId === oldId; });
      for (var index = 0; index < affected.length; index++) {
        affected[index].localId = newId;
        if (affected[index].record) affected[index].record.__backendId = newId;
        await putOperation(affected[index]);
      }
    }

    async function sendOperation(operation) {
      var body;
      if (operation.action === 'delete') {
        body = { action: 'delete', id: operation.localId };
      } else {
        var outgoing = copy(operation.record || {});
        if (operation.action === 'create') {
          outgoing.client_sync_id = outgoing.client_sync_id || operation.localId;
          delete outgoing.__backendId;
        }
        body = { action: operation.action, record: outgoing };
      }

      var result = await apiRequest(body);

      // A stale local queue can refer to a row that was removed or replaced on
      // Google. Deleting it is already complete; updating it is repaired by
      // creating a fresh row and remapping every later queued operation.
      if (!result.isOk && operation.action === 'delete' && isMissingRecord(result)) {
        return { isOk: true, alreadyDeleted: true };
      }

      if (!result.isOk && operation.action === 'update' && isMissingRecord(result)) {
        var recreated = copy(operation.record || {});
        recreated.client_sync_id = recreated.client_sync_id || operation.localId;
        delete recreated.__backendId;
        var createResult = await apiRequest({ action: 'create', record: recreated });
        if (!createResult.isOk) return createResult;
        if (!createResult.__backendId) return { isOk: false, error: 'missing-id', uncertain: true };
        await local.remapBackendId(operation.localId, createResult.__backendId);
        await remapQueuedIds(operation.localId, createResult.__backendId);
        createResult.recreated = true;
        return createResult;
      }

      if (!result.isOk) return result;

      if (operation.action === 'create') {
        if (!result.__backendId) return { isOk: false, error: 'missing-id', uncertain: true };
        var originalLocalId = operation.localId;
        if (result.__backendId !== operation.localId) {
          await local.remapBackendId(operation.localId, result.__backendId);
          await remapQueuedIds(operation.localId, result.__backendId);
        }
        // The Apps Script can enrich a newly-created project with its Google
        // Drive folder ID/URL. Merge that authoritative record back into the
        // local database immediately so the Drive button appears without a
        // manual refresh.
        if (result.record && typeof result.record === 'object') {
          var enriched = copy(result.record);
          enriched.__backendId = result.__backendId;
          await local.update(enriched);
          if (originalLocalId !== result.__backendId) {
            await remapQueuedIds(originalLocalId, result.__backendId);
          }
        }
      }
      return result;
    }

    async function processQueue() {
      while (syncEnabled && url) {
        if (root.navigator && root.navigator.onLine === false) {
          rememberSyncError({ error: 'offline', offline: true });
          break;
        }
        var operations = await listOperations();
        queueCount = operations.length;
        emitStatus();
        if (!operations.length) break;

        var operation = operations[0];
        if (operation.action === 'create' && operation.uncertain) {
          syncError = 'รายการใหม่อาจส่งถึง Google แล้ว · กดตรวจสอบการซิงก์';
          syncErrorCode = 'uncertain-create';
          syncErrorDetail = 'ระบบหยุดส่งซ้ำเพื่อป้องกันรายการซ้ำ';
          syncErrorAt = new Date().toISOString();
          syncUncertain = true;
          break;
        }
        var result = await sendOperation(operation);
        if (!result.isOk) {
          operation.attempts = (operation.attempts || 0) + 1;
          operation.error = result.error || 'sync-failed';
          operation.errorDetail = cleanDetail(result.detail || '');
          operation.uncertain = !!result.uncertain;
          operation.updatedAt = new Date().toISOString();
          await putOperation(operation);
          rememberSyncError(result);
          syncUncertain = !!result.uncertain && operation.action === 'create';
          if (!syncUncertain && !result.offline) scheduleSync(Math.min(30000, 3000 * operation.attempts));
          break;
        }

        await deleteOperation(operation.seq);
        queueCount = Math.max(0, queueCount - 1);
        clearSyncError();
        syncUncertain = false;
        lastSyncAt = new Date().toISOString();
        try { storage.setItem('DSR_google_last_sync_at', lastSyncAt); } catch (ignore) {}
        emitStatus();
      }
      await updateQueueCount();
      return { isOk: !syncError, pending: queueCount, error: syncErrorCode || syncError,
        message: syncError, detail: syncErrorDetail };
    }

    function applyOperations(records, operations) {
      var next = (records || []).map(copy);
      operations.forEach(function (operation) {
        var id = operation.localId || (operation.record && operation.record.__backendId);
        if (operation.action === 'delete') {
          next = next.filter(function (item) { return item.__backendId !== id; });
          return;
        }
        var record = copy(operation.record || {});
        if (!record.__backendId) record.__backendId = id;
        var index = next.findIndex(function (item) { return item.__backendId === record.__backendId; });
        if (index < 0) next.push(record); else next[index] = record;
      });
      return next;
    }

    async function queueLocalOnlyRecords(serverRecords) {
      var serverIds = new Set((serverRecords || []).map(function (record) { return record.__backendId; }));
      var operations = await listOperations();
      var queuedIds = new Set(operations.map(function (operation) { return operation.localId; }));
      var localRecords = typeof options.getRecords === 'function' ? options.getRecords() : [];
      var added = 0;
      for (var index = 0; index < localRecords.length; index++) {
        var record = localRecords[index] || {};
        var id = record.__backendId || '';
        if (id.indexOf('local-') !== 0 || serverIds.has(id) || queuedIds.has(id)) continue;
        await addOperation({
          action: 'create', localId: id, record: copy(record), createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(), attempts: 0, error: '', uncertain: false
        });
        queuedIds.add(id);
        added++;
      }
      if (added) {
        await updateQueueCount();
        scheduleSync();
      }
      return added;
    }

    async function reconcileUncertainCreates(serverRecords) {
      var operations = await listOperations();
      var uncertainCreates = operations.filter(function (operation) {
        return operation.action === 'create' && operation.uncertain;
      });
      var resolved = 0;
      for (var index = 0; index < uncertainCreates.length; index++) {
        var operation = uncertainCreates[index];
        var serverRecord = (serverRecords || []).find(function (record) {
          return record.client_sync_id && record.client_sync_id === operation.localId;
        });
        if (!serverRecord || !serverRecord.__backendId) continue;
        await local.remapBackendId(operation.localId, serverRecord.__backendId);
        await remapQueuedIds(operation.localId, serverRecord.__backendId);
        await deleteOperation(operation.seq);
        resolved++;
      }
      await updateQueueCount();
      var remaining = (await listOperations()).some(function (operation) {
        return operation.action === 'create' && operation.uncertain;
      });
      syncUncertain = remaining;
      if (!remaining && resolved) clearSyncError();
      return { resolved: resolved, remaining: remaining };
    }

    async function pullServer() {
      if (!url) return { isOk: false, error: 'not-configured' };
      if (options.hasPendingDraft && options.hasPendingDraft()) return { isOk: false, error: 'unsaved-changes' };
      if (root.navigator && root.navigator.onLine === false) return { isOk: false, error: 'offline' };
      try {
        var result = await fetchServerRecords();
        if (!result.isOk) {
          rememberSyncError(result);
          return result;
        }
        await reconcileUncertainCreates(result.records);
        await queueLocalOnlyRecords(result.records);
        var operations = await listOperations();
        var merged = applyOperations(result.records, operations);
        await local.replaceFromSync(merged);
        if (!syncUncertain) clearSyncError();
        lastSyncAt = new Date().toISOString();
        try { storage.setItem('DSR_google_last_sync_at', lastSyncAt); } catch (ignore) {}
        return { isOk: true, count: merged.length, serverCount: result.records.length };
      } catch (error) {
        var failure = error && error.syncResult ? error.syncResult : { error: error.message || 'connection' };
        rememberSyncError(failure);
        return { isOk: false, error: failure.error || 'connection', detail: failure.detail || '' };
      }
    }

    function syncNow(includePull) {
      if (includePull) pullRequested = true;
      if (!syncEnabled || !url) {
        emitStatus();
        return Promise.resolve({ isOk: false, error: 'not-configured' });
      }
      if (syncPromise) return syncPromise;
      syncActive = true;
      clearSyncError();
      emitStatus();
      syncPromise = (async function () {
        var queueResult = await processQueue();
        var pullResult = null;
        if (pullRequested && queueResult.isOk && !syncUncertain) {
          pullRequested = false;
          pullResult = await pullServer();
        } else if (!queueResult.isOk) {
          pullRequested = false;
        }
        return pullResult || queueResult;
      })().finally(function () {
        syncActive = false;
        syncPromise = null;
        emitStatus();
      });
      return syncPromise;
    }

    async function localFirstWrite(action, record) {
      var result = await local[action](record);
      if (!result || !result.isOk) return result;
      var payload = result.record || record;
      try {
        var queued = await enqueue(action, payload);
        result.syncQueued = !!queued.queued;
      } catch (error) {
        syncError = 'บันทึกในเครื่องแล้ว แต่สร้างคิว Google ไม่สำเร็จ';
        syncErrorCode = 'queue-failed';
        syncErrorDetail = cleanDetail(error && error.message || '');
        syncErrorAt = new Date().toISOString();
        result.syncQueued = false;
        result.syncError = syncError;
        emitStatus();
      }
      return result;
    }

    // Draft edits never touch the Google queue. This keeps number inputs instant
    // while still protecting the current value in IndexedDB on this device.
    async function localOnlyWrite(action, record) {
      var result = await local[action](record);
      if (result && result.isOk) {
        result.localOnly = true;
        result.syncQueued = false;
      }
      return result;
    }

    function flushGoogle() {
      if (syncTimer) {
        clearTimeout(syncTimer);
        syncTimer = null;
      }
      return syncNow(false);
    }

    function syncFromGoogleWhenIdle() {
      if (!syncEnabled || !url) return;
      if (root.navigator && root.navigator.onLine === false) return;
      if (root.document && root.document.visibilityState === 'hidden') return;
      syncNow(true);
    }

    if (root.addEventListener) {
      root.addEventListener('online', function () {
        setTimeout(function () { syncNow(true); }, 150);
      });
      root.addEventListener('focus', syncFromGoogleWhenIdle);
    }
    if (root.document && root.document.addEventListener) {
      root.document.addEventListener('visibilitychange', function () {
        if (root.document.visibilityState === 'visible') syncFromGoogleWhenIdle();
      });
    }

    return {
      init: async function (nextHandler) {
        handler = nextHandler;
        var result = await local.init(nextHandler);
        await updateQueueCount();
        emitStatus();
        if (syncEnabled && url) setTimeout(function () { syncNow(true); }, 0);
        if (!heartbeatTimer && root.setInterval) {
          heartbeatTimer = root.setInterval(syncFromGoogleWhenIdle, 15000);
        }
        return result;
      },
      create: function (record) { return localFirstWrite('create', record); },
      update: function (record) { return localFirstWrite('update', record); },
      delete: function (record) { return localFirstWrite('delete', record); },
      createLocal: function (record) { return localOnlyWrite('create', record); },
      updateLocal: function (record) { return localOnlyWrite('update', record); },
      deleteLocal: function (record) { return localOnlyWrite('delete', record); },
      flushGoogle: flushGoogle,
      refresh: function () { return syncNow(true); },
      getUrl: function () { return url; },
      setUrl: async function (value) {
        var nextUrl = String(value || '').trim();
        await updateQueueCount();
        var changedWithPending = !!(queueCount && url && nextUrl !== url);
        url = nextUrl;
        try { storage.setItem('DSR_script_url', url); } catch (ignore) {}
        clearSyncError();
        emitStatus();
        return { isOk: true, configured: !!url, changedWithPending: changedWithPending, pending: queueCount };
      },
      setSyncEnabled: async function (enabled) {
        syncEnabled = !!enabled;
        try { storage.setItem('DSR_google_sync_enabled', String(syncEnabled)); } catch (ignore) {}
        emitStatus();
        if (syncEnabled && url) syncNow(true);
        return { isOk: true, enabled: syncEnabled };
      },
      syncNow: function () { return syncNow(true); },
      testConnection: async function () {
        if (!syncEnabled || !url) return { isOk: false, error: 'not-configured' };
        var result = await fetchServerRecords();
        if (!result.isOk) rememberSyncError(result); else clearSyncError();
        emitStatus();
        return result.isOk ? { isOk: true, count: result.records.length, transport: transportMode } : result;
      },
      getSyncInfo: getSyncInfo,
      isBusy: function () { return local.isBusy(); },
      retryUpdates: async function () {
        var read = await fetchServerRecords();
        if (!read.isOk) {
          rememberSyncError(read);
          emitStatus();
          return read;
        }
        var reconciliation = await reconcileUncertainCreates(read.records);
        if (reconciliation.remaining) {
          syncError = 'พบรายการที่สถานะไม่แน่นอน · ยังไม่ส่งซ้ำเพื่อป้องกันข้อมูลซ้ำ';
          syncErrorCode = 'uncertain-create';
          syncErrorDetail = 'ตรวจ Google แล้วแต่ไม่พบ client_sync_id ของรายการใหม่';
          syncErrorAt = new Date().toISOString();
          emitStatus();
          return { isOk: false, error: 'uncertain-create', pending: queueCount };
        }
        return syncNow(true);
      },
      exportBackup: local.exportBackup,
      downloadBackup: local.downloadBackup,
      importBackup: local.importBackup,
      chooseStorageFolder: local.chooseStorageFolder,
      reconnectStorageFolder: local.reconnectStorageFolder,
      saveFolderSnapshot: local.saveFolderSnapshot,
      restoreFromStorageFolder: local.restoreFromStorageFolder,
      disconnectStorageFolder: local.disconnectStorageFolder,
      storageFolderInfo: local.storageFolderInfo,
      saveLiveToFolder: local.saveLiveToFolder,
      saveDeviceConfig: local.saveDeviceConfig,
      getDeviceConfig: local.getDeviceConfig,
      storageInfo: async function () {
        var info = await local.storageInfo();
        info.sync = await getSyncInfo();
        return info;
      }
    };

    async function getSyncInfo() {
        await updateQueueCount();
        return { enabled: syncEnabled, configured: !!url, url: url, pending: queueCount,
          active: syncActive, error: syncError, errorCode: syncErrorCode, errorDetail: syncErrorDetail,
          errorAt: syncErrorAt, uncertain: syncUncertain, lastSyncAt: lastSyncAt,
          transport: transportMode, online: !(root.navigator && root.navigator.onLine === false) };
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = createDSRHybrid;
  else root.createDSRHybrid = createDSRHybrid;
})(typeof window === 'undefined' ? this : window);
