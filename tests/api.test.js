import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 3199;
let child;
let authToken;

test.before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(root, 'backend'),
    env: { ...process.env, PORT: String(port), MQTT_ENABLED: 'false', DATABASE_PATH: ':memory:' },
    stdio: 'ignore'
  });
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'mxt', password: '123456' }) }).then(r => r.json());
        authToken = login.token;
        return;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server không khởi động');
});
test.after(() => child?.kill());

test('health và dashboard trả dữ liệu', async () => {
  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then(r => r.json());
  assert.equal(health.status, 'ok');
  assert.equal(health.realtime, 'websocket');
  assert.equal(health.esp32, 'OFFLINE');
  const dashboard = await fetch(`http://127.0.0.1:${port}/api/dashboard`, { headers: { Authorization: `Bearer ${authToken}` } }).then(r => r.json());
  assert.equal(dashboard.latest.length, 3);
  assert.equal(dashboard.devices.length, 3);
  assert.equal(dashboard.connection.esp32_status, 'OFFLINE');
});

test('đăng nhập JWT và đọc phiên hiện tại', async () => {
  const loginResponse = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'mxt', password: '123456' }) });
  assert.equal(loginResponse.status, 200);
  const login = await loginResponse.json();
  authToken = login.token;
  assert.ok(authToken.split('.').length === 3);
  const meResponse = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers: { Authorization: `Bearer ${authToken}` } });
  assert.equal(meResponse.status, 200);
  const me = await meResponse.json();
  assert.equal(me.user.username, 'mxt');
  assert.equal(me.user.password_hash, undefined);
});

test('đăng ký tài khoản mới với mật khẩu được bảo vệ', async () => {
  const suffix = Date.now();
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ full_name: 'Test User', email: `test${suffix}@example.com`, username: `test${suffix}`, password: 'secret123' }) });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.user.password_hash, undefined);
});

test('WebSocket yêu cầu JWT và gửi sự kiện ready', async () => {
  const message = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(authToken)}`);
    const timer = setTimeout(() => { socket.close(); reject(new Error('WebSocket timeout')); }, 2000);
    socket.addEventListener('message', event => { clearTimeout(timer); socket.close(); resolve(JSON.parse(event.data)); });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket lỗi')); });
  });
  assert.equal(message.event, 'ready');
});

test('lọc và phân trang sensor', async () => {
  const result = await fetch(`http://127.0.0.1:${port}/api/sensors?field=type&search=${encodeURIComponent('Nhiệt độ')}&page=1&limit=10`, { headers: { Authorization: `Bearer ${authToken}` } }).then(r => r.json());
  assert.equal(result.items.length, 10);
  assert.ok(result.items.every(item => item.sensor_type === 'TEMPERATURE'));
  assert.ok(result.pagination.total >= 5);
  assert.ok(result.items.every((item, index, items) => index === 0 || new Date(items[index - 1].recorded_at) >= new Date(item.recorded_at)));
});

test('lọc lịch sử và điều khiển thiết bị', async () => {
  const controlResponse = await fetch(`http://127.0.0.1:${port}/api/device/control`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` }, body: JSON.stringify({ device_id: 1, action: 'bat' }) });
  assert.equal(controlResponse.status, 503);
  const control = await controlResponse.json();
  assert.equal(control.status, 'FAIL');
  const history = await fetch(`http://127.0.0.1:${port}/api/history?field=action&search=${encodeURIComponent('Bật')}`, { headers: { Authorization: `Bearer ${authToken}` } }).then(r => r.json());
  assert.ok(history.items.every(item => item.action === 'TURN_ON'));
  assert.ok(history.items.some(item => item.user_name === 'mxt' && item.status === 'FAIL'));
});

test('firmware, backend và database dùng đúng GPIO/topic', async () => {
  const firmware = await import('node:fs/promises').then(fs => fs.readFile(new URL('../esp32_firmware/esp32_firmware.ino', import.meta.url), 'utf8'));
  assert.match(firmware, /TOPIC_DATA_SENSOR\s*=\s*"data_Sensors"/);
  assert.match(firmware, /TOPIC_DEVICE_CONTROL\s*=\s*"device_control"/);
  assert.match(firmware, /TOPIC_DEVICE_RESPONSE\s*=\s*"device_Response"/);
  assert.match(firmware, /TOPIC_DEVICE_ALERT\s*=\s*"device_Alert"/);
  assert.match(firmware, /LED_DEN\s+18/);
  assert.match(firmware, /LED_QUAT\s+17/);
  assert.match(firmware, /LED_DIEU_HOA\s+16/);
  const dashboard = await fetch(`http://127.0.0.1:${port}/api/dashboard`, { headers: { Authorization: `Bearer ${authToken}` } }).then(r => r.json());
  assert.deepEqual(dashboard.devices.map(device => device.gpio_pin), [18, 17, 16]);
});

test('API nghiệp vụ từ chối request không có JWT', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/sensors`);
  assert.equal(response.status, 401);
});

test('profile đúng thông tin Bài 3', async () => {
  const profile = await fetch(`http://127.0.0.1:${port}/api/profile`, { headers: { Authorization: `Bearer ${authToken}` } }).then(r => r.json());
  assert.equal(profile.full_name, 'Mai Xuân Trường');
  assert.equal(profile.phone, null);
  assert.equal(profile.github_url, null);
  assert.equal(profile.figma_url, null);
});

