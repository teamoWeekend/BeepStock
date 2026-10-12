// Camera barcode scanner. Detection and triggering happen entirely in the browser:
//  - native BarcodeDetector (Chrome/Edge on Android, Safari 17+ ...) when available,
//  - otherwise ZXing (served from /vendor/zxing/, loaded on demand).
// The detected code is handed to ctx.send(code), the same path a hardware scanner uses (WebSocket, else REST).
// ?camdry=1 only shows what was recognised without sending anything; ?cam=1 opens the scanner on load.

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];
const DATE_CHIPS = [['+1 T', 'PCD1'], ['+3 T', 'PCD3'], ['+1 W', 'PCW1'], ['+2 W', 'PCW2'], ['+1 M', 'PCM1'], ['+3 M', 'PCM3'], ['+6 M', 'PCM6']];
const EXTRA_CHIPS = [['↩ Rückgängig', 'PCUNDO'], ['×2', 'PCQ2'], ['×3', 'PCQ3'], ['×6', 'PCQ6']];

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

let zxingPromise = null;
function loadZxing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  zxingPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/zxing/index.min.js';
    s.onload = () => resolve(window.ZXing);
    s.onerror = () => { zxingPromise = null; reject(new Error('Barcode-Bibliothek konnte nicht geladen werden')); };
    document.head.append(s);
  });
  return zxingPromise;
}

/** Returns { name, decode(source, maxDim) -> Promise<string|null> } using the best available engine. */
async function makeDecoder() {
  if ('BarcodeDetector' in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = FORMATS.filter((f) => supported.includes(f));
      if (formats.length) {
        const detector = new window.BarcodeDetector({ formats });
        return { name: 'native', decode: async (src) => (await detector.detect(src))[0]?.rawValue ?? null };
      }
    } catch { /* fall through to ZXing */ }
  }
  const Z = await loadZxing();
  const hints = new Map();
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E, Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.ITF]);
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);
  const canvas = document.createElement('canvas');
  const c2d = canvas.getContext('2d', { willReadFrequently: true });
  return {
    name: 'zxing',
    decode: async (src, maxDim = 960) => {
      const w = src.videoWidth || src.width, hh = src.videoHeight || src.height;
      if (!w || !hh) return null;
      const scale = Math.min(1, maxDim / Math.max(w, hh));
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(hh * scale);
      c2d.drawImage(src, 0, 0, canvas.width, canvas.height);
      try {
        return reader.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)))).getText();
      } catch { return null; } // NotFoundException = nothing in this frame
    },
  };
}

