// 远程桌面网页端：与设备建立独立 RTCPeerConnection，视频/控制字节走两条有序 DataChannel，
// 用 Tango 解析 scrcpy 码流、WebCodecs 解码；Worker 只转发 SDP/ICE。由 build-desktop-client.mjs 打包为 desktop-client-source.js。
import { ScrcpyOptions3_3_3, ScrcpyControlMessageWriter, AndroidMotionEventAction, AndroidKeyEventAction, AndroidKeyCode, AndroidMotionEventButton } from '@yume-chan/scrcpy';
import { WebCodecsVideoDecoder, WebGLVideoFrameRenderer, BitmapVideoFrameRenderer } from '@yume-chan/scrcpy-decoder-webcodecs';
import { ReadableStream, WritableStream, BufferedReadableStream, Consumable } from '@yume-chan/stream-extra';

const IDLE_LIMIT_MS = 20 * 60 * 1000;
const ICONS = [
  ['menu', '菜单', 'M3 6h18M3 12h18M3 18h18'],
  ['recent', '最近任务', 'M4 5h16v14H4zM8 3v4M16 3v4'],
  ['home', '桌面', 'M3 11l9-8 9 8v10a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z'],
  ['back', '返回', 'M15 18l-6-6 6-6'],
  ['copy', '复制', 'M8 8h12v12H8zM4 16V4h12'],
  ['paste', '粘贴', 'M9 4h6v3H9zM6 6h12v14H6zM9 12h6M9 16h6'],
  ['fold', '折叠', 'M15 6l-6 6 6 6'],
];
let active = null, lastMessage = '';

function icon(path) { return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="' + path + '"/></svg>'; }
function render() { if (typeof window.renderRemoteConsole === 'function') window.renderRemoteConsole(); if (typeof window.render === 'function') window.render(); }
function log(s, text) { s.message = text; const el = s.node?.querySelector('.desktop-status'); if (el) el.textContent = text; }
async function json(url, body, method) {
  const r = await fetch(url, { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const x = await r.json().catch(() => ({})); if (!r.ok || x.ok === false) throw Error(x.msg || '远程桌面请求失败'); return x;
}
function send(s, p) { if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify(p)); }

function channelReadable(dc, s) {
  return new ReadableStream({
    start(c) { dc.binaryType = 'arraybuffer'; dc.onmessage = e => { const u = new Uint8Array(e.data); s.bytes += u.length; c.enqueue(u); }; dc.onclose = () => { try { c.close(); } catch {} }; },
    cancel() { try { dc.close(); } catch {} }
  });
}
function channelWritable(dc) {
  return new WritableStream({ write(chunk) { const v = chunk instanceof Consumable ? chunk.value : chunk; if (dc.readyState === 'open') dc.send(v); if (chunk instanceof Consumable) chunk.consume(); } });
}
function waitOpen(dc) { return new Promise((res, rej) => { if (dc.readyState === 'open') return res(); dc.onopen = res; dc.onerror = e => rej(Error('数据通道失败')); dc.onclose = () => rej(Error('数据通道已关闭')); }); }

function buildNode(s) {
  const node = document.createElement('div'); node.className = 'desktop-view'; node.dataset.deviceId = s.device.id;
  node.innerHTML = '<div class="desktop-stage"><div class="desktop-screen" tabindex="0" aria-label="设备屏幕"></div>'
    + '<div class="desktop-tools" role="toolbar" aria-label="远程桌面工具">' + ICONS.map(i => '<button type="button" data-act="' + i[0] + '" title="' + i[1] + '" aria-label="' + i[1] + '">' + icon(i[2]) + '</button>').join('') + '</div>'
    + '<button type="button" class="desktop-unfold" title="展开工具栏" aria-label="展开工具栏" hidden></button></div>'
    + '<div class="desktop-foot"><span class="desktop-status" role="status"></span><span class="desktop-stats"></span></div>';
  const screen = node.querySelector('.desktop-screen'), tools = node.querySelector('.desktop-tools'), unfold = node.querySelector('.desktop-unfold');
  let folded = false; try { folded = localStorage.getItem('elf-desktop-folded') === '1'; } catch {}
  const applyFold = () => { tools.hidden = folded; unfold.hidden = !folded; try { localStorage.setItem('elf-desktop-folded', folded ? '1' : '0'); } catch {} };
  applyFold();
  tools.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; e.stopPropagation(); if (b.dataset.act === 'fold') { folded = true; applyFold(); return; } action(s, b.dataset.act); });
  unfold.onclick = () => { folded = false; applyFold(); };
  // 鼠标→触摸：按实际画面矩形换算，黑边不发；失焦/离开/断线释放触点。
  let down = false, lastMove = 0;
  const pos = e => { const c = s.canvas; if (!c || !s.videoW) return null; const r = c.getBoundingClientRect(); const scale = Math.min(r.width / s.videoW, r.height / s.videoH); const w = s.videoW * scale, h = s.videoH * scale; const ox = r.left + (r.width - w) / 2, oy = r.top + (r.height - h) / 2; const x = (e.clientX - ox) / scale, y = (e.clientY - oy) / scale; return x < 0 || y < 0 || x > s.videoW || y > s.videoH ? null : { x, y }; };
  const touch = (act, p, pressure) => { if (!s.controller || !s.inputReady || s.geometryEpoch !== s.frameEpoch) return; s.lastInput = Date.now(); return s.controller.injectTouch({ action: act, pointerId: BigInt(-1), pointerX: p.x, pointerY: p.y, videoWidth: s.videoW, videoHeight: s.videoH, pressure, buttons: AndroidMotionEventButton.Primary }).catch(() => {}); };
  const release = () => { if (!down) return; down = false; touch(AndroidMotionEventAction.Up, { x: 0, y: 0 }, 0); };
  screen.addEventListener('pointerdown', e => { if (e.button !== 0) return; const p = pos(e); if (!p) return; down = true; screen.setPointerCapture(e.pointerId); screen.focus(); touch(AndroidMotionEventAction.Down, p, 1); });
  screen.addEventListener('pointermove', e => { if (!down) return; const now = performance.now(); if (now - lastMove < 16) return; lastMove = now; const p = pos(e); if (p) touch(AndroidMotionEventAction.Move, p, 1); });
  screen.addEventListener('pointerup', e => { if (!down) return; down = false; touch(AndroidMotionEventAction.Up, pos(e) || { x: 0, y: 0 }, 0); });
  screen.addEventListener('pointercancel', release);
  screen.addEventListener('wheel', e => { const p = pos(e); if (!p || !s.controller || !s.inputReady) return; e.preventDefault(); s.lastInput = Date.now(); s.controller.injectScroll({ pointerX: p.x, pointerY: p.y, videoWidth: s.videoW, videoHeight: s.videoH, scrollX: 0, scrollY: e.deltaY > 0 ? -1 : 1, buttons: 0 }).catch(() => {}); }, { passive: false });
  s.release = release;
  window.addEventListener('blur', release); document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
  return node;
}

