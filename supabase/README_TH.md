# ตั้งฐานข้อมูลกลาง DSR — Supabase Free

สถานะ: มี frontend adapter และล็อกอินอีเมล/รหัสผ่านแล้ว ทดสอบ SDK ผ่าน HTTP จำลองและทดสอบ adapter กับ PostgreSQL ผ่าน PGlite แล้ว **ยังต้องยืนยันล็อกอิน/บันทึกบนโปรเจกต์จริงจากอุปกรณ์ผู้ใช้** เครื่องพัฒนาถูก egress proxy บล็อกการติดต่อ Supabase

เว็บเริ่มในโหมดข้อมูลเดิมของแต่ละเบราว์เซอร์ กด **ใช้ข้อมูลร่วมกัน · เข้าสู่ระบบ** เพื่อเลือกฐานกลาง ไม่มีการนำข้อมูลในเครื่องขึ้นอัตโนมัติ ดูวิธีใช้งานใน [CLOUD_SYNC_TH.md](../CLOUD_SYNC_TH.md)

## ขั้นที่ 1: สร้างตาราง

1. เข้าโปรเจกต์ Supabase ของตัวเอง → SQL Editor → New query
2. คัดลอกเนื้อหาทั้งหมดของ `01_setup.sql` วาง แล้วกด Run
3. ผลลัพธ์ควรเป็น `DSR schema ready; no business data imported and no members granted yet`

การรันซ้ำจะไม่ล้างตาราง ไม่รีเซ็ตเวอร์ชัน และไม่ลบสมาชิก ตารางถูกป้องกันไว้ ไม่มีสมาชิกคนใดอ่านหรือเขียนข้อมูลธุรกิจได้จนกว่าเจ้าของโปรเจกต์จะให้สิทธิ์

Publishable key เป็นค่าที่ใช้ในเว็บสาธารณะได้ แต่ใช้สร้าง schema หรือเพิ่มสมาชิกไม่ได้ ไม่ต้องส่งรหัสฐานข้อมูล Secret key, service_role หรือรหัส OAuth มาในแชต

## ขั้นที่ 2: ตั้งล็อกอินและสิทธิ์ (หลังสร้างตาราง)

- ใช้อีเมล/รหัสผ่าน Supabase Email provider ต้องเปิดอยู่ ไม่ต้องตั้ง Google OAuth สำหรับรุ่นนี้
- เจ้าของโปรเจกต์สร้างบัญชีใน Authentication → Users → Add user → Create new user ยืนยันอีเมลที่ตรวจสอบแล้ว และตั้งรหัสผ่านให้เจ้าของบัญชีเก็บเอง
- เพิ่มสิทธิ์ผ่าน SQL Editor เท่านั้น ตัวอย่างต่อไปนี้ต้องเปลี่ยน UUID เป็นของผู้ใช้จริงที่ตรวจแล้ว:

```sql
insert into public.dsr_members (user_id, role)
values ('UUID_FROM_AUTHENTICATION_USERS', 'owner');
```

สมาชิกเครื่องอื่นเพิ่มเป็น `editor` ด้วยขั้นตอนเดียวกัน ห้ามเปิดให้ผู้ใช้เพิ่มสิทธิ์ตัวเอง และห้ามใช้เงื่อนไขแค่มีบัญชี Google แล้วเข้าถึงข้อมูลบริษัทได้

## ขั้นที่ 3: เชื่อมเว็บและย้ายข้อมูลอย่างชัดเจน

Frontend adapter ใช้ `dsr-cloud.js` มี memory draft layer เดิมครอบอยู่ การเชื่อมต่อสาธารณะอยู่ใน `cloud-config.js` มีเฉพาะ Project URL และ Publishable key ซึ่งไม่ได้ให้สิทธิ์อ่านธุรกิจหากยังไม่ล็อกอินและไม่ได้เป็นสมาชิก

- เก็บสำรอง JSON ของทุกเครื่องก่อน แล้วเลือกชุดข้อมูลหลักเพียงชุดเดียว
- ให้เจ้าของนำเข้าข้อมูลเมื่อฐานข้อมูลยังว่าง รักษา `__backendId` และเลขเอกสารเดิม
- ทดสอบสองเครื่อง: เครื่อง A บันทึก → เครื่อง B โหลดข้อมูลล่าสุด → ตรวจรายการและยอดเงิน ก่อนเลิกใช้ข้อมูลแยกเครื่อง
- ถ้าเครือข่ายล้มเหลว ห้ามแจ้งว่าบันทึกสำเร็จ และต้องเก็บฉบับร่างไว้ให้ลองใหม่
- ถ้าเวอร์ชันชนกัน ห้ามดึงเวอร์ชันล่าสุดมาใส่แล้วบังคับเขียนทับ ต้องเก็บฉบับร่างเพื่อเปรียบเทียบและจัดการความขัดแย้ง

