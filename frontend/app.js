const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { sensorPage: 1, sensorLimit: 10, sensorRequest: 0, historyPage: 1, historyLimit: 10, historyRequest: 0, dashboard: null, user: null, profile: null, avatarDraft: '', socket: null };
const routeTitles = { dashboard: 'Dashboard giám sát', sensors: 'Dữ liệu cảm biến', history: 'Lịch sử hoạt động', profile: 'Hồ sơ hệ thống' };
const sensorNames = { TEMPERATURE: 'Nhiệt độ', HUMIDITY: 'Độ ẩm', LIGHT: 'Ánh sáng' };
const actionNames = { TURN_ON: 'Bật', TURN_OFF: 'Tắt', AUTO_OFF: 'Tự động ngắt' };
const statusNames = { SUCCESS: 'Thành công', PROCESSING: 'Đang xử lý', FAIL: 'Thất bại', TIMEOUT: 'Quá thời gian' };
let toastTimer;

async function request(url, options = {}) {
  const { auth = true, headers = {}, ...fetchOptions } = options;
  const token = localStorage.getItem('iot_token');
  const response = await fetch(url, { ...fetchOptions, headers: { 'Content-Type': 'application/json', ...(auth && token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
  const data = await response.json();
  if (response.status === 401 && auth) logout(true);
  if (!response.ok) {
    const error = new Error(data.message || data.error || 'Không thể kết nối máy chủ');
    Object.assign(error, { code: data.error, field: data.field, hint: data.hint, status: response.status });
    throw error;
  }
  return data;
}
function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function formatTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value || '—') : new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'medium' }).format(date); }
function formatDate(value) { if (!value) return 'Chưa cập nhật'; const [y, m, d] = value.split('-'); return `${d}/${m}/${y}`; }
function rowNumber(pagination, index) { return (pagination.page - 1) * pagination.limit + index + 1; }
function normalizedSearch(value) { return String(value || '').normalize('NFKC').replace(/[\u200e\u200f\u202a-\u202e]/g, '').replace(/\s+/g, ' ').trim(); }
function validSearchDate(day, month, year = new Date().getFullYear()) { const fullYear = Number(year) < 100 ? 2000 + Number(year) : Number(year); const date = new Date(Date.UTC(fullYear, Number(month) - 1, Number(day))); return date.getUTCFullYear() === fullYear && date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day); }
function validSearchTime(hour, minute, second = 0) { return Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59; }
function validTimeSearch(value) {
  const input = normalizedSearch(value); let match;
  if (/^\d{4}$/.test(input)) return Number(input) >= 1970;
  if ((match = input.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/))) return validSearchDate(match[1], match[2], match[3]);
  if ((match = input.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/))) return validSearchTime(match[1], match[2], match[3]);
  if ((match = input.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/))) return validSearchTime(match[1], match[2], match[3]) && validSearchDate(match[4], match[5], match[6]);
  if ((match = input.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?[,]?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/))) return validSearchDate(match[1], match[2], match[3]) && validSearchTime(match[4], match[5], match[6]);
  if ((match = input.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i))) return validSearchDate(match[3], match[2], match[1]) && (!match[4] || validSearchTime(match[4], match[5], match[6]));
  return false;
}
function setSearchError(form, message) { const input = form.elements.search; const error = $('.search-error', form); input.setAttribute('aria-invalid', message ? 'true' : 'false'); error.textContent = message || ''; error.hidden = !message; }
function validateSearchForm(form, kind) {
  const keyword = normalizedSearch(form.elements.search.value); const field = form.elements.field.value;
  setSearchError(form, '');
  if (!keyword) return true;
  if (keyword.length > 100) { setSearchError(form, 'Từ khóa tìm kiếm không được vượt quá 100 ký tự.'); return false; }
  if (kind === 'history' || field === 'time') {
    if (validTimeSearch(keyword)) return true;
    setSearchError(form, 'Định dạng thời gian không hợp lệ. Hãy nhập như 30/9, 14:20 hoặc 14:20:08 30/9/26.'); return false;
  }
  const isNumber = /^[+-]?\d+(?:[.,]\d+)?$/.test(keyword);
  if (['temperature', 'humidity', 'light'].includes(field) && !isNumber && !validTimeSearch(keyword)) {
    setSearchError(form, 'Với loại cảm biến đã chọn, hãy nhập giá trị số hoặc thời gian.'); return false;
  }
  if (field === 'all' && !isNumber && !validTimeSearch(keyword) && !/\p{L}/u.test(keyword)) {
    setSearchError(form, 'Định dạng tìm kiếm không hợp lệ.'); return false;
  }
  return true;
}
function toast(message, tone = '') { const el = $('#toast'); el.textContent = message; el.className = tone; requestAnimationFrame(() => el.classList.add('show')); clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.classList.remove('show'); setTimeout(() => { el.className = ''; }, 250); }, 2600); }
function normalizeDisplayedTime(value) {
  const input = String(value || '').normalize('NFKC').replace(/[\u200e\u200f\u202a-\u202e]/g, '').replace(/\s+/g, ' ').trim();
  const timeFirst = input.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  const dateFirst = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})[,]?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!timeFirst && !dateFirst) return input;
  const parts = timeFirst
    ? { hour: timeFirst[1], minute: timeFirst[2], second: timeFirst[3] || 0, day: timeFirst[4], month: timeFirst[5], year: timeFirst[6] }
    : { day: dateFirst[1], month: dateFirst[2], year: dateFirst[3], hour: dateFirst[4], minute: dateFirst[5], second: dateFirst[6] || 0 };
  const year = Number(parts.year) < 100 ? 2000 + Number(parts.year) : Number(parts.year);
  const date = new Date(year, Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Number.isNaN(date.getTime()) ? input : date.toISOString().slice(0, 19);
}
function queryFromForm(form, page, limit) {
  const params = new URLSearchParams(new FormData(form));
  if (params.get('field') === 'time' && params.get('search')) params.set('search', normalizeDisplayedTime(params.get('search')));
  params.set('page', page); params.set('limit', String(limit)); return params;
}

