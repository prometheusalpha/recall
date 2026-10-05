Phase 1:
- Khi mở app thì sẽ báo lỗi no open connection for id với connection của cái table đang mở
- Chữ NULL mờ khi cell null
- Nút new connection ở sidebar khi connection trống không bấm được, bấm k ra gì
- nút dấu + ở sidebar connection cũng k bấm được 
- Thêm nút định vị current tab trong sidebar (focus active ấy)
- Thiếu menu edit connection

Phase 2:
- Nút new tab (dấu +) đang không căn giữa với các tab
- Khi bật dropdown của table ở sidebar thì không load vội cái gì mà chỉ khi mở drop down bên trong thì mới load cái bên trong
  - Phần foreign key và trigger load rất lâu
- Không tự sort khi bấm tên cột mà đưa vào context menu

Phase 3:
- Context ở file sql
- Area run sql
- [x] Mnemonic bookmark — `Ctrl+Shift+<chữ/số>` gán, `Ctrl+<chữ/số>` nhảy, `Ctrl+F11` rồi gõ ký tự cũng gán được; lưu trong SQLite của app, xoá file là mất
- Global search

Phase 4:
- [x] CRUD file trong sidebar quản lý file, bao gồm rename, cut copy paste, delete, save các thể loại
- [x] Run selection khi cmd enter
- [x] Autosave sql file
- [x] Bottom border cho màn sql, ngăn cách editor và result set 
- [x] Phần run against trong sql editor ấy, phần list connection và database chưa có height limit + scroll

Phase 5:
- Nút reconnect connection ở context menu connection 
- Phần bên ngoài của modal create/edit connection trắng quá, cho đen lại 
- Border phải của cột ngoài cùng bị thiếu
- Icon của connection hiển thị loại db (Icon của mysql / postgres)

Phase 6:
- [x] Pin row number ở bên trái khi scroll ngang
- [x] Bug khi select cell cột cuối thì row number cell highlight lên
- [x] Border ngăn cách editor và result ở màn sql chưa rõ ràng, và cần thêm khả năng kéo resize

Phase 7:
- [x] Kéo thả phần resize trên dưới ở màn sql editor lại select text trong editor
- [x] 7.2. Khi đặt cursor vào 1 query thì border câu query to đó, và khi cmd enter thì chỉ chạy câu query đó (giống datagrip)
- [x] Kéo thả vị trí cột

Phase 8:
- [x] Toast góc dưới phải, trông UI đẹp hơn
- [x] Khi cuộn ngang table grid sang tận cùng bên phải mà tận cùng bên phải có scroll bar thì sẽ bị lệch với thành row header phía trên
- [x] Bỏ cái phần 4 cái pill result-context-pill đi, mục Columns ở bên phải chúng nó thì cho xuống cạnh nút refresh. Bỏ cái All rows cạnh where đi
- [x] Chọn cell rồi dùng phím mũi tên để di chuyển selection sang bên phải ngoài màn hình thì scroll không theo

Phase 9:
- [x] 9.1. 1 nút là folder sidebar toggle ở bên trái nút light/dark mode, thay cho nút collapse ở right sidebar, sử dụng icon folder-tree của lucide
- [x] 9.2. Chuyển cái nút search đang ở bên trái nút collapse left sidebar sang ở bên trái cái nút định làm ở trên
  - [x] 1 điểm: input của cái phần search này đang không có padding left, placeholder đang bị dính vào bên trái của text input
- [x] 9.3. Phần border của 7.2 thiết kế lại, phải bo đủ 4 border, có màu, và chỉ bo đến cái ký tự xa nhất về phía bên phải
- [x] Cell tự resize theo width của nội dung (có 1 min / max nào đó)
- [x] Paging ở màn table result grid

Phase 10:
- [x] Keyboard shortcuts mechanism / settings, nhất là close others, next/previous tab, close tab

Phase 11:
- [x] Search tên bảng không ra
- [x] Khi dùng phím left right để chuyển selection sang cell tận cùng bên trái trong table grid thì lại không cuộn hết hẳn sang trái
- [x] ctrl + shift + up/down key (macos) để sort cột
- [x] Hover column / index hiện ra tooltip với nội dung k bị cắt mất khi quá dài

Phase 12:
- [x] Sum selection ở query result / table grid, bỏ qua invalid
- [x] Auto suggest field / table ở editor (code mirror autocomplete logic, tham khảo dbx)
- [x] 12.3 Gợi ý cột ở where và order by, sửa giao diện
- [x] Bỏ nút refresh thay bằng cmd + r

Phase 13:
- Các field thời gian bị null toàn bộ, kể cả sql editor result và table grid
  - Nguyên nhân: Cottontail 0.7.1 đóng gói Bun 1.3.10, `parsePostgresTimestamp` đưa text `timestamptz` vào `Date.parse`. Postgres render offset tròn giờ thành `+00` (không có phút) — JSC từ chối chuỗi đó → Invalid Date → `toJsonSafe` đổi thành `null`. Chỉ `timestamptz` chết, `timestamp` sống vì hàm tự thêm `Z`
  - Đã ép session `timezone=+05:45` trong `src/bun/drivers/postgres.ts`. Offset có phút thì Postgres render dài ra nên `Date.parse` hiểu được. `+07` không dùng được vì Postgres luôn render offset ngắn nhất từ giá trị thật
  - Xoá workaround khi Cottontail bản mới hơn bundle fix từ oven-sh/bun#35505 (merged 2026-08-24, tự tách component offset thay vì gọi `Date.parse`). Chưa biết Cottontail bản nào bundle Bun >= 1.4.2 — Cottontail private, không tra được danh sách version. Nâng phải nâng cả `hutch` lẫn `cottontail` trong `hutch.config.ts`, vì `cottontail=0.7.1` đang pin và cũng là default của hutch 0.27.1
  - Side effect đã biết: `now()::timestamp` và `to_char(now(), ...)` trả giờ +05:45 thay vì giờ server. Ô `timestamptz` trong grid không đổi vì đã ép về UTC. Nếu profile tự set `timezone` trong `urlParams` thì giá trị đó thắng — kể cả `+09:00`, và `timestamptz` sẽ null lại

Phase 14:
- Auto limit trong sql editor 
- Keyboard short cut sort cột 

Sau:
- Màn loading 
- Cơ chế update
- Redis support