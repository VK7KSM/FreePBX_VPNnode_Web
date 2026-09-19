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
  ['keys', '特殊按键', 'M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M7 14h10'],
  ['info', '连接信息', 'M12 8h.01M11 12h1v4h1M12 3a9 9 0 110 18 9 9 0 010-18z'],
  ['expand', '占满窗口', 'M4 9V4h5M20 15v5h-5M4 15v5h5M20 9V4h-5'],
  ['fold', '折叠工具栏', 'M11 18l-6-6 6-6M18 18l-6-6 6-6'],
];
let active = null, lastMessage = '';

function icon(path) { return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="' + path + '"/></svg>'; }
function render() { if (typeof window.renderOps === 'function') window.renderOps(); else if (typeof window.render === 'function') window.render(); }
function log(s, text) { s.message = text; const el = s.node?.querySelector('.desktop-status'); if (el) el.textContent = text; updateInfoPanel(s); }
// 右上角信息面板：未连接时自动显示状态；已连接后默认关闭，点左侧“连接信息”图标打开。
function updateInfoPanel(s) { const p = s.node?.querySelector('.desktop-info'); if (!p) return; p.hidden = s.ready ? !s.infoOpen : false; }
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

// 浏览器按键 → 安卓 keycode（按物理键位 e.code 映射；Esc 作返回键）。
const KEYMAP = (() => {
  const m = { Space: 62, Enter: 66, NumpadEnter: 66, Backspace: 67, Delete: 112, Tab: 61, Escape: 4, ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22, Home: 122, End: 123, PageUp: 92, PageDown: 93, Insert: 124,
    Minus: 69, Equal: 70, BracketLeft: 71, BracketRight: 72, Backslash: 73, Semicolon: 74, Quote: 75, Comma: 55, Period: 56, Slash: 76, Backquote: 68,
    ShiftLeft: 59, ShiftRight: 60, ControlLeft: 113, ControlRight: 114, AltLeft: 57, AltRight: 58, CapsLock: 115, NumpadAdd: 157, NumpadSubtract: 156, NumpadMultiply: 155, NumpadDivide: 154, NumpadDecimal: 158 };
  for (let i = 0; i < 26; i++) m['Key' + String.fromCharCode(65 + i)] = 29 + i;
  for (let i = 0; i < 10; i++) { m['Digit' + i] = 7 + i; m['Numpad' + i] = 144 + i; }
  for (let i = 1; i <= 12; i++) m['F' + i] = 130 + i;
  return m;
})();
const ASCII_ONLY = /^[\x20-\x7e\n]*$/;
const META_SHIFT = 0x1 | 0x40, META_ALT = 0x2 | 0x10, META_CTRL = 0x1000 | 0x2000, META_CAPS = 0x100000;
function metaOf(e) { return (e.shiftKey ? META_SHIFT : 0) | (e.altKey ? META_ALT : 0) | (e.ctrlKey ? META_CTRL : 0) | (e.getModifierState && e.getModifierState('CapsLock') ? META_CAPS : 0); }
const SPECIAL_KEYS = [['电源', 26], ['音量+', 24], ['音量-', 25], ['静音', 164], ['搜索', 84], ['相机', 27], ['通话', 5], ['挂断', 6]];

function buildNode(s) {
  const node = document.createElement('div'); node.className = 'desktop-view'; node.dataset.deviceId = s.device.id;
  node.innerHTML = '<div class="desktop-stage"><div class="desktop-screen" aria-label="设备屏幕"></div>'
    + '<textarea class="desktop-ime" aria-label="键盘输入" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>'
    + '<div class="desktop-tools" role="toolbar" aria-label="远程桌面工具">' + ICONS.map(i => '<button type="button" data-act="' + i[0] + '" title="' + i[1] + '" aria-label="' + i[1] + '">' + icon(i[2]) + '</button>').join('') + '</div>'
    + '<button type="button" class="desktop-unfold" title="展开工具栏" aria-label="展开工具栏" hidden>' + icon('M6 6l6 6-6 6M13 6l6 6-6 6') + '</button>'
    + '<div class="desktop-keys" hidden>' + SPECIAL_KEYS.map(k => '<button type="button" data-key="' + k[1] + '">' + k[0] + '</button>').join('') + '</div>'
    + '<div class="desktop-info"><span class="desktop-status" role="status"></span><span class="desktop-stats"></span></div>'
    + '<div class="desktop-kbd-hint">键盘已接管，点击画面外释放</div></div>';
  const screen = node.querySelector('.desktop-screen'), tools = node.querySelector('.desktop-tools'), unfold = node.querySelector('.desktop-unfold'), ime = node.querySelector('.desktop-ime'), keysPanel = node.querySelector('.desktop-keys');
  let folded = false; try { folded = localStorage.getItem('elf-desktop-folded') === '1'; } catch {}
  const applyFold = () => { tools.hidden = folded; unfold.hidden = !folded; try { localStorage.setItem('elf-desktop-folded', folded ? '1' : '0'); } catch {} };
  applyFold();
  let expanded = false; try { expanded = localStorage.getItem('elf-desktop-expanded') === '1'; } catch {}
  const expandBtn = node.querySelector('button[data-act="expand"]');
  // 占满浏览器窗口而不是调 Fullscreen API：这是运维工具，多半要一边看画面一边看旁边的终端和日志，
  // 全屏会把面板其它部分藏掉、要按 ESC 才能退出，还有用户手势与退出键的兼容问题。
  // 清晰度按下一次连接生效：scrcpy 改不了运行中的分辨率，改了要重启服务端并重来一遍解码器。
  const applyExpand = () => {
    node.classList.toggle('desktop-expanded', expanded);
    // 卡片的毛玻璃会成为 fixed 定位的包含块，撑满窗口前要先在 body 上解除它，否则只撑满那张卡片。
    document.body.classList.toggle('desktop-expanded-host', expanded);
    if (expandBtn) { const t = expanded ? '退出占满窗口' : '占满窗口（清晰度下次连接时生效）'; expandBtn.title = t; expandBtn.setAttribute('aria-label', t); }
    try { localStorage.setItem('elf-desktop-expanded', expanded ? '1' : '0'); } catch {}
  };
  applyExpand();
  tools.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; e.stopPropagation(); if (b.dataset.act === 'fold') { folded = true; applyFold(); return; } if (b.dataset.act === 'expand') { expanded = !expanded; applyExpand(); return; } if (b.dataset.act === 'info') { s.infoOpen = !s.infoOpen; updateInfoPanel(s); return; } if (b.dataset.act === 'keys') { keysPanel.hidden = !keysPanel.hidden; return; } action(s, b.dataset.act); });
  keysPanel.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; e.stopPropagation(); key(s, Number(b.dataset.key)); });
  unfold.onclick = () => { folded = false; applyFold(); };
  // 鼠标→触摸：按实际画面矩形换算，黑边不发；右键=返回，中键=桌面；失焦/离开/断线释放触点。
  let down = false, lastMove = 0;
  const pos = e => { const c = s.canvas; if (!c || !s.videoW) return null; const r = c.getBoundingClientRect(); const scale = Math.min(r.width / s.videoW, r.height / s.videoH); const w = s.videoW * scale, h = s.videoH * scale; const ox = r.left + (r.width - w) / 2, oy = r.top + (r.height - h) / 2; const x = (e.clientX - ox) / scale, y = (e.clientY - oy) / scale; return x < 0 || y < 0 || x > s.videoW || y > s.videoH ? null : { x, y }; };
  const touch = (act, p, pressure) => { if (!s.controller || !s.inputReady || s.geometryEpoch !== s.frameEpoch) return; s.lastInput = Date.now(); return s.controller.injectTouch({ action: act, pointerId: BigInt(-1), pointerX: p.x, pointerY: p.y, videoWidth: s.videoW, videoHeight: s.videoH, pressure, buttons: AndroidMotionEventButton.Primary }).catch(() => {}); };
  const releaseTouch = () => { if (!down) return; down = false; touch(AndroidMotionEventAction.Up, { x: 0, y: 0 }, 0); };
  screen.addEventListener('contextmenu', e => e.preventDefault());
  screen.addEventListener('pointerdown', e => {
    if (e.button === 2) { e.preventDefault(); key(s, AndroidKeyCode.AndroidBack); return; }
    if (e.button === 1) { e.preventDefault(); key(s, AndroidKeyCode.AndroidHome); return; }
    if (e.button !== 0) return; const p = pos(e); if (!p) return; down = true; screen.setPointerCapture(e.pointerId); touch(AndroidMotionEventAction.Down, p, 1);
  });
  // 阻止鼠标按下的默认焦点切换，否则刚给隐藏输入框的焦点会被浏览器移回 body，键盘就收不到。
  screen.addEventListener('mousedown', e => { e.preventDefault(); captureKeyboard(); });
  screen.addEventListener('click', () => captureKeyboard());
  screen.addEventListener('pointermove', e => { if (!down) return; const now = performance.now(); if (now - lastMove < 16) return; lastMove = now; const p = pos(e); if (p) touch(AndroidMotionEventAction.Move, p, 1); });
  screen.addEventListener('pointerup', e => { if (!down) return; down = false; touch(AndroidMotionEventAction.Up, pos(e) || { x: 0, y: 0 }, 0); });
  screen.addEventListener('pointercancel', releaseTouch);
  screen.addEventListener('wheel', e => { const p = pos(e); if (!p || !s.controller || !s.inputReady) return; e.preventDefault(); s.lastInput = Date.now(); s.controller.injectScroll({ pointerX: p.x, pointerY: p.y, videoWidth: s.videoW, videoHeight: s.videoH, scrollX: 0, scrollY: e.deltaY > 0 ? -1 : 1, buttons: 0 }).catch(() => {}); }, { passive: false });
  // 键盘：点过画面后由隐藏输入框接管；ASCII 走按键事件，输入法组词的中文走剪贴板粘贴。
  const held = new Set();
  const sendKey = (act, code, meta) => { if (!s.controller || !s.inputReady) return; s.lastInput = Date.now(); return s.controller.injectKeyCode({ action: act, keyCode: code, repeat: 0, metaState: meta }).catch(() => {}); };
  const releaseKeys = () => { for (const code of held) sendKey(AndroidKeyEventAction.Up, code, 0); held.clear(); };
  const captureKeyboard = () => { if (document.activeElement !== ime) ime.focus({ preventScroll: true }); };
  ime.addEventListener('focus', () => { node.classList.add('capturing'); });
  ime.addEventListener('blur', () => { node.classList.remove('capturing'); releaseKeys(); });
  ime.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.ctrlKey && !e.altKey && e.code === 'KeyV') { e.preventDefault(); action(s, 'paste'); return; }
    // D22 固件会吞掉 KEYCODE_3/KEYCODE_4（adb 注入同样丢失），这两个键位的字符改走剪贴板粘贴。
    if (!e.ctrlKey && !e.altKey && (e.code === 'Digit3' || e.code === 'Digit4' || e.code === 'Numpad3' || e.code === 'Numpad4') && typeof e.key === 'string' && e.key.length === 1) { e.preventDefault(); if (!e.repeat) pasteChar(s, e.key); return; }
    const code = KEYMAP[e.code]; if (code === undefined) return;
    e.preventDefault(); if (e.repeat) { sendKey(AndroidKeyEventAction.Down, code, metaOf(e)); return; }
    held.add(code); sendKey(AndroidKeyEventAction.Down, code, metaOf(e));
  });
  ime.addEventListener('keyup', e => { if (e.isComposing) return; const code = KEYMAP[e.code]; if (code === undefined) return; e.preventDefault(); held.delete(code); sendKey(AndroidKeyEventAction.Up, code, metaOf(e)); });
  const pasteChar = async ch => { if (!s.controller || !s.inputReady) return; s.lastInput = Date.now(); try { await s.controller.setClipboard({ sequence: 0n, content: ch, paste: true }); } catch (e) { log(s, '文本输入失败：' + (e.message || e)); } };
  const flushText = async () => {
    const text = ime.value; ime.value = ''; if (!text || !s.controller || !s.inputReady) return;
    s.lastInput = Date.now(); send(s, { type: 'activity' });
    try { await sendText(s, text); }
    catch (e) { log(s, '文本输入失败：' + (e.message || e)); }
  };
  ime.addEventListener('compositionend', () => { setTimeout(flushText, 0); });
  ime.addEventListener('input', e => { if (e.isComposing) return; if (e.inputType === 'insertText' || e.inputType === 'insertFromPaste' || e.inputType === 'insertCompositionText') { if (!e.isComposing) flushText(); } else ime.value = ''; });
  s.release = () => { releaseTouch(); releaseKeys(); };
  window.addEventListener('blur', s.release); document.addEventListener('visibilitychange', () => { if (document.hidden) s.release(); });
  return node;
}
// 把文本送进设备。分两条路，因为「设剪贴板 + 由 scrcpy 注入 KEYCODE_PASTE」在老系统上不生效：
// Android 6 的前台应用不响应那个键，表现是内容确实到了设备剪贴板、却粘不进输入框。
// D31 实测印证了这一点：设备日志里 Device clipboard set 连出四次全部成功、没有任何注入报错，
// 而在输入框里手动长按选「粘贴」能粘出来。scrcpy 上游提供 --legacy-paste 正是为了这个。
//
// 纯 ASCII 走 injectText，这就是键盘打字用的那条通路，在 D31 上已经实测可用。
// 含非 ASCII 时只能过剪贴板，但改成自己注入 Ctrl+V：TextView 从 API 11 起就在 onKeyShortcut 里
// 处理它，支持面比 KEYCODE_PASTE 宽。setClipboard 因此传 paste:false，避免和自己注入的键重复触发。
// 模拟真实键盘按组合键：先按下 Ctrl 这个键本身，再按字母，最后依次松开。
// 只在字母事件的 metaState 里标上 Ctrl 是不够的——上一版就是那么发的，D31 上毫无反应。
// 真实键盘会先产生一个 CTRL_LEFT 按下事件，窗口的快捷键分发依赖这个先后顺序。
async function chord(s, keyCode) {
  const CTRL_LEFT = 113;
  await s.controller.injectKeyCode({ action: AndroidKeyEventAction.Down, keyCode: CTRL_LEFT, repeat: 0, metaState: META_CTRL });
  await s.controller.injectKeyCode({ action: AndroidKeyEventAction.Down, keyCode, repeat: 0, metaState: META_CTRL });
  await s.controller.injectKeyCode({ action: AndroidKeyEventAction.Up, keyCode, repeat: 0, metaState: META_CTRL });
  await s.controller.injectKeyCode({ action: AndroidKeyEventAction.Up, keyCode: CTRL_LEFT, repeat: 0, metaState: 0 });
}