async function key(s, code) { if (!s.controller || !s.inputReady) return; s.lastInput = Date.now(); send(s, { type: 'activity' }); await s.controller.injectKeyCode({ action: AndroidKeyEventAction.Down, keyCode: code, repeat: 0, metaState: 0 }); await s.controller.injectKeyCode({ action: AndroidKeyEventAction.Up, keyCode: code, repeat: 0, metaState: 0 }); }
async function action(s, act) {
  try {
    if (act === 'menu') await key(s, AndroidKeyCode.ContextMenu);
    else if (act === 'recent') await key(s, AndroidKeyCode.AndroidAppSwitch);
    else if (act === 'home') await key(s, AndroidKeyCode.AndroidHome);
    else if (act === 'back') await key(s, AndroidKeyCode.AndroidBack);
    else if (act === 'copy') { const text = s.deviceClipboard; if (text === undefined) { log(s, '设备尚未复制过文本；请先在设备画面中选择文字并用安卓的复制'); return; } await navigator.clipboard.writeText(text); log(s, '已取回设备剪贴板 ' + text.length + ' 字'); }
    else if (act === 'paste') { const text = await navigator.clipboard.readText(); if (!text) { log(s, '电脑剪贴板为空'); return; } if (text.length > 30000) { log(s, '剪贴板文本过长'); return; } s.lastInput = Date.now(); send(s, { type: 'activity' }); await s.controller.setClipboard({ sequence: 0n, content: text, paste: true }); log(s, '已粘贴 ' + text.length + ' 字到设备'); }
  } catch (e) { log(s, (act === 'copy' || act === 'paste' ? '剪贴板操作失败：' : '操作失败：') + (e.message || e)); }
}

