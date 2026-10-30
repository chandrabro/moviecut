import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

const $ = (id) => document.getElementById(id);
const CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
let file = null, duration = 0, ffmpeg = null, busy = false;

const pad = (n) => String(n).padStart(2, '0');
function fmt(s, sep = ':') {
  s = Math.round(s);
  return pad(Math.floor(s / 3600)) + sep + pad(Math.floor((s % 3600) / 60)) + sep + pad(s % 60);
}

// Each part is `interval` long and starts `overlap` seconds before the previous part ended.
function plan(total, interval, overlap) {
  const parts = [];
  let start = 0;
  while (start < total) {
    const end = Math.min(start + interval, total);
    parts.push({ start, end });
    if (end >= total) break;
    start = end - overlap;
  }
  return parts;
}


// ---- Minimal ZIP writer (store only, no compression; video is already compressed) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function buildZip(entries) {
  const enc = new TextEncoder();
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const chunks = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true); lh.setUint16(10, time, true); lh.setUint16(12, date, true);
    lh.setUint32(14, e.crc, true); lh.setUint32(18, e.size, true); lh.setUint32(22, e.size, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    chunks.push(lh.buffer, name, e.blob);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, time, true); ch.setUint16(14, date, true);
    ch.setUint32(16, e.crc, true); ch.setUint32(20, e.size, true); ch.setUint32(24, e.size, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + e.size;
  }
  const cdSize = central.reduce((n, b) => n + (b.byteLength ?? b.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end.buffer], { type: 'application/zip' });
}
let zipEntries = [], zipName = 'parts.zip';

function readInputs() {
  const interval = parseFloat($('interval').value) * 60;
  const overlap = parseFloat($('overlap').value);
  let err = '';
  if (!(interval > 0)) err = 'Enter a part length greater than 0.';
  else if (!(overlap >= 0)) err = 'Overlap cannot be negative.';
  else if (overlap >= interval) err = 'Overlap must be shorter than the part length.';
  return { interval, overlap, err };
}

function renderPlan() {
  if (!duration) return;
  const { interval, overlap, err } = readInputs();
  $('err').hidden = !err;
  $('err').textContent = err;
  $('go').disabled = !!err || busy;
  const box = $('plan');
  box.innerHTML = '';
  if (err) return;
  const parts = plan(duration, interval, overlap);
  const wrap = document.createElement('div');
  wrap.className = 'tl';
  parts.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'seg';
    row.title = `Part ${i + 1}: ${fmt(p.start)} – ${fmt(p.end)}`;
    row.innerHTML = `<i style="left:${(p.start / duration) * 100}%;width:${((p.end - p.start) / duration) * 100}%"></i>`;
    if (i > 0) {
      const o = parts[i - 1].end - p.start;
      row.innerHTML += `<b style="left:${(p.start / duration) * 100}%;width:${(o / duration) * 100}%"></b>`;
    }
    wrap.appendChild(row);
  });
  const text = document.createElement('p');
  text.className = 'note';
  text.textContent = `${parts.length} parts: ` + parts.map((p, i) => `${i + 1}) ${fmt(p.start)}–${fmt(p.end)}`).join('   ');
  box.append(wrap, text);
}

function setFile(f) {
  if (!f) return;
  file = f;
  $('dropText').textContent = f.name;
  const url = URL.createObjectURL(f);
  const v = document.createElement('video');
  v.preload = 'metadata';
  v.onloadedmetadata = () => {
    duration = v.duration;
    URL.revokeObjectURL(url);
    $('info').hidden = false;
    $('info').textContent = `Length ${fmt(duration)}, size ${(f.size / 1048576).toFixed(0)} MB`;
    $('settings').hidden = false;
    $('out').innerHTML = '';
    renderPlan();
  };
  v.onerror = () => {
    $('info').hidden = false;
    $('info').textContent = "This browser can't read that video's length. Try an MP4 or WebM file.";
  };
  v.src = url;
}

