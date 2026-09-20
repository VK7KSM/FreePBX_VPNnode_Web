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
function describe(l) {
  return '创建于 ' + fmt(l.created_at) + ' · 剩余 ' + remaining(l) + ' · ' + (l.has_password ? '有密码' : '无密码');
}
function render() {
  const body = document.getElementById('shareBody'); if (!body || !state) return;
  const s = state, sel = s.links.find(l => l.token === s.selected);
  let h = '';
  if (s.error) h += '<p class="share-error" role="alert">' + esc(s.error) + '</p>';
  h += '<section class="share-panel"><div class="share-panel-title">' + (sel ? '修改链接 <code>' + esc(sel.token) + '</code>' : '新建链接') + '</div><div class="share-form-row">';
  h += '<label>密码 <input id="sharePw" class="inp" type="password" autocomplete="new-password"></label>';
  h += '<label class="share-ttl">有效期 <select id="shareTtl" class="inp">' + (sel ? '<option value="">不修改</option>' : '') + TTL_OPTIONS.map(o => '<option value="' + o[0] + '"' + (!sel && o[0] === '1h' ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></label>';
  if (sel && sel.has_password) h += '<label class="share-inline"><input id="shareClearPw" type="checkbox"> 取消密码</label>';
  h += '<span class="share-form-actions">' + (sel ? '<button type="button" class="share-btn share-btn-ghost" onclick="ElfShare.select(null)">取消</button><button type="button" class="share-btn share-btn-primary" onclick="ElfShare.save()">保存修改</button>' : '<button type="button" class="share-btn share-btn-primary" onclick="ElfShare.create()">生成新地址</button>') + '</span>';
  h += '</div></section>';
  h += '<div class="share-list-title">已创建链接 <span class="share-count">' + s.links.length + '</span></div><div class="share-list">';
  if (!s.links.length) h += '<div class="share-empty">暂无有效链接，先在上方生成一个。</div>';
  for (const l of s.links) {
    h += '<div class="share-item' + (l.token === s.selected ? ' on' : '') + (l.current ? ' live' : '') + '" data-token="' + esc(l.token) + '">'
      + '<div class="share-item-main"><div class="share-item-link"><span class="share-link" tabindex="0" title="点击选中后可修改密码或有效期；悬停显示二维码" data-url="' + esc(l.url) + '" onclick="ElfShare.select(\'' + esc(l.token) + '\')">' + esc(l.url) + '</span>'
      + '<button type="button" class="share-copy" onclick="ElfShare.copy(\'' + esc(l.url) + '\',this)">复制</button></div>'
      + '<div class="share-item-meta">' + esc(describe(l)) + '</div></div>'
      + (l.current ? '<span class="share-live-badge">当前会话</span>' : '')
      + '<button type="button" class="share-btn share-btn-danger" onclick="ElfShare.remove(\'' + esc(l.token) + '\')">删除</button></div>';
  }
  h += '</div>';
  body.innerHTML = h;
  bindQrHover(body);
}
// 悬停显示二维码：固定定位的浮层挂在 body 上，优先显示在链接上方，放不下再放下方；不占布局、不产生滚动条。
function qrPopover() {
  let p = document.getElementById('shareQrPop');
  if (!p) { p = document.createElement('div'); p.id = 'shareQrPop'; p.className = 'share-qr-pop'; p.hidden = true; document.body.appendChild(p); }
  return p;
}
function bindQrHover(body) {
  const pop = qrPopover();
  body.querySelectorAll('.share-link').forEach(el => {
    const show = () => { const r = el.getBoundingClientRect(); pop.innerHTML = qrSvg(el.dataset.url); pop.hidden = false; const w = 196, h = 196; let left = r.left, top = r.top - h - 8; if (top < 8) top = r.bottom + 8; if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8; pop.style.left = left + 'px'; pop.style.top = top + 'px'; };
    const hide = () => { pop.hidden = true; };
    el.addEventListener('mouseenter', show); el.addEventListener('mouseleave', hide); el.addEventListener('focus', show); el.addEventListener('blur', hide);
  });
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
function close() { const w = document.getElementById('shareWrap'); if (w) w.style.display = 'none'; const p = document.getElementById('shareQrPop'); if (p) p.hidden = true; state = null; }
async function guard(fn) { if (!state) return; state.error = ''; try { await fn(); await reload(); } catch (e) { if (state) state.error = e.message || String(e); } render(); }
const ElfShare = {
  isShare, open, close,
  select(token) { if (!state) return; state.selected = token || null; render(); },
  copy(url, btn) { navigator.clipboard.writeText(url).then(() => { if (btn) { btn.textContent = '已复制'; setTimeout(() => { btn.textContent = '复制'; }, 1500); } }).catch(() => { if (btn) btn.textContent = '复制失败'; }); },
  create() { return guard(async () => { const pw = document.getElementById('sharePw')?.value || '', ttl = document.getElementById('shareTtl')?.value || ''; const x = await api('/api/share/links', { device_id: state.device.id, ttl: ttl || undefined, password: pw || null });  }); },
  save() { return guard(async () => { const pw = document.getElementById('sharePw')?.value || '', clear = document.getElementById('shareClearPw')?.checked, ttl = document.getElementById('shareTtl')?.value || ''; const body = { token: state.selected }; if (clear) body.password = { action: 'clear' }; else if (pw) body.password = { action: 'set', value: pw }; if (ttl) body.ttl = ttl; if (!body.password && !body.ttl) throw Error('没有需要保存的修改'); await api('/api/share/links/update', body); }); },
  remove(token) { const l = state?.links.find(x => x.token === token); if (!l) return; if (!confirm(l.current ? '删除当前会话正在使用的链接，将立即退出该会话。确定删除？' : '确定删除此链接？删除后立即失效。')) return; return guard(async () => { await api('/api/share/links/delete', { token }); }); },
  // 供页面调用：总后台标题栏「分享」/独立页「设置」按钮。
  button(d) { if (isShare()) return ''; const can = !!d && d.enabled !== false; return '<button class="device-action action-share" onclick="ElfShare.open()"' + (can ? '' : ' disabled') + '>分享</button>'; },
  locked(d) { return !!d && d.share_locked === true && !isShare(); },
  lockedNotice(d) { return this.locked(d) ? '<span class="share-lock-tag" role="status">只读模式，其它用户使用中</span>' : ''; },
};
window.ElfShare = ElfShare;