export function initCamera(ctx) {
  const params = new URLSearchParams(location.search);
  const dry = params.has('camdry');
  let root, video, msgEl, msgText, msgThumb, modeRow, locRow, dateRow, extraRow, zoomRow, zoomInput, torchBtn, switchBtn, countEl, typeRow, typeInput, panel;
  let stream = null, track = null, decoder = null, loopTimer = 0, running = false, isOpen = false;
  let lastCode = '', lastAt = 0, pauseUntil = 0, torchOn = false, count = 0, devices = [], deviceIdx = -1, wakeLock = null, audio = null;

  // ---------------------------------------------------------------- feedback
  const pref = (key) => { try { return localStorage.getItem(key) !== '0'; } catch { return true; } };
  const vib = (pattern) => { if (pref('pantry_cam_vibrate')) navigator.vibrate?.(pattern); };
  const beep = (freq, ms) => {
    if (!pref('pantry_cam_sound')) return;
    try {
      audio ??= new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = freq; g.gain.value = 0.08;
      o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + ms / 1000);
    } catch { /* no audio */ }
  };
  const feedback = (level) => {
    if (level === 'ok') { vib(35); beep(880, 90); }
    else if (level === 'warn') { vib([70, 50, 70]); beep(520, 160); }
    else { vib(250); beep(220, 260); }
    root.dataset.flash = level;
    setTimeout(() => { if (root.dataset.flash === level) root.dataset.flash = ''; }, 450);
  };
  const setMsg = (text, level = '', thumb = '') => {
    msgEl.dataset.level = level;
    msgText.textContent = text;
    msgThumb.src = thumb || '';
    msgThumb.hidden = !thumb;
  };

  // ---------------------------------------------------------------- UI
  function chip(label, onclick, active = false) {
    return h('button', { type: 'button', class: 'cam-chip' + (active ? ' on' : ''), onclick }, label);
  }
  function refresh() {
    if (!root) return;
    const st = ctx.getState() || {};
    modeRow.replaceChildren(h('span', { class: 'cam-lbl' }, 'Modus'),
      ...ctx.modeOrder.map((m) => chip(ctx.modeLabels[m], () => ctx.setMode(m), st.mode === m)));
    locRow.replaceChildren(h('span', { class: 'cam-lbl' }, 'Ort'),
      ...ctx.getLocations().map((l) => chip(l.name, () => ctx.setLocation(l.id), st.location_id === l.id)));
    dateRow.hidden = st.mode !== 'add';
    dateRow.replaceChildren(h('span', { class: 'cam-lbl' }, 'MHD'), ...DATE_CHIPS.map(([l, code]) => chip(l, () => ctx.send(code))));
    extraRow.replaceChildren(...EXTRA_CHIPS.map(([l, code]) => chip(l, () => ctx.send(code))),
      chip('⌨ Eintippen', () => { typeRow.hidden = !typeRow.hidden; if (!typeRow.hidden) typeInput.focus(); }));
  }

  function build() {
    if (root) return;
    video = h('video', { playsinline: true, muted: true, autoplay: true });
    video.muted = true;
    msgThumb = h('img', { class: 'cam-thumb', alt: '', hidden: true });
    msgText = h('span', {}, 'Barcode in den Rahmen halten');
    msgEl = h('div', { class: 'cam-msg', 'aria-live': 'polite' }, msgThumb, msgText);
    countEl = h('span', { class: 'cam-count' }, '');
    torchBtn = h('button', { type: 'button', class: 'cam-round', title: 'Licht', hidden: true, onclick: toggleTorch }, '🔦');
    switchBtn = h('button', { type: 'button', class: 'cam-round', title: 'Kamera wechseln', hidden: true, onclick: switchCamera }, '🔄');
    modeRow = h('div', { class: 'cam-row' }); locRow = h('div', { class: 'cam-row' });
    dateRow = h('div', { class: 'cam-row' }); extraRow = h('div', { class: 'cam-row' });
    zoomInput = h('input', { type: 'range', min: '1', max: '4', step: '0.1', value: '1', 'aria-label': 'Zoom', oninput: () => applyZoom(Number(zoomInput.value)) });
    zoomRow = h('div', { class: 'cam-zoom', hidden: true }, h('span', {}, '🔍'), zoomInput);
    typeInput = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'Barcode eintippen …', autocomplete: 'off' });
    typeRow = h('form', { class: 'cam-type', hidden: true, onsubmit: (e) => { e.preventDefault(); const v = typeInput.value.trim(); if (v) { ctx.send(v); typeInput.value = ''; } } },
      typeInput, h('button', { type: 'submit', class: 'cam-chip on' }, 'Senden'));
    panel = h('div', { class: 'cam-panel', hidden: true });
    root = h('div', { id: 'cam', class: 'cam', hidden: true, role: 'dialog', 'aria-label': 'Kamera-Scanner' },
      video,
      h('div', { class: 'cam-frame' }, h('i'), h('i'), h('i'), h('i'), h('span', { class: 'cam-line' })),
      h('div', { class: 'cam-top' },
        h('button', { type: 'button', class: 'cam-round', title: 'Schließen', onclick: close }, '✕'),
        h('div', { class: 'cam-title' }, 'Kamera-Scanner', dry ? ' (Test)' : '', countEl),
        torchBtn, switchBtn),
      panel,
      h('div', { class: 'cam-bottom' }, msgEl, zoomRow, typeRow, modeRow, locRow, dateRow, extraRow));
    document.body.append(root);
    document.addEventListener('visibilitychange', () => {
      if (!isOpen) return;
      if (document.hidden) stop(); else if (panel.hidden) start().catch(showError); // resume after the tab/app was in the background
    });
    document.addEventListener('keydown', (e) => { if (isOpen && e.key === 'Escape') close(); });
  }

  // ---------------------------------------------------------------- camera
  async function start(deviceId) {
    stop();
    panel.hidden = true;
    const video_ = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } };
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...video_, width: { ideal: 1280 }, height: { ideal: 720 } } });
    track = stream.getVideoTracks()[0];
    video.srcObject = stream;
    await video.play().catch(() => undefined);
    try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { /* not supported */ }
    const caps = track.getCapabilities?.() ?? {};
    torchBtn.hidden = !caps.torch;
    torchOn = false; torchBtn.classList.remove('on');
    if (caps.zoom) { zoomInput.min = String(caps.zoom.min ?? 1); zoomInput.max = String(Math.min(caps.zoom.max ?? 4, 8)); zoomInput.step = String(caps.zoom.step || 0.1); zoomInput.value = String(caps.zoom.min ?? 1); zoomRow.hidden = false; } else zoomRow.hidden = true;
    try { devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch { devices = []; }
    const cur = track.getSettings?.().deviceId;
    deviceIdx = Math.max(0, devices.findIndex((d) => d.deviceId === cur));
    switchBtn.hidden = devices.length < 2;
    decoder ??= await makeDecoder();
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
    running = true;
    setMsg('Barcode in den Rahmen halten');
    tick();
  }

  function stop() {
    running = false;
    clearTimeout(loopTimer);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null; track = null;
    if (video) video.srcObject = null;
    wakeLock?.release?.().catch(() => undefined); wakeLock = null;
  }

  async function tick() {
    if (!running) return;
    try {
      if (performance.now() >= pauseUntil && video.readyState >= 2) {
        const code = await decoder.decode(video);
        if (code) handle(code);
      }
    } catch { /* single frame failed */ }
    loopTimer = setTimeout(tick, decoder?.name === 'native' ? 60 : 140);
  }

  function handle(code) {
    const now = performance.now();
    if (code === lastCode && now - lastAt < 3000) { lastAt = now; return; } // same barcode still in view
    lastCode = code; lastAt = now; pauseUntil = now + 900;
    count++;
    countEl.textContent = ` · ${count}`;
    if (dry) { setMsg(`Erkannt: ${code} (Testmodus, nichts gesendet)`, 'ok'); feedback('ok'); window.__camLast = code; return; }
    vib(25);
    setMsg(`${code} …`, '');
    ctx.send(code);
  }

  async function toggleTorch() {
    try { torchOn = !torchOn; await track.applyConstraints({ advanced: [{ torch: torchOn }] }); torchBtn.classList.toggle('on', torchOn); } catch { torchOn = false; }
  }
  async function applyZoom(v) { try { await track.applyConstraints({ advanced: [{ zoom: v }] }); } catch { /* ignore */ } }
  async function switchCamera() {
    if (devices.length < 2) return;
    deviceIdx = (deviceIdx + 1) % devices.length;
    try { await start(devices[deviceIdx].deviceId); } catch (e) { showError(e); }
  }

  // ---------------------------------------------------------------- problems / fallback without live camera
  function showPanel(title, text, extra = []) {
    panel.replaceChildren(h('h3', {}, title), h('p', {}, text), ...extra);
    panel.hidden = false;
  }
  function photoButton() {
    const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: async () => {
      const f = input.files?.[0];
      if (!f) return;
      setMsg('Foto wird ausgewertet …');
      try {
        decoder ??= await makeDecoder();
        const bmp = await createImageBitmap(f);
        const code = await decoder.decode(bmp, 1800);
        if (code) { handle(code); } else { setMsg('Kein Barcode erkannt. Näher heran, Barcode waagerecht und scharf.', 'warn'); feedback('warn'); }
      } catch (e) { setMsg(`Fehler: ${e.message || e}`, 'error'); }
      input.value = '';
    } });
    return h('div', {}, input, h('button', { type: 'button', class: 'cam-chip on big', onclick: () => input.click() }, '📷 Foto aufnehmen'));
  }
  async function showInsecure() {
    let httpsPort = 0;
    try { httpsPort = (await ctx.getInfo()).httpsPort; } catch { /* ignore */ }
    const extra = [];
    if (httpsPort) {
      const url = `https://${location.hostname}:${httpsPort}${location.pathname}${location.search}${location.hash}`;
      extra.push(h('a', { class: 'cam-chip on big', href: url }, 'Sicher öffnen (HTTPS)'),
        h('p', { class: 'cam-small' }, 'Beim ersten Mal zeigt der Browser eine Zertifikatswarnung (selbst signiert). Unter „Erweitert“ trotzdem fortfahren; danach funktioniert die Live-Kamera.'));
    } else {
      extra.push(h('p', { class: 'cam-small' }, 'Der Server bietet kein HTTPS an (HTTPS_PORT in der docker-compose.yml setzen).'));
    }
    extra.push(h('p', { class: 'cam-small' }, 'Ohne HTTPS geht es trotzdem per Foto:'), photoButton());
    showPanel('Live-Kamera nicht verfügbar', 'Browser erlauben die Kamera nur über HTTPS oder localhost.', extra);
  }
  function showError(e) {
    const name = e?.name || '';
    if (name === 'NotAllowedError') showPanel('Kamerazugriff verweigert', 'Erlaube den Kamerazugriff für diese Seite in den Browser-Einstellungen und öffne den Scanner erneut.', [photoButton()]);
    else if (name === 'NotFoundError' || name === 'OverconstrainedError') showPanel('Keine Kamera gefunden', 'Auf diesem Gerät wurde keine Kamera erkannt.', [photoButton()]);
    else showPanel('Kamera konnte nicht gestartet werden', String(e?.message || e), [photoButton()]);
  }

  // ---------------------------------------------------------------- public
  async function open() {
    build();
    try { audio ??= new (window.AudioContext || window.webkitAudioContext)(); audio.resume?.(); } catch { /* optional */ }
    isOpen = true; root.hidden = false;
    document.body.classList.add('cam-open');
    count = 0; countEl.textContent = ''; lastCode = '';
    refresh();
    setMsg('Kamera wird gestartet …');
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return showInsecure();
    try { await start(); } catch (e) { showError(e); }
  }
  function close() {
    isOpen = false; stop();
    if (root) root.hidden = true;
    document.body.classList.remove('cam-open');
  }
  function onResult(r) {
    if (!isOpen) return;
    setMsg(r.message, r.level, r.product?.image_url || '');
    feedback(r.level);
    refresh();
  }

  if (params.has('cam')) setTimeout(open, 400);
  return { open, close, isOpen: () => isOpen, onResult, refresh };
}
