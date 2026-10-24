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
        self.page.wait_for_function("window._dsrInitialDataRendered && currentPage === 'settings'")
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
        self.page.get_by_role('button', name='↻ Refresh', exact=True).click()
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
        self.page.get_by_role('button', name='↻ Refresh', exact=True).click()
        self.page.wait_for_function("document.getElementById('inst-list').innerText.includes('งวดที่ 1')")
        self.assertEqual(self.page.evaluate('dataSdk.draftCount()'), 0)

    def test_failed_add_retains_form(self):
        self.page.evaluate("() => { dataSdk.create = async () => { throw new Error('save failed'); }; }")
        self.page.get_by_role('button', name='เพิ่มงวด', exact=True).click()
        self.page.locator('#inst-val').fill('50')
        self.page.locator('#inst-submit').click()
        self.page.wait_for_function("!document.getElementById('inst-submit').disabled")
        self.assertEqual(self.page.locator('#inst-val').input_value(), '50')
        self.assertEqual(self.page.evaluate("getInstallments('test').length"), 0)

if __name__ == '__main__': unittest.main()