async function negotiate(s, hello) {
  s.generation = hello.generation; if (hello.ice_servers) s.iceServers = hello.ice_servers; if (hello.turn === false) log(s, 'TURN 凭据不可用，仅尝试直连');
  if (s.pc) { try { s.pc.close(); } catch {} }
  const pc = new RTCPeerConnection({ iceServers: hello.ice_servers || [{ urls: 'stun:stun.cloudflare.com:3478' }] });
  s.pc = pc; s.pendingCandidates = [];
  pc.onicecandidate = e => { if (e.candidate && active === s) send(s, { type: 'signal', kind: 'candidate', payload: JSON.stringify(e.candidate.toJSON()), generation: s.generation }); };
  pc.onconnectionstatechange = () => { if (active !== s) return; if (pc.connectionState === 'failed') { if (s.generation < 4 && !s.ready) send(s, { type: 'restart' }); else stop('远程桌面网络连接失败'); } if (pc.connectionState === 'disconnected') log(s, '连接中断，正在等待恢复…'); };
  pc.ondatachannel = e => { if (active !== s) return; if (e.channel.label === 'video') s.videoDc = e.channel; else if (e.channel.label === 'control') s.controlDc = e.channel; if (s.videoDc && s.controlDc) attach(s).catch(err => { if (active === s) stop(err.message || '远程桌面初始化失败'); }); };
}
async function signal(s, p) {
  if (p.generation !== s.generation || !s.pc) return;
  if (p.kind === 'offer') {
    await s.pc.setRemoteDescription({ type: 'offer', sdp: p.payload });
    await s.pc.setLocalDescription(await s.pc.createAnswer());
    send(s, { type: 'signal', kind: 'answer', payload: s.pc.localDescription.sdp, generation: s.generation });
    for (const c of s.pendingCandidates.splice(0)) await s.pc.addIceCandidate(c).catch(() => {});
  } else if (p.kind === 'candidate') { const c = JSON.parse(p.payload); if (s.pc.remoteDescription) await s.pc.addIceCandidate(c).catch(() => {}); else s.pendingCandidates.push(c); }
}
async function attach(s) {
  await Promise.all([waitOpen(s.videoDc), waitOpen(s.controlDc)]);
  const options = new ScrcpyOptions3_3_3({ audio: false, control: true, videoCodec: 'h264', sendDummyByte: false, sendDeviceMeta: true, sendCodecMeta: true, sendFrameMeta: true });
  const { metadata, stream } = await options.parseVideoStreamMetadata(channelReadable(s.videoDc, s));
  const renderer = (window.WebGLRenderingContext ? new WebGLVideoFrameRenderer() : new BitmapVideoFrameRenderer());
  s.canvas = renderer.canvas || renderer.element; s.canvas.className = 'desktop-canvas';
  s.node.querySelector('.desktop-screen').replaceChildren(s.canvas);
  s.decoder = new WebCodecsVideoDecoder({ codec: metadata.codec, renderer });
  s.decoder.sizeChanged(({ width, height }) => { if (width === s.videoW && height === s.videoH) return; s.videoW = width; s.videoH = height; s.geometryEpoch++; });
  const counted = new TransformStream({ transform(p, c) { if (p.type === 'data') { s.frames++; if (!s.firstFrameAt) { s.firstFrameAt = performance.now(); } s.frameEpoch = s.geometryEpoch; } c.enqueue(p); } });
  stream.pipeThrough(options.createMediaStreamTransformer()).pipeThrough(counted).pipeTo(s.decoder.writable).catch(e => { if (active === s && !s.closed) log(s, '视频流结束：' + (e?.message || e)); });
  s.controller = new ScrcpyControlMessageWriter(channelWritable(s.controlDc).getWriter(), options);
  (async () => { const b = new BufferedReadableStream(channelReadable(s.controlDc, s)); try { while (true) { const id = (await b.readExactly(1))[0]; await options.deviceMessageParsers.parse(id, b); } } catch {} })();
  options.clipboard?.pipeTo(new WritableStream({ write(text) { s.deviceClipboard = text; log(s, '设备剪贴板已更新（' + text.length + ' 字），点“复制”取回'); } })).catch(() => {});
  s.inputReady = true; updateReady(s);
}
function updateReady(s) {
  if (s.ready || !s.inputReady || !s.firstFrameAt || !s.deviceReady) return;
  s.ready = true; s.started = Date.now(); s.lastInput = Date.now();
  log(s, '已连接，' + s.videoW + '×' + s.videoH + '，首帧 ' + Math.round(s.firstFrameAt - s.startedAt) + ' ms'); render();
}
function tick(s) {
  if (active !== s) return;
  const now = performance.now(), dt = (now - (s.lastTick || s.startedAt)) / 1000;
  const kbps = Math.round((s.bytes - s.lastBytes) * 8 / 1000 / dt), fps = ((s.frames - s.lastFrames) / dt).toFixed(0);
  s.lastTick = now; s.lastBytes = s.bytes; s.lastFrames = s.frames;
  const el = s.node.querySelector('.desktop-stats'); if (el) el.textContent = s.ready ? fps + ' 帧/秒 ' + kbps + ' kbps 本次 ' + (s.bytes / 1048576).toFixed(1) + ' MB' : '';
  if (s.ready && Date.now() - s.lastInput >= IDLE_LIMIT_MS) { stop('20分钟无操作，已自动关闭'); return; }
  if (!s.lastPing || Date.now() - s.lastPing >= 15000) { send(s, { type: 'ping' }); s.lastPing = Date.now(); }
  if (Date.now() - s.lastInput < 30000 && Date.now() - (s.lastActivitySent || 0) >= 30000) { send(s, { type: 'activity' }); s.lastActivitySent = Date.now(); }
}

