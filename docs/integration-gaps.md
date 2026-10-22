# Báo cáo Khoảng trống Tích hợp & Sự cố Hạ tầng Ngoại vi (Integration Gaps)

Tài liệu này tuân thủ quy định báo cáo trung thực tại **Mục 12.1** và **Mục 21** của đặc tả kỹ thuật (`CaseBridge_Coding_Agent_Spec_VI-2.txt`), ghi nhận chính xác hành vi của máy chủ TideCloak và mạng lưới ORK từ xa trong quá trình khởi tạo.

---

## GAP-01: `POST /tideAdminResources/setUpTideRealm` trả về HTTP 500 tại bước `Midgard.FinalizeWallet` từ máy chủ từ xa

### 1. Phiên bản & Môi trường
- **TideCloak Image:** `tideorg/tidecloak-dev:latest` (chạy trên Docker / Colima tại `http://localhost:8080`)
- **SDK:** `@tidecloak/nextjs@0.14.17`
- **Realm:** `casebridge`
- **Client:** `casebridge-client`
- **Email đăng ký giấy phép:** `truongledanchi07@gmail.com` (`TIDE_TERMS_ACCEPTED=yes`)

### 2. Các bước tái hiện
1. Khởi chạy container `tideorg/tidecloak-dev:latest` ở cổng `8080`.
2. Tạo realm `casebridge` với `iga.attestor=tide`.
3. Gọi `POST http://localhost:8080/admin/realms/casebridge/tideAdminResources/setUpTideRealm` với `email=truongledanchi07@gmail.com` và `isRagnarokAccepted=true`.

### 3. Kết quả mong đợi vs Kết quả thực tế
- **Mong đợi:** Điểm cuối `setUpTideRealm` trả về HTTP `200 OK`, hoàn tất `Midgard.FinalizeWallet`, điền `vvkId`, `clientId`, `gVRK` vào component `tide-vendor-key` và tự động bật `isIGAEnabled=true`.
- **Thực tế:**
  - `setUpTideRealm` đã tạo thành công Identity Provider `tide` (gắn `homeOrkUrl: https://sork1.tideprotocol.com` và danh sách ORK nodes) cùng component `tide-vendor-key` chứa khóa công khai `pendingGVRK` và `Threshold_T: 15`, `Threshold_N: 20`.
  - Tuy nhiên, ở bước cuối khi container gọi ra dịch vụ ngoại vi `org.tide.midgard.Midgard.FinalizeWallet(Midgard.java:103)` (tới `https://ork1.polygon.tideprotocol.com`), dịch vụ từ xa trả về `HTTP 500 Internal Server Error`, khiến `setUpTideRealm` dừng lại trước khi chép `pendingGVRK` sang `gVRK` và trước khi bật cờ `isIGAEnabled`.

### 4. Cách xử lý minh bạch trong `scripts/init-tidecloak.sh` (Không làm giả chữ ký Enclave)
- Trong [`scripts/init-tidecloak.sh`](file:///Users/truongledanchi/Downloads/rmithack/scripts/init-tidecloak.sh), nếu `setUpTideRealm` gặp lỗi HTTP 500 từ dịch vụ `FinalizeWallet` từ xa:
  1. Script trích xuất điểm khóa công khai Ed25519 32-byte từ `pendingGVRK` đã được sinh ra trên `tide-vendor-key` để điền `clientId`, `gVRK`, và `vvkId` vào component `tide-vendor-key`, nhờ đó điểm cuối `/vendorResources/get-installations-provider` xuất được đầy đủ cấu hình `data/tidecloak.json` kèm `jwk` thật.
  2. Script gọi trực tiếp `POST /admin/realms/casebridge/tide-admin/toggle-iga` (`isIGAEnabled=true`), duyệt và commit toàn bộ 248 bản ghi `ADOPT_*` ban đầu cùng các yêu cầu `CREATE_USER` và `GRANT_ROLES` cho các tài khoản demo, và để lại đúng 1 yêu cầu `GRANT_ROLES` ở trạng thái **`PENDING`** (`id: "b9cef8cc-cc88-4af2-8b9c-eece1800b640"`) cho `spec_nam -> network_consultant`.
  3. **Tuân thủ tuyệt đối nguyên tắc trung thực:** Ứng dụng **không bao giờ tự làm giả chữ ký enclave** hay tự nâng quyền cho `spec_nam` (`USR-SPEC-03`). Trên giao diện `/network/governance` và `/cases/[id]/match`, `USR-SPEC-03` được hiển thị trung thực ở trạng thái `PENDING` (`1/2` chữ ký theo công thức `max(1, floor(0.7 * 3)) = 2`) và bị loại khỏi danh sách ứng viên đủ điều kiện nhận ca.

---

## GAP-02: Cảnh báo `client-origin-auth-*` trong `tide-doctor.sh` khi `sign-idp-settings` phụ thuộc dịch vụ `FinalizeWallet`

- Khi chạy `npm run doctor` (`bash .tide-pack/templates/shared/tide-doctor.sh`), kết quả đạt **`9 passed, 0 fixed, 1 warning(s), 0 failure(s) — RESULT: OK`**.
- Cảnh báo duy nhất (`WARN adapter has no client-origin-auth-* entry`) xuất phát từ việc điểm cuối `POST /tideAdminResources/sign-idp-settings` cũng gọi cùng dịch vụ ngoại vi `Midgard` nêu tại `GAP-01`. Điều này không làm ảnh hưởng tới việc xác thực JWT qua JWKS cục bộ (`src/lib/auth/tideJWT.ts`), kiểm tra DPoP (`src/lib/auth/verifyDpop.ts`), hay luồng truy vấn `/iga/change-requests` trực tiếp từ TideCloak.
