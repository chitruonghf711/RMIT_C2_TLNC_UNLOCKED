# Kịch bản Trình diễn 2 Phút & Lời thuyết minh (Demo Script) — CaseBridge

> **Lưu ý trước khi bắt đầu:** Chạy `npm run db:reset && npm run dev` và mở `http://localhost:3000/workspace`. Thanh công cụ đầu trang cho phép chuyển nhanh giữa các nhân vật (tự động ký mỗi yêu cầu bằng WebCrypto ES256 DPoP) hoặc bấm **Khôi phục dữ liệu mẫu** bất kỳ lúc nào.

---

## Phút 0:00 – 0:25 | Bàn điều phối & Tóm tắt AI có trích dẫn nguồn (Ca A)

- **Nhân vật đang chọn:** `BS. Nguyễn Minh Khoa` (`referring_clinician` — Phòng khám Đa khoa An Bình).
- **Thao tác trên màn hình:**
  1. Tại `/workspace`, quan sát 4 thẻ chỉ số thời gian xử lý thực tế tính từ cơ sở dữ liệu SQLite (`Section 19`).
  2. Bấm vào **Ca A (`CB-AB-2026-014`)**: *"Ho kéo dài 5 tuần kèm bóng mờ dạng nốt thùy trên phổi phải & khó thở gắng sức"* -> chuyển tới `/cases/CASE-DEMO-001/prepare`.
  3. Tại cột trái, bấm vào từng đoạn văn bản gốc `#S-001`, `#S-002` của `DOC-DEMO-001` và `DOC-DEMO-002`.
  4. Tại cột phải (Tab **1. Tóm tắt AI & Chốt gói**), quan sát 4 phần tóm tắt đều gắn nhãn trích dẫn `[DOC-DEMO-001 v1 #S-001]`, mục **Thông tin còn thiếu (`Unknowns`)** nằm riêng biệt (không tự trộn thành y lệnh xét nghiệm), và tham khảo nhanh **Kho ca tham khảo nội mạng (P1)**.
- **Lời thuyết minh tiếng Việt:**
  > *"Tại tuyến cơ sở, bác sĩ Khoa tiếp nhận một bệnh nhân ho kéo dài 5 tuần kèm bóng mờ thùy trên phổi phải từ nhiều ghi chú rời rạc. Thay vì gửi một tin nhắn mơ hồ, CaseBridge chuẩn hóa tài liệu thành từng đoạn có mã định danh và tạo bản tóm tắt mà mọi mệnh đề đều bắt buộc gắn trích dẫn nguồn thực tế. Những thông tin chưa có trong hồ sơ—như mức độ tuân trị hay phim X-quang cũ cách 6 tháng—được tách bạch vào mục Thông tin còn thiếu chứ AI tuyệt đối không tự bịa dữ kiện."*

---

## Phút 0:25 – 0:55 | Nhận định lâm sàng, Gợi ý xét nghiệm có kiểm chứng & Xác nhận gói song song

- **Thao tác trên màn hình:**
  1. Chuyển sang Tab **2. Nhận định & Kế hoạch Xét nghiệm** trên màn hình `/cases/CASE-DEMO-001/prepare`.
  2. Quan sát **Nhận định lâm sàng sơ bộ (`ClinicalAssessment v1`)** của BS. Khoa đã lưu.
  3. Bấm **Tạo đề xuất xét nghiệm có kiểm chứng**.
  4. Quan sát 3 đề xuất từ danh mục giới hạn (`TestCatalogEntry`), trong đó:
     - **Hô hấp ký có giãn phế quản (`SPIRO_POST_BD`)**: Trạng thái `SUPPORTED`, gắn trích dẫn đoạn hồ sơ bệnh nhân + hướng dẫn lâm sàng (`DEMO_ONLY`). Bấm **Phê duyệt (`APPROVED`)**.
     - **CT ngực độ phân giải cao (`HRCT_CHEST_NON_CONTRAST`)**: Tự động gắn cờ cảnh báo trùng lặp `POSSIBLE_DUPLICATE_NEEDS_REVIEW` vì hồ sơ đã ghi nhận phim X-quang ngực cách 2 tuần. Bấm **Hoãn (`DEFERRED`)** hoặc **Từ chối (`REJECTED`)**.
  5. Bấm **Xác nhận kế hoạch xét nghiệm (`TestPlanVersion v1`)** -> sau đó bấm **Tạo chỉ định mô phỏng (`MockTestOrder`)** (hệ thống bảo vệ idempotency chống bấm đúp).
  6. Quay lại Tab **1. Tóm tắt AI & Chốt gói**, tích chọn ô xác nhận của bác sĩ và bấm **Chốt gói hội chẩn (`ReferralSnapshot v1`) & Tìm chuyên gia**.
