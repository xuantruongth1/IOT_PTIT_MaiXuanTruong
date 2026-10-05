import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}
const DB_PATH = process.env.DATABASE_PATH === ':memory:'
  ? ':memory:'
  : path.resolve(__dirname, process.env.DATABASE_PATH || path.join(ROOT, 'database', 'iot.db'));
const PORT = Number(process.env.PORT || 3000);
const PAGE_SIZE = 10;
const JWT_SECRET = process.env.JWT_SECRET || 'iot-ptit-development-secret-change-me';

const db = new DatabaseSync(DB_PATH);
const userTableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get();
if (userTableExists) {
  const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
  if (!columns.has('username')) db.exec('ALTER TABLE users ADD COLUMN username TEXT');
  if (!columns.has('password_hash')) db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
  if (!columns.has('postman_url')) db.exec('ALTER TABLE users ADD COLUMN postman_url TEXT');
  if (!columns.has('srs_url')) db.exec('ALTER TABLE users ADD COLUMN srs_url TEXT');
  if (!columns.has('avatar_url')) db.exec('ALTER TABLE users ADD COLUMN avatar_url TEXT');
}
db.exec(fs.readFileSync(path.join(ROOT, 'database', 'schema.sql'), 'utf8'));
const actionTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='action_history'").get()?.sql || '';
if (!actionTableSql.includes('AUTO_OFF')) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    ALTER TABLE action_history RENAME TO action_history_legacy;
    CREATE TABLE action_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      device_id INTEGER NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('TURN_ON','TURN_OFF','AUTO_OFF')),
      status TEXT NOT NULL DEFAULT 'PROCESSING' CHECK(status IN ('SUCCESS','PROCESSING','FAIL','TIMEOUT')),
      requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (device_id) REFERENCES devices(id)
    );
    INSERT INTO action_history SELECT * FROM action_history_legacy;
    DROP TABLE action_history_legacy;
    COMMIT;
    PRAGMA foreign_keys = ON;
    CREATE INDEX IF NOT EXISTS idx_action_time ON action_history(requested_at DESC);
    CREATE INDEX IF NOT EXISTS idx_action_device ON action_history(device_id);
  `);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)');
db.prepare("UPDATE users SET username = COALESCE(NULLIF(username, ''), 'mxt') WHERE id = 1").run();
const owner = db.prepare('SELECT id, password_hash FROM users WHERE id = 1').get();
if (owner && !owner.password_hash) db.prepare('UPDATE users SET password_hash = ? WHERE id = 1').run(bcrypt.hashSync('123456', 10));

function seedDemoData() {
  const count = db.prepare('SELECT COUNT(*) AS total FROM sensor_data').get().total;
  if (count) return;
  const insertSensor = db.prepare('INSERT INTO sensor_data (sensor_id, value, recorded_at) VALUES (?, ?, ?)');
  const insertAction = db.prepare('INSERT INTO action_history (user_id, device_id, action, status, requested_at) VALUES (1, ?, ?, ?, ?)');
  const now = Date.now();
  for (let i = 0; i < 36; i += 1) {
    const time = new Date(now - i * 5 * 60_000).toISOString();
    insertSensor.run(1, +(26 + Math.sin(i / 3) * 3).toFixed(1), time);
    insertSensor.run(2, +(62 + Math.cos(i / 4) * 8).toFixed(1), time);
    insertSensor.run(3, Math.round(380 + Math.sin(i / 5) * 170), time);
  }
  const states = ['SUCCESS', 'SUCCESS', 'PROCESSING', 'TIMEOUT', 'FAIL'];
  for (let i = 0; i < 28; i += 1) {
    insertAction.run((i % 3) + 1, i % 2 ? 'TURN_OFF' : 'TURN_ON', states[i % states.length], new Date(now - i * 17 * 60_000).toISOString());
  }
}
seedDemoData();

const wsServer = new WebSocketServer({ noServer: true });
const pendingCommands = new Map();
const MQTT_TOPICS = Object.freeze({ telemetry: 'data_Sensors', control: 'device_control', response: 'device_Response', alert: 'device_Alert' });
let esp32Status = 'OFFLINE';
let lastDeviceAlert = null;
const sendJson = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};
class ApiError extends Error {
  constructor(status, code, message, field = 'search', hint = '') {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
    this.hint = hint;
  }
}
const readBody = async (req) => {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('Payload quá lớn');
  }
  return raw ? JSON.parse(raw) : {};
};
const clampPage = (value) => Math.max(1, Number.parseInt(value || '1', 10) || 1);
const periodSql = (period, column) => {
  const days = { today: 1, '7d': 7, '30d': 30 }[period];
  return days ? ` AND ${column} >= datetime('now', '-${days} day')` : '';
};
const publicRow = (row) => ({ ...row, value: row.value == null ? row.value : Number(row.value) });
const base64url = (value) => Buffer.from(value).toString('base64url');
const safeUser = ({ password_hash, ...user }) => user;
function createToken(user) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ sub: user.id, username: user.username, exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60 }));
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}
function verifyToken(token) {
  try {
    const [header, payload, signature] = String(token || '').split('.');
    if (!header || !payload || !signature) return null;
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.sub || data.exp <= Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch { return null; }
}
function currentUser(req) {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const claims = verifyToken(token);
  if (!claims) return null;
  return db.prepare('SELECT id, username, email, full_name, date_of_birth, phone, status, github_url, figma_url, postman_url, srs_url, avatar_url, created_at FROM users WHERE id = ?').get(Number(claims.sub)) || null;
}

function paginate(url, baseSql, params, orderSql) {
  const page = clampPage(url.searchParams.get('page'));
  const requestedLimit = Number.parseInt(url.searchParams.get('limit') || PAGE_SIZE, 10);
  const limit = [5, 10, 25, 50, 100].includes(requestedLimit) ? requestedLimit : PAGE_SIZE;
  const filterParams = [...params];
  const total = Number(db.prepare(`SELECT COUNT(*) AS total FROM (${baseSql}) AS filtered_rows`).get(...filterParams).total);
  const pages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, pages);
  const offset = (safePage - 1) * limit;
  const items = db.prepare(`${baseSql} ${orderSql} LIMIT ? OFFSET ?`).all(...filterParams, limit, offset).map(publicRow);
  return { items, pagination: { page: safePage, limit, total, pages } };
}

const normalizedText = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const normalizeKeyword = (value) => String(value || '').normalize('NFKC').replace(/[\u200e\u200f\u202a-\u202e]/g, '').replace(/\s+/g, ' ').trim();
const escapeLike = (value) => String(value).replace(/[\\%_]/g, '\\$&');
const SEARCH_HINT = 'Hãy nhập giá trị như 27.5 hoặc thời gian như 30/9/2026, 14:20.';
const TIME_HINT = 'Hãy nhập thời gian như 30/9, 30/9/2026, 14:20 hoặc 14:20:08 30/9/26.';

function searchError(message, hint = SEARCH_HINT) {
  throw new ApiError(400, 'INVALID_SEARCH_FORMAT', message, 'search', hint);
}

function validDateParts(day, month, year = new Date().getFullYear()) {
  const fullYear = Number(year) < 100 ? 2000 + Number(year) : Number(year);
  const date = new Date(Date.UTC(fullYear, Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === fullYear && date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day);
}

function validTimeParts(hour, minute, second = 0) {
  return Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59;
}

function isValidTimeKeyword(keyword) {
  const value = normalizeKeyword(keyword);
  if (/^\d{4}$/.test(value)) return Number(value) >= 1970 && Number(value) <= 9999;
  let match = value.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/);
  if (match) return validDateParts(match[1], match[2], match[3]);
  match = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match) return validTimeParts(match[1], match[2], match[3]);
  match = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/);
  if (match) return validTimeParts(match[1], match[2], match[3]) && validDateParts(match[4], match[5], match[6]);
  match = value.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?[,]?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match) return validDateParts(match[1], match[2], match[3]) && validTimeParts(match[4], match[5], match[6]);
  match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i);
  return Boolean(match && validDateParts(match[3], match[2], match[1]) && (!match[4] || validTimeParts(match[4], match[5], match[6])));
}

function parseKeyword(keyword) {
  const value = normalizeKeyword(keyword);
  if (!value) return { kind: 'empty', value };
  if (value.length > 100) searchError('Từ khóa tìm kiếm không được vượt quá 100 ký tự.');
  if (/^[+-]?\d+(?:[.,]\d+)?$/.test(value)) return { kind: 'number', value: Number(value.replace(',', '.')) };
  if (isValidTimeKeyword(value)) return { kind: 'time', value };
  if (/[\/:]/.test(value) || /^\d{4}-/.test(value)) searchError('Định dạng ngày hoặc giờ không hợp lệ.', TIME_HINT);
  if (/\p{L}/u.test(value)) return { kind: 'text', value };
  searchError('Định dạng tìm kiếm không hợp lệ.');
}

function requireTimeKeyword(keyword) {
  const value = normalizeKeyword(keyword);
  if (!value) return value;
  if (value.length > 100) searchError('Từ khóa tìm kiếm không được vượt quá 100 ký tự.', TIME_HINT);
  if (!isValidTimeKeyword(value)) searchError('Ô tìm kiếm này chỉ hỗ trợ định dạng ngày hoặc giờ.', TIME_HINT);
  return value;
}
function mappedSensorType(keyword) {
  const value = normalizedText(keyword);
  if (value.includes('nhiet') || value.includes('temperature')) return 'TEMPERATURE';
  if (value.includes('am') || value.includes('humidity')) return 'HUMIDITY';
  if (value.includes('sang') || value.includes('light')) return 'LIGHT';
  return null;
}
function mappedAction(keyword) {
  const value = normalizedText(keyword);
  if (value === 'bat' || value.includes('turn_on')) return 'TURN_ON';
  if (value === 'tat' || value.includes('turn_off')) return 'TURN_OFF';
  if (value.includes('tu dong') || value.includes('auto')) return 'AUTO_OFF';
  return null;
}
function mappedStatus(keyword) {
  const value = normalizedText(keyword);
  if (value.includes('thanh cong') || value === 'success') return 'SUCCESS';
  if (value.includes('that bai') || value === 'fail') return 'FAIL';
  if (value.includes('dang xu ly') || value === 'processing') return 'PROCESSING';
  if (value.includes('qua thoi gian') || value === 'timeout') return 'TIMEOUT';
  return null;
}

function normalizedTimeKeyword(keyword) {
  const value = String(keyword || '').normalize('NFKC').replace(/[\u200e\u200f\u202a-\u202e]/g, '').replace(/\s+/g, ' ').trim();
  const timeFirst = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  const dateFirst = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})[,]?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!timeFirst && !dateFirst) return value;
  const parts = timeFirst
    ? { hour: timeFirst[1], minute: timeFirst[2], second: timeFirst[3] || 0, day: timeFirst[4], month: timeFirst[5], year: timeFirst[6] }
    : { day: dateFirst[1], month: dateFirst[2], year: dateFirst[3], hour: dateFirst[4], minute: dateFirst[5], second: dateFirst[6] || 0 };
  const year = Number(parts.year) < 100 ? 2000 + Number(parts.year) : Number(parts.year);
  const localDate = new Date(year, Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Number.isNaN(localDate.getTime()) ? value : localDate.toISOString().slice(0, 19);
}

function timeSearchExpression(column) {
  const localTime = `datetime(${column}, '+7 hours')`;
  const day = `CAST(strftime('%d', ${localTime}) AS INTEGER)`;
  const month = `CAST(strftime('%m', ${localTime}) AS INTEGER)`;
  const year = `strftime('%Y', ${localTime})`;
  const shortYear = `substr(${year}, 3, 2)`;
  const clock = `strftime('%H:%M:%S', ${localTime})`;
  return `(${column} || ' ' || ${clock} || ' ' || strftime('%d/%m/%Y', ${localTime}) || ' ' || ${day} || '/' || ${month} || '/' || ${year} || ' ' || ${clock} || ' ' || ${day} || '/' || ${month} || '/' || ${shortYear})`;
}

function addTimeFilter(where, params, column, keyword) {
  const normalized = normalizedTimeKeyword(keyword);
  params.push(`%${escapeLike(normalized)}%`);
  return `${where} AND ${timeSearchExpression(column)} LIKE ? ESCAPE '\\'`;
}

function getSensorRows(url) {
  const type = url.searchParams.get('type') || '';
  const keyword = (url.searchParams.get('search') || url.searchParams.get('keyword') || '').trim();
  const field = url.searchParams.get('field') || 'all';
  if (!['all', 'time', 'temperature', 'humidity', 'light', 'type', 'value'].includes(field)) throw new ApiError(400, 'INVALID_FILTER', 'Tiêu chí tìm kiếm không hợp lệ.', 'field');
  const fieldSensorType = { temperature: 'TEMPERATURE', humidity: 'HUMIDITY', light: 'LIGHT' }[field];
  const valueRange = url.searchParams.get('value') || '';
  const from = url.searchParams.get('from') || '';
  const to = url.searchParams.get('to') || '';
  const min = url.searchParams.get('min');
  const max = url.searchParams.get('max');
  let where = ` WHERE 1=1${periodSql(url.searchParams.get('period'), 'sd.recorded_at')}`;
  const params = [];
  if (from) { where += ' AND datetime(sd.recorded_at) >= datetime(?)'; params.push(from); }
  if (to) { where += ' AND datetime(sd.recorded_at) <= datetime(?)'; params.push(to); }
  if (type) {
    if (!['TEMPERATURE', 'HUMIDITY', 'LIGHT'].includes(type)) throw new ApiError(400, 'INVALID_FILTER', 'Loại cảm biến không hợp lệ.', 'type');
    where += ' AND s.sensor_type = ?'; params.push(type);
  }
  if (fieldSensorType) { where += ' AND s.sensor_type = ?'; params.push(fieldSensorType); }
  if (min !== null && min !== '' && Number.isFinite(Number(min))) { where += ' AND sd.value >= ?'; params.push(Number(min)); }
  if (max !== null && max !== '' && Number.isFinite(Number(max))) { where += ' AND sd.value <= ?'; params.push(Number(max)); }
  if (valueRange === 'low') where += ' AND sd.value < 30';
  if (valueRange === 'medium') where += ' AND sd.value >= 30 AND sd.value <= 70';
  if (valueRange === 'high') where += ' AND sd.value > 70';
  if (keyword) {
    if (field === 'time') { where = addTimeFilter(where, params, 'sd.recorded_at', requireTimeKeyword(keyword)); }
    else if (fieldSensorType) {
      const parsed = parseKeyword(keyword);
      if (parsed.kind === 'number') { where += ' AND sd.value = ?'; params.push(parsed.value); }
      else if (parsed.kind === 'time') where = addTimeFilter(where, params, 'sd.recorded_at', parsed.value);
      else searchError(`Khi chọn ${field === 'temperature' ? 'Nhiệt độ' : field === 'humidity' ? 'Độ ẩm' : 'Ánh sáng'}, hãy nhập một giá trị số hoặc thời gian.`);
    }
    else if (field === 'type') {
      const mapped = mappedSensorType(keyword);
      if (mapped) { where += ' AND s.sensor_type = ?'; params.push(mapped); }
      else { const like = `%${escapeLike(keyword)}%`; where += " AND (s.sensor_type LIKE ? ESCAPE '\\' OR s.code LIKE ? ESCAPE '\\')"; params.push(like, like); }
    } else if (field === 'value') {
      const parsed = parseKeyword(keyword);
      if (parsed.kind !== 'number') searchError('Ô tìm kiếm giá trị chỉ chấp nhận số.');
      where += ' AND sd.value = ?'; params.push(parsed.value);
    }
    else {
      const parsed = parseKeyword(keyword);
      if (parsed.kind === 'number') { where += ' AND sd.value = ?'; params.push(parsed.value); }
      else if (parsed.kind === 'time') where = addTimeFilter(where, params, 'sd.recorded_at', parsed.value);
      else {
        const mapped = mappedSensorType(parsed.value);
        const like = `%${escapeLike(parsed.value)}%`;
        where += ` AND (s.code LIKE ? ESCAPE '\\' OR s.sensor_type LIKE ? ESCAPE '\\'${mapped ? ' OR s.sensor_type = ?' : ''})`;
        params.push(like, like); if (mapped) params.push(mapped);
      }
    }
  }
  const tableClause = ' FROM sensor_data sd JOIN sensors s ON s.id = sd.sensor_id';
  const select = `SELECT sd.id, s.code, s.sensor_type, sd.value, s.unit, sd.recorded_at${tableClause}${where}`;
  return paginate(url, select, params, 'ORDER BY sd.recorded_at DESC, sd.id DESC');
}

function getActionRows(url) {
  const device = url.searchParams.get('device') || '';
  const action = url.searchParams.get('action') || '';
  const status = url.searchParams.get('status') || '';
  const keyword = (url.searchParams.get('search') || url.searchParams.get('keyword') || '').trim();
  const field = url.searchParams.get('field') || 'all';
  if (!['all', 'time', 'device', 'user', 'action', 'status'].includes(field)) throw new ApiError(400, 'INVALID_FILTER', 'Tiêu chí tìm kiếm không hợp lệ.', 'field');
  const from = url.searchParams.get('from') || '';
  const to = url.searchParams.get('to') || '';
  let where = ` WHERE 1=1${periodSql(url.searchParams.get('period'), 'ah.requested_at')}`;
  const params = [];
  if (from) { where += ' AND datetime(ah.requested_at) >= datetime(?)'; params.push(from); }
  if (to) { where += ' AND datetime(ah.requested_at) <= datetime(?)'; params.push(to); }
  if (device) {
    if (!/^\d+$/.test(device) || Number(device) < 1) throw new ApiError(400, 'INVALID_FILTER', 'Thiết bị không hợp lệ.', 'device');
    where += ' AND d.id = ?'; params.push(Number(device));
  }
  if (action) {
    if (!['TURN_ON', 'TURN_OFF', 'AUTO_OFF'].includes(action)) throw new ApiError(400, 'INVALID_FILTER', 'Hành động không hợp lệ.', 'action');
    where += ' AND ah.action = ?'; params.push(action);
  }
  if (status) {
    if (!['SUCCESS', 'PROCESSING', 'FAIL', 'TIMEOUT'].includes(status)) throw new ApiError(400, 'INVALID_FILTER', 'Trạng thái không hợp lệ.', 'status');
    where += ' AND ah.status = ?'; params.push(status);
  }
  if (keyword) {
    const like = `%${escapeLike(keyword)}%`;
    if (field === 'time') { where = addTimeFilter(where, params, 'ah.requested_at', requireTimeKeyword(keyword)); }
    else if (field === 'device') { where += " AND d.name LIKE ? ESCAPE '\\'"; params.push(like); }
    else if (field === 'user') { where += " AND (u.full_name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')"; params.push(like, like); }
    else if (field === 'action') { const mapped = mappedAction(keyword); where += mapped ? ' AND ah.action = ?' : " AND ah.action LIKE ? ESCAPE '\\'"; params.push(mapped || like); }
    else if (field === 'status') { const mapped = mappedStatus(keyword); where += mapped ? ' AND ah.status = ?' : " AND ah.status LIKE ? ESCAPE '\\'"; params.push(mapped || like); }
    else {
      const parsed = parseKeyword(keyword);
      if (parsed.kind === 'time') where = addTimeFilter(where, params, 'ah.requested_at', parsed.value);
      else if (parsed.kind === 'number') searchError('Lịch sử hoạt động không hỗ trợ tìm kiếm bằng giá trị số.', 'Hãy nhập thời gian hoặc tên người dùng, thiết bị, hành động, trạng thái.');
      else {
        const actionTerm = mappedAction(parsed.value); const statusTerm = mappedStatus(parsed.value);
        const textLike = `%${escapeLike(parsed.value)}%`;
        where += ` AND (u.full_name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\' OR d.name LIKE ? ESCAPE '\\' OR ah.action LIKE ? ESCAPE '\\' OR ah.status LIKE ? ESCAPE '\\'${actionTerm ? ' OR ah.action = ?' : ''}${statusTerm ? ' OR ah.status = ?' : ''})`;
        params.push(...Array(5).fill(textLike)); if (actionTerm) params.push(actionTerm); if (statusTerm) params.push(statusTerm);
      }
    }
  }
  const tableClause = ' FROM action_history ah LEFT JOIN users u ON u.id = ah.user_id JOIN devices d ON d.id = ah.device_id';
  const select = `SELECT ah.id, ah.device_id, COALESCE(u.username, 'system') AS user_name, d.name AS device_name, ah.action, ah.status, ah.requested_at${tableClause}${where}`;
  return paginate(url, select, params, 'ORDER BY ah.requested_at DESC, ah.id DESC');
}

