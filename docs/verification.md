# Báo cáo Kiểm chứng Kỹ thuật (Verification Report) — CaseBridge

## 1. Môi trường & Phiên bản Đã Chạy Thực tế

| Thành phần | Phiên bản / Cấu hình thực tế | Trạng thái |
| :--- | :--- | :--- |
| **Next.js & React** | `next@16.4.2`, `react@19.0.0`, TypeScript `5.x` | Đã biên dịch thành công (`npm run build` exit 0) |
| **Cơ sở dữ liệu** | SQLite tích hợp (`node:sqlite` trên Node.js v22), chế độ `WAL` + `BEGIN IMMEDIATE TRANSACTION` | Hoạt động thực tế (`data/casebridge.db`) |
| **TideCloak Server** | Docker image `tideorg/tidecloak-dev:latest` tại `http://localhost:8080`, Realm: `casebridge`, Client: `casebridge-client` | Đang chạy trực tiếp (`docker ps`) |
| **TideCloak SDK & JOSE** | `@tidecloak/nextjs@0.14.17`, `jose@6.x` | Đã tích hợp (`useDPoP: true`, `createLocalJWKSet`) |
| **Tide Doctor (`tide-doctor.sh`)** | `.tide-pack/templates/shared/tide-doctor.sh` | `9 passed, 0 fixed, 1 warning(s), 0 failure(s) — RESULT: OK` |
| **Bộ kiểm thử tự động** | `vitest@3.2.7` (`tests/casebridge.test.ts` + `.tide-pack/templates/dpop-verify/verifyDpop.test.mjs`) | Toàn bộ bài kiểm thử `A01–A24` và 13 bài kiểm thử DPoP đều **PASS** |

---

## 2. Phân định Trung thực: Thành phần Chạy Trực tiếp (Live) vs Mô phỏng (Simulated/Fixture)

### 2.1. Thành phần Chạy Trực tiếp (Live)
1. **Container TideCloak & IGA/QEA REST API (`http://localhost:8080`):**
   - Realm `casebridge`, client `casebridge-client`, `isIGAEnabled: true`, toàn bộ 8 tài khoản người dùng (`admin`, `dr_khoa`, `spec_bao`, `spec_ha`, `spec_nam`, `coord_mai`, `admin2`, `admin3`) đã được tạo và commit qua IGA.
   - Yêu cầu cấp quyền `GRANT_ROLES` cho `spec_nam -> network_consultant` (`id: "b9cef8cc-cc88-4af2-8b9c-eece1800b640"`) tồn tại thực tế ở trạng thái `PENDING` trên `/admin/realms/casebridge/iga/change-requests?status=PENDING` và được đồng bộ trực tiếp vào `/api/governance/changes`.
2. **Xác thực JWT qua JWKS + RFC 9449 DPoP (`src/lib/auth/tideJWT.ts` & `src/lib/auth/verifyDpop.ts`):**
   - Mọi yêu cầu API đều được xác thực chữ ký JWK thật (EdDSA / ES256) và kiểm tra ràng buộc khóa DPoP (`htm`, `htu`, `ath`, `cnf.jkt`, cửa sổ `iat`, và bộ nhớ chống phát lại `jti`).
3. **Giao dịch SQLite & Kiểm soát Quy trình (`src/lib/workflow.ts`, `src/lib/matching.ts`):**
   - Toàn bộ trạng thái ca bệnh, kiểm tra lệch phiên bản `input_version` / `assessment_version`, tính điểm chuyên gia, hết hạn lời mời theo đồng hồ máy chủ, chuyển tiếp dự phòng (`fallback_queue`), chấp nhận nguyên tử (`BEGIN IMMEDIATE`) và tính toán các chỉ số thời gian xử lý (`Section 19`) đều thực thi trực tiếp trên SQLite.

### 2.2. Thành phần Chạy ở Chế độ Mô phỏng Tất định (Simulated / Fixture)
1. **Adapter AI có kiểm chứng nguồn (`FIXTURE_SIMULATED` / `FIXTURE_GROUNDED`):**
   - Để đảm bảo chấm điểm offline ổn định 100%, bước chuẩn bị tóm tắt AI và đề xuất xét nghiệm mặc định dùng bộ sinh tất định dựa trên các đoạn văn bản thực tế (`#S-001`...) của hồ sơ được tải lên, sau đó vẫn đi qua **cùng một bộ kiểm tra schema Zod và kiểm tra trích dẫn nguồn nghiêm ngặt** như khi gọi LLM trực tiếp.
2. **Tài liệu hướng dẫn lâm sàng (`KnowledgeDocumentVersion`) & Chỉ định xét nghiệm (`MockTestOrder`):**
   - Các tài liệu trong Knowledge Base được gắn nhãn rõ ràng `DEMO_ONLY` hoặc `CLINICIAN_APPROVED`.
   - `MockTestOrder` là y lệnh mô phỏng trong nội bộ ứng dụng demo, không kết nối máy xét nghiệm hay hệ thống HIS/LIS bệnh viện thật.

---

## 3. Bảng Đối chiếu Kết quả Kiểm thử Tự động `A01–A24` (`tests/casebridge.test.ts`)