- **Lời thuyết minh tiếng Việt:**
  > *"Trước khi hệ thống được phép gợi ý cận lâm sàng, bác sĩ Khoa phải lưu Nhận định lâm sàng sơ bộ. Mỗi gợi ý xét nghiệm chỉ được lấy từ danh mục chuẩn, phải trích dẫn cả bằng chứng bệnh nhân lẫn tài liệu hướng dẫn và tự động cảnh báo khi hồ sơ đã có X-quang hoặc kết quả Eosinophil. Bác sĩ duyệt từng mục, tạo kế hoạch bất biến và gửi hội chẩn chuyên gia ngay lập tức mà không bị chặn chờ kết quả xét nghiệm."*

---

## Phút 0:55 – 1:25 | Tìm người nhận có giải thích & Quản trị Tide QEA (Ca A, Ca B, Ca C)

- **Thao tác trên màn hình:**
  1. Tại màn hình `/cases/CASE-DEMO-001/match` (**Tìm người nhận có giải thích**):
     - Quan sát danh sách **Đủ điều kiện**: **PGS.TS. Trần Quốc Bảo** xếp hạng #1 (điểm `86.7`: khớp chuyên khoa Hô hấp `40`, lịch sẵn sàng `30`, sức chứa còn trống `2/3` = `13.3`, khớp chủ đề), kế tiếp là **ThS.BS. Hoàng Lan Anh** (ứng viên dự phòng).
     - Quan sát danh sách **Không đủ điều kiện** có giải thích minh bạch: **TS.BS. Lê Thu Hà** bị loại vì đang bận tối đa (`3/3` ca mở); **BS.CKI. Phạm Hoàng Nam** bị loại vì chưa có quyền `network_consultant` do yêu cầu Tide QEA mới đạt `1/2` chữ ký; **TS.BS. Đỗ Văn Hùng** bị loại do lệch chuyên khoa (`Nội tiết`).
  2. Tích chọn **Bật tự động chuyển tiếp dự phòng (`fallback_enabled`)** tới ThS.BS. Hoàng Lan Anh và bấm **Gửi lời mời hội chẩn**.
  3. Mở nhanh `/network/governance` để thấy yêu cầu QEA trực tiếp từ TideCloak (`b9cef8cc-cc88-4af2-8b9c-eece1800b640`) và công thức quorum `max(1, floor(0.7 * 3)) = 2`.
- **Lời thuyết minh tiếng Việt:**
  > *"Ở bước tìm chuyên gia, CaseBridge không dùng hộp đen: hệ thống chấm điểm minh bạch từng tiêu chí và giải thích rõ vì sao bác sĩ Hà bị loại do đã đầy tải 3/3 ca, hay vì sao bác sĩ Nam chưa được nhận ca liên cơ sở do yêu cầu cấp quyền network_consultant trên TideCloak QEA mới có 1 trên 2 chữ ký quản trị viên độc lập."*

---

## Phút 1:25 – 2:00 | Hộp thư chuyên gia, Chấp nhận nguyên tử & Đóng vòng hội chẩn

- **Thao tác trên màn hình:**
  1. Trên thanh công cụ đầu trang, chuyển nhân vật sang **`PGS.TS. Trần Quốc Bảo`** (`consulting_specialist`) và mở `/specialist/inbox`.
  2. Quan sát thẻ lời mời chỉ hiển thị **Tóm tắt tối giản (`preview_summary`)** (ẩn định danh gốc và tài liệu thô trước khi nhận ca).
  3. Bấm **Chấp nhận nhận ca** -> hệ thống thực thi giao dịch nguyên tử (`BEGIN IMMEDIATE`) và mở `/consultations/[id]`.
  4. Trong **Phòng hội chẩn**, PGS. Bảo xem toàn bộ gói `ReferralSnapshot`, có thể gửi **Yêu cầu bổ sung thông tin (`NEEDS_INFO`)** hoặc điền **Phản hồi chuyên môn có cấu trúc** trả lời từng câu hỏi và bấm **Gửi phản hồi chính thức (`ANSWERED`)**.
  5. Chuyển lại nhân vật **`BS. Nguyễn Minh Khoa`**, xem khuyến nghị của chuyên gia và bấm **Hoàn tất & Đóng ca hội chẩn (`CLOSED`)**.
- **Lời thuyết minh tiếng Việt:**
  > *"Trước khi nhận ca, chuyên gia chỉ thấy bản tóm tắt tối giản để bảo vệ quyền riêng tư bệnh nhân. Ngay khi PGS. Bảo chấp nhận lời mời qua giao dịch nguyên tử, phòng hội chẩn mở ra với đầy đủ trích dẫn nguồn, kế hoạch xét nghiệm đã duyệt và luồng phản hồi có cấu trúc. Bác sĩ tuyến dưới nhận được câu trả lời sát mục tiêu và đóng ca khép kín toàn bộ vòng đời hội chẩn."*
