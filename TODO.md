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
- [x] ctrl + shift + up/down key (macos) để sort cột (không phải nút option đâu)
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
  - Side effect đã biết: `now()::timestamp` và `to_char(now(), ...)` trả giờ +05:45 thay vì giờ server. Ô `timestamptz` trong grid không còn phụ thuộc workaround này: nó đọc qua text rồi renderer đổi sang +07, nên session timezone lệch múi nào cũng hiện đúng. Nếu profile tự set `timezone` trong `urlParams` thì giá trị đó thắng

- [ ] Grid thiếu microsecond: Bun decode `timestamptz`/`timestamp` thành `Date` nên cắt còn ms. Giờ đọc 2 cột đó qua text: `to_jsonb(col) #>> '{}'` cho `timestamptz`, `::text` cho `timestamp` (`textFidelitySql` trong `src/bun/drivers/postgres.ts`), renderer gắn `+07` và giữ nguyên phần microsecond (code xong, chờ test trong app)
  - Probe tên cột giờ chỉ đọc plan (`LIMIT 0`), trước đây chạy body thật thêm 1 lần cho mỗi statement
  - Chỉ áp cho statement đọc. `INSERT/UPDATE ... RETURNING`, `EXPLAIN`, câu bị probe từ chối (trùng tên cột), và MySQL vẫn đi đường cũ (ms)
  - `date` giữ nguyên `2026-01-01T00:00:00.000Z`, chưa đụng vì không liên quan microsecond

Phase 14:
- Sum selection skip mọi số valid
- Thêm cơ chế select + shift + select another cell -> select range, ở cả result grid và table grid
- Cột tự điều chỉnh width theo nội dung / title, có min max nhất định
- Format sql
- Tab auto width

Phase 15:
- Highlight màu text cột theo kiểu dữ liệu
- Suggest field trong editor
- Nới đôi thanh WHERE / ORDER BY, thêm Cmd+L để focus vào input WHERE

Phase 16:
- Pin table trong sidebar
- Generate sql row insert, trong context menu khi chuột phải vào row number 
- Generate table ddl sidebar context menu
- Cancel connect dial sidebar context menu

Phase 17:
- [x] Explain plan viewer (code xong, chờ test trong app): `EXPLAIN (FORMAT JSON)` cho Postgres, `EXPLAIN FORMAT=JSON` cho MySQL, không chạy câu lệnh; canvas + tree + raw, `Opt/Ctrl+Shift+E` hoặc nút Explain cạnh Run, switcher Result | Explain trên result pane
  - MySQL 26.7.0 chỉ trả document `query_plan`; parser còn nhánh `query_block` cho server cũ nhưng chưa có server cũ để test
  - MySQL UPDATE/DELETE qua `FORMAT=JSON` chỉ ra `<not executable by iterator executor>`; muốn đủ phải thêm fallback `EXPLAIN` dạng bảng như dbx

Sau:
- Xuống dòng trong cell
- Sửa nút count là kết quả query chứ k phải size cả bảng (code xong, chờ test trong app)
- copy raw plan / tree (code xong, chờ test trong app)
- Sidebar index: tooltip hiện condition của partial index, context menu Copy DDL (code xong, chờ test trong app)
- Khoảng trống dưới sql editor (code xong, chờ test trong app)
- Sửa: khi reload table thì mất thứ tự code đã thay đổi
- Connection để idle bị ngắt nhưng UI vẫn báo connected và không tự nối lại (code xong, chờ test trong app)
  - Nguyên nhân: NAT/firewall reap socket im lặng (không FIN, không RST) nên Bun không bắn `onclose`, pool vẫn giữ session, renderer vẫn `connected`. Request kế tiếp ghi vào socket chết rồi treo tới khi kernel bỏ cuộc — đo trên proxy TCP reap im lặng: **quá 300s** không trả lỗi, sau đó mới ra `Operation timed out`
  - Sửa trong `src/bun/connectionPool.ts`: `profiles` giữ lại `ConnectionConfig` (xoá khi user disconnect) để request thiếu session thì tự mở lại (`openPrimary`) thay vì ném "No open connection"; `handOut` probe session đã idle ≥ 5s (`probeAlive`, cap 5s) và thay session chết bằng session mới, chỉ chạy khi `inFlight = 0` nên không cắt query đang chạy
  - Đo lại: idle 8s rồi request → xong sau 5s, không có toast "Connection lost" giả; query `pg_sleep(12)` đang chạy không bị probe/giết; server đóng socket thật vẫn báo `Connection closed` như cũ; disconnect tay không bị tự mở lại
  - Toast "Connection lost: Connection closed" giả lần 2: khi probe thất bại và session bị thay, `onclose` của socket cũ bắn **sau** khi session mới đã đăng ký cùng key; guard cũ chỉ hỏi `connections.get(key) === undefined` nên nó xoá luôn session mới rồi báo lost (UI mất kết nối, lần request sau phải mở lại). Sửa: so identity `connections.get(key) !== live` trong `src/bun/connectionPool.ts`. Test `tests/connectionPoolReplacement.test.ts` (cần `docker compose up -d postgres` + `RECALL_TEST_PG_URL`): proxy TCP nuốt packet không đóng socket, idle 5s, request → trước fix losses = `["Connection closed"]` và `isConnected = false`, sau fix losses rỗng và session mới chạy tiếp
  - Không replay statement: `WITH x AS (INSERT … RETURNING *) SELECT …` vẫn là "read" theo `isReadStatement` nên chạy lại sẽ nhân đôi dữ liệu
- Màn loading 
- Cơ chế update
- Redis support