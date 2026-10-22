/* DSR Google Drive connection via Google Identity Services (OAuth 2.0). */
(function (root) {
  'use strict';

  var DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var FOLDER_MIME = 'application/vnd.google-apps.folder';
  var ROOT_FOLDER_NAME = 'DSR Projects';
  var tokenClient = null;
  var token = '';
  var tokenExpiresAt = 0;
  var configuredClientId = '';

  function getClientId() {
    if (configuredClientId) return configuredClientId;
    try { return root.localStorage.getItem('DSR_google_drive_client_id') || ''; } catch (ignore) { return ''; }
  }

  function configure(clientId) {
    var next = String(clientId || '').trim();
    if (next !== configuredClientId) tokenClient = null;
    configuredClientId = next;
    try {
      if (next) root.localStorage.setItem('DSR_google_drive_client_id', next);
      else root.localStorage.removeItem('DSR_google_drive_client_id');
    } catch (ignore) {}
    return next;
  }

  function hasGoogleLibrary() {
    return !!(root.google && root.google.accounts && root.google.accounts.oauth2);
  }

  function waitForGoogleLibrary() {
    if (hasGoogleLibrary()) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var waited = 0;
      var timer = root.setInterval(function () {
        waited += 100;
        if (hasGoogleLibrary()) {
          root.clearInterval(timer);
          resolve();
        } else if (waited >= 10000) {
          root.clearInterval(timer);
          reject(new Error('โหลดระบบเชื่อมต่อ Google ไม่สำเร็จ'));
        }
      }, 100);
    });
  }

  function isConnected() {
    return !!token && Date.now() < tokenExpiresAt - 30000;
  }

  async function connect(clientId) {
    var id = configure(clientId || getClientId());
    if (!id) return { isOk: false, error: 'missing-client-id' };
    await waitForGoogleLibrary();
    return new Promise(function (resolve) {
      tokenClient = root.google.accounts.oauth2.initTokenClient({
        client_id: id,
        scope: DRIVE_SCOPE,
        callback: function (response) {
          if (!response || response.error || !response.access_token) {
            resolve({ isOk: false, error: (response && response.error) || 'authorization-failed' });
            return;
          }
          token = response.access_token;
          tokenExpiresAt = Date.now() + (Number(response.expires_in) || 3600) * 1000;
          resolve({ isOk: true, expiresAt: new Date(tokenExpiresAt).toISOString() });
        },
        error_callback: function (error) {
          resolve({ isOk: false, error: (error && (error.type || error.message)) || 'popup-failed' });
        }
      });
      tokenClient.requestAccessToken({ prompt: 'select_account' });
    });
  }

  function disconnect() {
    var oldToken = token;
    token = '';
    tokenExpiresAt = 0;
    if (oldToken && hasGoogleLibrary()) {
      try { root.google.accounts.oauth2.revoke(oldToken, function () {}); } catch (ignore) {}
    }
    return { isOk: true };
  }

  async function driveFetch(url, options) {
    if (!isConnected()) return { isOk: false, error: 'not-connected' };
    options = options || {};
    options.headers = options.headers || {};
    options.headers.Authorization = 'Bearer ' + token;
    var response;
    try {
      response = await root.fetch(url, options);
    } catch (error) {
      return { isOk: false, error: 'connection', detail: String(error && error.message || '') };
    }
    var text = await response.text();
    var data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (ignore) {}
    if (!response.ok) {
      if (response.status === 401) { token = ''; tokenExpiresAt = 0; }
      return {
        isOk: false,
        error: response.status === 401 ? 'authorization-expired' : 'drive-api-' + response.status,
        detail: (data.error && data.error.message) || text || ('HTTP ' + response.status)
      };
    }
    data.isOk = true;
    return data;
  }

  function q(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  async function findFolder(name, parentId, prefixOnly) {
    var condition = prefixOnly ? "name contains '" + q(name) + "'" : "name = '" + q(name) + "'";
    var query = condition + " and mimeType = '" + FOLDER_MIME + "' and trashed = false";
    if (parentId) query += " and '" + q(parentId) + "' in parents";
    var url = 'https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=20&fields=files(id,name,webViewLink)&q=' + encodeURIComponent(query);
    var result = await driveFetch(url, { method: 'GET' });
    if (!result.isOk) return result;
    return { isOk: true, folder: result.files && result.files[0] || null };
  }

  async function createFolder(name, parentId) {
    var metadata = { name: name, mimeType: FOLDER_MIME };
    if (parentId) metadata.parents = [parentId];
    return driveFetch('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify(metadata)
    });
  }

  async function ensureFolder(name, parentId, prefixOnly) {
    var found = await findFolder(name, parentId, prefixOnly);
    if (!found.isOk) return found;
    if (found.folder) return Object.assign({ isOk: true }, found.folder);
    return createFolder(name, parentId);
  }

  async function ensureRootFolder() {
    var savedId = '';
    try { savedId = root.localStorage.getItem('DSR_google_drive_root_id') || ''; } catch (ignore) {}
    if (savedId) {
      var existing = await driveFetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(savedId) + '?fields=id,name,webViewLink,trashed', { method: 'GET' });
      if (existing.isOk && !existing.trashed) return existing;
    }
    var folder = await ensureFolder(ROOT_FOLDER_NAME, '', false);
    if (folder.isOk) {
      try { root.localStorage.setItem('DSR_google_drive_root_id', folder.id); } catch (ignore) {}
    }
    return folder;
  }

  function safeName(value) {
    return String(value || '').replace(/[\\/:*?"<>|\r\n]+/g, '-').trim().slice(0, 180) || 'Untitled';
  }

  async function ensureProjectFolder(project) {
    project = project || {};
    if (!project.project_id) return { isOk: false, error: 'missing-project-id' };
    if (project.drive_folder_id) {
      var known = await driveFetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(project.drive_folder_id) + '?fields=id,name,webViewLink,trashed', { method: 'GET' });
      if (known.isOk && !known.trashed) {
        return { isOk: true, folderId: known.id, folderName: known.name, folderUrl: known.webViewLink || ('https://drive.google.com/drive/folders/' + known.id) };
      }
    }
    var rootFolder = await ensureRootFolder();
    if (!rootFolder.isOk) return rootFolder;
    var prefix = '[' + project.project_id + ']';
    var projectFolder = await ensureFolder(prefix, rootFolder.id, true);
    if (!projectFolder.isOk) return projectFolder;
    if (projectFolder.name === prefix) {
      var renamed = await driveFetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(projectFolder.id) + '?fields=id,name,webViewLink', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify({ name: prefix + ' ' + safeName(project.project_name || 'Untitled') })
      });
      if (renamed.isOk) projectFolder = renamed;
    }
    var children = ['01 Documents', '02 Presentations', '03 Reference'];
    for (var i = 0; i < children.length; i++) {
      var child = await ensureFolder(children[i], projectFolder.id, false);
      if (!child.isOk) return child;
    }
    return {
      isOk: true,
      folderId: projectFolder.id,
      folderName: projectFolder.name || (prefix + ' ' + safeName(project.project_name)),
      folderUrl: projectFolder.webViewLink || ('https://drive.google.com/drive/folders/' + projectFolder.id)
    };
  }

  async function uploadProjectFile(project, file) {
    if (!file) return { isOk: false, error: 'missing-file' };
    var projectFolder = await ensureProjectFolder(project);
    if (!projectFolder.isOk) return projectFolder;
    var docsFolder = await ensureFolder('01 Documents', projectFolder.folderId, false);
    if (!docsFolder.isOk) return docsFolder;
    var metadata = await driveFetch('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink,webContentLink,mimeType', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({ name: safeName(file.name || 'document'), parents: [docsFolder.id] })
    });
    if (!metadata.isOk) return metadata;
    var uploaded = await driveFetch('https://www.googleapis.com/upload/drive/v3/files/' + encodeURIComponent(metadata.id) + '?uploadType=media&fields=id,name,webViewLink,webContentLink,mimeType,size', {
      method: 'PATCH',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file
    });
    if (!uploaded.isOk) return uploaded;
    return {
      isOk: true,
      fileId: uploaded.id,
      fileName: uploaded.name || file.name,
      fileUrl: uploaded.webViewLink || ('https://drive.google.com/file/d/' + uploaded.id + '/view'),
      downloadUrl: uploaded.webContentLink || ('https://drive.google.com/uc?export=download&id=' + uploaded.id),
      mimeType: uploaded.mimeType || file.type,
      folderId: projectFolder.folderId,
      folderName: projectFolder.folderName,
      folderUrl: projectFolder.folderUrl
    };
  }

  async function deleteFile(fileId) {
    if (!fileId) return { isOk: false, error: 'missing-file-id' };
    return driveFetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({ trashed: true })
    });
  }

  root.dsrDrive = {
    configure: configure,
    getClientId: getClientId,
    connect: connect,
    disconnect: disconnect,
    isConnected: isConnected,
    ensureProjectFolder: ensureProjectFolder,
    uploadProjectFile: uploadProjectFile,
    deleteFile: deleteFile
  };
})(window);