async function sendText(s, text) {
  if (ASCII_ONLY.test(text)) { await s.controller.injectText(text); return 'typed'; }
  await s.controller.setClipboard({ sequence: 0n, content: text, paste: false });
  await chord(s, 50);   // KEYCODE_V
  return 'clipboard';
}

async function key(s, code) { if (!s.controller || !s.inputReady) return; s.lastInput = Date.now(); send(s, { type: 'activity' }); await s.controller.injectKeyCode({ action: AndroidKeyEventAction.Down, keyCode: code, repeat: 0, metaState: 0 }); await s.controller.injectKeyCode({ action: AndroidKeyEventAction.Up, keyCode: code, repeat: 0, metaState: 0 }); }
async function action(s, act) {
  try {
    if (act === 'menu') await key(s, AndroidKeyCode.ContextMenu);
    else if (act === 'recent') await key(s, AndroidKeyCode.AndroidAppSwitch);
    else if (act === 'home') await key(s, AndroidKeyCode.AndroidHome);
    else if (act === 'back') await key(s, AndroidKeyCode.AndroidBack);
    else if (act === 'copy') {
      // 「复制」应当是「把设备上选中的文字取过来」。原来它只是读设备上一次复制过的内容，
      // 所以在设备上选中文字再点它没有任何反应，必须先用安卓自带的复制菜单，这不符合按钮的名字。
      // 现在先在设备上触发一次 Ctrl+C，等设备把剪贴板推上来再读。
      s.lastInput = Date.now(); send(s, { type: 'activity' });
      const before = s.deviceClipboard;
      try { await chord(s, 31); } catch {}   // KEYCODE_C
      await new Promise(r => setTimeout(r, 400));
      const text = s.deviceClipboard;
      if (text === undefined) { log(s, '设备剪贴板为空；请先在设备画面中选中文字'); return; }
      await navigator.clipboard.writeText(text);
      log(s, text === before ? ('已取回设备剪贴板 ' + text.length + ' 字，内容未变；如果刚选中了文字却没复制到，请用设备上的复制菜单')
        : ('已复制设备上选中的 ' + text.length + ' 字'));
    }
    else if (act === 'paste') { const text = await navigator.clipboard.readText(); if (!text) { log(s, '电脑剪贴板为空'); return; } if (text.length > 30000) { log(s, '剪贴板文本过长'); return; } s.lastInput = Date.now(); send(s, { type: 'activity' }); const how = await sendText(s, text); log(s, how === 'typed' ? ('已输入 ' + text.length + ' 字') : ('已送到设备剪贴板并触发粘贴 ' + text.length + ' 字；若没粘上，可在设备输入框长按选粘贴')); }
  } catch (e) { log(s, (act === 'copy' || act === 'paste' ? '剪贴板操作失败：' : '操作失败：') + (e.message || e)); }
}

