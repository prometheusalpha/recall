- Với các yêu cầu tính năng mới, hãy tham khảo ../dbx để xem dbx làm gì và có thể làm theo không
- KHÔNG tự ý hard-wrap markdown / code comment
- Tham khảo GUIDELINE.md cho cấu trúc thư mục, folder và tech
- TUYỆT ĐỐI KHÔNG Co-Author trong git commit
- Ưu tiên subagent cho các task dài / độc lập
- Cố gắng giữ do các file không vượt quá 1000 dòng, nếu vốn đã vượt quá 1000 dòng thì cố gắng không để nó thêm quá dài
- Comment nên ngắn gọn, không dài hơn 5-10 dòng
- Ưu tiên lưu local sqlite hơn là local storage

# Tech
- Đây là repo electronbun + TS + Vue
- Ưu tiên dùng tailwindcss cho styling nếu có thể
- Ưu tiên tách hooks/composables/vue component nếu có thể

# Verify
- Đừng tin báo cáo "đã sửa xong" của subagent. `bun run typecheck` xanh chỉ chứng minh code compile, không chứng minh bug hết
- Mọi khẳng định về nguyên nhân bug phải kèm dòng code hoặc số liệu chạy thật
- Có test harness, xem `# Test`. Muốn chắc về DB thì dựng DB thật (docker) và chạy driver của project, đừng đoán
- Sửa xong thì báo user test trước khi tick checkbox trong TODO.md

# Test
- Chạy test bằng `bun run test`. KHÔNG dùng `hutch run test`.
- `hutch run` chạy lệnh bằng runtime Cottontail (bun 1.3.10). `bun test` ở đó nạp file nhưng collect 0 test và exit 0, tức là false green. Đừng thêm task `test` vào `hutch.config.ts`.
- Test nằm trong `tests/`, tên `*.test.ts` (bun cũng chạy `*.spec.ts`). `bunfig.toml` pin `root = "./tests"`.
- `tsconfig.json` include `tests`, nên `vue-tsc` soi cả file test. `noUnusedLocals` và `noUnusedParameters` áp dụng cho test như code thường.
- Import trong test dùng đường dẫn tương đối `../src/...`, hoặc alias `@/` và `@shared/`.
- Test chạy trên bun 1.4.2. App chạy bun 1.3.10 trong Cottontail. Test xanh không chứng minh app xanh.
- Muốn kiểm chứng đúng runtime của app thì viết script `.ts` thường, gọi qua một task trong `hutch.config.ts`, chạy `hutch run <task>`. Cách đó chạy được, chỉ `bun test` là không.
- Integration test cần DB thật: `docker compose up -d postgres`, rồi đặt `RECALL_TEST_PG_URL`. Thiếu biến thì `test.skip`, đừng để suite đỏ vì thiếu docker.
- Chưa có cơ chế cô lập `appDb`. Đừng gọi nó trong test, nó mở DB thật ở `~/Library/Application Support/app.recall.desktop/recall.db`.
- Muốn cô lập bằng `HOME` thì phải set lúc spawn process. Bun cache `homedir()` lúc start, set trong test file không ăn.
- `credentialStore` ghi Keychain thật. Không test.
- Insert bytea trong test thì dùng `decode('00ff','hex')`. Literal `'\x00ff'` làm bun 1.4.2 lỗi protocol `insufficient data left in message`.
- `package.json` đang có `--pass-with-no-tests` để `bun run test` không đỏ khi `tests/` rỗng. Có test thật đầu tiên thì bỏ cờ này.

# Đừng báo xong khi chưa chạy
- User báo "vẫn lỗi" thì mình sai. Đọc lại code từ đầu, đừng suy ra từ giả định cũ
- Chạy `hutch electrobun dev` thì KHÔNG tự build renderer. Phải `vite build` trước, nếu không user test code cũ và báo vẫn lỗi
- Đừng kết luận về connection nào hỏng từ 1 dòng log. Xác định đúng profile trước (xem `sqlite3 ~/Library/Application\ Support/app.recall.desktop/recall.db "SELECT * FROM connections"`)