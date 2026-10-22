# CaseBridge — Từ hồ sơ rời rạc đến đúng chuyên gia

## Giới thiệu theo 5 tiêu chí đánh giá (<= 300 từ)

- **Tầm nhìn & tính nguyên bản (Vision & originality):** CaseBridge giải quyết điểm nghẽn trước và trong hội chẩn liên cơ sở ở tuyến dưới: hồ sơ rời rạc, câu hỏi mơ hồ, kế hoạch cận lâm sàng ban đầu chưa gắn bằng chứng và việc tìm chuyên gia phụ thuộc quen biết cá nhân. Thay vì tạo một mạng xã hội y tế đại trà hay chatbot tự chẩn đoán, CaseBridge biến dữ liệu rời rạc thành gói hội chẩn có trích dẫn nguồn, tách biệt phần chưa biết, hỗ trợ lập kế hoạch xét nghiệm có bác sĩ duyệt và điều phối tới đúng chuyên gia khả dụng.
- **Thấu hiểu ràng buộc tin cậy (Trust constraint insight):** Chia sẻ bệnh án liên cơ sở và cấp quyền chuyên gia tham vấn không thể dựa trên một quản trị viên đơn lẻ tự sửa cơ sở dữ liệu ứng dụng. Mọi dữ liệu lâm sàng chỉ được mở theo phạm vi ca bệnh đã chấp nhận.
- **Giá trị & tác động (Value & impact):** Giúp bác sĩ tuyến dưới chuẩn bị ca bệnh nhanh hơn, giảm vòng hỏi lại thông tin cơ bản, tránh bỏ sót hoặc trùng lặp xét nghiệm và minh bạch hóa lý do chọn hay loại từng chuyên gia.
- **Vì sao TideCloak quan trọng (Why TideCloak matters):** TideCloak bảo vệ danh tính người dùng bằng JWT xác thực qua JWKS, ràng buộc token với khóa DPoP chống đánh cắp/phát lại và áp dụng Quản trị thực thi theo ngưỡng (QEA) với công thức `max(1, floor(0.7 * N))` cho quyền nhạy cảm `network_consultant`.
- **Nguyên mẫu & câu chuyện kiểm chứng (Prototype & storytelling):** Bản mẫu hoạt động trọn vẹn qua 3 ca bệnh mẫu (Ca A luồng chính, Ca B làm rõ câu hỏi mơ hồ, Ca C không có chuyên gia khả dụng do bận hoặc chờ duyệt QEA) cùng bộ kiểm thử tự động `A01–A24`.

---

## 1. Kiến trúc tổng quan & Ranh giới trung thực của MVP

CaseBridge được xây dựng bằng **Next.js 16 (App Router, TypeScript)**, **Tailwind CSS v4**, **SQLite (`node:sqlite`)** với khóa giao dịch `BEGIN IMMEDIATE TRANSACTION`, và tích hợp **TideCloak (`@tidecloak/nextjs@0.14.17`)** cùng xác thực **RFC 9449 DPoP** (`verifyDpop.ts`).

### Ranh giới chức năng & an toàn lâm sàng
- **Dữ liệu giả lập (Synthetic Only):** Toàn bộ hồ sơ bệnh án, kết quả xét nghiệm và ca tham khảo trong hệ thống là dữ liệu giả lập phục vụ trình diễn kỹ thuật; tuyệt đối không dùng cho bệnh nhân thật hoặc cấp cứu.
- **AI có kiểm chứng nguồn (Grounded AI Assist):**
  - Mọi mệnh đề tóm tắt (`summary_sections`) bắt buộc gắn trích dẫn `[DOC_ID vX #S-YYY]` tồn tại thực sự trong phiên bản tài liệu nguồn hiện tại (`A01`, `A02`).
  - Mục **Thông tin còn thiếu (`Unknowns`)** chỉ liệt kê dữ kiện chưa có trong hồ sơ, tách biệt hoàn toàn khỏi mục **Đề xuất xét nghiệm** (`A03`, `A17`).
  - Gợi ý xét nghiệm chỉ được chọn từ danh mục giới hạn (`TestCatalogEntry`, 7 mã xét nghiệm demo) và phải trích dẫn cả bằng chứng bệnh nhân lẫn tài liệu hướng dẫn (`KnowledgeDocumentVersion` có nhãn `DEMO_ONLY` hoặc `CLINICIAN_APPROVED`) (`A15`, `A18`, `A24`).
  - Mọi chỉ thị độc hại nhúng trong văn bản (Prompt Injection) đều bị phát hiện và cô lập làm dữ liệu văn bản thuần, không được thực thi (`A14`).