async function negotiate(s, hello) {
  s.generation = hello.generation; if (hello.ice_servers) s.iceServers = hello.ice_servers; if (hello.turn === false) log(s, 'TURN 凭据不可用，仅尝试直连');
  if (s.pc) { try { s.pc.close(); } catch {} }
  const pc = new RTCPeerConnection({ iceServers: hello.ice_servers || [{ urls: 'stun:stun.cloudflare.com:3478' }] });
  s.pc = pc; s.pendingCandidates = [];
  pc.onicecandidate = e => { if (e.candidate && active === s) send(s, { type: 'signal', kind: 'candidate', payload: JSON.stringify(e.candidate.toJSON()), generation: s.generation }); };
  pc.onconnectionstatechange = () => { if (active !== s) return; if (pc.connectionState === 'failed') { if (s.generation < 4 && !s.ready) send(s, { type: 'restart' }); else stop('远程桌面网络连接失败'); } if (pc.connectionState === 'disconnected') log(s, '连接中断，正在等待恢复…'); };
  pc.ondatachannel = e => { if (active !== s) return; if (e.channel.label === 'video') s.videoDc = e.channel; else if (e.channel.label === 'control') s.controlDc = e.channel; if (s.videoDc && s.controlDc) attach(s).catch(err => { console.error('desktop attach failed', err); if (active === s) stop('远程桌面初始化失败：' + (err && err.message || err)); }); };
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
  if (!WebCodecsVideoDecoder.isSupported) throw Error('此浏览器不支持 WebCodecs 视频解码，请用最新版 Chrome/Edge');
  // WebGL 在部分环境（远程桌面、禁用 GPU、隐私设置）不可用：真正尝试创建，失败退回位图渲染。
  let renderer;
  try { renderer = new WebGLVideoFrameRenderer(); if (!(renderer.canvas || renderer.element)) throw Error('no canvas'); }
  catch (e) { console.warn('desktop webgl renderer unavailable, fallback to bitmap', e); renderer = new BitmapVideoFrameRenderer(); }
  s.canvas = renderer.canvas || renderer.element; s.canvas.className = 'desktop-canvas';
  s.node.querySelector('.desktop-screen').replaceChildren(s.canvas);
  s.decoder = new WebCodecsVideoDecoder({ codec: metadata.codec, renderer });
  s.decoder.sizeChanged(({ width, height }) => { if (width === s.videoW && height === s.videoH) return; s.videoW = width; s.videoH = height; s.geometryEpoch++; });
  const counted = new TransformStream({ transform(p, c) { if (p.type === 'data') { s.frames++; if (!s.firstFrameAt) { s.firstFrameAt = performance.now(); setTimeout(() => updateReady(s), 0); } s.frameEpoch = s.geometryEpoch; } c.enqueue(p); } });
  stream.pipeThrough(options.createMediaStreamTransformer()).pipeThrough(counted).pipeTo(s.decoder.writable).catch(e => { if (active === s && !s.closed) log(s, '视频流结束：' + (e?.message || e)); });
  s.controller = new ScrcpyControlMessageWriter(channelWritable(s.controlDc).getWriter(), options);
  (async () => { const b = new BufferedReadableStream(channelReadable(s.controlDc, s)); try { while (true) { const id = (await b.readExactly(1))[0]; await options.deviceMessageParsers.parse(id, b); } } catch {} })();
  options.clipboard?.pipeTo(new WritableStream({ write(text) { s.deviceClipboard = text; log(s, '设备剪贴板已更新（' + text.length + ' 字），点“复制”取回'); } })).catch(() => {});
  s.inputReady = true; updateReady(s);
}
function updateReady(s) {
  if (s.ready || !s.inputReady || !s.firstFrameAt || !s.deviceReady) return;
  s.ready = true; s.started = Date.now(); s.lastInput = Date.now();
  log(s, '已连接 ' + s.videoW + '×' + s.videoH + ' · 首帧 ' + Math.round(s.firstFrameAt - s.startedAt) + ' ms'); render();
}
function tick(s) {
  if (active !== s) return;
  const now = performance.now(), dt = (now - (s.lastTick || s.startedAt)) / 1000;
  const kbps = Math.round((s.bytes - s.lastBytes) * 8 / 1000 / dt), fps = ((s.frames - s.lastFrames) / dt).toFixed(0);
  s.lastTick = now; s.lastBytes = s.bytes; s.lastFrames = s.frames;
  const el = s.node.querySelector('.desktop-stats'); if (el) el.textContent = s.ready ? fps + ' 帧/秒 · ' + kbps + ' kbps · 本次 ' + (s.bytes / 1048576).toFixed(1) + ' MB' : '';
  if (s.ready && Date.now() - s.lastInput >= IDLE_LIMIT_MS) { stop('20分钟无操作，已自动关闭'); return; }
  if (!s.lastPing || Date.now() - s.lastPing >= 15000) { send(s, { type: 'ping' }); s.lastPing = Date.now(); }
  if (Date.now() - s.lastInput < 30000 && Date.now() - (s.lastActivitySent || 0) >= 30000) { send(s, { type: 'activity' }); s.lastActivitySent = Date.now(); }
}

