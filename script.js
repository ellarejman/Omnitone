'use strict';
/* ===== Config: confirm these with the firmware team ===== */
const CFG = {
  RATE: 44100,
  TONE_MAX: 250 * 1024,            // per tone sample
  TRACK_MAX: 8 * 1024 * 1024,      // per backing track
  TRANSFER_MAX: 3 * 1024 * 1024,   // per send (conflicts with TRACK_MAX: resolve in the spec)
  LIB_MAX: 50 * 1024 * 1024,
  NUM_TONES: 4, NUM_TRACKS: 4,
  BAUD: 115200, CHUNK: 16384,
  NOTES: ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
};
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const kb = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' kB';

/* ===== State ===== */
let lib = {
  tones: Array.from({length: CFG.NUM_TONES}, (_, i) => ({name: 'Tone ' + (i + 1), mode: 'pitch', samples: Array(12).fill(null)})),
  tracks: []
};
const ui = {tab: 'tones', tone: 0, note: 0};
let port = null, sending = false;

/* ===== Local storage subsystem (IndexedDB) ===== */
const DB = {
  open: () => new Promise((res, rej) => {
    const r = indexedDB.open('omnitone', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }),
  async get(k) { const db = await this.open(); return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
};
const save = () => DB.set('library', lib).catch(() => notify('err', 'Could not save your library in this browser.'));
const libSize = () => lib.tones.reduce((a, t) => a + t.samples.reduce((b, s) => b + (s ? s.bytes.byteLength : 0), 0), 0) + lib.tracks.reduce((a, t) => a + t.bytes.byteLength, 0);

/* ===== Audio processing + validation subsystem ===== */
function readWavInfo(ab) {
  const v = new DataView(ab), tag = o => String.fromCharCode(...new Uint8Array(ab, o, 4));
  if (ab.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw Error('This file is not a valid WAV file.');
  for (let o = 12; o + 8 <= ab.byteLength;) {
    const size = v.getUint32(o + 4, true);
    if (tag(o) === 'fmt ') return {channels: v.getUint16(o + 10, true), rate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true)};
    o += 8 + size + (size & 1);
  }
  throw Error('This WAV file has no format information.');
}
function encodeWav(samples, rate) {
  const n = samples.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return buf;
}
async function processWav(file, maxBytes) {
  if (!/\.wav$/i.test(file.name)) throw Error(file.name + ' can’t be added. Only WAV files are accepted. Convert it to WAV and try again.');
  const ab = await file.arrayBuffer(), info = readWavInfo(ab);
  const ctx = new AudioContext({sampleRate: CFG.RATE});
  let decoded;
  try { decoded = await ctx.decodeAudioData(ab.slice(0)); } catch { throw Error(file.name + ' could not be read as audio.'); } finally { ctx.close(); }
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * CFG.RATE)), CFG.RATE);
  const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
  const out = await off.startRendering(), bytes = encodeWav(out.getChannelData(0), CFG.RATE);
  if (bytes.byteLength > maxBytes) throw Error(`${file.name} is ${kb(bytes.byteLength)} after conversion. The limit is ${kb(maxBytes)}. Trim the file and try again.`);
  const converted = info.channels !== 1 || info.rate !== CFG.RATE || info.bits !== 16;
  return {name: file.name, bytes, duration: decoded.duration, converted};
}

/* ===== Library + UI subsystem ===== */
function notify(type, msg) {
  const el = document.createElement('div'); el.className = 'note ' + type;
  el.innerHTML = `<span>${esc(msg)}</span><button>Dismiss</button>`;
  el.querySelector('button').onclick = () => el.remove();
  $('#notices').prepend(el);
  while ($('#notices').children.length > 3) $('#notices').lastChild.remove();
}
const toneReady = t => t.mode === 'pitch' ? !!t.samples[0] : t.samples.every(Boolean);
const toneUsed = t => t.samples.some(Boolean);

async function addFiles(files) {
  for (const f of files) {
    try {
      if (libSize() + f.size > CFG.LIB_MAX) throw Error('The library is full (50 MB). Remove a sound first.');
      let item;
      if (ui.tab === 'tones') {
        const t = lib.tones[ui.tone], n = t.mode === 'pitch' ? 0 : ui.note;
        item = await processWav(f, CFG.TONE_MAX);
        t.samples[n] = item;
        if (t.mode === 'multi') { const nx = t.samples.findIndex(s => !s); if (nx >= 0) ui.note = nx; }
      } else {
        item = await processWav(f, CFG.TRACK_MAX);
        lib.tracks.push({...item, slot: null});
      }
      if (item.converted) notify('warn', item.name + ' was converted to 16-bit, 44.1 kHz, mono so it plays correctly on the Omnitone.');
    } catch (e) { notify('err', e.message); }
  }
  await save(); render();
}

