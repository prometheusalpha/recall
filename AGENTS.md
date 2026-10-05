- Với các yêu cầu tính năng mới, hãy tham khảo ../dbx để xem dbx làm gì và có thể làm theo không
- Tham khảo GUIDELINE.md cho cấu trúc thư mục, folder và tech
- TUYỆT ĐỐI KHÔNG Co-Author trong git commit
- Ưu tiên subagent cho các task dài / độc lập
- Cố gắng giữ do các file không vượt quá 1000 dòng, nếu vốn đã vượt quá 1000 dòng thì cố gắng không để nó thêm quá dài
- KHÔNG tự ý ngắt dòng markdown / code comment
- Comment nên ngắn gọn, không dài hơn 5-10 dòng

# Tech
- Đây là repo electronbun + TS + Vue
- Ưu tiên dùng tailwindcss cho styling nếu có thể
- Ưu tiên tách hooks/composables/vue component nếu có thể

# Verify
- Đừng tin báo cáo "đã sửa xong" của subagent. `bun run typecheck` xanh chỉ chứng minh code compile, không chứng minh bug hết
- Mọi khẳng định về nguyên nhân bug phải kèm dòng code hoặc số liệu chạy thật
- Không có test suite. Muốn chắc thì dựng DB thật (docker/orbstack) và chạy driver của project, đừng đoán
- Sửa xong thì báo user test trước khi tick checkbox trong TODO.md

# Đừng báo xong khi chưa chạy
- User báo "vẫn lỗi" thì mình sai. Đọc lại code từ đầu, đừng suy ra từ giả định cũ
- Chạy `hutch electrobun dev` thì KHÔNG tự build renderer. Phải `vite build` trước, nếu không user test code cũ và báo vẫn lỗi
- Đừng kết luận về connection nào hỏng từ 1 dòng log. Xác định đúng profile trước (xem `sqlite3 ~/Library/Application\ Support/app.recall.desktop/recall.db "SELECT * FROM connections"`)