// 播放区的物理像素尺寸。把宽高两个数都报上去，由设备和自己的屏幕做 contain 计算：
// 手机是竖屏，放进横向播放区里上下顶满、左右留黑边，真正约束的是高度；窗口又窄又高时
// 约束才变成宽度。这个判断要同时知道手机屏幕和播放区，只有设备两边都知道，所以不在这里算。
// 之前这里只报了播放区长边，等于在横向窗口下把宽度当成了约束边，编出来的画面白白多了一截宽、
// 高度反而不够，表现就是放大后锯齿明显。量不到就不报，服务端不下发相关字段，设备走自己的默认值。
function displayBox(node) {
  try {
    const r = node?.querySelector('.desktop-stage')?.getBoundingClientRect();
    const w = r?.width || 0, h = r?.height || 0;
    if (!w || !h) return null;
    const ratio = window.devicePixelRatio || 1;
    return { w: Math.round(w * ratio), h: Math.round(h * ratio) };
  } catch { return null; }
}

async function start(d) {
  if (!d || d.managed_desktop_v1 !== true || d.enabled === false) return;
  if (active && active.device.id === d.id) return;
  if (active) await stop('已切换设备');
  const s = { device: d, bytes: 0, frames: 0, lastBytes: 0, lastFrames: 0, videoW: 0, videoH: 0, geometryEpoch: 0, frameEpoch: 0, generation: 1, startedAt: performance.now(), lastInput: Date.now(), closed: false, message: '正在连接…' };
  active = s; lastMessage = ''; s.node = buildNode(s); render(); log(s, '正在唤醒设备…');
  try {
    const box = displayBox(s.node);
    const result = await json('/api/elfremote/desktop/session', { device_id: d.id, display_w: box?.w, display_h: box?.h, quality: (d.network || '').toLowerCase().includes('cell') || /移动|蜂窝|4g|lte/i.test(d.network || '') ? 'cellular' : 'wifi' });
    if (active !== s) { await json('/api/elfremote/desktop/session', { session_id: result.session_id }, 'DELETE').catch(() => {}); return; }
    s.id = result.session_id;
    s.ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/elfremote/desktop/browser?session_id=' + s.id);
    s.ws.onmessage = e => { if (active !== s) return; let p; try { p = JSON.parse(e.data); } catch { return; } message(s, p).catch(err => { console.error('desktop message failed', err); if (active === s) stop('远程桌面失败：' + (err && err.message || err)); }); };
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
  // 桌面关掉之后 body 上的标记必须收回，否则页面会一直禁止滚动、卡片也一直没有毛玻璃。
  document.body.classList.remove('desktop-expanded-host');
  render();
}
// 供设备页调用：按钮状态、把保留的桌面节点挂回终端区域。
function isActive(d) { return !!active && (!d || active.device.id === d.id); }
function button(d) {
  const on = isActive(d), can = !!d && d.managed_desktop_v1 === true && d.enabled !== false && d.share_locked !== true;
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