$('file').addEventListener('change', (e) => setFile(e.target.files[0]));
const drop = $('drop');
['dragover', 'dragenter'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('on'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('on'); }));
drop.addEventListener('drop', (e) => setFile(e.dataTransfer.files[0]));
['interval', 'overlap'].forEach((id) => $(id).addEventListener('input', renderPlan));

async function loadFFmpeg() {
  if (ffmpeg) return ffmpeg;
  ffmpeg = new FFmpeg();
  $('status').textContent = 'Loading video engine (first time only)...';
  await ffmpeg.load({
    coreURL: await toBlobURL(`${CORE}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${CORE}/ffmpeg-core.wasm`, 'application/wasm'),
  });
  return ffmpeg;
}

$('go').addEventListener('click', async () => {
  const { interval, overlap, err } = readInputs();
  if (err || !file) return;
  busy = true;
  $('go').disabled = true;
  $('out').innerHTML = '';
  $('zip').hidden = true;
  zipEntries = [];
  $('bar').hidden = false;
  $('bar').value = 0;
  try {
    const ff = await loadFFmpeg();
    const precise = $('precise').checked;
    const ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
    const base = file.name.replace(/\.[^.]+$/, '');
    const inName = 'input.' + ext;
    const outExt = precise ? 'mp4' : ext;

    // Mount the file directly so a long video is not copied into memory.
    try { await ff.unmount('/in'); } catch {}
    try { await ff.deleteDir('/in'); } catch {}
    await ff.createDir('/in');
    await ff.mount('WORKERFS', { files: [new File([file], inName)] }, '/in');

    const parts = plan(duration, interval, overlap);
    let cur = 0;
    ff.on('progress', ({ progress }) => {
      $('bar').value = Math.min(1, (cur + Math.max(0, Math.min(1, progress))) / parts.length);
    });

    for (let i = 0; i < parts.length; i++) {
      cur = i;
      const p = parts[i];
      $('status').textContent = `Cutting part ${i + 1} of ${parts.length}...`;
      const outName = `part${i + 1}.${outExt}`;
      const args = ['-ss', String(p.start), '-i', `/in/${inName}`, '-t', String(p.end - p.start)];
      if (precise) args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac');
      else args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
      args.push(outName);
      const code = await ff.exec(args);
      if (code !== 0) throw new Error(`Part ${i + 1} failed. Try "Precise cuts" for this file.`);
      const data = await ff.readFile(outName);
      await ff.deleteFile(outName);
      const blob = new Blob([data], { type: 'video/' + outExt });
      const url = URL.createObjectURL(blob);
      const li = document.createElement('li');
      const dl = `${base}_part${i + 1}_${fmt(p.start, '-')}_to_${fmt(p.end, '-')}.${outExt}`;
      li.innerHTML = `<span>Part ${i + 1}: ${fmt(p.start)} – ${fmt(p.end)}</span>`;
      const a = document.createElement('a');
      a.href = url; a.download = dl; a.textContent = 'Download';
      li.appendChild(a);
      zipEntries.push({ name: dl, blob, crc: crc32(data), size: data.length });
      $('out').appendChild(li);
    }
    zipName = `${base}_parts.zip`;
    $('zip').hidden = false;
    $('bar').value = 1;
    $('status').textContent = 'Done. Download each part below, or all at once as a ZIP.';
  } catch (e) {
    console.error(e);
    $('status').textContent = '';
    $('err').hidden = false;
    $('err').textContent = e.message || 'Something went wrong. Try a smaller file or enable Precise cuts.';
  } finally {
    busy = false;
    $('go').disabled = false;
  }
});

$('zip').addEventListener('click', () => {
  if (!zipEntries.length) return;
  const url = URL.createObjectURL(buildZip(zipEntries));
  const a = document.createElement('a');
  a.href = url; a.download = zipName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
});