function broadcast(event, payload) {
  const message = JSON.stringify({ event, payload });
  for (const client of wsServer.clients) {
    if (client.readyState === 1) client.send(message);
  }
}

function updateEsp32Status(status, alert = lastDeviceAlert) {
  esp32Status = status;
  lastDeviceAlert = alert;
  broadcast('system', { esp32_status: esp32Status, mqtt: mqttState, alert: lastDeviceAlert });
}

function insertTelemetry(payload) {
  const values = [
    [1, Number(payload.temperature ?? payload.nhiet_do)],
    [2, Number(payload.humidity ?? payload.do_am)],
    [3, Number(payload.light ?? payload.anh_sang)]
  ];
  const insert = db.prepare('INSERT INTO sensor_data (sensor_id, value, recorded_at) VALUES (?, ?, ?)');
  const time = new Date().toISOString();
  const rows = [];
  for (const [sensorId, value] of values) {
    if (!Number.isFinite(value)) continue;
    const result = insert.run(sensorId, value, time);
    rows.push({ id: Number(result.lastInsertRowid), sensor_id: sensorId, value, recorded_at: time });
  }
  if (!rows.length) throw new Error('Không có giá trị cảm biến hợp lệ');
  updateEsp32Status('ONLINE', null);
  broadcast('telemetry', rows);
  return rows;
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { status: 'ok', database: 'connected', mqtt: mqttState, esp32: esp32Status, realtime: 'websocket' });
  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    const body = await readBody(req);
    const fullName = String(body.full_name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!fullName || !email || !username || !password) return sendJson(res, 400, { error: 'Vui lòng nhập đầy đủ thông tin' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: 'Email không hợp lệ' });
    if (!/^[a-z0-9_.]{3,30}$/.test(username)) return sendJson(res, 400, { error: 'Tên tài khoản dài 3-30 ký tự và chỉ gồm chữ, số, dấu chấm hoặc gạch dưới' });
    if (password.length < 6) return sendJson(res, 400, { error: 'Mật khẩu phải có ít nhất 6 ký tự' });
    if (db.prepare('SELECT 1 FROM users WHERE email = ? OR username = ?').get(email, username)) return sendJson(res, 409, { error: 'Email hoặc tên tài khoản đã tồn tại' });
    const result = db.prepare("INSERT INTO users (username, email, password_hash, full_name, status) VALUES (?, ?, ?, ?, 'ACTIVE')").run(username, email, bcrypt.hashSync(password, 10), fullName);
    const user = db.prepare('SELECT id, username, email, full_name, status, created_at FROM users WHERE id = ?').get(Number(result.lastInsertRowid));
    return sendJson(res, 201, { message: 'Đăng ký thành công', user });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readBody(req);
    const account = String(body.account || body.username || body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!account || !password) return sendJson(res, 400, { error: 'Vui lòng nhập tài khoản và mật khẩu' });
    const user = db.prepare('SELECT * FROM users WHERE lower(username) = ? OR lower(email) = ?').get(account, account);
    if (!user || !bcrypt.compareSync(password, user.password_hash || '')) return sendJson(res, 401, { error: 'Tài khoản hoặc mật khẩu không đúng' });
    if (user.status !== 'ACTIVE') return sendJson(res, 403, { error: 'Tài khoản không hoạt động' });
    return sendJson(res, 200, { token: createToken(user), user: safeUser(user) });
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const user = currentUser(req);
    return user ? sendJson(res, 200, { user }) : sendJson(res, 401, { error: 'Phiên đăng nhập không hợp lệ' });
  }
  if (req.method === 'POST' && url.pathname === '/api/telemetry') return sendJson(res, 201, { items: insertTelemetry(await readBody(req)) });
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Bạn cần đăng nhập để sử dụng chức năng này' });
  if (req.method === 'GET' && url.pathname === '/api/sensors') return sendJson(res, 200, getSensorRows(url));
  if (req.method === 'GET' && ['/api/history', '/api/actions'].includes(url.pathname)) return sendJson(res, 200, getActionRows(url));
  if (req.method === 'GET' && url.pathname === '/api/profile') {
    const profile = db.prepare('SELECT id, username, email, full_name, date_of_birth, phone, status, github_url, figma_url, postman_url, srs_url, avatar_url, created_at FROM users WHERE id = ?').get(user.id);
    return sendJson(res, 200, profile);
  }
  if (req.method === 'PUT' && ['/api/profile', '/api/users/profile'].includes(url.pathname)) {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const phone = String(body.phone || '').trim();
    const dateOfBirth = String(body.date_of_birth || '').trim();
    const cleanUrl = value => String(value || '').trim();
    const githubUrl = cleanUrl(body.github_url);
    const figmaUrl = cleanUrl(body.figma_url);
    const postmanUrl = cleanUrl(body.postman_url);
    const srsUrl = cleanUrl(body.srs_url);
    const avatarUrl = cleanUrl(body.avatar_url);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: 'Email không hợp lệ' });
    if (phone && !/^\d{9,11}$/.test(phone)) return sendJson(res, 400, { error: 'Số điện thoại phải có 9-11 chữ số' });
    if (dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) return sendJson(res, 400, { error: 'Ngày sinh không hợp lệ' });
    const isUrl = value => !value || /^https?:\/\/\S+$/i.test(value);
    if (![githubUrl, figmaUrl, postmanUrl, srsUrl].every(isUrl)) return sendJson(res, 400, { error: 'Liên kết tài nguyên phải bắt đầu bằng http:// hoặc https://' });
    if (avatarUrl && !/^data:image\/(png|jpeg|webp);base64,/i.test(avatarUrl) && !isUrl(avatarUrl)) return sendJson(res, 400, { error: 'Ảnh đại diện không hợp lệ' });
    if (avatarUrl.length > 900_000) return sendJson(res, 413, { error: 'Ảnh đại diện quá lớn' });
    if (db.prepare('SELECT 1 FROM users WHERE lower(email) = ? AND id <> ?').get(email, user.id)) return sendJson(res, 409, { error: 'Email đã được sử dụng' });
    db.prepare('UPDATE users SET email=?, phone=?, date_of_birth=?, github_url=?, figma_url=?, postman_url=?, srs_url=?, avatar_url=? WHERE id=?').run(email, phone || null, dateOfBirth || null, githubUrl || null, figmaUrl || null, postmanUrl || null, srsUrl || null, avatarUrl || null, user.id);
    const profile = db.prepare('SELECT id, username, email, full_name, date_of_birth, phone, status, github_url, figma_url, postman_url, srs_url, avatar_url, created_at FROM users WHERE id = ?').get(user.id);
    return sendJson(res, 200, { message: 'Cập nhật hồ sơ thành công', profile });
  }
  if (req.method === 'GET' && url.pathname === '/api/devices') return sendJson(res, 200, db.prepare('SELECT * FROM devices ORDER BY id').all());
  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    const latest = db.prepare(`SELECT s.sensor_type, s.unit, sd.value, sd.recorded_at FROM sensor_data sd JOIN sensors s ON s.id=sd.sensor_id WHERE sd.id=(SELECT sd2.id FROM sensor_data sd2 WHERE sd2.sensor_id=sd.sensor_id ORDER BY sd2.recorded_at DESC, sd2.id DESC LIMIT 1)`).all();
    const chart = db.prepare(`SELECT sd.recorded_at, MAX(CASE WHEN s.sensor_type='TEMPERATURE' THEN sd.value END) temperature, MAX(CASE WHEN s.sensor_type='HUMIDITY' THEN sd.value END) humidity, MAX(CASE WHEN s.sensor_type='LIGHT' THEN sd.value END) light FROM sensor_data sd JOIN sensors s ON s.id=sd.sensor_id GROUP BY sd.recorded_at ORDER BY sd.recorded_at DESC LIMIT 20`).all().reverse();
    return sendJson(res, 200, { latest, chart, devices: db.prepare('SELECT * FROM devices ORDER BY id').all(), connection: { esp32_status: esp32Status, mqtt: mqttState, alert: lastDeviceAlert } });
  }
  const deviceMatch = url.pathname.match(/^\/api\/devices\/(\d+)\/control$/);
  if (req.method === 'POST' && (deviceMatch || url.pathname === '/api/device/control')) {
    const body = await readBody(req);
    const deviceId = deviceMatch ? Number(deviceMatch[1]) : Number(body.device_id);
    const requestedAction = String(body.action || '').trim().toUpperCase();
    const action = ['TURN_ON', 'BAT', 'ON'].includes(requestedAction) ? 'TURN_ON' : ['TURN_OFF', 'TAT', 'OFF'].includes(requestedAction) ? 'TURN_OFF' : '';
    if (!action) return sendJson(res, 400, { error: 'action phải là TURN_ON/TURN_OFF hoặc bat/tat' });
    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
    if (!device) return sendJson(res, 404, { error: 'Không tìm thấy thiết bị' });
    const requestedAt = new Date().toISOString();
    const status = mqttClient?.connected ? 'PROCESSING' : 'FAIL';
    const result = db.prepare('INSERT INTO action_history (user_id, device_id, action, status, requested_at) VALUES (?, ?, ?, ?, ?)').run(user.id, deviceId, action, status, requestedAt);
    const next = action === 'TURN_ON' ? 'ON' : 'OFF';
    const actionId = Number(result.lastInsertRowid);
    if (mqttClient?.connected) {
      mqttClient.publish(MQTT_TOPICS.control, JSON.stringify({ device_id: deviceId, action: action === 'TURN_ON' ? 'bat' : 'tat' }));
      const timer = setTimeout(() => {
        const update = db.prepare("UPDATE action_history SET status='TIMEOUT' WHERE id=? AND status='PROCESSING'").run(actionId);
        pendingCommands.delete(actionId);
        if (update.changes) broadcast('device', { id: actionId, device_id: deviceId, status: 'TIMEOUT', current_status: device.current_status });
      }, 5000);
      pendingCommands.set(actionId, timer);
    }
    const payload = { id: actionId, device_id: deviceId, action, status, current_status: device.current_status, requested_at: requestedAt };
    broadcast('device', payload);
    return sendJson(res, mqttClient?.connected ? 202 : 503, mqttClient?.connected ? payload : { ...payload, error: 'MQTT Broker hoặc ESP32 chưa sẵn sàng' });
  }
  return sendJson(res, 404, { error: 'API không tồn tại' });
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.pdf': 'application/pdf' };
function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(FRONTEND, relative);
  if (!file.startsWith(FRONTEND)) return sendJson(res, 403, { error: 'Forbidden' });
  const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(FRONTEND, 'index.html');
  res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache', Expires: '0' });
  fs.createReadStream(target).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(res, decodeURIComponent(url.pathname));
  } catch (error) {
    if (!(error instanceof ApiError)) console.error(error);
    if (!res.headersSent) {
      if (error instanceof ApiError) sendJson(res, error.status, { error: error.code, message: error.message, field: error.field, hint: error.hint });
      else sendJson(res, 500, { error: error.message || 'Lỗi máy chủ' });
    }
    else res.end();
  }
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const claims = url.pathname === '/ws' ? verifyToken(url.searchParams.get('token')) : null;
  if (!claims || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(Number(claims.sub))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wsServer.handleUpgrade(req, socket, head, client => {
    client.userId = Number(claims.sub);
    wsServer.emit('connection', client, req);
  });
});

