# LAB 3 — Thanh toán học phí (Node.js/Express)

Một monorepo, hai backend Node.js riêng biệt: Fee Service `:4001`, Bank Service `:4002`.

## Cài đặt

Yêu cầu Node.js >= 18.

```bash
npm install
```

Nếu muốn chỉnh cấu hình theo từng kịch bản, tạo hai file `.env` từ ví dụ:

```powershell
Copy-Item fee-service/.env.example fee-service/.env
Copy-Item bank-service/.env.example bank-service/.env
```

Khởi chạy ở hai terminal:

```bash
npm run fee
npm run bank
```

Tất cả dữ liệu lưu trong RAM, khởi động lại service sẽ reset dữ liệu của service đó.

## Endpoint

Fee Service:

- `GET http://localhost:4001/students/1/fees`
- `POST http://localhost:4001/students/1/payments`, JSON `{"amount":100000}`
- `GET http://localhost:4001/payments/P1` (tiện ích mở rộng)
- `POST http://localhost:4001/payments/P1/retry` (đối soát PENDING, cùng khóa)

Bank Service:

- `POST http://localhost:4002/charges`, JSON `{"reference":"P1","amount":100000}`, header `Idempotency-Key: P1`
- `GET http://localhost:4002/stats`

## Chạy bốn kịch bản

1. Bank tắt: chạy Fee, gửi POST; kỳ vọng `503 FAILED`; sau đó bật Bank và gửi POST mới => `201 PAID`.
2. Bank chậm: trong `bank-service/.env`, đặt `DELAY_MS=5000` và restart Bank; POST => `504 PENDING` trước 4.5 giây. Test đồng thời `COUNT=20 CONCURRENCY=20 MEASURE_FEES=1`.
3. Keep-alive: Bank config bình thường, restart cả hai để reset số liệu. Chạy `npm run test:load`; dự kiến 200 PAID, `connections` tăng <= 20. Đợi 6s, thử thêm request.
4. Từng lượt restart Bank với `DROP_RATE=0.3`, sau đó `FAIL_RATE=0.3`. Chạy 60 yêu cầu tuần tự `COUNT=60 CONCURRENCY=1`. Dùng student 1 với amount 1000. Cuối cùng reset lỗi và POST amount 25000000 => `402 FAILED`, Bank `requests` tăng 1.

Với Bash:

```bash
COUNT=60 CONCURRENCY=1 node scripts/load-test.js
```

Với PowerShell:

```powershell
$env:COUNT="60"; $env:CONCURRENCY="1"; node scripts/load-test.js
```

Các biến môi trường: `PORT`, `BANK_URL` cho Fee; `PORT`, `DELAY_MS`, `FAIL_RATE`, `DROP_RATE` cho Bank. Tham khảo các file `.env.example`.

**Lưu ý:** Khi kết quả là PENDING, ngân hàng có thể đã trừ tiền nhưng Fee chưa xác nhận. Không gửi một lệnh thanh toán mới để đối soát lệnh cũ; dùng `POST /payments/:id/retry` để tái dùng cùng Idempotency-Key. Bản lab lưu RAM, không đủ cho hệ thống tài chính production.