| Mã tiêu chí | Nội dung kiểm chứng | Kết quả |
| :--- | :--- | :---: |
| **A01** | Tạo ca bệnh lấy `organization_id` từ máy chủ; tạo tóm tắt AI có trích dẫn `[document_id, version, segment_id]` hợp lệ | **PASS** |
| **A02** | Từ chối (`422 ValidationError`) khi đầu ra AI chứa trích dẫn `segment_id` không tồn tại (`S-999`) | **PASS** |
| **A03** | Tách biệt hoàn toàn mục `Unknowns` khỏi xét nghiệm; yêu cầu làm rõ khi câu hỏi hội chẩn mơ hồ (Ca B) | **PASS** |
| **A04** | Chặn chốt `ReferralSnapshot` nếu thiếu xác nhận tường minh của bác sĩ (`confirmed_by_clinician: true`) | **PASS** |
| **A05** | Tăng `input_version` khi tải thêm tài liệu mới và chặn chốt gói hội chẩn dựa trên `input_version` cũ (`409 STALE_INPUT_VERSION`) | **PASS** |
| **A06** | Tính điểm xếp hạng chuyên gia tất định; loại chuyên gia đang bận (`3/3`) hoặc lệch chuyên khoa kèm giải thích rõ ràng; chặn xem bệnh án trước khi `ACCEPT` | **PASS** |
| **A07** | Giao dịch nhận ca nguyên tử (`BEGIN IMMEDIATE`); chống nhận trùng và xử lý idempotent khi bấm đúp | **PASS** |
| **A08** | Tự động hết hạn lời mời theo đồng hồ máy chủ (`410 Gone`) và tự động kích hoạt ứng viên dự phòng (`fallback_queue`) khi hết hạn hoặc từ chối | **PASS** |
| **A09** | Luồng `InformationRequest` chuyển ca sang `NEEDS_INFO`, tạo `ReferralSnapshot v2` khi bác sĩ bổ sung, phản hồi có cấu trúc (`ANSWERED`) và đóng ca (`CLOSED`) | **PASS** |
| **A10** | Chặn bác sĩ khác cơ sở (`403`), che dữ liệu lâm sàng đối với Điều phối viên (`clinical_payload_redacted: true`), chặn Admin đọc bệnh án (`403`), và chặn phát lại DPoP token dưới dạng `Bearer` (`401`) | **PASS** |
| **A11** | Ngưỡng quorum `max(1, floor(0.7 * N))` (`N=3 => 2`); chuyên gia chờ duyệt QEA (`USR-SPEC-03`) bị loại khỏi matching và không thể được mời trực tiếp | **PASS** |
| **A12** | Từ chối file scan không có lớp văn bản đọc được hoặc tài liệu rỗng (`422 UNREADABLE_SCAN`) | **PASS** |
| **A13** | Chỉ số thời gian chuẩn bị, điều phối, nhận lời mời và phản hồi đầu tiên tính trực tiếp từ dấu thời gian SQLite | **PASS** |
| **A14** | Phát hiện và cô lập chỉ thị Prompt Injection trong tài liệu nguồn, không thực thi lệnh độc hại | **PASS** |
| **A15** | Từ chối gợi ý xét nghiệm `SUPPORTED` nếu thiếu trích dẫn bằng chứng bệnh nhân hoặc trích dẫn tài liệu hướng dẫn | **PASS** |
| **A16** | Bắt buộc lưu `ClinicalAssessment` trước khi cho phép tạo gợi ý xét nghiệm hoặc xác nhận kế hoạch xét nghiệm | **PASS** |
| **A17** | Không tự trộn `Unknowns` thành chỉ định xét nghiệm; không cho phép phê duyệt trực tiếp gợi ý `UNSUPPORTED` | **PASS** |
| **A18** | Chỉ cho phép xét nghiệm thuộc `TestCatalogEntry`; các mục `PENDING_REVIEW`, `REJECTED`, `DEFERRED` không lọt vào `TestPlanVersion` | **PASS** |
| **A19** | Khi cập nhật `ClinicalAssessment` hoặc tài liệu nguồn mới, kế hoạch đã xác nhận chuyển sang `NEEDS_REVIEW` và yêu cầu rà soát lại trước khi chốt mới | **PASS** |
| **A20** | Chỉ `referring_clinician` phụ trách ca bệnh mới được duyệt gợi ý, xác nhận kế hoạch và tạo `MockTestOrder` (`403` với Coordinator/Admin) | **PASS** |
| **A21** | Xác nhận kế hoạch chỉ tạo `TestPlanVersion` bất biến, không tự tạo `MockTestOrder`; thao tác tạo `MockTestOrder` bắt buộc `idempotency_key` chống trùng lặp | **PASS** |
| **A22** | Tự động phát hiện và gắn cờ xét nghiệm đã có hoặc nghi trùng lặp (`POSSIBLE_DUPLICATE_NEEDS_REVIEW` / `ALREADY_AVAILABLE`); cập nhật trạng thái khi nhập `TestResult` | **PASS** |
| **A23** | Luồng gửi hội chẩn chuyên gia hoạt động song song, không bị chặn bởi trạng thái của kế hoạch xét nghiệm | **PASS** |
| **A24** | Mọi trích dẫn tài liệu hướng dẫn đều hiển thị rõ nhãn trạng thái kiểm duyệt `DEMO_ONLY` hoặc `CLINICIAN_APPROVED` | **PASS** |
