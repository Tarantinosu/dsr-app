"""File save flows use real origin-private FileSystemFileHandles in Chromium."""
import unittest
import test_web_release as harness

class JsonFileSave(unittest.TestCase):
    @classmethod
    def setUpClass(cls): harness.WebRelease.setUpClass.__func__(cls)
    @classmethod
    def tearDownClass(cls): harness.WebRelease.tearDownClass.__func__(cls)
    def setUp(self): harness.WebRelease.setUp(self)
    def tearDown(self): harness.WebRelease.tearDown(self)

    def choose_file(self):
        return self.page.evaluate("""async () => {
          const directory = await navigator.storage.getDirectory();
          const file = await directory.getFileHandle('DSR_LIVE_DATA.json',{create:true});
          const writable = await file.createWritable();
          await writable.write(JSON.stringify({marker:'original file'})); await writable.close();
          window.showSaveFilePicker = async () => file;
          return await dataSdk.chooseJsonFile();
        }""")

    def read_file(self):
        return self.page.evaluate("""async () => {
          const root = await navigator.storage.getDirectory();
          return JSON.parse(await (await (await root.getFileHandle('DSR_LIVE_DATA.json')).getFile()).text());
        }""")

    def test_json_written_only_when_save_all_is_clicked(self):
        self.assertTrue(self.choose_file()['isOk'])
        self.assertEqual(self.read_file(),{'marker':'original file'})
        self.page.evaluate("dataSdk.update({...getProjects()[0],project_name:'Project saved to JSON'})")
        self.page.wait_for_timeout(450)
        self.assertEqual(self.read_file(),{'marker':'original file'})
        self.page.locator('#dsr-save-all').click()
        self.page.wait_for_function("!document.getElementById('dsr-save-all').disabled")
        backup=self.read_file()
        self.assertEqual(backup['format'],'DSR_OFFLINE_BACKUP')
        self.assertEqual(next(r for r in backup['records'] if r['record_type']=='project')['project_name'],'Project saved to JSON')
        self.page.reload(wait_until='domcontentloaded')
        self.page.wait_for_function('window._dsrInitialDataRendered')
        status=self.page.evaluate('dataSdk.jsonFileStatus()')
        self.assertTrue(status['configured'])
        self.assertEqual(status['fileName'],'DSR_LIVE_DATA.json')
        self.assertIn('DSR_LIVE_DATA.json',self.page.locator('#dsr-save-status').inner_text())
        self.assertEqual(self.read_file(),backup)

    def test_global_save_from_settings_includes_company_fields_in_json(self):
        self.assertTrue(self.choose_file()['isOk'])
        self.page.evaluate("navigate('settings')")
        self.page.locator('#set-company-name').fill('Company saved to JSON')
        self.page.locator('#dsr-save-all').click()
        self.page.wait_for_function("!!_dsrLastSyncState.jsonLastSavedAt && !_dsrLastSyncState.jsonSaving")
        self.assertEqual(self.read_file()['config']['company_name'],'Company saved to JSON')

    def test_file_failure_keeps_browser_save_and_reports_json_error(self):
        self.assertTrue(self.choose_file()['isOk'])
        self.page.evaluate("""() => {FileSystemFileHandle.prototype.createWritable=async()=>{throw new Error('JSON disk full')}; dataSdk.update({...getProjects()[0],project_name:'Browser copy retained'});}""")
        self.page.locator('#dsr-save-all').click()
        self.page.wait_for_function("!document.getElementById('dsr-save-all').disabled")
        self.assertIn('JSON',self.page.locator('#toast-container').inner_text())
        self.assertIn('JSON disk full',self.page.locator('#toast-container').inner_text())
        self.assertEqual(self.read_file(),{'marker':'original file'})
        exported=self.page.evaluate('dataSdk.exportBackup()')
        self.assertEqual(next(r for r in exported['records'] if r['record_type']=='project')['project_name'],'Browser copy retained')

    def test_disconnect_removes_binding_without_deleting_file_or_records(self):
        self.assertTrue(self.choose_file()['isOk'])
        before=self.page.evaluate('dataSdk.exportBackup()')
        result=self.page.evaluate('dataSdk.disconnectJsonFile()')
        self.assertTrue(result['isOk'])
        self.assertFalse(self.page.evaluate('dataSdk.jsonFileStatus()')['configured'])
        self.assertEqual(self.read_file(),{'marker':'original file'})
        self.assertEqual(self.page.evaluate('dataSdk.exportBackup()')['records'],before['records'])

    def test_file_status_failure_does_not_misreport_browser_save(self):
        self.assertTrue(self.choose_file()['isOk'])
        self.page.evaluate("""() => {dataSdk.jsonFileStatus=async()=>{throw new Error('file status unavailable')};dataSdk.update({...getProjects()[0],project_name:'Committed despite file error'});}""")
        self.page.locator('#dsr-save-all').click()
        self.page.wait_for_function("!document.getElementById('dsr-save-all').disabled")
        self.assertIn('บันทึกในเบราว์เซอร์แล้ว',self.page.locator('#toast-container').inner_text())
        exported=self.page.evaluate('dataSdk.exportBackup()')
        self.assertEqual(next(r for r in exported['records'] if r['record_type']=='project')['project_name'],'Committed despite file error')

    def test_cancel_file_picker_keeps_existing_binding(self):
        self.assertTrue(self.choose_file()['isOk'])
        self.page.evaluate("() => {window.showSaveFilePicker=async()=>{throw new DOMException('cancelled','AbortError')};}")
        result=self.page.evaluate('dataSdk.chooseJsonFile()')
        self.assertTrue(result['cancelled'])
        self.assertEqual(self.page.evaluate('dataSdk.jsonFileStatus()')['fileName'],'DSR_LIVE_DATA.json')
        self.assertEqual(self.read_file(),{'marker':'original file'})

    def test_revoked_file_permission_keeps_json_unchanged(self):
        self.assertTrue(self.choose_file()['isOk'])
        self.page.evaluate("() => {FileSystemFileHandle.prototype.queryPermission=async()=> 'denied'; dataSdk.update({...getProjects()[0],project_name:'Browser copy after revocation'});}")
        self.page.locator('#dsr-save-all').click()
        self.page.wait_for_function("!document.getElementById('dsr-save-all').disabled")
        self.assertIn('อนุญาต',self.page.locator('#toast-container').inner_text())
        self.assertEqual(self.read_file(),{'marker':'original file'})
        exported=self.page.evaluate('dataSdk.exportBackup()')
        self.assertEqual(next(r for r in exported['records'] if r['record_type']=='project')['project_name'],'Browser copy after revocation')

    def test_unsupported_browser_keeps_download_backup_available(self):
        self.page.evaluate("Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true})")
        result=self.page.evaluate('dataSdk.chooseJsonFile()')
        self.assertFalse(result['isOk'])
        self.assertTrue(result['unsupported'])
        self.page.evaluate("navigate('settings')")
        self.assertEqual(self.page.get_by_role('button',name='ดาวน์โหลด Backup',exact=True).count(),1)