function renderTones() {
  const t = lib.tones[ui.tone], pitch = t.mode === 'pitch', s = t.samples[pitch ? 0 : ui.note];
  const keys = CFG.NOTES.map((n, i) => {
    const full = pitch ? !!t.samples[0] : !!t.samples[i];
    return `<button class="key ${full ? 'full' : ''} ${i === 0 && pitch && full ? 'root' : ''} ${!pitch && i === ui.note ? 'sel-on' : ''}" data-act="note" data-i="${i}" ${pitch ? 'disabled' : ''} aria-label="Note ${n}, ${full ? 'filled' : 'empty'}">${n}</button>`;
  }).join('');
  $('#panel-tones').innerHTML = `<div class="stack">
    <div class="head"><label><span class="lbl">Tone slot</span><br><select class="sel" data-act="tone">${lib.tones.map((x, i) => `<option value="${i}" ${i === ui.tone ? 'selected' : ''}>${esc(x.name)}${toneReady(x) ? '' : ' (incomplete)'}</option>`).join('')}</select></label>
    <label><span class="lbl">Name</span><br><input class="txt" data-act="name" value="${esc(t.name)}" maxlength="24"></label></div>
    <div class="radios"><label><input type="radio" name="mode" value="pitch" ${pitch ? 'checked' : ''}>One sample, pitch-shifted</label>
    <label><input type="radio" name="mode" value="multi" ${pitch ? '' : 'checked'}>12 individual samples</label></div>
    <div><div class="lbl" style="margin-bottom:8px">${pitch ? 'The Omnitone shifts one sample (C) across all 12 notes.' : 'Select a note, then add a WAV file for it.'}</div><div class="keys">${keys}</div></div>
    <div class="lbl">${s ? `${esc(s.name)} · ${s.duration.toFixed(1)} s · ${kb(s.bytes.byteLength)} of ${kb(CFG.TONE_MAX)}` : 'No file for this note yet. Drop a WAV file above.'}</div>
    <div style="display:flex;gap:12px"><button class="btn" data-act="preview" ${s ? '' : 'disabled'}>Preview</button><button class="btn" data-act="clear" ${s ? '' : 'disabled'}>Remove file</button></div></div>`;
}
function renderTracks() {
  const rows = lib.tracks.map((t, i) => `<div class="row"><div><strong>${esc(t.name)}</strong><div class="lbl">${t.duration.toFixed(0)} s</div></div>
    <div><div class="lbl" style="margin-bottom:6px">${kb(t.bytes.byteLength)} of ${kb(CFG.TRACK_MAX)}</div><div class="bar"><i style="width:${Math.min(100, t.bytes.byteLength / CFG.TRACK_MAX * 100)}%"></i></div></div>
    <select class="sel" data-act="slot" data-i="${i}" aria-label="Slot for ${esc(t.name)}"><option value="">Not assigned</option>${Array.from({length: CFG.NUM_TRACKS}, (_, k) => `<option value="${k}" ${t.slot === k ? 'selected' : ''}>Backing slot ${k + 1}</option>`).join('')}</select>
    <button class="btn" data-act="preview-track" data-i="${i}">Preview</button><button class="btn" data-act="del-track" data-i="${i}">Remove</button></div>`).join('');
  $('#panel-tracks').innerHTML = `<div class="head"><div class="h2">Backing tracks</div><span class="lbl">Up to ${kb(CFG.TRACK_MAX)} each</span></div>${rows || '<p class="lbl">No backing tracks yet. Drop a WAV file above.</p>'}`;
}
function sendPlan() {
  const issues = [], tones = lib.tones.filter(toneUsed), tracks = lib.tracks.filter(t => t.slot !== null);
  tones.filter(t => !toneReady(t)).forEach(t => issues.push(t.name + ' needs all 12 notes filled.'));
  if (!tones.length && !tracks.length) issues.push('Add at least one tone or backing track.');
  const size = buildBundle().byteLength;
  if (size > CFG.TRANSFER_MAX) issues.push(`This send is ${kb(size)}. The limit is ${kb(CFG.TRANSFER_MAX)}. Unassign a track or remove a tone.`);
  return {issues, tones, tracks, size};
}
function renderSend() {
  const p = sendPlan(), ready = lib.tones.filter(t => toneUsed(t) && toneReady(t)).length;
  $('#checks').innerHTML = [
    ['Tones ready', `${ready} of ${lib.tones.filter(toneUsed).length}`, ready === lib.tones.filter(toneUsed).length ? 'good' : 'bad'],
    ['Backing tracks', p.tracks.length + ' assigned', ''],
    ['Format', '16-bit, 44.1 kHz, mono', 'good'],
    ['This transfer', `${kb(p.size)} of ${kb(CFG.TRANSFER_MAX)} max`, p.size > CFG.TRANSFER_MAX ? 'bad' : '']
  ].map(([a, b, c]) => `<div class="chk ${c}"><span>${a}</span><strong>${b}</strong></div>`).join('') + p.issues.map(i => `<div class="chk bad"><span>${esc(i)}</span></div>`).join('');
  $('#btn-send').disabled = sending || !port || p.issues.length > 0;
  $('#btn-send').title = !port ? 'Connect your Omnitone first' : '';
  const used = libSize();
  $('#store-txt').textContent = `${kb(used)} of 50 MB`; $('#store-bar').style.width = Math.min(100, used / CFG.LIB_MAX * 100) + '%';
}
function renderHome() {
  const ready = lib.tones.filter(t => toneUsed(t) && toneReady(t)).length;
  $('#home-tones').textContent = `${ready} of ${CFG.NUM_TONES} tones ready`;
  $('#home-tracks').textContent = `${lib.tracks.length} uploaded, ${lib.tracks.filter(t => t.slot !== null).length} assigned`;
}
function render() { renderHome(); renderTones(); renderTracks(); renderSend(); }

