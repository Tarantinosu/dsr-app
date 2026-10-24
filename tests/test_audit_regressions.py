"""Regressions reproduced by the 24 October browser audit; isolated local data."""
import copy
import json
import unittest
from datetime import datetime, timezone
import test_web_release as harness

FIXTURE = [
 {'__backendId':'p','record_type':'project','project_id':'p1','project_name':'Audit project','client_name':'Audit client','status':'active'},
 {'__backendId':'client','record_type':'profile','role':'client','name':'Audit client'},
 {'__backendId':'partner','record_type':'profile','role':'partner','name':'Audit partner','default_wht':0},
 {'__backendId':'q','record_type':'quotation','project_id':'p1','doc_number':'QT2569-001','items_json':json.dumps([{'desc':'Work','qty':1,'price':10000}]),'subtotal':10000,'grand_total':10000,'vat_mode':'none','client_wht_rate':0},
 {'__backendId':'inst','record_type':'installment','project_id':'p1','installment_index':0,'split_type':'percent','split_value':100,'amount':10000,'status':'draft'},
 {'__backendId':'sp','record_type':'partner_split','project_id':'p1','partner_name':'Audit partner','partner_share_type':'percent','partner_share_value':50,'partner_amount':5000,'partner_wht_rate':0,'partner_wht_amount':0,'partner_net_amount':5000,'partner_paid':False}
]

