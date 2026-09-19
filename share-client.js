// 单设备分享管理弹窗：总后台「分享」与独立页「设置」共用同一实现；列出本设备全部有效链接、
// 当前连接、改密码/有效期、删除、新建；二维码本地生成，只含网址。由 build-share-client.mjs 打包。
import qrcode from 'qrcode-generator';

const TTL_OPTIONS = [['1h', '1 小时'], ['6h', '6 小时'], ['1d', '1 天'], ['7d', '7 天'], ['30d', '30 天'], ['permanent', '永久']];
let state = null, clockOffset = 0;

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function isShare() { return !!document.querySelector('meta[name="elf-share"]'); }
function currentDevice() { return typeof window.currentDev === 'function' ? window.currentDev() : null; }
async function api(url, body, method) {
  const r = await fetch(url, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  const x = await r.json().catch(() => ({})); if (!r.ok || x.ok === false) throw Error(x.msg || '请求失败'); return x;
}
function remaining(link) {
  if (link.expires_at === null || link.expires_at === undefined) return '永久';
  const ms = link.expires_at - (Date.now() + clockOffset); if (ms <= 0) return '已到期';
  const m = Math.floor(ms / 60000); if (m < 60) return m + ' 分钟'; const h = Math.floor(m / 60); if (h < 48) return h + ' 小时 ' + (m % 60) + ' 分'; return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时';
}
function fmt(ms) { try { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Australia/Sydney', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms)); } catch { return new Date(ms).toLocaleString(); } }
function qrSvg(text) { const q = qrcode(0, 'M'); q.addData(text.toUpperCase(), 'Alphanumeric'); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); }

function ensureNode() {
  let wrap = document.getElementById('shareWrap');
  if (wrap) return wrap;
  wrap = document.createElement('div'); wrap.id = 'shareWrap'; wrap.className = 'file-send-wrap'; wrap.style.display = 'none';
  wrap.innerHTML = '<div class="file-send-dialog share-dialog" role="dialog" aria-modal="true" aria-labelledby="shareTitle"><div class="traffic-header"><h3 id="shareTitle">本设备管理链接</h3><button type="button" class="btn-close share-close" aria-label="关闭" onclick="ElfShare.close()">&times;</button></div><div id="shareBody"></div></div>';
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  document.body.appendChild(wrap);
  return wrap;
}
function render() {
  const body = document.getElementById('shareBody'); if (!body || !state) return;
  const s = state, sel = s.links.find(l => l.token === s.selected);
  let h = '';
  if (s.error) h += '<p class="share-error" role="alert">' + esc(s.error) + '</p>';
  // 新建/修改表单：密码、有效期、按钮同一行；默认 1 小时。
  h += '<fieldset class="share-edit"><legend>' + (sel ? '修改链接 ' + esc(sel.token) : '新建链接') + '</legend><div class="share-form-row">';
  h += '<label>密码 <input id="sharePw" class="inp" type="password" autocomplete="new-password"></label>';
  h += '<label>有效期 <select id="shareTtl" class="inp">' + (sel ? '<option value="">不修改</option>' : '') + TTL_OPTIONS.map(o => '<option value="' + o[0] + '"' + (!sel && o[0] === '1h' ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></label>';
  if (sel && sel.has_password) h += '<label class="share-inline"><input id="shareClearPw" type="checkbox"> 取消密码</label>';
  h += sel ? '<button type="button" class="btn-green" onclick="ElfShare.save()">保存修改</button><button type="button" class="btn-gray" onclick="ElfShare.select(null)">取消</button>' : '<button type="button" class="btn-green" onclick="ElfShare.create()">生成新地址</button>';
  h += '</div></fieldset>';
  // 已创建链接：一行一条，鼠标移到链接上显示二维码；点击链接选中后可修改。
  h += '<table class="share-table"><thead><tr><th>链接</th><th>创建</th><th>剩余</th><th>密码</th><th></th></tr></thead><tbody>';
  if (!s.links.length) h += '<tr><td colspan="5" class="share-empty">暂无有效链接</td></tr>';
  for (const l of s.links) {
    h += '<tr class="' + (l.token === s.selected ? 'on' : '') + '" data-token="' + esc(l.token) + '">'
      + '<td class="share-link-cell"><span class="share-link" tabindex="0" title="点击选中后可修改密码或有效期" onclick="ElfShare.select(\'' + esc(l.token) + '\')">' + esc(l.url) + '</span>' + (l.current ? '<span class="tag share-tag">当前会话</span>' : '') + '<div class="share-qr-pop" aria-hidden="true">' + qrSvg(l.url) + '</div></td>'
      + '<td>' + esc(fmt(l.created_at)) + '</td><td>' + esc(remaining(l)) + '</td><td>' + (l.has_password ? '已设' : '免密') + '</td>'
      + '<td class="share-row-actions"><button type="button" class="btn-red" onclick="ElfShare.remove(\'' + esc(l.token) + '\')">删除</button></td></tr>';
  }
  h += '</tbody></table>';
  body.innerHTML = h;
}
async function reload() {
  const d = currentDevice(); if (!d) return;
  const x = await api('/api/share/links?device_id=' + encodeURIComponent(d.id));
  clockOffset = (x.server_time || Date.now()) - Date.now();
  state.links = x.links || []; state.session = x.session; if (state.selected && !state.links.some(l => l.token === state.selected)) state.selected = null; if (state.qrToken && !state.links.some(l => l.token === state.qrToken)) state.qrToken = null;
}
async function open() {
  const d = currentDevice(); if (!d) return;
  state = { device: d, links: [], session: null, selected: null, qrToken: null, error: '' };
  ensureNode().style.display = 'flex'; render();
  try { await reload(); } catch (e) { state.error = e.message; } render();
}
function close() { const w = document.getElementById('shareWrap'); if (w) w.style.display = 'none'; state = null; }
async function guard(fn) { if (!state) return; state.error = ''; try { await fn(); await reload(); } catch (e) { if (state) state.error = e.message || String(e); } render(); }
const ElfShare = {
  isShare, open, close,
  select(token) { if (!state) return; state.selected = token || null; render(); },
  create() { return guard(async () => { const pw = document.getElementById('sharePw')?.value || '', ttl = document.getElementById('shareTtl')?.value || ''; const x = await api('/api/share/links', { device_id: state.device.id, ttl: ttl || undefined, password: pw || null });  }); },
  save() { return guard(async () => { const pw = document.getElementById('sharePw')?.value || '', clear = document.getElementById('shareClearPw')?.checked, ttl = document.getElementById('shareTtl')?.value || ''; const body = { token: state.selected }; if (clear) body.password = { action: 'clear' }; else if (pw) body.password = { action: 'set', value: pw }; if (ttl) body.ttl = ttl; if (!body.password && !body.ttl) throw Error('没有需要保存的修改'); await api('/api/share/links/update', body); }); },
  remove(token) { const l = state?.links.find(x => x.token === token); if (!l) return; if (!confirm(l.current ? '删除当前会话正在使用的链接，将立即退出该会话。确定删除？' : '确定删除此链接？删除后立即失效。')) return; return guard(async () => { await api('/api/share/links/delete', { token }); }); },
  // 供页面调用：总后台标题栏「分享」/独立页「设置」按钮。
  button(d) { if (isShare()) return ''; const can = !!d && d.enabled !== false; return '<button class="device-action action-share" onclick="ElfShare.open()"' + (can ? '' : ' disabled') + '>分享</button>'; },
  locked(d) { return !!d && d.share_locked === true && !isShare(); },
  lockedNotice(d) { return this.locked(d) ? '<span class="share-lock-tag" role="status">只读模式，其它用户使用中</span>' : ''; },
};
window.ElfShare = ElfShare;