/* ===== Router: one page, three views, chosen by the URL hash (#/, #/tones, #/tracks) ===== */
function route() {
  const page = location.hash.replace('#/', '');
  const view = page === 'tones' || page === 'tracks' ? page : 'home';
  ui.tab = view === 'tracks' ? 'tracks' : 'tones';   // addFiles() reads ui.tab
  $('#view-home').hidden = view !== 'home';
  $('#view-work').hidden = view === 'home';
  $('#send-card').hidden = view === 'home';
  $('#panel-tones').hidden = view !== 'tones';
  $('#panel-tracks').hidden = view !== 'tracks';
  $('#work-title').textContent = view === 'tracks' ? 'Upload a backing track' : 'Upload a tone';
  $('#drop-hint').textContent = view === 'tracks' ? `WAV only, up to ${kb(CFG.TRACK_MAX)} per track.` : `WAV only, up to ${kb(CFG.TONE_MAX)} per file.`;
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

/* ===== Packager: placeholder format, agree on the real one with firmware =====
   "OMNI" | version u8 | toneCount u8 | trackCount u8
   per tone:  slot u8 | mode u8 (0 pitch, 1 multi) | sampleCount u8 | [note u8 | len u32 | WAV bytes]...
   per track: slot u8 | len u32 | WAV bytes
   then CRC32 (u32, little-endian) of everything before it */
function crc32(u8) {
  let crc = -1;
  for (let i = 0; i < u8.length; i++) { let c = (crc ^ u8[i]) & 255; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ -1) >>> 0;
}
function buildBundle() {
  const parts = [], u8 = (...a) => parts.push(new Uint8Array(a));
  const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); parts.push(b); };
  const tones = lib.tones.map((t, i) => ({t, i})).filter(x => toneUsed(x.t) && toneReady(x.t)), tracks = lib.tracks.filter(t => t.slot !== null);
  parts.push(new TextEncoder().encode('OMNI')); u8(1, tones.length, tracks.length);
  for (const {t, i} of tones) {
    const ss = t.samples.map((s, n) => ({s, n})).filter(x => x.s);
    u8(i, t.mode === 'pitch' ? 0 : 1, ss.length);
    for (const {s, n} of ss) { u8(n); u32(s.bytes.byteLength); parts.push(new Uint8Array(s.bytes)); }
  }
  for (const t of tracks) { u8(t.slot); u32(t.bytes.byteLength); parts.push(new Uint8Array(t.bytes)); }
  const body = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0;
  for (const p of parts) { body.set(p, o); o += p.length; }
  const out = new Uint8Array(body.length + 4); out.set(body); new DataView(out.buffer).setUint32(body.length, crc32(body), true);
  return out;
}