async function start(d) {
  if (!d || d.managed_desktop_v1 !== true || d.enabled === false) return;
  if (active && active.device.id === d.id) return;
  if (active) await stop('已切换设备');
  const s = { device: d, bytes: 0, frames: 0, lastBytes: 0, lastFrames: 0, videoW: 0, videoH: 0, geometryEpoch: 0, frameEpoch: 0, generation: 1, startedAt: performance.now(), lastInput: Date.now(), closed: false, message: '正在连接…' };
  active = s; lastMessage = ''; s.node = buildNode(s); render(); log(s, '正在唤醒设备…');
  try {
    const result = await json('/api/elfremote/desktop/session', { device_id: d.id, quality: (d.network || '').toLowerCase().includes('cell') || /移动|蜂窝|4g|lte/i.test(d.network || '') ? 'cellular' : 'wifi' });
    if (active !== s) { await json('/api/elfremote/desktop/session', { session_id: result.session_id }, 'DELETE').catch(() => {}); return; }
    s.id = result.session_id;
    s.ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/elfremote/desktop/browser?session_id=' + s.id);
    s.ws.onmessage = e => { if (active !== s) return; let p; try { p = JSON.parse(e.data); } catch { return; } message(s, p).catch(err => { if (active === s) stop(err.message || '远程桌面失败'); }); };
    s.ws.onclose = () => { if (active === s && !s.closed) stop(s.closeMessage || '远程桌面连接已断开'); };
    s.ws.onerror = () => { if (active === s) stop('远程桌面连接失败'); };
    s.timer = setInterval(() => tick(s), 1000);
  } catch (e) { if (active === s) stop(e.message || '远程桌面启动失败'); }
}
async function message(s, p) {
  if (p.type === 'hello') { log(s, '设备已响应，正在建立连接…'); await negotiate(s, p); }
  else if (p.type === 'signal') await signal(s, p);
  else if (p.type === 'restart') { log(s, '正在重新协商（第 ' + p.generation + ' 次）…'); s.inputReady = false; await negotiate(s, { generation: p.generation, ice_servers: s.iceServers }); }
  else if (p.type === 'ready') { s.deviceReady = true; s.deviceWidth = p.width; s.deviceHeight = p.height; updateReady(s); }
  else if (p.type === 'status') { if (p.stage === 'failed') log(s, '设备报告失败：' + (p.message || '')); else if (p.stage === 'starting') log(s, '设备正在启动屏幕服务…'); else if (p.stage === 'ice_failed') log(s, '设备侧网络连接失败'); }
  else if (p.type === 'closed') { s.closeMessage = p.message; stop(p.message || '远程桌面已结束'); }
}
async function stop(text) {
  const s = active; if (!s) return; active = null; s.closed = true; lastMessage = text || '';
  clearInterval(s.timer); try { s.release?.(); } catch {}
  try { send(s, { type: 'stop' }); } catch {}
  try { s.ws?.close(); } catch {} try { await s.controller?.close(); } catch {} try { s.decoder?.dispose(); } catch {} try { s.pc?.close(); } catch {}
  if (s.id) json('/api/elfremote/desktop/session', { session_id: s.id }, 'DELETE').catch(() => {});
  render();
}
// 供设备页调用：按钮状态、把保留的桌面节点挂回终端区域。
function isActive(d) { return !!active && (!d || active.device.id === d.id); }
function button(d) {
  const on = isActive(d), can = !!d && d.managed_desktop_v1 === true && d.enabled !== false;
  return '<button type="button" class="' + (on ? 'btn-red' : can ? 'btn-green' : 'btn-gray') + '" onclick="ElfDesktop.' + (on ? 'stop()' : 'start()') + '"' + (on || can ? '' : ' disabled') + '>' + (on ? '关闭桌面' : '远程桌面') + '</button>';
}
function mount(d) {
  const s = active; const term = document.getElementById('taskOut');
  if (!s || !term) return;
  if (d && s.device.id !== d.id) { stop('已切换设备'); return; }
  if (s.node.parentNode !== term.parentNode) term.replaceWith(s.node); else if (term.parentNode) term.remove();
  const input = document.getElementById('shellCmd'); const row = input?.closest('.adb-input, .shell-row, form') || input?.parentElement; if (row) row.hidden = true;
}
function feedback(d) { return active && (!d || active.device.id === d.id) ? active.message : lastMessage; }
window.ElfDesktop = { start: () => start(typeof window.currentDev === 'function' ? window.currentDev() : null), stop: () => stop('远程桌面已关闭'), isActive, button, mount, feedback, supported: WebCodecsVideoDecoder.isSupported };