function showRoute() {
  if (!localStorage.getItem('iot_token')) { showAuth('login'); return; }
  const route = location.hash.slice(1) || 'dashboard';
  const safeRoute = routeTitles[route] ? route : 'dashboard';
  document.body.classList.toggle('dashboard-active', safeRoute === 'dashboard');
  $$('.page').forEach(page => { page.hidden = page.id !== safeRoute; });
  $$('[data-route]').forEach(link => link.classList.toggle('active', link.dataset.route === safeRoute));
  $('#pageTitle').textContent = routeTitles[safeRoute];
  if (safeRoute === 'dashboard') loadDashboard();
  if (safeRoute === 'sensors') loadSensors();
  if (safeRoute === 'history') loadHistory();
  if (safeRoute === 'profile') loadProfile();
}

function showAuth(screen = 'login') {
  $('#appShell').hidden = true; $('#authView').hidden = false;
  $('#loginCard').hidden = screen !== 'login'; $('#registerCard').hidden = screen !== 'register';
}
function showApplication(user) {
  state.user = user; $('#currentUserName').textContent = user.full_name || user.username;
  $('.avatar-mini').textContent = (user.full_name || user.username).split(/\s+/).map(part => part[0]).slice(-2).join('').toUpperCase();
  $('#authView').hidden = true; $('#appShell').hidden = false; connectWebSocket(); showRoute();
}
function logout(expired = false) {
  localStorage.removeItem('iot_token'); state.user = null; state.socket?.close(); state.socket = null;
  location.hash = 'login'; showAuth('login');
  if (expired) toast('Phiên đăng nhập đã hết hạn');
}
async function submitLogin(event) {
  event.preventDefault(); const form = event.currentTarget; const error = $('#loginError'); error.textContent = '';
  if (!form.reportValidity()) return;
  const button = $('button[type="submit"]', form); button.disabled = true;
  try {
    const data = await request('/api/auth/login', { method: 'POST', auth: false, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    localStorage.setItem('iot_token', data.token); location.hash = 'dashboard'; showApplication(data.user); toast('Đăng nhập thành công');
  } catch (err) { error.textContent = err.message; } finally { button.disabled = false; }
}
async function submitRegister(event) {
  event.preventDefault(); const form = event.currentTarget; const error = $('#registerError'); error.textContent = '';
  if (!form.reportValidity()) return;
  const values = Object.fromEntries(new FormData(form));
  if (values.password !== values.confirm_password) { error.textContent = 'Mật khẩu xác nhận không khớp'; return; }
  const button = $('button[type="submit"]', form); button.disabled = true;
  try {
    delete values.confirm_password;
    await request('/api/auth/register', { method: 'POST', auth: false, body: JSON.stringify(values) });
    form.reset(); showAuth('login'); $('#loginForm [name="account"]').value = values.username; toast('Đăng ký thành công, hãy đăng nhập');
  } catch (err) { error.textContent = err.message; } finally { button.disabled = false; }
}

async function loadDashboard() {
  try {
    const data = await request('/api/dashboard'); state.dashboard = data;
    const latest = Object.fromEntries(data.latest.map(row => [row.sensor_type, row]));
    $('#temperatureValue').textContent = `${latest.TEMPERATURE?.value?.toFixed(1) ?? '--'} °C`;
    $('#humidityValue').textContent = `${latest.HUMIDITY?.value?.toFixed(1) ?? '--'} %`;
    $('#lightValue').textContent = `${latest.LIGHT?.value?.toFixed(0) ?? '--'} Lux`;
    renderAssessments(latest);
    renderConnection(data.connection);
    renderDevices(data.devices); drawChart(data.chart);
  } catch (error) { toast(error.message); }
}
function setAssessment(selector, value, ranges) {
  const element = $(selector); const number = Number(value);
  const assessment = Number.isFinite(number) ? ranges.find(item => item.when(number)) : { text: '• Đang đánh giá', tone: 'neutral' };
  element.textContent = assessment.text; element.className = `assessment ${assessment.tone}`;
}
function renderAssessments(latest) {
  setAssessment('#temperatureAssessment', latest.TEMPERATURE?.value, [
    { when: value => value < 20, text: '❄ Se lạnh', tone: 'cool' },
    { when: value => value <= 30, text: '● Lý tưởng', tone: 'ideal' },
    { when: () => true, text: '🔥 Khá nóng · Cần bật điều hòa', tone: 'hot' }
  ]);
  setAssessment('#humidityAssessment', latest.HUMIDITY?.value, [
    { when: value => value < 40, text: '○ Không khí khô', tone: 'dry' },
    { when: value => value <= 70, text: '● Thoải mái', tone: 'comfortable' },
    { when: () => true, text: '💧 Độ ẩm cao', tone: 'wet' }
  ]);
  setAssessment('#lightAssessment', latest.LIGHT?.value, [
    { when: value => value < 300, text: '○ Thiếu sáng · Nên bật đèn', tone: 'dim' },
    { when: value => value <= 750, text: '● Đủ sáng học tập', tone: 'bright' },
    { when: () => true, text: '☀ Ánh sáng mạnh', tone: 'sunny' }
  ]);
}
function renderConnection(connection = {}) {
  const webSocketOnline = state.socket?.readyState === WebSocket.OPEN;
  const online = connection.esp32_status === 'ONLINE' && connection.mqtt === 'connected' && webSocketOnline;
  $('#esp32Status').textContent = online ? 'ONLINE' : 'OFFLINE';
  $('#esp32Status').classList.toggle('online', online); $('#esp32Status').classList.toggle('offline', !online);
  $('#esp32Dot').classList.toggle('ok', online);
  $('#connectionDetail').textContent = online ? 'WebSocket · MQTT ổn định' : `WebSocket: ${webSocketOnline ? 'online' : 'offline'} · MQTT: ${connection.mqtt || 'offline'}`;
  $('#deviceAlert').textContent = connection.alert || (online ? 'ESP32 đang hoạt động ổn định' : 'Chưa nhận kết nối từ ESP32');
}
function renderDevices(devices) {
  $('#deviceList').innerHTML = devices.map(device => { const on = device.current_status === 'ON'; return `<div class="device-row"><div class="device-name"><i>${deviceIcon(device.device_type)}</i><span><strong>${escapeHtml(device.name)}</strong><small>GPIO ${device.gpio_pin}</small><small class="device-state ${on ? 'state-on' : 'state-off'}">${on ? '● Đang bật' : '○ Đang tắt'}</small></span></div><button class="toggle ${on ? 'on' : ''}" data-device-id="${device.id}" data-device-status="${device.current_status}" aria-label="${on ? 'Tắt' : 'Bật'} ${escapeHtml(device.name)}"></button></div>`; }).join('');
  $$('.toggle').forEach(button => button.addEventListener('click', () => controlDevice(button)));
}
function deviceIcon(type) {
  if (type === 'LIGHT') return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 22h4M8.2 14.5A7 7 0 1 1 15.8 14.5c-.8.7-1.3 1.5-1.3 2.5h-5c0-1-.5-1.8-1.3-2.5Z"/></svg>';
  if (type === 'FAN') return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2"/><path d="M12 10c-1.2-2.7-.6-6.7 2.2-7.5 2.1-.6 3.2 1.8 2.4 3.7C15.8 8.2 14 9.4 12 10ZM14 12c2.7-1.2 6.7-.6 7.5 2.2.6 2.1-1.8 3.2-3.7 2.4-2-.8-3.2-2.6-3.8-4.6ZM12 14c1.2 2.7.6 6.7-2.2 7.5-2.1.6-3.2-1.8-2.4-3.7.8-2 2.6-3.2 4.6-3.8ZM10 12c-2.7 1.2-6.7.6-7.5-2.2-.6-2.1 1.8-3.2 3.7-2.4 2 .8 3.2 2.6 3.8 4.6Z"/></svg>';
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v20M4.93 4.93l14.14 14.14M2 12h20M4.93 19.07 19.07 4.93M8 4l4 4 4-4M8 20l4-4 4 4M4 8l4 4-4 4M20 8l-4 4 4 4"/></svg>';
}
async function controlDevice(button) {
  button.disabled = true; const next = button.dataset.deviceStatus === 'ON' ? 'tat' : 'bat';
  try { const result = await request('/api/device/control', { method: 'POST', body: JSON.stringify({ device_id: Number(button.dataset.deviceId), action: next }) }); toast(result.status === 'PROCESSING' ? 'Đã gửi lệnh tới ESP32' : 'Đã cập nhật thiết bị'); await loadDashboard(); }
  catch (error) { toast(error.message); button.disabled = false; }
}
function drawChart(rows) {
  const canvas = $('#sensorChart'); const wrap = canvas.parentElement; const ratio = devicePixelRatio || 1;
  const width = wrap.clientWidth; const height = wrap.clientHeight; canvas.width = width * ratio; canvas.height = height * ratio;
  const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio); ctx.clearRect(0, 0, width, height);
  $('#chartEmpty').hidden = rows.length > 0; if (!rows.length) return;
  const pad = { l: 38, r: 16, t: 16, b: 28 }; const cw = width - pad.l - pad.r; const ch = height - pad.t - pad.b;
  ctx.strokeStyle = 'rgba(156,163,175,.18)'; ctx.lineWidth = 1; ctx.fillStyle = '#9ca3af'; ctx.font = '10px system-ui';
  for (let i = 0; i <= 4; i++) { const y = pad.t + ch * i / 4; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(width - pad.r, y); ctx.stroke(); ctx.fillText(String(100 - i * 25), 8, y + 3); }
  const series = [{ key: 'temperature', color: '#ef5b5b', max: 100 }, { key: 'humidity', color: '#3b82f6', max: 100 }, { key: 'light', color: '#f4a524', max: 1000 }];
  series.forEach(({ key, color, max }) => { ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); rows.forEach((row, i) => { const x = pad.l + (rows.length === 1 ? cw / 2 : i * cw / (rows.length - 1)); const y = pad.t + ch - Math.min(max, Number(row[key] || 0)) / max * ch; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); });
  const labelIndexes = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])]; ctx.textAlign = 'center';
  labelIndexes.forEach(i => { const x = pad.l + (rows.length === 1 ? cw / 2 : i * cw / (rows.length - 1)); ctx.fillText(new Date(rows[i].recorded_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }), x, height - 7); });
}

