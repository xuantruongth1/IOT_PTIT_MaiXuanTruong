PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  date_of_birth TEXT,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  github_url TEXT,
  figma_url TEXT,
  postman_url TEXT,
  srs_url TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sensors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  sensor_type TEXT NOT NULL CHECK(sensor_type IN ('TEMPERATURE','HUMIDITY','LIGHT')),
  unit TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
);

CREATE TABLE IF NOT EXISTS sensor_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sensor_id INTEGER NOT NULL,
  value REAL NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sensor_id) REFERENCES sensors(id)
);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  device_type TEXT NOT NULL,
  current_status TEXT NOT NULL DEFAULT 'OFF' CHECK(current_status IN ('ON','OFF','FAULT')),
  gpio_pin INTEGER,
  status TEXT NOT NULL DEFAULT 'ONLINE'
);

CREATE TABLE IF NOT EXISTS action_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  device_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('TURN_ON','TURN_OFF','AUTO_OFF')),
  status TEXT NOT NULL DEFAULT 'PROCESSING' CHECK(status IN ('SUCCESS','PROCESSING','FAIL','TIMEOUT')),
  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (device_id) REFERENCES devices(id)
);

CREATE INDEX IF NOT EXISTS idx_sensor_data_time ON sensor_data(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_sensor_data_sensor ON sensor_data(sensor_id);
CREATE INDEX IF NOT EXISTS idx_action_time ON action_history(requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_device ON action_history(device_id);

INSERT OR IGNORE INTO users
  (id, username, password_hash, full_name, date_of_birth, email, phone, status, github_url, figma_url)
VALUES
  (1, 'mxt', '', 'Mai Xuân Trường', NULL, 'student@example.com', NULL, 'ACTIVE', NULL, NULL);

INSERT OR IGNORE INTO sensors (id, code, sensor_type, unit) VALUES
  (1, 'DHT11-TEMP', 'TEMPERATURE', '°C'),
  (2, 'DHT11-HUM', 'HUMIDITY', '%'),
  (3, 'LDR-LIGHT', 'LIGHT', 'Lux');

INSERT OR IGNORE INTO devices (id, code, name, device_type, current_status, gpio_pin) VALUES
  (1, 'LED-01', 'Đèn LED phòng học', 'LIGHT', 'OFF', 18),
  (2, 'FAN-01', 'Quạt thông gió', 'FAN', 'OFF', 17),
  (3, 'AC-01', 'Điều hòa', 'AIR_CONDITIONER', 'OFF', 16);
