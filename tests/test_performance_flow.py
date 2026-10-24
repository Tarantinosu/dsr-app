"""Guard measured hot-path work without flaky wall-clock assertions."""
import unittest
import test_web_release as harness

class PerformanceFlow(unittest.TestCase):
    @classmethod
    def setUpClass(cls): harness.WebRelease.setUpClass.__func__(cls)
    @classmethod
    def tearDownClass(cls): harness.WebRelease.tearDownClass.__func__(cls)
    def setUp(self): harness.WebRelease.setUp(self)
    def tearDown(self): harness.WebRelease.tearDown(self)

    def test_draft_edits_do_not_reload_unchanged_company_images(self):
        result=self.page.evaluate("""async()=>{
          const old=dataSdk.getDeviceConfig;let calls=0;
          dataSdk.getDeviceConfig=()=>{calls++;return old()};
          await dataSdk.updateLocal({...getProjects()[0],project_name:'First draft'});
          await dataSdk.updateLocal({...getProjects()[0],project_name:'Second draft'});
          const unchangedCalls=calls;
          await dataSdk.saveDeviceConfig({company_name:'Updated company'});
          await dataSdk.updateLocal({...getProjects()[0],project_name:'Third draft'});
          return {unchangedCalls,changedCalls:calls,name:elementSdk.config.company_name};
        }""")
        self.assertEqual(result['unchangedCalls'],0)
        self.assertEqual(result['changedCalls'],1)
        self.assertEqual(result['name'],'Updated company')

    def test_document_group_modes_keep_rows_and_search(self):
        self.page.evaluate("""async()=>{
          await dataSdk.create({record_type:'installment',project_id:'test',installment_index:0,amount:100,status:'paid',invoice_number:'INV-TEST',receipt_number:'REC-TEST',invoice_date:'2026-10-24',receipt_date:'2026-10-24'});
          await dataSdk.commitDrafts();navigate('documents');
        }""")
        self.page.evaluate("window.docGroupMode='legacy';renderDocuments(document.getElementById('main-content'))")
        self.assertEqual(self.page.locator('[data-doc-row]').count(),3)
        for mode in ['project','date']:
            self.page.evaluate('mode=>setDocumentGroupMode(mode)',mode)
            self.assertEqual(self.page.locator('[data-doc-row]').count(),3)
            self.page.locator('#doc-search-input').fill('INV-TEST')
            self.assertEqual(self.page.locator('[data-doc-row]:visible').count(),1)
            self.page.locator('#doc-search-input').fill('')
            self.assertEqual(self.page.locator('[data-doc-row]:visible').count(),3)
            self.assertEqual(self.page.locator('i[data-lucide]').count(),0)