Sessions อยู่ในหน่วยความจำของ SDK (`persistSession:false`) ไม่บันทึก access token, refresh token หรือรหัสผ่านใน localStorage/IndexedDB/JSON ผู้ใช้ต้องเข้าสู่ระบบใหม่เมื่อเปิดหรือรีโหลดหน้า ข้อมูลธุรกิจเดิมในเครื่องยังเก็บในฐานเดิม แต่ข้อมูลกลางที่อ่านเข้ามาไม่เขียนทับฐานเดิม

การกดบันทึกทั้งชุดใช้ optimistic version check เลขเอกสารที่เตรียมในฉบับร่างอาจชนกับอีกเครื่อง แต่ทั้งชุดของเครื่องที่ถือเวอร์ชันเก่าจะถูกปฏิเสธพร้อมเก็บฉบับร่างไว้ จึงไม่รวมเลขที่ทั้งสองเครื่องจองไว้เข้าฐานกลางพร้อมกัน การจองไม่เขียนฐานกลางก่อนผู้ใช้กดบันทึก

SDK ทางการ `@supabase/supabase-js` 2.118.0 ถูก vendor ใน assets พร้อม MIT license, registry integrity และ bundle SHA-256 ที่ตรวจแล้ว dependency graph อยู่ใน lockfile ของ tools/cloud-tests ตรวจด้วย npm audit ก่อนปล่อยรุ่น

## สัญญา API v1

ชุดข้อมูลกลางเป็น JSON หนึ่งชุด (`dsr-main`) ประกอบด้วย records และ config เก็บข้อมูลที่ใช้สร้างเอกสาร ไม่เก็บไฟล์ PDF

`dsr_read(p_known_version bigint = -1)` คืน `{version, updated_at, role, unchanged, payload}` หากเวอร์ชันไม่เปลี่ยนจะไม่ส่ง JSON ซ้ำ

`dsr_save(p_request_id uuid, p_expected_version bigint, p_payload jsonb)` คืน `{version, replayed}`

- `payload` เป็น DSR_OFFLINE_BACKUP version 2 มี records array และ config object
- จำกัด 8 MiB ต่อชุด และ 10,000 records เป็นเพดานของ implementation นี้ ไม่ใช่โควตาของ Supabase Free
- ทุก record ต้องมี backend ID ไม่ซ้ำ และมี record_type
- `p_expected_version` เป็นเวอร์ชันที่โหลดมาก่อนเริ่มแก้ไข
- สร้าง UUID หนึ่งครั้งต่อเจตนาบันทึก เก็บ UUID และ payload เดิมไว้เมื่อ timeout แล้วลองซ้ำ ใช้ UUID เดิมกับ payload ใหม่ไม่ได้
- การบันทึกเป็น transaction เดียว มี row lock และ receipt ที่มี unique primary key การ retry ไม่สร้างข้อมูลซ้ำ
- Receipt เก็บเพียง UUID ของผู้ใช้ hash และเวอร์ชัน ไม่คัดลอก payload เก็บย้อนหลัง และไม่ลบทิ้งอัตโนมัติเพื่อรักษาความปลอดภัยของ retry
- Error code PostgreSQL: `42501` ไม่มีสิทธิ์, `22023` ข้อมูลไม่ถูกต้อง/ใช้ UUID ซ้ำผิดเจตนา, `40001` เวอร์ชันชนกัน ข้อความขึ้นต้น `DSR_` ใช้แยกสาเหตุ

การส่ง JSON ทั้งชุดทุกครั้งเหมาะเป็นจุดเริ่มต้นสำหรับทีมเล็กที่กดบันทึกเป็นครั้ง ๆ ไม่ส่งทุกการพิมพ์ ต้องติดตามขนาดข้อมูลและ data transfer ของแผนฟรีจริง ไม่มีการรับประกันพื้นที่หรือการใช้งานไม่จำกัด

## ตรวจสอบก่อนเปิดจริง

ทดสอบ SQL แบบแยกฐานข้อมูลด้วย PostgreSQL WASM:

```sh
cd tools/cloud-tests
npm ci --ignore-scripts
npm test
npm audit
```

ครอบคลุม anonymous/non-member, การยกระดับสิทธิ์ตัวเอง, owner-only initial import, ID/company preservation, stale writer, idempotent retry หลังเครื่องอื่นบันทึก, UUID reuse, validation, empty replacement, unchanged read และ migration rerun

การทดสอบนี้ไม่ได้พิสูจน์การตั้งค่า Supabase Auth, API routing หรือการเชื่อมต่อกับโปรเจกต์จริง ต้องตรวจบนโปรเจกต์อีกครั้ง เมื่อเตรียม auth และเว็บพร้อมแล้ว
