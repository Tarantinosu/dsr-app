DSR Web — Manual Save, 23 October 2026

Editing records, adding items and confirming a deletion update the current tab's draft only.
These drafts are held in memory. No record, folder mirror or Google operation is written until Save.
Use “บันทึกทั้งหมด / ส่ง Google” after applying any open Add form.
Existing explicit Save buttons for profiles, settings, progress, allocations, BOQ and quotations also save applied drafts.
Save commits applied record changes to the browser database, then sends Google in the background.
The Google URL must be configured and enabled for an online save to complete.
Previously saved Google operations may still retry in the background.
Closing or reloading before Save loses unsaved drafts; the browser warns before leaving.
Document-row deletion removes its record on Save and preserves its original Google Drive file.
File uploads, AI extraction and explicit Drive actions remain separate user-invoked operations.

Validation: node manual-save.test.cjs