async function loadSensors(page = state.sensorPage, limit = state.sensorLimit) {
  const form = $('#sensorFilters'); if (!validateSearchForm(form, 'sensor')) return;
  state.sensorPage = page; state.sensorLimit = limit; const requestId = ++state.sensorRequest;
  try { const data = await request(`/api/sensors?${queryFromForm($('#sensorFilters'), page, limit)}`); if (requestId !== state.sensorRequest) return; $('#sensorTable').innerHTML = data.items.length ? data.items.map((row, index) => `<tr><td>#${rowNumber(data.pagination, index)}</td><td><span class="type-pill ${row.sensor_type}">${sensorNames[row.sensor_type] || escapeHtml(row.sensor_type)}</span></td><td><strong>${Number(row.value).toLocaleString('vi-VN')} ${escapeHtml(row.unit)}</strong></td><td>${formatTime(row.recorded_at)}</td></tr>`).join('') : emptyRow(4); renderPagination($('#sensorPagination'), data.pagination, loadSensors); }
  catch (error) { if (error.field === 'search') setSearchError(form, [error.message, error.hint].filter(Boolean).join(' ')); else toast(error.message); }
}
async function loadHistory(page = state.historyPage, limit = state.historyLimit) {
  const form = $('#historyFilters'); if (!validateSearchForm(form, 'history')) return;
  state.historyPage = page; state.historyLimit = limit; const requestId = ++state.historyRequest;
  try { const data = await request(`/api/history?${queryFromForm($('#historyFilters'), page, limit)}`); if (requestId !== state.historyRequest) return; $('#historyTable').innerHTML = data.items.length ? data.items.map((row, index) => `<tr><td>#${rowNumber(data.pagination, index)}</td><td>${escapeHtml(row.user_name)}</td><td>${escapeHtml(row.device_name)}</td><td>${actionNames[row.action] || row.action}</td><td><span class="status ${row.status}">${statusNames[row.status] || row.status}</span></td><td>${formatTime(row.requested_at)}</td></tr>`).join('') : emptyRow(6); renderPagination($('#historyPagination'), data.pagination, loadHistory); }
  catch (error) { if (error.field === 'search') setSearchError(form, [error.message, error.hint].filter(Boolean).join(' ')); else toast(error.message); }
}
function emptyRow(columns) { return `<tr><td colspan="${columns}" style="text-align:center;color:#748096;padding:34px">Không tìm thấy bản ghi phù hợp</td></tr>`; }
function renderPagination(container, pagination, loader) {
  const pages = paginationPages(pagination.page, pagination.pages);
  const pageItems = pages.map(page => page === '…' ? '<span class="page-ellipsis">…</span>' : `<button class="${page === pagination.page ? 'active' : ''}" data-page="${page}" aria-label="Trang ${page}" ${page === pagination.page ? 'aria-current="page"' : ''}>${page}</button>`).join('');
  container.innerHTML = `<span class="pagination-total">Tổng số: ${pagination.total}</span><div class="page-buttons"><button data-page="${pagination.page - 1}" aria-label="Trang trước" ${pagination.page <= 1 ? 'disabled' : ''}>&lt;</button>${pageItems}<button data-page="${pagination.page + 1}" aria-label="Trang sau" ${pagination.page >= pagination.pages ? 'disabled' : ''}>&gt;</button><label class="page-jump">Đến trang <input class="page-input" type="number" min="1" max="${pagination.pages}" value="${pagination.page}" aria-label="Nhập số trang"></label><label class="limit-control"><select class="page-limit" aria-label="Số bản ghi mỗi trang"><option value="5" ${pagination.limit === 5 ? 'selected' : ''}>5 / trang</option><option value="10" ${pagination.limit === 10 ? 'selected' : ''}>10 / trang</option><option value="25" ${pagination.limit === 25 ? 'selected' : ''}>25 / trang</option><option value="50" ${pagination.limit === 50 ? 'selected' : ''}>50 / trang</option><option value="100" ${pagination.limit === 100 ? 'selected' : ''}>100 / trang</option></select></label></div>`;
  $$('button[data-page]', container).forEach(button => button.addEventListener('click', () => loader(Number(button.dataset.page), pagination.limit)));
  $('.page-input', container).addEventListener('keydown', event => { if (event.key !== 'Enter') return; event.preventDefault(); const page = Math.min(pagination.pages, Math.max(1, Number.parseInt(event.currentTarget.value, 10) || 1)); loader(page, pagination.limit); });
  $('.page-limit', container).addEventListener('change', event => loader(1, Number(event.currentTarget.value)));
}
function paginationPages(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  if (current <= 4) return [1, 2, 3, 4, 5, '…', total];
  if (current >= total - 3) return [1, '…', total - 4, total - 3, total - 2, total - 1, total];
  return [1, '…', current - 1, current, current + 1, '…', total];
}
async function loadProfile() {
  try {
    const user = await request('/api/profile'); state.profile = user; $('#profileName').textContent = user.full_name; $('#profileDob').textContent = formatDate(user.date_of_birth); $('#profileEmail').textContent = user.email; $('#profilePhone').textContent = user.phone || 'Chưa cập nhật';
    renderProfileAvatar(user.avatar_url);
    setProjectLink($('#githubLink'), user.github_url);
    setProjectLink($('#figmaLink'), user.figma_url);
    setProjectLink($('#srsLink'), user.srs_url);
    setProjectLink($('#postmanLink'), user.postman_url, 'assets/IOT-PTIT.postman_collection.json');
  }
  catch (error) { toast(error.message); }
}
function setProjectLink(element, url, fallbackUrl = '') {
  const effectiveUrl = url || fallbackUrl; const status = $('.resource-status', element);
  if (!effectiveUrl) {
    element.href = '#'; element.classList.add('link-pending'); element.setAttribute('aria-disabled', 'true'); element.removeAttribute('target'); element.removeAttribute('rel');
    status.textContent = '○ Chưa liên kết'; status.className = 'resource-status pending'; return;
  }
  element.href = effectiveUrl; element.classList.remove('link-pending'); element.removeAttribute('aria-disabled'); status.textContent = '● Đã liên kết'; status.className = 'resource-status linked';
  if (url) { element.target = '_blank'; element.rel = 'noreferrer'; element.removeAttribute('download'); }
  else if (fallbackUrl) { element.removeAttribute('target'); element.removeAttribute('rel'); element.setAttribute('download', ''); }
}
function renderProfileAvatar(url) {
  const avatar = $('.profile-avatar'); avatar.innerHTML = url ? `<img src="${escapeHtml(url)}" alt="Ảnh đại diện">` : 'XT';
}
function renderAvatarPreview(url) { $('#avatarPreview').innerHTML = url ? `<img src="${escapeHtml(url)}" alt="Xem trước ảnh đại diện">` : 'XT'; }
async function openProfileModal() {
  if (!state.profile) await loadProfile(); if (!state.profile) return;
  const form = $('#profileEditForm'); const user = state.profile;
  form.elements.full_name.value = user.full_name || ''; form.elements.student_id.value = 'B23DCAT309'; form.elements.email.value = user.email || ''; form.elements.phone.value = user.phone || ''; form.elements.date_of_birth.value = user.date_of_birth || '';
  form.elements.github_url.value = user.github_url || ''; form.elements.figma_url.value = user.figma_url || ''; form.elements.postman_url.value = user.postman_url || ''; form.elements.srs_url.value = user.srs_url || '';
  state.avatarDraft = user.avatar_url || ''; renderAvatarPreview(state.avatarDraft); $('#avatarInput').value = ''; $('#profileEditError').textContent = ''; $('#profileModal').hidden = false; document.body.classList.add('modal-open');
}
function closeProfileModal() { $('#profileModal').hidden = true; document.body.classList.remove('modal-open'); }
async function selectAvatar(event) {
  const file = event.currentTarget.files[0]; if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 650 * 1024) { $('#profileEditError').textContent = 'Ảnh phải là PNG, JPG hoặc WebP và không vượt quá 650 KB'; event.currentTarget.value = ''; return; }
  state.avatarDraft = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }); renderAvatarPreview(state.avatarDraft); $('#profileEditError').textContent = '';
}
async function saveProfile(event) {
  event.preventDefault(); const form = event.currentTarget; const error = $('#profileEditError'); error.textContent = ''; if (!form.reportValidity()) return;
  const button = $('.save-profile', form); button.disabled = true; $('.button-label', button).hidden = true; $('.button-loading', button).hidden = false;
  const values = Object.fromEntries(new FormData(form)); delete values.avatar; delete values.full_name; delete values.student_id; values.avatar_url = state.avatarDraft;
  try { const result = await request('/api/users/profile', { method: 'PUT', body: JSON.stringify(values) }); state.profile = result.profile; closeProfileModal(); await loadProfile(); toast(result.message || 'Cập nhật hồ sơ thành công', 'success'); }
  catch (err) { error.textContent = err.message; }
  finally { button.disabled = false; $('.button-label', button).hidden = false; $('.button-loading', button).hidden = true; }
}
function debounce(fn, wait = 350) { let id; return (...args) => { clearTimeout(id); id = setTimeout(() => fn(...args), wait); }; }
$('#sensorFilters').addEventListener('submit', event => { event.preventDefault(); loadSensors(1); });
$('#historyFilters').addEventListener('submit', event => { event.preventDefault(); loadHistory(1); });
$$('#sensorFilters [name="search"], #historyFilters [name="search"]').forEach(input => {
  input.dataset.searchNotEmpty = String(input.value.trim() !== '');
  input.addEventListener('input', () => {
    const wasNotEmpty = input.dataset.searchNotEmpty === 'true';
    const isNotEmpty = input.value.trim() !== '';
    input.dataset.searchNotEmpty = String(isNotEmpty);
    setSearchError(input.form, '');
    if (wasNotEmpty && !isNotEmpty) input.form.id === 'sensorFilters' ? loadSensors(1) : loadHistory(1);
  });
});
$$('#sensorFilters select, #historyFilters select').forEach(select => select.addEventListener('change', () => {
  setSearchError(select.form, '');
  select.form.id === 'sensorFilters' ? loadSensors(1) : loadHistory(1);
}));
$$('[data-refresh]').forEach(button => button.addEventListener('click', () => button.dataset.refresh === 'sensor' ? loadSensors(1) : loadHistory(1)));
window.addEventListener('hashchange', showRoute); window.addEventListener('resize', debounce(() => state.dashboard && drawChart(state.dashboard.chart), 120));
setInterval(() => { $('#clock').textContent = new Date().toLocaleString('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }); }, 1000);
async function checkServer() { try { await request('/api/health', { auth: false }); $('#serverDot').classList.add('ok'); $('#serverText').textContent = 'Đã kết nối'; } catch { $('#serverDot').classList.remove('ok'); $('#serverText').textContent = 'Mất kết nối'; } }
function connectWebSocket() {
  state.socket?.close(); const token = localStorage.getItem('iot_token'); if (!token) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`); state.socket = socket;
  socket.addEventListener('open', () => { if (location.hash.slice(1) === 'dashboard') loadDashboard(); });
  socket.addEventListener('message', event => { try { const message = JSON.parse(event.data); if (['telemetry', 'device', 'system'].includes(message.event) && location.hash.slice(1) === 'dashboard') loadDashboard(); } catch {} });
  socket.addEventListener('close', () => { if (location.hash.slice(1) === 'dashboard' && state.dashboard) renderConnection(state.dashboard.connection); if (localStorage.getItem('iot_token') && state.socket === socket) setTimeout(connectWebSocket, 3000); });
}
async function initialize() {
  checkServer();
  const token = localStorage.getItem('iot_token'); if (!token) { showAuth(location.hash === '#register' ? 'register' : 'login'); return; }
  try { const data = await request('/api/auth/me'); showApplication(data.user); } catch { logout(); }
}
$('#loginForm').addEventListener('submit', submitLogin); $('#registerForm').addEventListener('submit', submitRegister);
$$('[data-auth-screen]').forEach(button => button.addEventListener('click', () => { const screen = button.dataset.authScreen; location.hash = screen; showAuth(screen); }));
$('#logoutButton').addEventListener('click', () => logout());
$('.project-links').addEventListener('click', event => { if (event.target.closest('a[aria-disabled="true"]')) event.preventDefault(); });
$('#editProfileButton').addEventListener('click', openProfileModal); $('#profileEditForm').addEventListener('submit', saveProfile); $('#avatarInput').addEventListener('change', selectAvatar);
$$('[data-close-profile]').forEach(button => button.addEventListener('click', closeProfileModal));
$('#profileModal').addEventListener('click', event => { if (event.target === event.currentTarget) closeProfileModal(); });
window.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#profileModal').hidden) closeProfileModal(); });
setInterval(checkServer, 15000); initialize();
