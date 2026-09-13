# Matematika sayti — Supabase sozlash

Bu sayt Arab va Chinese saytlari bilan bir xil Supabase loyihasidan foydalana oladi.
Uning ma’lumotlari alohida `math_students`, `math_questions`, `math_app_settings` jadvallarida saqlanadi.

1. Supabase Dashboard'da **SQL Editor** ni oching.
2. `supabase-schema.sql` faylidagi SQL kodni nusxalab, **Run** ni bosing.
3. Lokal `.env` fayliga quyidagini qo‘shing:

   ```text
   SUPABASE_URL=https://pxxlluithjwnfofnzhya.supabase.co
   SUPABASE_SECRET_KEY=sb_secret_...
   ```

4. Mavjud lokal savollar, o‘quvchilar va sozlamalarni bir marta import qilish uchun:

   ```powershell
   npm run migrate:supabase
   ```

5. Matematika Render Web Service -> **Environment** bo‘limiga `SUPABASE_URL` va
   `SUPABASE_SECRET_KEY` ni qo‘shing. Start Command `npm start` bo‘lib qoladi.
6. GitHub'ga kodni push qilib, Render’da deploy qiling.

Secret key maxfiy. Uni GitHub'ga va brauzer JavaScriptiga kiritmang.