- **Bác sĩ giữ quyền quyết định cuối cùng:**
  - Bác sĩ tuyến dưới phải lưu **Nhận định lâm sàng sơ bộ (`ClinicalAssessment`)** trước khi tạo gợi ý xét nghiệm hoặc xác nhận kế hoạch (`A16`).
  - Bác sĩ duyệt từng gợi ý (`APPROVED`, `MODIFIED`, `REJECTED`, `DEFERRED`); việc xác nhận kế hoạch chỉ tạo `TestPlanVersion` bất biến và chỉ tạo `MockTestOrder` khi bác sĩ bấm nút kích hoạt riêng có `idempotency_key` (`A18`, `A20`, `A21`).
  - Hội chẩn chuyên gia diễn ra **song song**, không bắt buộc chờ hoàn tất xét nghiệm (`A23`).

---

## 2. Hướng dẫn cài đặt & khởi chạy

### Yêu cầu môi trường
- Node.js `>= 22.x` (sử dụng module `node:sqlite` tích hợp sẵn)
- Docker / Colima (để chạy container `tideorg/tidecloak-dev:latest` ở cổng `8080`)

### Các bước chạy nhanh
```bash
# 1. Cài đặt phụ thuộc
npm install

# 2. Khởi tạo dữ liệu demo (Tổ chức, Người dùng, Ca A/B/C, Danh mục xét nghiệm, Ca tham khảo)
npm run db:reset

# 3. (Tùy chọn nếu khởi tạo lại TideCloak container)
npm run init

# 4. Kiểm tra sức khỏe tích hợp TideCloak + DPoP
npm run doctor

# 5. Chạy bộ kiểm thử tự động A01–A24
npm test

# 6. Khởi chạy máy chủ phát triển (http://localhost:3000)
npm run dev
```

### Chế độ AI (Fixture vs Live)
- Mặc định ứng dụng chạy ở chế độ **`AI mô phỏng (Fixture Grounded)`** để đảm bảo tính tất định 100% khi chấm điểm và trình diễn offline.
- Người dùng vẫn có thể chỉnh sửa trực tiếp từng câu hỏi, nhận định lâm sàng, thêm xét nghiệm thủ công từ danh mục hoặc tải thêm tài liệu `.txt` mới để kiểm chứng cơ chế phát hiện lệch phiên bản (`input_version` / `assessment_version`).

---

## 3. Danh sách tài khoản Demo & Vai trò

Có thể chuyển nhanh giữa các nhân vật trên thanh công cụ đầu trang (mỗi yêu cầu API đều tự động ký bằng khóa bất đối xứng WebCrypto ES256 DPoP và token gắn `cnf.jkt`) hoặc đăng nhập qua TideCloak OIDC:

| Mã nhân vật | Họ tên & Chức danh | Cơ sở y tế | Vai trò ứng dụng | Quyền Tide / QEA |
| :--- | :--- | :--- | :--- | :--- |
| `USR-REF-01` | **BS. Nguyễn Minh Khoa** | Phòng khám Đa khoa An Bình | `referring_clinician` | Bác sĩ gửi ca, duyệt tóm tắt, lưu nhận định & kế hoạch xét nghiệm |
| `USR-SPEC-01` | **PGS.TS. Trần Quốc Bảo** | Trung tâm Chuyên khoa Minh An | `consulting_specialist` | Có `network_consultant` (QEA đã duyệt), Sẵn sàng (`1/3` ca mở) |
| `USR-SPEC-05` | **ThS.BS. Hoàng Lan Anh** | Trung tâm Chuyên khoa Minh An | `consulting_specialist` | Có `network_consultant` (QEA đã duyệt), Ứng viên dự phòng (`2/4` ca mở) |
| `USR-SPEC-02` | **TS.BS. Lê Thu Hà** | Trung tâm Chuyên khoa Minh An | `consulting_specialist` | Có `network_consultant`, nhưng đang **BẬN (`3/3` ca mở)** |
| `USR-SPEC-03` | **BS.CKI. Phạm Hoàng Nam** | Trung tâm Chuyên khoa Minh An | `consulting_specialist` | **Chưa có `network_consultant`** (Đang chờ đủ quorum QEA `1/2` chữ ký) |
| `USR-SPEC-04` | **TS.BS. Đỗ Văn Hùng** | Trung tâm Chuyên khoa Minh An | `consulting_specialist` | Có `network_consultant`, nhưng khác chuyên khoa (`ENDOCRINOLOGY`) |
| `USR-COORD-01` | **ĐPV. Vũ Thanh Mai** | Trung tâm Chuyên khoa Minh An | `coordinator` | Chỉ xem siêu dữ liệu điều phối, **bị che toàn bộ nội dung lâm sàng** (`A10`) |
| `USR-ADMIN-01..03` | **Hội đồng Quản trị viên QEA (3 Admin)** | Minh An & An Bình | `network_admin` | Quản trị mạng lưới & QEA (`max(1, floor(0.7 * 3)) = 2`), **không đọc được hồ sơ bệnh án** (`A10`) |