wsServer.on('connection', client => client.send(JSON.stringify({ event: 'ready', payload: { connected: true } })));

let mqttClient = null;
let mqttState = 'disabled';
async function connectMqtt() {
  if (String(process.env.MQTT_ENABLED).toLowerCase() !== 'true') return;
  mqttState = 'connecting';
  try {
    const { connect } = await import('mqtt');
    const brokerHost = process.env.MQTT_BROKER_HOST || '127.0.0.1';
    const brokerPort = Number(process.env.MQTT_BROKER_PORT || 2005);
    const mqttUrl = process.env.MQTT_URL || `mqtt://${brokerHost}:${brokerPort}`;
    mqttClient = connect(mqttUrl, { username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD, reconnectPeriod: 3000, connectTimeout: 5000 });
    mqttClient.on('connect', () => { mqttState = 'connected'; mqttClient.subscribe([MQTT_TOPICS.telemetry, MQTT_TOPICS.response, MQTT_TOPICS.alert]); broadcast('system', { esp32_status: esp32Status, mqtt: mqttState, alert: lastDeviceAlert }); });
    mqttClient.on('offline', () => { mqttState = 'offline'; updateEsp32Status('OFFLINE', 'Mất kết nối MQTT Broker'); });
    mqttClient.on('error', () => { mqttState = 'error'; updateEsp32Status('OFFLINE', 'Không thể kết nối MQTT Broker'); });
    mqttClient.on('message', (topic, buffer) => {
      try {
        const payload = JSON.parse(buffer.toString());
        if (topic === MQTT_TOPICS.telemetry) insertTelemetry(payload);
        if (topic === MQTT_TOPICS.response) {
          const id = Number(payload.device_id);
          const next = ['on', 'bat', 'ON'].includes(payload.trang_thai || payload.status) ? 'ON' : 'OFF';
          const succeeded = ['thanh_cong', 'success', 'ok'].includes(String(payload.ket_qua || '').toLowerCase());
          if (succeeded) db.prepare('UPDATE devices SET current_status = ? WHERE id = ?').run(next, id);
          const pending = db.prepare("SELECT id FROM action_history WHERE device_id=? AND status='PROCESSING' ORDER BY id DESC LIMIT 1").get(id);
          if (pending) {
            db.prepare('UPDATE action_history SET status=? WHERE id=?').run(succeeded ? 'SUCCESS' : 'FAIL', pending.id);
            clearTimeout(pendingCommands.get(pending.id));
            pendingCommands.delete(pending.id);
          }
          updateEsp32Status('ONLINE', null);
          broadcast('device', { id: pending?.id, device_id: id, current_status: succeeded ? next : undefined, status: succeeded ? 'SUCCESS' : 'FAIL' });
        }
        if (topic === MQTT_TOPICS.alert) {
          const alert = String(payload.canh_bao || payload.trang_thai || 'Thông báo từ ESP32');
          const normalized = alert.toUpperCase();
          const isOffline = normalized.includes('RUT NGUON') || normalized.includes('MAT KET NOI') || normalized.includes('OFFLINE');
          updateEsp32Status(isOffline ? 'OFFLINE' : 'ONLINE', alert);
        }
      } catch (error) { console.error('MQTT payload lỗi:', error.message); }
    });
  } catch { mqttState = 'module-not-installed'; }
}
connectMqtt();

db.prepare("UPDATE action_history SET status='TIMEOUT' WHERE status='PROCESSING' AND datetime(requested_at) < datetime('now', '-5 seconds')").run();

server.listen(PORT, () => console.log(`IoT PTIT server: http://localhost:${PORT}`));

export { server, db, getSensorRows, getActionRows };
