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
- Paging ở màn table result grid
- Keyboard shortcuts mechanism / settings, nhất là close others
- Kéo thả phần resize trên dưới ở màn sql editor lại select text trong editor
- Khi đặt cursor vào 1 query thì border câu query to đó, và khi cmd enter thì chỉ chạy câu query đó (giống datagrip)

Sau:
- [x] Mnemonic bookmark có thể nhảy vào khi k mở file chứa cái mnemonic đó (Chưa work)
- Kéo thả vị trí cột
- Auto suggest field / table ở editor
- Gợi ý cột ở where và order by
- Redis support