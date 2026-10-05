# IoT PTIT Monitoring System - Bài 3

Dự án gồm backend REST API, Auth bcrypt/JWT, WebSocket realtime, SQLite database, giao diện web và cầu nối MQTT tới ESP32. Backend tự khởi tạo cơ sở dữ liệu và dữ liệu minh họa trong lần chạy đầu tiên.

## Chạy dự án

Yêu cầu Node.js 22.5 trở lên (khuyến nghị Node.js 24).

```powershell
cd backend
npm.cmd install
node server.js
```

Mở `http://localhost:3000`. Tài khoản mẫu là `mxt`, mật khẩu `123456`. Không mở trực tiếp `frontend/index.html` bằng `file://` vì giao diện cần API và WebSocket.

File `backend/.env` đã được cấu hình cho broker `172.20.10.3:2005`. Khi đổi mạng, cập nhật `MQTT_BROKER_HOST`, `MQTT_BROKER_PORT`, tài khoản và mật khẩu trong file này. Nếu không bật MQTT, thao tác điều khiển được mô phỏng thành công để trình diễn giao diện.

## Cấu trúc

- `backend/server.js`: Auth, HTTP server, REST API, WebSocket và cầu nối MQTT.
- `database/schema.sql`: bảng người dùng, cảm biến, dữ liệu đo, thiết bị và lịch sử thao tác.
- `database/iot.db`: được tạo tự động khi chạy (không commit Git).
- `esp32_firmware/esp32_firmware.ino`: đọc DHT11/LDR và điều khiển ba thiết bị.
- `frontend/`: SPA Dashboard, Data Sensor, Action History và Profile.

## API chính

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/dashboard`
- `GET /api/sensors?page=1&limit=10&field=type&search=Nhiệt độ`
- `GET /api/history?page=1&limit=10&field=action&search=Bật`
- `POST /api/telemetry`
- `POST /api/device/control`
- `WS /ws?token=<JWT>`

## Cấu hình cá nhân

Thông tin liên hệ cá nhân không được lưu trong mã nguồn công khai. GitHub và Figma mặc định để `NULL`; có thể cập nhật sau khi đăng nhập. Khi có PDF Bài 1, đặt file trong `frontend/assets` và cập nhật `#srsLink` tại `frontend/index.html`.

Firmware đang sử dụng ngoài thực tế được xem là nguồn chuẩn và không được tự ý sửa. Backend đang tương thích các topic `data_Sensors`, `device_control`, `device_Response` và payload tiếng Việt hiện tại.

Luồng MQTT được đồng bộ với firmware:

- `data_Sensors`: nhận `{nhiet_do, do_am, anh_sang}`.
- `device_control`: gửi `{device_id, action: "bat"|"tat"}`.
- `device_Response`: nhận `{device_id, trang_thai, ket_qua}`.
- `device_Alert`: nhận trạng thái online, cảnh báo phần cứng và LWT mất kết nối.

## Kiểm thử

```powershell
cd backend
npm.cmd test
```