---

## 4. Các màn hình chính (6 màn hình tiếng Việt)

1. `/workspace` — **Bàn điều phối & Danh sách ca bệnh**: Thống kê thời gian xử lý thực tế từ SQLite (`Section 19`), bộ lọc trạng thái, tạo ca mới và truy cập nhanh Ca A, Ca B, Ca C.
2. `/cases/[id]/prepare` — **Soạn gói hội chẩn & Kế hoạch xét nghiệm**:
   - Xem văn bản gốc theo từng đoạn `#S-001`...
   - Tóm tắt AI có trích dẫn nguồn, tách riêng phần chưa biết (`Unknowns`), cảnh báo mâu thuẫn & cô lập Prompt Injection.
   - Hộp thoại làm rõ câu hỏi mơ hồ (Ca B).
   - Biểu mẫu **Nhận định lâm sàng sơ bộ (`ClinicalAssessment`)** có phiên bản.
   - Bảng **Đề xuất xét nghiệm có kiểm chứng nguồn**, cảnh báo trùng lặp (`POSSIBLE_DUPLICATE_NEEDS_REVIEW`), quyết định từng mục, xác nhận `TestPlanVersion` và tạo `MockTestOrder` bất biến/idempotent.
   - Ngăn kéo **Kho ca tham khảo nội mạng (P1)**.
3. `/cases/[id]/match` — **Tìm người nhận có giải thích**: Hiển thị điểm số thành phần (`40*chuyên khoa + 30*lịch + 20*sức chứa + 10*chủ đề`) cho ứng viên đủ điều kiện và giải thích rõ lý do loại cho ứng viên không đủ điều kiện (quá tải `3/3`, thiếu quyền QEA `network_consultant`, lệch chuyên khoa), kèm thiết lập hàng đợi dự phòng (`fallback_queue`).
4. `/specialist/inbox` — **Hộp thư chuyên gia**: Chỉ hiển thị bản xem trước tối giản (`minimal_preview`) trước khi nhận ca; chấp nhận ca nguyên tử (`BEGIN IMMEDIATE`) hoặc từ chối để kích hoạt tự động chuyển tiếp dự phòng.
5. `/consultations/[id]` — **Phòng hội chẩn**: Không gian trao đổi sau khi chuyên gia nhận ca, hỗ trợ yêu cầu bổ sung thông tin (`NEEDS_INFO` -> tạo `ReferralSnapshot` phiên bản mới), gửi phản hồi chuyên môn có cấu trúc (`ANSWERED`) và đóng ca (`CLOSED`).
6. `/network/governance` — **Mạng lưới & Quản trị QEA**: Hiển thị công thức quorum `max(1, floor(0.7 * N))` (`N=3 => 2`), đồng bộ trạng thái yêu cầu cấp quyền `network_consultant` trực tiếp từ TideCloak `/iga/change-requests`, và danh mục thỏa thuận liên cơ sở.

---

## 5. Tài liệu chi tiết trong thư mục `docs/`

- [docs/architecture.md](file:///Users/truongledanchi/Downloads/rmithack/docs/architecture.md): Kiến trúc hệ thống, phân tách tầng xác thực TideCloak/DPoP, phân quyền mức đối tượng và ranh giới QEA.
- [docs/demo-script.md](file:///Users/truongledanchi/Downloads/rmithack/docs/demo-script.md): Kịch bản trình diễn 2 phút và lời thuyết minh tiếng Việt theo từng bước.
- [docs/verification.md](file:///Users/truongledanchi/Downloads/rmithack/docs/verification.md): Báo cáo kiểm chứng thực tế (`A01–A24`), phiên bản SDK/image và kết quả kiểm thử.
- [docs/integration-gaps.md](file:///Users/truongledanchi/Downloads/rmithack/docs/integration-gaps.md): Báo cáo trung thực về sự cố máy chủ từ xa `Midgard.FinalizeWallet` khi khởi tạo realm TideCloak và cách xử lý minh bạch.