test('sensor API supports page limits 5, 10, 25, 50 and 100', async () => {
  for (const limit of [5, 10, 25, 50, 100]) {
    const response = await fetch(`http://127.0.0.1:${port}/api/sensors?field=all&page=1&limit=${limit}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.pagination.limit, limit);
    assert.equal(result.items.length, limit);
  }
});

test('history API supports page limits 5, 10, 25, 50 and 100', async () => {
  for (const limit of [5, 10, 25, 50, 100]) {
    const response = await fetch(`http://127.0.0.1:${port}/api/history?page=1&limit=${limit}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.pagination.limit, limit);
    assert.ok(result.items.length <= limit);
  }
});

test('page limit UI offers 5, 10, 25, 50, 100 and resets to page one', async () => {
  const app = await readFile(new URL('../frontend/app.js', import.meta.url), 'utf8');
  const limitValues = [...app.matchAll(/<option value="(5|10|25|50|100)"/g)].map(match => Number(match[1]));
  assert.deepEqual(limitValues, [5, 10, 25, 50, 100]);
  assert.match(app, /\.page-limit[^\n]+addEventListener\('change',[^\n]+loader\(1,/);
});

test('sensor and history toolbars expose search and refresh actions', async () => {
  const html = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../frontend/app.js', import.meta.url), 'utf8');
  assert.match(html, /data-refresh="sensor"/);
  assert.match(html, /data-refresh="history"/);
  assert.match(html.match(/<form id="sensorFilters"[\s\S]*?<\/form>/)?.[0] || '', /type="submit">Tìm kiếm/);
  assert.match(html.match(/<form id="historyFilters"[\s\S]*?<\/form>/)?.[0] || '', /type="submit">Tìm kiếm/);
  assert.match(app, /\[data-refresh\][^\n]+loadSensors\(1\)[^\n]+loadHistory\(1\)/);
});

test('sensor UI has exactly five search options', async () => {
  const html = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  const form = html.match(/<form id="sensorFilters"[\s\S]*?<\/form>/)?.[0];
  assert.ok(form, 'sensorFilters form was not found');
  const options = [...form.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(options, ['all', 'time', 'temperature', 'humidity', 'light']);
  assert.match(form, /placeholder="Nhập giá trị tìm kiếm\.\.\."/);
});

test('history API combines device, status, action and time filters', async () => {
  const year = new Date().getFullYear();
  const params = new URLSearchParams({
    page: '1', limit: '20', device: '1', status: 'SUCCESS',
    action: 'TURN_ON', field: 'time', search: String(year)
  });
  const response = await fetch(`http://127.0.0.1:${port}/api/history?${params}`, {
    headers: { Authorization: `Bearer ${authToken}` }
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.items.length > 0);
  assert.ok(result.items.every(item => item.device_id === 1));
  assert.ok(result.items.every(item => item.status === 'SUCCESS'));
  assert.ok(result.items.every(item => item.action === 'TURN_ON'));
  assert.ok(result.items.every(item => item.requested_at.includes(String(year))));
});

test('history UI has three selects and a time search input', async () => {
  const html = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  const form = html.match(/<form id="historyFilters"[\s\S]*?<\/form>/)?.[0];
  assert.ok(form, 'historyFilters form was not found');
  assert.match(form, /name="device"/);
  assert.match(form, /name="status"/);
  assert.match(form, /name="action"/);
  assert.match(form, /name="field" type="hidden" value="time"/);
  assert.match(form, /name="search" type="search"[^>]+placeholder="VD: 14:15:08 30\/9\/26"/);
});

test('profile exposes a valid Postman Collection with all API groups', async () => {
  const html = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  assert.match(html, /href="assets\/IOT-PTIT\.postman_collection\.json" download/);
  const raw = await readFile(new URL('../frontend/assets/IOT-PTIT.postman_collection.json', import.meta.url), 'utf8');
  const collection = JSON.parse(raw);
  assert.equal(collection.info.schema, 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
  assert.deepEqual(collection.item.map(group => group.name), ['Auth', 'Sensor Data', 'Action History', 'Device Control']);
});

test('dashboard has three metric cards and ESP32 status in sidebar', async () => {
  const html = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  const dashboard = html.match(/<section id="dashboard"[\s\S]*?<\/section>/)?.[0] || '';
  const metricGrid = dashboard.match(/<div class="metric-grid">[\s\S]*?<div class="dashboard-grid">/)?.[0] || '';
  assert.equal((metricGrid.match(/<article class="metric /g) || []).length, 3);
  assert.doesNotMatch(metricGrid, /metric connection/);
  assert.match(html, /class="server-state esp32-sidebar-state"/);
  assert.match(html, /id="esp32Status">OFFLINE/);
});

test('dashboard is viewport locked and uses assessment badges with SVG icons', async () => {
  const css = await readFile(new URL('../frontend/styles.css', import.meta.url), 'utf8');
  const html = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../frontend/app.js', import.meta.url), 'utf8');
  assert.match(css, /body\.dashboard-active[^{]+\{[^}]*height:\s*100vh;[^}]*max-height:\s*100vh;[^}]*overflow:\s*hidden;/);
  assert.doesNotMatch(css, /body\.dashboard-active \.dashboard-container[^}]*\{[^}]*height:\s*100vh/);
  assert.match(css, /\.dashboard-page\s*\{[^}]*height:\s*calc\(100vh - 92px\)/);
  assert.match(css, /\.metric-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,/);
  assert.match(css, /\.dashboard-grid\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s+max-content/);
  assert.match(css, /\.device-panel\s*\{[^}]*min-height:\s*max-content/);
  assert.ok((html.match(/<svg viewBox="0 0 24 24"/g) || []).length >= 3);
  assert.match(app, /value < 20/);
  assert.match(app, /value <= 30/);
  assert.match(app, /value < 40/);
  assert.match(app, /value <= 70/);
  assert.match(app, /value < 300/);
  assert.match(app, /value <= 750/);
  assert.match(app, /function deviceIcon\(type\)/);
});

test('time search accepts the exact Vietnamese display format', async () => {
  const headers = { Authorization: `Bearer ${authToken}` };
  const firstPage = await fetch(`http://127.0.0.1:${port}/api/sensors?page=1&limit=10`, { headers }).then(response => response.json());
  const row = firstPage.items[0];
  const date = new Date(row.recorded_at);
  const pad = value => String(value).padStart(2, '0');
  const displayed = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${date.getDate()}/${date.getMonth() + 1}/${String(date.getFullYear()).slice(-2)}`;
  const result = await fetch(`http://127.0.0.1:${port}/api/sensors?field=time&search=${encodeURIComponent(displayed)}&page=1&limit=10`, { headers }).then(response => response.json());
  assert.ok(result.items.some(item => item.id === row.id));
  const normalizedByFrontend = date.toISOString().slice(0, 19);
  const normalizedResult = await fetch(`http://127.0.0.1:${port}/api/sensors?field=time&search=${encodeURIComponent(normalizedByFrontend)}&page=1&limit=10`, { headers }).then(response => response.json());
  assert.ok(normalizedResult.items.some(item => item.id === row.id));
});

test('smart sensor search combines selected type with value or partial date', async () => {
  const headers = { Authorization: `Bearer ${authToken}` };
  const firstPage = await fetch(`http://127.0.0.1:${port}/api/sensors?page=1&limit=10`, { headers }).then(response => response.json());
  const row = firstPage.items[0];
  const field = { TEMPERATURE: 'temperature', HUMIDITY: 'humidity', LIGHT: 'light' }[row.sensor_type];
  const localDate = new Date(new Date(row.recorded_at).getTime() + 7 * 60 * 60 * 1000);
  const day = localDate.getUTCDate();
  const month = localDate.getUTCMonth() + 1;
  const year = localDate.getUTCFullYear();
  for (const keyword of [`${day}/${month}`, `${day}/${month}/${String(year).slice(-2)}`, `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`]) {
    const result = await fetch(`http://127.0.0.1:${port}/api/sensors?field=${field}&search=${encodeURIComponent(keyword)}&page=1&limit=100`, { headers }).then(response => response.json());
    assert.ok(result.items.some(item => item.id === row.id), `missing sensor row for ${keyword}`);
    assert.ok(result.items.every(item => item.sensor_type === row.sensor_type));
  }
  const valueResult = await fetch(`http://127.0.0.1:${port}/api/sensors?field=${field}&search=${encodeURIComponent(String(row.value))}&page=1&limit=100`, { headers }).then(response => response.json());
  assert.ok(valueResult.items.some(item => item.id === row.id));
});

test('history search supports partial Vietnamese dates without exact datetime comparison', async () => {
  const headers = { Authorization: `Bearer ${authToken}` };
  const firstPage = await fetch(`http://127.0.0.1:${port}/api/history?page=1&limit=10`, { headers }).then(response => response.json());
  const row = firstPage.items[0];
  const localDate = new Date(new Date(row.requested_at).getTime() + 7 * 60 * 60 * 1000);
  const day = localDate.getUTCDate();
  const month = localDate.getUTCMonth() + 1;
  const year = localDate.getUTCFullYear();
  for (const keyword of [`${day}/${month}`, `${day}/${month}/${String(year).slice(-2)}`, `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`]) {
    const result = await fetch(`http://127.0.0.1:${port}/api/history?field=time&search=${encodeURIComponent(keyword)}&page=1&limit=100`, { headers }).then(response => response.json());
    assert.ok(result.items.some(item => item.id === row.id), `missing history row for ${keyword}`);
  }
  const server = await readFile(new URL('../backend/server.js', import.meta.url), 'utf8');
  assert.doesNotMatch(server, /datetime\(\$\{column\}\)\s*=\s*datetime\(\?\)/);
});

test('search validation returns structured 400 errors for invalid input', async () => {
  const headers = { Authorization: `Bearer ${authToken}` };
  const cases = [
    '/api/sensors?field=time&search=35%2F19',
    '/api/sensors?field=temperature&search=abc',
    `/api/history?field=time&search=${encodeURIComponent('Quạt')}`
  ];
  for (const pathname of cases) {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers });
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(result.error, 'INVALID_SEARCH_FORMAT');
    assert.equal(result.field, 'search');
    assert.ok(result.message);
    assert.ok(result.hint);
  }
});

test('numeric smart search only matches the sensor value column', async () => {
  const headers = { Authorization: `Bearer ${authToken}` };
  const temperatures = await fetch(`http://127.0.0.1:${port}/api/sensors?field=temperature&page=1&limit=10`, { headers }).then(response => response.json());
  const target = temperatures.items.find(item => !Number.isInteger(item.value)) || temperatures.items[0];
  const result = await fetch(`http://127.0.0.1:${port}/api/sensors?field=all&search=${encodeURIComponent(String(target.value))}&page=1&limit=100`, { headers }).then(response => response.json());
  assert.ok(result.items.length > 0);
  assert.ok(result.items.every(item => item.value === target.value));
});

test('filtered pagination total and pages use exactly the same sensor filter', async () => {
  const headers = { Authorization: `Bearer ${authToken}` };
  const first = await fetch(`http://127.0.0.1:${port}/api/sensors?field=temperature&page=1&limit=5`, { headers }).then(response => response.json());
  const ids = [];
  for (let page = 1; page <= first.pagination.pages; page += 1) {
    const result = await fetch(`http://127.0.0.1:${port}/api/sensors?field=temperature&page=${page}&limit=5`, { headers }).then(response => response.json());
    assert.equal(result.pagination.total, first.pagination.total);
    assert.equal(result.pagination.pages, Math.max(1, Math.ceil(first.pagination.total / 5)));
    assert.ok(result.items.every(item => item.sensor_type === 'TEMPERATURE'));
    ids.push(...result.items.map(item => item.id));
  }
  assert.equal(ids.length, first.pagination.total);
  assert.equal(new Set(ids).size, first.pagination.total);
});

test('search forms expose accessible inline validation without replacing table data', async () => {
  const html = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../frontend/styles.css', import.meta.url), 'utf8');
  const app = await readFile(new URL('../frontend/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="sensorSearchError"[^>]+role="alert"[^>]+aria-live="polite"/);
  assert.match(html, /id="historySearchError"[^>]+role="alert"[^>]+aria-live="polite"/);
  assert.equal((html.match(/maxlength="100"/g) || []).length, 2);
  assert.match(css, /\.search-field input\[aria-invalid="true"\]/);
  assert.match(app, /function validateSearchForm\(form, kind\)/);
  assert.match(app, /error\.field === 'search'\) setSearchError/);
});

test('filter dropdowns auto-submit and clearing a keyword reloads page one', async () => {
  const app = await readFile(new URL('../frontend/app.js', import.meta.url), 'utf8');
  assert.match(app, /#sensorFilters select, #historyFilters select/);
  assert.match(app, /select\.addEventListener\('change',[\s\S]*?select\.form\.id === 'sensorFilters' \? loadSensors\(1\) : loadHistory\(1\)/);
  assert.match(app, /const wasNotEmpty = input\.dataset\.searchNotEmpty === 'true'/);
  assert.match(app, /const isNotEmpty = input\.value\.trim\(\) !== ''/);
  assert.match(app, /if \(wasNotEmpty && !isNotEmpty\) input\.form\.id === 'sensorFilters' \? loadSensors\(1\) : loadHistory\(1\)/);
});

test('static frontend files disable cache and use versioned assets', async () => {
  const indexResponse = await fetch(`http://127.0.0.1:${port}/`);
  assert.match(indexResponse.headers.get('cache-control') || '', /no-store/);
  const html = await indexResponse.text();
  assert.match(html, /styles\.css\?v=\d+/);
  assert.match(html, /app\.js\?v=\d+/);
});

test('all reported sensor pages contain the expected rows', async () => {
  const headers = { Authorization: `Bearer ${authToken}` };
  const first = await fetch(`http://127.0.0.1:${port}/api/sensors?page=1&limit=10`, { headers }).then(response => response.json());
  const ids = [];
  for (let page = 1; page <= first.pagination.pages; page += 1) {
    const result = await fetch(`http://127.0.0.1:${port}/api/sensors?page=${page}&limit=10`, { headers }).then(response => response.json());
    const expected = Math.min(10, first.pagination.total - (page - 1) * 10);
    assert.equal(result.items.length, expected, `page ${page} must not be empty or incomplete`);
    ids.push(...result.items.map(item => item.id));
  }
  assert.equal(ids.length, first.pagination.total);
  assert.equal(new Set(ids).size, first.pagination.total);
});

test('sensor and history tables display continuous page-relative STT', async () => {
  const html = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../frontend/app.js', import.meta.url), 'utf8');
  assert.equal((html.match(/<th>STT<\/th>/g) || []).length, 2);
  assert.match(app, /function rowNumber\(pagination, index\) \{ return \(pagination\.page - 1\) \* pagination\.limit \+ index \+ 1; \}/);
  assert.match(app, /data\.items\.map\(\(row, index\) => `<tr><td>#\$\{rowNumber\(data\.pagination, index\)\}/);
  assert.doesNotMatch(app, /<tr><td>#\$\{row\.id\}/);
});

test('backend keeps deterministic time and primary-key ordering for both tables', async () => {
  const server = await readFile(new URL('../backend/server.js', import.meta.url), 'utf8');
  assert.match(server, /ORDER BY sd\.recorded_at DESC, sd\.id DESC/);
  assert.match(server, /ORDER BY ah\.requested_at DESC, ah\.id DESC/);
});

test('table cards do not repeat the page titles', async () => {
  const html = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  const sensorSection = html.match(/<section id="sensors"[\s\S]*?<\/section>/)?.[0] || '';
  const historySection = html.match(/<section id="history"[\s\S]*?<\/section>/)?.[0] || '';
  assert.doesNotMatch(sensorSection, /<h2>Dữ liệu cảm biến<\/h2>/);
  assert.doesNotMatch(historySection, /<h2>Action History<\/h2>/);
});

test('sensor and history table cards fill the viewport with bottom pagination', async () => {
  const css = await readFile(new URL('../frontend/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.table-page\s*\{[^}]*min-height:\s*calc\(100vh - 102px\)[^}]*display:\s*flex[^}]*flex-direction:\s*column/);
  assert.match(css, /\.table-panel\s*\{[^}]*flex:\s*1[^}]*display:\s*flex[^}]*flex-direction:\s*column/);
  assert.match(css, /\.pagination\s*\{[^}]*margin-top:\s*auto/);
  assert.match(css, /th\s*\{[^}]*padding:\s*16px 14px/);
  assert.match(css, /td\s*\{[^}]*padding:\s*16px 14px/);
});

test('profile edit API updates editable fields but preserves identity', async () => {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` };
  const update = {
    email: 'updated-student@example.com', phone: '0900000000', date_of_birth: '2000-01-01',
    github_url: 'https://github.com/example/iot', figma_url: 'https://figma.com/file/example',
    postman_url: 'https://documenter.getpostman.com/example', srs_url: 'https://example.com/srs.pdf',
    avatar_url: 'data:image/png;base64,AA=='
  };
  const response = await fetch(`http://127.0.0.1:${port}/api/users/profile`, { method: 'PUT', headers, body: JSON.stringify(update) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.profile.full_name, 'Mai Xuân Trường');
  assert.equal(result.profile.username, 'mxt');
  assert.equal(result.profile.github_url, update.github_url);
  assert.equal(result.profile.postman_url, update.postman_url);
  assert.equal(result.profile.srs_url, update.srs_url);
  assert.equal(result.profile.avatar_url, update.avatar_url);
});

test('profile UI contains SVG resources, status badges and edit modal', async () => {
  const html = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  const profile = html.match(/<section id="profile"[\s\S]*?<\/section>/)?.[0] || '';
  assert.equal((profile.match(/class="resource-status /g) || []).length, 4);
  assert.equal((profile.match(/class="resource-icon [^"]+"><svg/g) || []).length, 4);
  assert.doesNotMatch(profile, />GH<|>API<|>PDF</);
  assert.match(html, /id="profileModal"/);
  assert.match(html, /id="profileEditForm"/);
  assert.match(html, /name="full_name" readonly/);
  assert.match(html, /name="student_id" readonly/);
  assert.match(html, /name="avatar" type="file"/);
  assert.match(html, /name="github_url" type="url"/);
  assert.match(html, /name="srs_url" type="url"/);
});

test('profile uses system-wide title, edit icon and muted resource colors', async () => {
  const html = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../frontend/styles.css', import.meta.url), 'utf8');
  const app = await readFile(new URL('../frontend/app.js', import.meta.url), 'utf8');
  assert.match(app, /profile: 'Hồ sơ hệ thống'/);
  assert.match(html, /id="editProfileButton"[^>]*><svg[^>]*>[\s\S]*?<span>Sửa hồ sơ<\/span>/);
  assert.match(css, /\.resource-icon\s*\{[^}]*color:\s*#d1d5db[^}]*transition:/);
  assert.match(css, /\.resource-card:hover \.figma-icon\s*\{[^}]*color:\s*#c084fc/);
  assert.match(css, /\.resource-card:hover \.postman-icon\s*\{[^}]*color:\s*#ff6c37/);
  assert.match(css, /\.resource-card:hover \.pdf-icon\s*\{[^}]*color:\s*#f87171/);
});

test('profile modal saves through PUT then closes, reloads and shows success toast', async () => {
  const app = await readFile(new URL('../frontend/app.js', import.meta.url), 'utf8');
  assert.match(app, /request\('\/api\/users\/profile', \{ method: 'PUT'/);
  assert.match(app, /state\.profile = result\.profile; closeProfileModal\(\); await loadProfile\(\); toast\([^;]+, 'success'\)/);
  assert.match(app, /#editProfileButton[^\n]+addEventListener\('click', openProfileModal\)/);
  assert.match(app, /data-close-profile[^\n]+addEventListener\('click', closeProfileModal\)/);
});