class AuditRegressions(unittest.TestCase):
    @classmethod
    def setUpClass(cls): harness.WebRelease.setUpClass.__func__(cls)
    @classmethod
    def tearDownClass(cls): harness.WebRelease.tearDownClass.__func__(cls)
    def setUp(self):
        harness.WebRelease.setUp(self)
        self.seed(FIXTURE)
    def tearDown(self): harness.WebRelease.tearDown(self)
    def seed(self, records):
        result=self.page.evaluate('d=>dataSdk.importBackup(new File([JSON.stringify(d)],"fixture.json"))',{'format':'DSR_OFFLINE_BACKUP','version':2,'records':records,'config':{'company_name':'Audit Company'}})
        self.assertTrue(result['isOk'])
        self.page.evaluate("navigate('project-detail','p1')")
    def save(self):
        self.page.locator('#dsr-save-all').click()
        self.page.wait_for_function('!dataSdk.isSavingDrafts()')

    def test_invalid_backup_keeps_existing_database(self):
        before=self.page.evaluate('dataSdk.exportBackup()')
        for records in [[{}],[FIXTURE[0],FIXTURE[0]]]:
            result=self.page.evaluate('records=>dataSdk.importBackup(new File([JSON.stringify({format:"DSR_OFFLINE_BACKUP",records})],"invalid.json"))',records)
            self.assertFalse(result['isOk'])
            self.assertEqual(self.page.evaluate('dataSdk.exportBackup()')['records'],before['records'])

    def test_large_backup_succeeds_when_localstorage_cache_is_full(self):
        self.page.evaluate("""() => { const set=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='DSR_data')throw new DOMException('quota','QuotaExceededError');return set.call(this,key,value);}; }""")
        result=self.page.evaluate('d=>dataSdk.importBackup(new File([JSON.stringify(d)],"full-cache.json"))',{'format':'DSR_OFFLINE_BACKUP','version':2,'records':FIXTURE,'config':{'company_name':'Imported company'}})
        self.assertTrue(result['isOk'])
        self.page.reload(wait_until='domcontentloaded');self.page.wait_for_function('window._dsrInitialDataRendered')
        exported=self.page.evaluate('dataSdk.exportBackup()')
        self.assertEqual(exported['records'],sorted(FIXTURE,key=lambda r:r['__backendId']))
        self.assertEqual(exported['config']['company_name'],'Imported company')

    def test_failed_config_import_rolls_back_records_too(self):
        before=self.page.evaluate('dataSdk.exportBackup()')
        self.page.evaluate("""() => { const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(record){if(this.name==='meta'&&record.key==='deviceConfig')throw new Error('metadata write failed');return put.call(this,record);}; }""")
        new=copy.deepcopy(FIXTURE);new[0]['project_name']='Must not replace'
        result=self.page.evaluate('d=>dataSdk.importBackup(new File([JSON.stringify(d)],"bad-disk.json"))',{'format':'DSR_OFFLINE_BACKUP','version':2,'records':new,'config':{'company_name':'Must not apply'}})
        self.assertFalse(result['isOk'])
        self.assertEqual(self.page.evaluate('dataSdk.exportBackup()')['records'],before['records'])
        self.assertEqual(self.page.evaluate('dataSdk.exportBackup()')['config'],before['config'])

    def test_quote_save_recalculates_unpaid_installments_and_shares(self):
        self.page.evaluate("_qt.q.items[0].price=20000;_qtSave('q')")
        self.save()
        self.assertEqual(self.page.evaluate("getInstallments('p1')[0].amount"),20000)
        self.assertEqual(self.page.evaluate("getPartnerSplits('p1')[0].partner_amount"),10000)

    def test_selected_quote_prints_its_own_items(self):
        rows=copy.deepcopy(FIXTURE);rows.append({**rows[3],'__backendId':'q2','doc_number':'QT2569-002','subtotal':20000,'grand_total':20000,'items_json':json.dumps([{'desc':'SECOND QUOTE','qty':1,'price':20000}])})
        self.seed(rows)
        self.page.evaluate("previewDoc('p1','QT','QT2569-002')")
        text=self.page.locator('#main-content').inner_text()
        self.assertIn('SECOND QUOTE',text)
        self.assertIn('20,000.00',text)

    def test_invoice_preview_does_not_use_another_projects_same_number(self):
        rows=copy.deepcopy(FIXTURE)
        rows[4].update(invoice_number='INV2569-001',status='invoiced')
        rows.extend([
          {**rows[0],'__backendId':'p2','project_id':'p2','project_name':'Second project'},
          {**rows[3],'__backendId':'q2','project_id':'p2','doc_number':'QT2569-002','grand_total':20000,'subtotal':20000,'items_json':json.dumps([{'desc':'Second work','qty':1,'price':20000}])},
          {**rows[4],'__backendId':'inst2','project_id':'p2','amount':2222}
        ])
        self.seed(rows)
        self.page.evaluate("previewDoc('p2','INV','INV2569-001')")
        text=self.page.locator('.mindoc-pages').inner_text()
        self.assertIn('2,222.00',text)
        self.assertNotIn('10,000.00',text)

    def test_zero_wht_remains_zero(self):
        self.page.evaluate("cascadePartnerSplits('p1',true)")
        self.assertEqual(self.page.evaluate("getPartnerSplits('p1')[0].partner_wht_amount"),0)
        self.assertEqual(self.page.evaluate("getPartnerSplits('p1')[0].partner_net_amount"),5000)

    def test_partner_installment_zero_wht_remains_zero(self):
        self.page.evaluate("showTab('split',document.querySelectorAll('.tab-btn')[1]);showPartnerInstForm('sp')")
        self.page.locator('#pinst-amt-sp').fill('2500')
        self.assertIn('WHT -0.00',self.page.locator('#pinst-calc-sp').inner_text())
        self.page.evaluate("savePartnerInst('sp')")
        self.page.wait_for_function("allData.some(r=>r.record_type==='partner_installment')")
        record=self.page.evaluate("allData.find(r=>r.record_type==='partner_installment')")
        self.assertEqual(record['wht_rate'],0)
        self.assertEqual(record['wht_amount'],0)

    def test_two_tabs_reserve_distinct_invoice_numbers(self):
        rows=copy.deepcopy(FIXTURE);rows.append({**rows[4],'__backendId':'inst2','installment_index':1})
        self.seed(rows)
        other=self.context.new_page();other.goto(self.page.url,wait_until='domcontentloaded');other.wait_for_function('window._dsrInitialDataRendered')
        for page,record in [(self.page,'inst'),(other,'inst2')]:
            page.evaluate('id=>issueInvoice(id)',record);page.locator('#dc-yes').click();page.wait_for_function('dataSdk.draftCount()>0');page.evaluate('dataSdk.commitDrafts()')
        records=self.page.evaluate('dataSdk.exportBackup()')['records']
        numbers=[r['invoice_number'] for r in records if r.get('invoice_number')]
        self.assertEqual(len(numbers),2)
        self.assertEqual(len(set(numbers)),2)

    def test_document_reservation_failure_is_reported_without_partial_document(self):
        self.page.evaluate("""() => { const put=IDBObjectStore.prototype.put; IDBObjectStore.prototype.put=function(record){if(this.name==='meta'&&record.key.startsWith('documentCounter:'))throw new Error('counter storage full');return put.call(this,record);}; }""")
        self.page.evaluate("issueInvoice('inst')")
        self.page.locator('#dc-yes').click()
        self.page.wait_for_function("document.getElementById('toast-container').innerText.includes('counter storage full')")
        self.assertFalse(self.page.evaluate("!!allData.find(r=>r.__backendId==='inst').invoice_number"))
        self.assertEqual(self.page.evaluate('dataSdk.draftCount()'),0)

    def test_profile_names_are_text_and_preserve_quotes(self):
        name='ACME "Design" <img src=x onerror="window.injected=true">'
        self.page.evaluate('name=>dataSdk.update({...allData.find(r=>r.__backendId==="client"),name})',name)
        self.page.evaluate("navigate('profiles');editProfile('client')")
        self.assertEqual(self.page.locator('#pf-name').input_value(),name)
        self.assertFalse(self.page.evaluate('window.injected===true'))

    def test_untrusted_names_remain_text_across_pages(self):
        rows=copy.deepcopy(FIXTURE)
        payload='<img src=x onerror="window.injected=true">'
        rows[0]['project_name']=payload
        rows[0]['client_name']=payload
        rows[1]['name']=payload
        rows[2]['name']=payload
        rows[5]['partner_name']=payload
        rows.extend([
          {'__backendId':'exp','record_type':'project_expense','project_id':'p1','expense_description':payload,'expense_amount':1},
          {'__backendId':'log','record_type':'log','project_id':'p1','log_action':payload,'log_detail':payload}
        ])
        self.seed(rows)
        for page in ['dashboard','projects','profiles','partners','logs','project-detail']:
            self.page.evaluate("name=>navigate(name,name==='project-detail'?'p1':undefined)",page)
            self.page.wait_for_timeout(30)
            self.assertFalse(self.page.evaluate('window.injected===true'),page)

    def test_cancel_installment_clears_only_its_draft(self):
        self.page.get_by_role('button',name='เพิ่มงวด',exact=True).click();self.page.locator('#inst-val').fill('25');self.page.wait_for_timeout(400)
        self.page.locator('#inst-form-area').get_by_role('button',name='ยกเลิก',exact=True).click()
        self.assertFalse(self.page.evaluate('dsrHasPendingDraft()'))
        self.page.locator('#tab-qt').get_by_role('button',name='↻ Refresh',exact=True).click()
        self.assertNotIn('กรุณาบันทึกหรือยกเลิก',self.page.locator('#toast-container').inner_text())

    def test_navigation_preserves_unsubmitted_form_before_debounce(self):
        self.page.evaluate("navigate('profiles');showProfileForm()")
        self.page.locator('#pf-name').fill('Unsaved name')
        self.page.evaluate("navigate('projects');navigate('profiles');showProfileForm()")
        self.page.wait_for_function("document.getElementById('pf-name').value==='Unsaved name'")

    def test_thai_default_date_at_midnight(self):
        self.context.new_cdp_session(self.page).send('Emulation.setTimezoneOverride',{'timezoneId':'Asia/Bangkok'})
        self.page.clock.install(time=datetime(2026,10,23,18,30,tzinfo=timezone.utc))
        self.page.evaluate("showDateConfirm('test','Confirm','',()=>{})")
        self.assertEqual(self.page.locator('#dc-date').input_value(),'2026-10-24')

    def test_boq_preserves_zero_quantity(self):
        rows=self.page.evaluate("async()=>parseBOQSpreadsheet(new File(['Description,Qty,Unit Price,Total\\nOptional,0,1000,0'],'zero.csv'),'csv')")
        self.assertEqual(rows[0]['qty'],0)
        self.assertEqual(rows[0]['total'],0)
        self.assertEqual(rows[0]['unit'],'lot')

    def test_office_attachment_is_download_only_with_extension(self):
        self.page.evaluate("async()=>{await dataSdk.create({__backendId:'doc',record_type:'external_doc',project_id:'p1',ext_doc_name:'Budget',ext_doc_file_name:'budget.xlsx',ext_doc_file_type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',ext_doc_data:'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,UEs='});viewExtDoc('doc')}")
        self.assertEqual(self.page.locator('#confirm-dialog img').count(),0)
        self.assertEqual(self.page.locator('#confirm-dialog a[download]').get_attribute('download'),'budget.xlsx')

    def test_backup_warns_when_drafts_not_saved(self):
        self.page.evaluate("() => { dataSdk.update({...getProjects()[0],project_name:'Unsaved'});window.backupCalled=false;dataSdk.downloadBackup=async()=>{window.backupCalled=true;return {isOk:true,count:6}}; }")
        self.page.evaluate('dsrDownloadBackup()')
        self.assertFalse(self.page.evaluate('window.backupCalled'))
        self.assertIn('บันทึก',self.page.locator('#toast-container').inner_text())

    def test_save_all_is_atomic_on_record_failure(self):
        before=self.page.evaluate('dataSdk.exportBackup()')
        self.page.evaluate("dataSdk.update({...getProjects()[0],project_name:'Changed'});dataSdk.update({...getQuotation('p1'),doc_subject:'Changed'})")
        self.page.evaluate("""() => {const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(record){if(record.__backendId==='q')throw new Error('record failure');return put.call(this,record)}}""")
        result=self.page.evaluate('dataSdk.commitDrafts()')
        self.assertFalse(result['isOk'])
        self.assertEqual(self.page.evaluate('dataSdk.exportBackup()')['records'],before['records'])
        self.assertEqual(self.page.evaluate('dataSdk.draftCount()'),2)
