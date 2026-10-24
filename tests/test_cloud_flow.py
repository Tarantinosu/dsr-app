"""Browser flow with real Supabase SDK and deterministic simulated HTTP service.
SQL access control/idempotency are separately tested with PostgreSQL in tools/cloud-tests.
"""
import base64
import json
import time
import unittest
import test_web_release as release


class CloudFlow(unittest.TestCase):
    setUpClass = classmethod(release.WebRelease.setUpClass.__func__)
    tearDownClass = classmethod(release.WebRelease.tearDownClass.__func__)
    tearDown = release.WebRelease.tearDown
    # Reuse browser/server setup, not the parent's local-only test cases.
    def setUp(self):
        release.WebRelease.setUp(self)
        self.central = None
        self.revision = 0
        self.receipts = {}
        self.offline = False
        self.calls = []
        self.token = '.'.join(base64.urlsafe_b64encode(json.dumps(p).encode()).decode().rstrip('=') for p in [
            {'alg': 'HS256', 'typ': 'JWT'},
            {'sub': '00000000-0000-4000-8000-000000000001', 'aud': 'authenticated', 'exp': int(time.time()) + 3600},
            'test-signature'
        ])
        self.context.route('https://xxxrlhrmtbhhtfrehcfb.supabase.co/**', self.api)

    def api(self, route):
        self.calls.append(route.request.url)
        if self.offline:
            route.abort(); return
        url = route.request.url
        data = route.request.post_data_json if route.request.post_data else {}
        response, status = {}, 200
        if '/auth/v1/token' in url:
            if data.get('password') != 'test-password':
                response, status = {'error_code': 'invalid_credentials', 'msg': 'Invalid login credentials'}, 400
            else:
                response = {'access_token': self.token, 'refresh_token': 'test-refresh-token', 'token_type': 'bearer',
                            'expires_in': 3600, 'user': {'id': '00000000-0000-4000-8000-000000000001', 'email': 'test@example.test'}}
        elif '/rpc/dsr_read' in url:
            same = data.get('p_known_version') == self.revision
            response = {'version': self.revision, 'unchanged': same, 'payload': None if same else self.central, 'role': 'owner'}
        elif '/rpc/dsr_save' in url:
            key = data['p_request_id']
            if key in self.receipts:
                response = self.receipts[key]
            elif data['p_expected_version'] != self.revision:
                response, status = {'code': '40001', 'message': 'DSR_VERSION_CONFLICT'}, 409
            else:
                self.central = data['p_payload']; self.revision += 1
                response = {'version': self.revision, 'replayed': False}; self.receipts[key] = response
        route.fulfill(status=status, content_type='application/json', body=json.dumps(response))

    def enter_cloud(self):
        self.page.locator('#dsr-cloud-connect').click()
        self.page.wait_for_selector('#dsr-cloud-dialog[open]')

    def login(self, page=None):
        page = page or self.page
        page.locator('#dsr-cloud-login-email').fill('test@example.test')
        page.locator('#dsr-cloud-login-password').fill('test-password')
        page.locator('#dsr-cloud-login-submit').click()
        page.wait_for_function('dataSdk.getCloudState().ready')

    def imported(self):
        self.enter_cloud(); self.login()
        self.page.locator('#dsr-cloud-import-local').click()
        self.page.wait_for_selector('#dsr-cloud-confirm-import:enabled')
        self.page.locator('#dsr-cloud-confirm-import').click()
        self.page.wait_for_function('dataSdk.getCloudState().version === 1 && !dataSdk.isBusy()')

    def test_login_and_import_require_confirmation_and_preserve_local_data(self):
        self.enter_cloud()
        self.assertEqual(self.calls, [])
        self.login()
        self.assertIsNone(self.central)
        self.assertEqual(self.page.locator('#dsr-cloud-login-password').input_value(), '')
        self.page.locator('#dsr-cloud-import-local').click()
        self.page.wait_for_selector('#dsr-cloud-confirm-import:enabled')
        self.assertIsNone(self.central)
        self.assertIn('2 รายการ', self.page.locator('#dsr-cloud-import-preview').inner_text())
        self.page.locator('#dsr-cloud-confirm-import').click()
        self.page.wait_for_function('dataSdk.getCloudState().version === 1 && !dataSdk.isBusy()')
        self.assertEqual(len(self.central['records']), 2)
        local = self.page.evaluate("""async () => {
          const local=createDSRLocal({mirrorFolder:false});await local.init({onDataChanged(){}});return local.exportBackup();
        }""")
        self.assertEqual(local['records'], self.central['records'])
        storage = self.page.evaluate('JSON.stringify({...localStorage}) + JSON.stringify({...sessionStorage})')
        self.assertNotIn(self.token, storage)
        self.assertNotIn('test-refresh-token', storage)

    def test_failed_login_shows_error_without_showing_central_data(self):
        self.enter_cloud()
        self.page.locator('#dsr-cloud-login-email').fill('test@example.test')
        self.page.locator('#dsr-cloud-login-password').fill('wrong')
        self.page.locator('#dsr-cloud-login-submit').click()
        self.page.wait_for_function("document.getElementById('dsr-cloud-message').innerText.includes('ไม่ถูกต้อง')")
        self.assertTrue(self.page.locator('#dsr-cloud-dialog').evaluate('(d)=>d.open'))
        self.assertEqual(self.page.evaluate('allData.length'), 0)

    def test_two_browsers_share_saved_data_and_stale_writer_keeps_draft(self):
        self.imported()
        second_context = self.browser.new_context(service_workers='block')
        try:
            second_context.add_init_script("localStorage.setItem('DSR_storage_mode','cloud')")
            second_context.route('https://xxxrlhrmtbhhtfrehcfb.supabase.co/**', self.api)
            second = second_context.new_page()
            second.goto(f'http://127.0.0.1:{self.server.server_port}/', wait_until='domcontentloaded')
            self.login(second)
            self.page.evaluate("dataSdk.update({...allData.find(r=>r.record_type==='project'),project_name:'Machine A'})")
            self.page.locator('#dsr-save-all').click()
            self.page.wait_for_function('dataSdk.draftCount()===0 && !dataSdk.isSavingDrafts()')
            self.assertEqual(self.revision, 2)
            second.evaluate("dataSdk.update({...allData.find(r=>r.record_type==='project'),project_name:'Machine B draft'})")
            second.locator('#dsr-save-all').click()
            second.wait_for_function('dataSdk.getCloudState().conflict')
            self.assertEqual(second.evaluate('dataSdk.draftCount()'), 1)
            self.assertTrue(second.locator('#dsr-cloud-conflict').is_visible())
            self.assertEqual(next(r for r in self.central['records'] if r['record_type']=='project')['project_name'], 'Machine A')
        finally:
            second_context.close()

    def test_network_failure_preserves_draft_and_retry_saves(self):
        self.imported()
        self.page.evaluate("dataSdk.update({...allData[0],project_name:'retry'})")
        self.offline = True
        result = self.page.evaluate('dataSdk.commitDrafts()')
        self.assertFalse(result['isOk'])
        self.assertEqual(self.page.evaluate('dataSdk.draftCount()'), 1)
        self.offline = False
        self.assertTrue(self.page.evaluate('dataSdk.commitDrafts()')['isOk'])
        self.assertEqual(self.page.evaluate('dataSdk.draftCount()'), 0)

    def test_mobile_login_dialog_fits_and_keyboard_focus_stays_inside(self):
        self.page.set_viewport_size({'width': 360, 'height': 800})
        self.enter_cloud()
        bounds = self.page.locator('#dsr-cloud-dialog').bounding_box()
        self.assertGreaterEqual(bounds['x'], 0)
        self.assertLessEqual(bounds['x'] + bounds['width'], 360)
        self.assertLessEqual(bounds['height'], 720)
        for _ in range(6):
            self.page.keyboard.press('Tab')
        self.assertTrue(self.page.evaluate("document.getElementById('dsr-cloud-dialog').contains(document.activeElement)"))

    def test_remote_company_image_cannot_inject_html(self):
        self.central = {'format': 'DSR_OFFLINE_BACKUP', 'version': 2,
                        'records': [{'__backendId':'cloud-project','record_type':'project','project_name':'Test'}],
                        'config': {'company_name':'Test', 'company_logo_data':'x" onerror="window.__cloudInjected=1'}}
        self.revision = 1
        self.enter_cloud(); self.login()
        self.page.evaluate("navigate('settings')")
        self.assertIsNone(self.page.evaluate('window.__cloudInjected'))
        self.assertEqual(self.page.locator('#preview-company-logo img').count(), 0)
