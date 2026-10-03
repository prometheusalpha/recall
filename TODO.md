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
- CRUD file trong sidebar quản lý file, bao gồm rename, cut copy paste, delete, save các thể loại
- Run selection khi cmd enter
- Autosave sql file
- Bottom border cho màn sql, ngăn cách editor và result set 
- Phần run against trong sql editor ấy, phần list connection và database chưa có height limit + scroll

Phase 5:
- Mnemonic có thể nhảy khi k mở file
- Paging table result grid

Sau:
- Kéo thả vị trí cột
- Gợi ý cột ở where và order by