/* ===== Device transport (Web Serial) ===== */
function setConn(on) {
  $('#status').classList.toggle('on', on); $('#status-text').textContent = on ? 'Omnitone connected via USB' : 'Not connected';
  $('#btn-connect').hidden = on; $('#btn-disconnect').hidden = !on; renderSend();
}
async function connect() {
  if (!('serial' in navigator)) return notify('err', 'This browser can’t connect to USB devices. Use Chrome or Edge on a desktop computer.');
  try { port = await navigator.serial.requestPort(); await port.open({baudRate: CFG.BAUD}); setConn(true); }
  catch (e) { port = null; if (e.name !== 'NotFoundError') notify('err', 'Could not open the device. Unplug it, plug it back in, and try again.'); }
}
async function disconnect() { try { await port.close(); } catch {} port = null; setConn(false); }
async function readLine(ms) {
  const r = port.readable.getReader(), dec = new TextDecoder(); let s = '';
  const timeout = new Promise(res => setTimeout(() => res({done: true}), ms));
  try { while (!s.includes('\n')) { const {value, done} = await Promise.race([r.read(), timeout]); if (done) break; s += dec.decode(value); } }
  finally { r.releaseLock(); }
  return s.trim();
}
function progress(label, pct) {
  $('#progress').hidden = false; $('#prog-label').textContent = label; $('#pct').textContent = pct + '%';
  $('#prog-bar').setAttribute('aria-valuenow', pct); $('#prog-bar').firstElementChild.style.width = pct + '%';
}
async function send() {
  const data = buildBundle(); sending = true; renderSend();
  const writer = port.writable.getWriter();
  try {
    await writer.write(new TextEncoder().encode(`OMNI_UPLOAD ${data.length}\n`));
    for (let o = 0; o < data.length; o += CFG.CHUNK) { await writer.write(data.subarray(o, o + CFG.CHUNK)); progress('Sending to Omnitone', Math.round(Math.min(o + CFG.CHUNK, data.length) / data.length * 100)); }
    writer.releaseLock();
    const reply = await readLine(10000);
    if (reply.startsWith('OK')) notify('ok', 'Sent. Your Omnitone has the new sounds.');
    else notify('err', reply ? 'The Omnitone reported an error: ' + reply : 'The Omnitone did not confirm the transfer. Check the cable and try again.');
  } catch (e) { try { writer.releaseLock(); } catch {} notify('err', 'The transfer stopped. Check the USB cable and try again.'); }
  sending = false; $('#progress').hidden = true; renderSend();
}

/* ===== Events ===== */
let player;
const play = bytes => { player && player.pause(); player = new Audio(URL.createObjectURL(new Blob([bytes], {type: 'audio/wav'}))); player.play(); };
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const t = lib.tones[ui.tone], i = +b.dataset.i;
  switch (b.dataset.act) {
    case 'note': ui.note = i; renderTones(); break;
    case 'preview': { const s = t.samples[t.mode === 'pitch' ? 0 : ui.note]; s && play(s.bytes); break; }
    case 'clear': t.samples[t.mode === 'pitch' ? 0 : ui.note] = null; save(); render(); break;
    case 'preview-track': play(lib.tracks[i].bytes); break;
    case 'del-track': lib.tracks.splice(i, 1); save(); render(); break;
  }
});
document.addEventListener('change', e => {
  const a = e.target.dataset.act, t = lib.tones[ui.tone];
  if (a === 'tone') { ui.tone = +e.target.value; ui.note = 0; render(); }
  else if (a === 'name') { t.name = e.target.value.trim() || 'Tone ' + (ui.tone + 1); save(); render(); }
  else if (a === 'slot') { const v = e.target.value === '' ? null : +e.target.value; lib.tracks.forEach(x => { if (v !== null && x.slot === v) x.slot = null; }); lib.tracks[+e.target.dataset.i].slot = v; save(); render(); }
  else if (e.target.name === 'mode') { t.mode = e.target.value; ui.note = 0; save(); render(); }
});
$('#btn-browse').onclick = () => $('#file').click();
$('#file').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
const drop = $('#drop');
['dragenter', 'dragover'].forEach(n => drop.addEventListener(n, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(n => drop.addEventListener(n, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => addFiles([...e.dataTransfer.files]));
$('#btn-connect').onclick = connect; $('#btn-disconnect').onclick = disconnect; $('#btn-send').onclick = send;
if ('serial' in navigator) navigator.serial.addEventListener('disconnect', () => { port = null; setConn(false); });

/* ===== Start ===== */
(async () => {
  try { const saved = await DB.get('library'); if (saved) lib = saved; } catch {}
  if (!('serial' in navigator)) notify('warn', 'Connecting to the Omnitone needs desktop Chrome or Edge. You can still build your library here.');
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  render(); route();
})();
