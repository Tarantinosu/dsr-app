"""Run: python3 -m unittest discover -s tests -v (Playwright + Chromium required)."""
import functools
import threading
import unittest
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass

class WebRelease(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(Path(__file__).resolve().parents[1])))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join()

    def setUp(self):
        self.context = self.browser.new_context(service_workers='block')
        self.context.route('https://**/*', lambda route: route.abort())
        self.page = self.context.new_page()
        self.page.set_default_timeout(5000)
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.goto(f'http://127.0.0.1:{self.server.server_port}/', wait_until='domcontentloaded')
        self.page.wait_for_function("window._dsrInitialDataRendered && !dataSdk.isBusy()")
        self.page.evaluate("""async () => {
          await dataSdk.create({record_type:'project',project_id:'test',project_name:'Test project',status:'active'});
          await dataSdk.create({record_type:'quotation',project_id:'test',doc_number:'QT-TEST',grand_total:10338.94,subtotal:10338.94,items_json:'[]',vat_mode:'none'});
          await dataSdk.commitDrafts();
          navigate('project-detail','test');
        }""")

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def add_installment(self):
        self.page.get_by_role('button', name='เพิ่มงวด', exact=True).click()
        self.page.locator('#inst-val').fill('100')
        self.page.locator('#inst-condition').fill('Visible draft')
        self.page.locator('#inst-submit').click()
        self.page.wait_for_function("getInstallments('test').length === 1")

    def test_added_installment_visible_and_explicit_save_persists(self):
        self.add_installment()
        self.assertIn('10,338.94', self.page.locator('#inst-list').inner_text())
        self.assertEqual(self.page.evaluate('dataSdk.draftCount()'), 1)
        self.page.locator('#tab-qt').get_by_role('button', name='↻ Refresh', exact=True).click()
        self.assertEqual(self.page.evaluate('dataSdk.draftCount()'), 1)
        self.page.locator('#dsr-save-all').click()
        self.page.wait_for_function('dataSdk.draftCount() === 0 && !dataSdk.isSavingDrafts()')
        self.page.reload(wait_until='domcontentloaded')
        self.page.wait_for_function("window._dsrInitialDataRendered && allData.some(r => r.record_type === 'installment')")
        self.assertEqual(self.page.evaluate("getInstallments('test').length"), 1)

    def test_refresh_saved_data_does_not_call_google(self):
        self.add_installment()
        self.page.evaluate('dataSdk.commitDrafts()')
        self.page.evaluate("_dsrDirty=false; _dsrMemoryFormDrafts.clear(); allData = allData.filter(r => r.record_type !== 'installment'); renderPage()")
        self.page.locator('#tab-qt').get_by_role('button', name='↻ Refresh', exact=True).click()
        self.page.wait_for_function("document.getElementById('inst-list').innerText.includes('งวดที่ 1')")
        self.assertEqual(self.page.evaluate('dataSdk.draftCount()'), 0)

    def test_local_mode_ignores_old_google_settings(self):
        before = self.page.evaluate('dataSdk.exportBackup()')
        self.page.evaluate("""async () => {
          const db = await new Promise((resolve,reject) => {
            const request = indexedDB.open('DSR_Hybrid_Sync_DB',1);
            request.onupgradeneeded = () => request.result.createObjectStore('operations',{keyPath:'seq'});
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          await new Promise((resolve,reject) => {
            const tx=db.transaction('operations','readwrite');
            tx.objectStore('operations').put({seq:1,action:'update',record:{name:'legacy pending record'}});
            tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
          });db.close();
        }""")
        calls = []
        self.page.on('request', lambda request: calls.append(request.url))
        self.page.evaluate("localStorage.setItem('DSR_script_url','https://script.google.com/macros/s/old/exec'); localStorage.setItem('DSR_google_sync_enabled','true')")
        self.page.reload(wait_until='domcontentloaded')
        self.page.wait_for_function('window._dsrInitialDataRendered')
        self.page.evaluate("navigate('settings')")
        text = self.page.locator('#main-content').inner_text()
        self.assertNotIn('Google Sync', text)
        self.assertNotIn('Google Drive', text)
        self.assertEqual([u for u in calls if any(h in u for h in ['accounts.google.com','script.google.com','googleapis.com'])], [])
        self.assertEqual(self.page.locator('#dsr-save-all').inner_text(), 'บันทึกทั้งหมด')
        after = self.page.evaluate('dataSdk.exportBackup()')
        self.assertEqual(before['records'],after['records'])
        self.assertEqual(before['config'],after['config'])
        pending = self.page.evaluate("""async () => {
          const db=await new Promise(resolve=>{const r=indexedDB.open('DSR_Hybrid_Sync_DB',1);r.onsuccess=()=>resolve(r.result);});
          const rows=await new Promise(resolve=>{const r=db.transaction('operations').objectStore('operations').getAll();r.onsuccess=()=>resolve(r.result);});
          db.close();return rows;
        }""")
        self.assertEqual(pending,[{'seq':1,'action':'update','record':{'name':'legacy pending record'}}])

    def test_local_attachment_is_saved_and_included_in_backup(self):
        self.page.evaluate("navigate('documents'); document.getElementById('main-content').insertAdjacentHTML('afterbegin','<div id=ext-upload-test></div>'); showUploadExtDoc('test')")
        self.page.locator('#ext-name-test').fill('Local attachment')
        self.page.locator('#ext-file-test').set_input_files({'name':'note.pdf','mimeType':'application/pdf','buffer':b'%PDF-1.4\nlocal test'})
        self.page.locator('#ext-save-test').click()
        self.page.wait_for_function("allData.some(r=>r.record_type==='external_doc')")
        self.page.locator('#dsr-save-all').click()
        self.page.wait_for_function('dataSdk.draftCount()===0 && !dataSdk.isSavingDrafts()')
        exported = self.page.evaluate('dataSdk.exportBackup()')
        attachment = next(r for r in exported['records'] if r['record_type']=='external_doc')
        self.assertEqual(attachment['storage_provider'],'local')
        self.assertTrue(attachment['ext_doc_data'].startswith('data:application/pdf;base64,'))
        self.page.reload(wait_until='domcontentloaded')
        self.page.wait_for_function("window._dsrInitialDataRendered && allData.some(r=>r.record_type==='external_doc')")
        self.assertEqual(self.page.evaluate("allData.find(r=>r.record_type==='external_doc').ext_doc_data"),attachment['ext_doc_data'])


    def test_failed_add_retains_form(self):
        self.page.evaluate("() => { dataSdk.create = async () => { throw new Error('save failed'); }; }")
        self.page.get_by_role('button', name='เพิ่มงวด', exact=True).click()
        self.page.locator('#inst-val').fill('50')
        self.page.locator('#inst-submit').click()
        self.page.wait_for_function("!document.getElementById('inst-submit').disabled")
        self.assertEqual(self.page.locator('#inst-val').input_value(), '50')
        self.assertEqual(self.page.evaluate("getInstallments('test').length"), 0)

if __name__ == '__main__': unittest.main()
