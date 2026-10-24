'use strict';
/* Cupra / VW Group EU-Data-Act-Export – lokale Visualisierung.
 * Die Exportdateien enthalten Datensätze {key, dataFieldName, value} ohne eigene Zeitangabe;
 * Werte lassen sich daher nur der jeweiligen Datei (dem Export) zuordnen. */

// ---------- Hilfsfunktionen ----------
const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const dtf = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'medium' });
const dtfShort = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtDate = d => (d instanceof Date && !isNaN(d)) ? dtf.format(d) : '–';
const fmtShort = d => (d instanceof Date && !isNaN(d)) ? dtfShort.format(d) : '–';
const lastSeg = f => f.split('.').pop();
const isTimeField = f => /(time|timestamp)$/i.test(lastSeg(f));
// Felder, deren Zeitwert den Erfassungszeitpunkt einer Meldung beschreibt (keine Prognosen)
const isCaptureField = f => /(captured_time|captured_utc_timestamp)$/.test(f) || lastSeg(f) === 'timestamp';
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}
const store = {
  get(k, d) { try { const v = localStorage.getItem('cupraviz.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cupraviz.' + k, JSON.stringify(v)); } catch { /* egal */ } },
};

// ---------- Zustand ----------
const state = {
  files: [],                 // geladene Exporte
  tab: 'overview',
  hideVin: store.get('hideVin', false),
  timeBase: store.get('timeBase', 'data'),   // 'data' = letzte Meldezeit, 'export' = Exportzeit aus Dateiname
  selectedFile: null,
  charts: [],
};

// ---------- Werte interpretieren ----------
function parseValue(field, raw) {
  const s = String(raw ?? '').trim();
  if (s === 'true' || s === 'false') return { t: 'bool', v: s === 'true', raw: s };
  if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(s)) {
    const n = Number(s);
    if (isTimeField(field) && Math.abs(n) > 1e11) return { t: 'date', v: new Date(n), raw: s };
    return { t: 'num', v: n, raw: s };
  }
  const dur = s.match(/^(-?\d+(?:\.\d+)?)s$/);
  if (dur) return { t: 'num', v: Number(dur[1]), raw: s };
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d)) return { t: 'date', v: d, raw: s };
  }
  return { t: 'str', v: s, raw: s };
}

function prettyName(field) {
  const seg = field.split('.').slice(-2).join(' · ').replace(/_/g, ' ');
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}
const meta = f => FIELD_META[f] || { label: prettyName(f), group: guessGroup(f) };
function guessGroup(f) {
  if (/^setup_real_speed_ratios/.test(f)) return 'Geschwindigkeitsprofil';
  if (/charg/.test(f)) return 'Laden';
  if (/clima/.test(f)) return 'Klima';
  if (/battery|energy/.test(f)) return 'Batterie';
  if (isTimeField(f)) return 'Zeit';
  return 'Sonstiges';
}

function enumLabel(s) {
  if (ENUM_DE[s]) return ENUM_DE[s];
  if (!/^[A-Z0-9_]+$/.test(s) || !s.includes('_')) return s;
  // Unbekannte Aufzählung: übliche Präfixe abschneiden und lesbar machen
  const t = s.replace(/^(CHARGE_STATE|CHARGE_TYPE|CHARGE_MODE_SELECTION|CHARGE_MODE|CHARGING_SCENARIO|CLIMATISATION_STATE|WINDOW_HEATING_STATE|UPDATE_REASON|REPORT_TYPE|IMMEDIATE_ACTION_STATE|TARGET_REACHABILITY|TRIGGER|MAX_CHARGE_CURRENT_AC|AUTO_UNLOCK_AC|VALUE_TYPE|CHARGE_RATE_UNIT)_/, '')
    .toLowerCase().replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function scaled(field, n) { const m = meta(field); return m.scale ? n * m.scale : n; }
function fmtNum(field, n, withUnit = true) {
  const m = meta(field);
  const v = scaled(field, n);
  const s = (m.unit === 'min' ? nf0 : nf).format(v);
  return withUnit && m.unit ? `${s} ${m.unit}` : s;
}
function fmtParsed(field, p) {
  switch (p.t) {
    case 'num': return fmtNum(field, p.v);
    case 'bool': return p.v ? 'ja' : 'nein';
    case 'date': return fmtDate(p.v);
    default: return enumLabel(p.v);
  }
}

// ---------- Dateien einlesen ----------
function findRecords(json) {
  const isRec = o => o && typeof o === 'object' && 'dataFieldName' in o;
  if (Array.isArray(json) && json.some(isRec)) return json.filter(isRec);
  if (json && typeof json === 'object') {
    for (const k of ['Data', 'data', 'records', 'items']) {
      if (Array.isArray(json[k]) && json[k].some(isRec)) return json[k].filter(isRec);
    }
    // tiefer suchen
    for (const v of Object.values(json)) {
      if (v && typeof v === 'object') { const r = findRecords(v); if (r && r.length) return r; }
    }
  }
  return null;
}
// Fallback für andere JSON-Formen: Objekt flach klopfen
function flatten(obj, prefix = '', out = []) {
  if (Array.isArray(obj)) obj.forEach((v, i) => flatten(v, `${prefix}${i}.`, out));
  else if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) flatten(v, `${prefix}${k}.`, out);
  else out.push({ dataFieldName: prefix.slice(0, -1), value: obj });
  return out;
}

function exportTimeFromName(name) {
  const m = name.match(/_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?!\d)/);
  return m ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}
function vinFromName(name) {
  const m = name.split(/[\\/]/).pop().match(/^([A-HJ-NPR-Z0-9]{17})_/i);
  return m ? m[1].toUpperCase() : null;
}

function buildFile({ name, text, source }) {
  const base = { id: source + '|' + name + '|' + text.length, name, source, text, empty: false, error: null };
  if (/no_content_found/i.test(name) || !text.trim()) return { ...base, empty: true, records: [], byField: new Map() };
  let recs = [], vin = vinFromName(name), userId = null;
  try {
    if (/\.csv$/i.test(name)) recs = parseCsv(text);
    else {
      const json = JSON.parse(text);
      vin = json.vin || json.VIN || vin;
      userId = json.user_id || null;
      recs = findRecords(json) ?? flatten(json).filter(r => !/^(vin|user_id)$/i.test(r.dataFieldName));
    }
  } catch (e) {
    return { ...base, error: 'Konnte nicht gelesen werden: ' + e.message, records: [], byField: new Map() };
  }
  const records = recs.map(r => {
    const f = String(r.dataFieldName ?? r.field ?? r.name ?? '').trim();
    const raw = typeof r.value === 'object' && r.value !== null ? JSON.stringify(r.value) : r.value;
    return { f, raw: raw == null ? '' : String(raw), p: parseValue(f, raw), key: r.key || null };
  }).filter(r => r.f);
  const byField = new Map();
  for (const r of records) { if (!byField.has(r.f)) byField.set(r.f, []); byField.get(r.f).push(r.p); }

  const exportTime = exportTimeFromName(name);
  // Zeitraum der enthaltenen Meldungen
  let minT = null, maxT = null;
  for (const r of records) {
    if (r.p.t !== 'date' || !isCaptureField(r.f)) continue;
    const t = r.p.v.getTime();
    if (exportTime && t > exportTime.getTime() + 86400e3) continue; // Ausreißer in der Zukunft ignorieren
    if (minT === null || t < minT) minT = t;
    if (maxT === null || t > maxT) maxT = t;
  }
  return {
    ...base, vin, userId, records, byField, exportTime,
    dataFrom: minT !== null ? new Date(minT) : null,
    dataTo: maxT !== null ? new Date(maxT) : null,
    empty: records.length === 0,
  };
}

function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  const delim = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = (rows.shift() || []).map(h => h.trim());
  const fi = head.findIndex(h => /^(dataFieldName|field|name)$/i.test(h));
  const vi = head.findIndex(h => /^value$/i.test(h));
  if (fi >= 0 && vi >= 0) return rows.filter(r => r[fi]).map(r => ({ dataFieldName: r[fi], value: r[vi] }));
  const out = [];
  for (const r of rows) head.forEach((h, i) => { if (h && r[i] !== undefined && r[i] !== '') out.push({ dataFieldName: h, value: r[i] }); });
  return out;
}

// Liefert [{name, text, source}] aus einer Datei (ZIP wird entpackt, auch verschachtelt)
async function readAny(file, name = file.name, source = 'Datei') {
  if (/\.zip$/i.test(name)) {
    const zip = await JSZip.loadAsync(file);
    const out = [];
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const n = entry.name;
      if (/\.zip$/i.test(n)) out.push(...await readAny(await entry.async('blob'), n, name));
      else if (/\.(json|csv)$/i.test(n) || /no_content_found/i.test(n)) out.push({ name: n, text: await entry.async('string'), source: name });
    }
    if (!out.length) out.push({ name: name + ' (leer)', text: '', source: name });
    return out;
  }
  if (/\.(json|csv)$/i.test(name) || /no_content_found/i.test(name)) return [{ name, text: await file.text(), source }];
  return [];
}

async function addFiles(fileList) {
  const list = [...fileList];
  if (!list.length) return;
  let added = 0, dup = 0, empty = 0, err = 0, skipped = 0;
  const known = new Set(state.files.map(f => f.id));
  for (const file of list) {
    let parts;
    try { parts = await readAny(file, file.webkitRelativePath || file.name); }
    catch (e) { err++; console.error(e); continue; }
    if (!parts.length) { skipped++; continue; }
    for (const part of parts) {
      const f = buildFile(part);
      if (known.has(f.id)) { dup++; continue; }
      known.add(f.id);
      state.files.push(f);
      if (f.error) err++; else if (f.empty) empty++; else added++;
      db.put(part);
    }
  }
  const msg = [`${added} Export${added === 1 ? '' : 'e'} geladen`];
  if (empty) msg.push(`${empty} leer`);
  if (dup) msg.push(`${dup} bereits vorhanden`);
  if (err) msg.push(`${err} fehlerhaft`);
  if (skipped) msg.push(`${skipped} übersprungen`);
  toast(msg.join(' · '));
  state.selectedFile = null;
  render();
}

// ---------- Speicherung im Browser (IndexedDB) ----------
const db = {
  _p: null,
  open() {
    if (this._p) return this._p;
    this._p = new Promise((res, rej) => {
      try {
        const r = indexedDB.open('cupra-viz', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'id' });
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
    return this._p;
  },
  async tx(mode, fn) {
    try {
      const d = await this.open();
      return await new Promise((res, rej) => {
        const t = d.transaction('files', mode); const s = t.objectStore('files');
        const out = fn(s); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error);
      });
    } catch (e) { console.warn('Speicher nicht verfügbar', e); return null; }
  },
  put(part) { return this.tx('readwrite', s => s.put({ id: part.source + '|' + part.name + '|' + part.text.length, ...part })); },
  del(id) { return this.tx('readwrite', s => s.delete(id)); },
  clear() { return this.tx('readwrite', s => s.clear()); },
  all() { return this.tx('readonly', s => s.getAll()); },
};

// ---------- Auswertung ----------
const fileTime = f => state.timeBase === 'export' ? (f.exportTime || f.dataTo) : (f.dataTo || f.exportTime);
const sortedFiles = () => state.files.filter(f => !f.empty && !f.error).sort((a, b) => (fileTime(a)?.getTime() ?? 0) - (fileTime(b)?.getTime() ?? 0));

function fieldIndex() {
  const idx = new Map();
  for (const file of state.files) for (const [f, vals] of file.byField) {
    if (!idx.has(f)) idx.set(f, { f, count: 0, files: new Set(), types: {}, values: new Map() });
    const e = idx.get(f);
    e.files.add(file.id);
    for (const p of vals) {
      e.count++; e.types[p.t] = (e.types[p.t] || 0) + 1;
      e.values.set(p.raw, (e.values.get(p.raw) || 0) + 1);
    }
  }
  for (const e of idx.values()) {
    const ts = Object.keys(e.types);
    e.kind = ts.length === 1 ? ts[0] : 'str';
  }
  return idx;
}

// Zusammenfassung eines Feldes innerhalb einer Datei
function summary(file, field) {
  const vals = file?.byField.get(field);
  if (!vals || !vals.length) return null;
  const nums = vals.filter(p => p.t === 'num').map(p => p.v);
  const distinct = [...new Map(vals.map(p => [p.raw, p])).values()];
  const s = { vals, distinct, nums };
  if (nums.length === vals.length) {
    s.min = Math.min(...nums); s.max = Math.max(...nums);
    const sorted = [...nums].sort((a, b) => a - b);
    s.median = sorted[Math.floor((sorted.length - 1) / 2)];
  }
  return s;
}

function displaySummary(field, s, { prefer } = {}) {
  if (!s) return null;
  if (s.min !== undefined) {
    if (prefer === 'max' || s.min === s.max) return fmtNum(field, prefer === 'max' ? s.max : s.min);
    const m = meta(field);
    return `${fmtNum(field, s.min, false)}–${fmtNum(field, s.max, false)}${m.unit ? ' ' + m.unit : ''}`;
  }
  return s.distinct.map(p => fmtParsed(field, p)).join(' / ');
}

// ---------- Rendering ----------
function maskVin(v) { if (!v) return '–'; return state.hideVin ? v.slice(0, 3) + '•'.repeat(Math.max(0, v.length - 3)) : v; }

function destroyCharts() { state.charts.forEach(c => c.destroy()); state.charts = []; }

function render() {
  const has = state.files.length > 0;
  $('#empty').hidden = has;
  $('#tabs').hidden = !has;
  $('#vinToggle').textContent = state.hideVin ? 'FIN anzeigen' : 'FIN ausblenden';
  const vins = [...new Set(state.files.map(f => f.vin).filter(Boolean))];
  const fs = sortedFiles();
  $('#vehicleLine').textContent = has
    ? `${vins.length ? 'FIN ' + vins.map(maskVin).join(', ') : 'FIN unbekannt'} · ${fs.length} Export${fs.length === 1 ? '' : 'e'}` +
      (fs.length > 1 ? ` · ${fmtShort(fileTime(fs[0]))} – ${fmtShort(fileTime(fs[fs.length - 1]))}` : fs.length ? ` · ${fmtShort(fileTime(fs[0]))}` : '')
    : 'EU Data Act · lokal im Browser';
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
  for (const v of ['overview', 'history', 'activity', 'raw', 'files']) $('#view-' + v).hidden = !has || v !== state.tab;
  destroyCharts();
  if (!has) return;
  ({ overview: renderOverview, history: renderHistory, activity: renderActivity, raw: renderRaw, files: renderFiles })[state.tab]();
}

// ----- Übersicht -----
function renderOverview() {
  const el = $('#view-overview');
  const fs = sortedFiles();
  if (!fs.length) { el.innerHTML = `<div class="hint">Die geladenen Dateien enthalten keine Daten (z.&nbsp;B. <span class="mono">_no_content_found</span>).</div>`; return; }
  const file = fs.find(f => f.id === state.selectedFile) || fs[fs.length - 1];
  const S = f => summary(file, f);
  const opts = [...fs].reverse().map(f => `<option value="${esc(f.id)}" ${f === file ? 'selected' : ''}>${esc(fmtDate(fileTime(f)))} – ${esc(f.name.split(/[\\/]/).pop())}</option>`).join('');

  // Batterie
  const soc = S('battery_state_report.soc') || S('battery_level_HV.value');
  const socField = S('battery_state_report.soc') ? 'battery_state_report.soc' : 'battery_level_HV.value';
  const target = S('settings.target_soc'), care = S('battery_care_mode.charge_bcam_threshold');
  const eCur = S('energy_contents.current_energy_content.physical_value'), eMax = S('energy_contents.maximal_energy_content.physical_value');

  let hero = '';
  if (soc) {
    const lo = soc.min, hi = soc.max;
    const marks = [];
    if (target) marks.push(`<div class="battery-mark" style="left:${target.max}%" title="Ziel-Ladestand"><span>Ziel ${nf.format(target.max)}&nbsp;%</span></div>`);
    if (care && (!target || care.max !== target.max)) marks.push(`<div class="battery-mark" style="left:${care.max}%;opacity:.5" title="Batterieschonung"><span>Schonung ${nf.format(care.max)}&nbsp;%</span></div>`);
    hero = `<div class="card kpi hero">
      <div class="label">Ladestand</div>
      <div class="value">${lo === hi ? nf.format(lo) : nf.format(lo) + '–' + nf.format(hi)}<small>%</small></div>
      <div class="note">${soc.nums.length > 1 ? `${soc.nums.length} Meldungen in diesem Export: ${soc.nums.map(n => nf.format(n)).join(' · ')} %` : 'eine Meldung in diesem Export'}</div>
      <div class="battery">
        <div class="battery-bar" role="img" aria-label="Ladestand ${lo} bis ${hi} Prozent">
          <div class="battery-fill" style="width:${lo}%"></div>
          ${hi > lo ? `<div class="battery-range" style="left:${lo}%;width:${hi - lo}%"></div>` : ''}
          ${marks.join('')}
        </div>
        <div class="battery-scale"><span>0</span><span>50</span><span>100&nbsp;%</span></div>
      </div>
    </div>`;
  }

  const tile = (field, { label, prefer, extra } = {}) => {
    const s = S(field);
    if (!s) return '';
    const m = meta(field);
    const txt = displaySummary(field, s, { prefer });
    const [num, ...unit] = txt.split(' ');
    const multi = s.distinct.length > 1 && prefer !== 'max';
    const note = extra || (multi ? `${s.vals.length} Meldungen` : (m.note || ''));
    return `<div class="card kpi" title="${esc(field)}${m.note ? ' – ' + esc(m.note) : ''}">
      <div class="label">${esc(label || m.label)}</div>
      <div class="value">${esc(num)}${unit.length ? `<small>${esc(unit.join(' '))}</small>` : ''}</div>
      <div class="note">${esc(note)}</div></div>`;
  };

  let energyExtra = '';
  if (eCur && eMax) energyExtra = `von ${fmtNum('energy_contents.maximal_energy_content.physical_value', eMax.max)} (≈ ${nf0.format(eCur.max / eMax.max * 100)} %)`;

  const tiles = [
    tile('energy_contents.current_energy_content.physical_value', { extra: energyExtra }),
    tile('mileage.value', { prefer: 'max' }),
    tile('battery_state_report.charge_power'),
    tile('battery_state_report.charge_rate'),
    tile('battery_state_report.remaining_charging_time_complete'),
    tile('battery_state_report.charge_energy'),
    tile('outdoor_temperature'),
    tile('min_temperature'),
    tile('max_temperature'),
    tile('remaining_climate_time'),
  ].join('');

  // Status
  const statusFields = ['charging_state_report.current_charge_state', 'charging_state_report.charge_type', 'charging_state_report.charge_mode',
    'charging_state_report.charging_scenario', 'climatisation_state', 'window_heating_state', 'locked', 'open',
    'parking_light_left', 'parking_light_right', 'update_reason'];
  const chips = statusFields.map(f => {
    const s = S(f); if (!s) return '';
    const vals = s.distinct.map(p => {
      const tone = p.t === 'str' ? ENUM_TONE[p.v] : (f === 'locked' ? (p.v ? 'good' : 'warn') : null);
      return `<span><span class="dot ${tone || ''}"></span>${esc(fmtParsed(f, p))}</span>`;
    });
    return `<div class="chip" title="${esc(f)}"><span class="k">${esc(meta(f).label)}</span><span class="v">${vals.join('<span class="alt"> / </span>')}</span></div>`;
  }).join('');

  const kvBlock = (title, fields) => {
    const rows = fields.map(f => { const s = S(f); return s ? `<div title="${esc(f)}">${esc(meta(f).label)}</div><div>${esc(displaySummary(f, s))}</div>` : ''; }).join('');
    return rows ? `<div class="card"><div class="card-head"><h3>${esc(title)}</h3></div><div class="kv">${rows}</div></div>` : '';
  };
  const allFields = [...file.byField.keys()];
  const byGroup = g => allFields.filter(f => meta(f).group === g);

  const range = file.dataFrom ? `${fmtDate(file.dataFrom)} – ${fmtDate(file.dataTo)}` : '–';
  const msgTypes = countBy(file.byField.get('message_id') || [], p => String(p.v).replace(/_\d+$/, ''));

  el.innerHTML = `
    <div class="toolbar">
      <label>Stand <select id="fileSel">${opts}</select></label>
      <span class="muted">Meldungen im Export: ${esc(range)}</span>
    </div>
    ${fs.length === 1 ? '' : ''}
    <div class="hint">Ein Export bündelt mehrere Fahrzeugmeldungen ohne Zuordnung, welcher Wert zu welcher Uhrzeit gehört. Unterscheiden sich Werte innerhalb eines Exports, zeigt die App den <b>Bereich</b> (z.&nbsp;B. 50–56&nbsp;%).</div>
    <div class="grid kpis">${hero}${tiles}</div>
    ${chips ? `<div class="card"><div class="card-head"><h3>Status</h3><span class="muted">mehrere Werte = mehrere Meldungen im Export</span></div><div class="chips">${chips}</div></div>` : ''}
    <div class="grid two">
      ${kvBlock('Ladeeinstellungen', [...byGroup('Laden').filter(f => /^settings\.|battery_care|charge_rate_unit/.test(f)), 'settings.target_soc'].filter((f, i, a) => a.indexOf(f) === i))}
      ${kvBlock('Ladeoptionen', byGroup('Ladeoptionen'))}
      ${kvBlock('Ladetimer', byGroup('Ladetimer'))}
      ${kvBlock('Klima', byGroup('Klima').filter(f => f !== 'climatisation_state' && f !== 'window_heating_state' && f !== 'remaining_climate_time'))}
      ${kvBlock('Verbrauch & Batterie', [...byGroup('Verbrauch'), 'energy_contents.maximal_energy_content.physical_value', 'battery_level_HV.value', 'battery_level_HV.state', 'mileage.state'])}
      <div class="card"><div class="card-head"><h3>Export</h3></div><div class="kv">
        <div>Datei</div><div class="mono">${esc(file.name.split(/[\\/]/).pop())}</div>
        <div>FIN</div><div class="mono">${esc(maskVin(file.vin))}</div>
        <div>Exportzeit (Dateiname, UTC)</div><div>${esc(fmtDate(file.exportTime))}</div>
        <div>Erste Meldung</div><div>${esc(fmtDate(file.dataFrom))}</div>
        <div>Letzte Meldung</div><div>${esc(fmtDate(file.dataTo))}</div>
        <div>Datensätze / Felder</div><div>${file.records.length} / ${file.byField.size}</div>
      </div>
      ${msgTypes.length ? `<div style="margin-top:12px">${msgTypes.map(([k, n]) => `<span class="tag" title="Nachrichtentyp">${esc(k)} ×${n}</span>`).join('')}</div>` : ''}
      </div>
    </div>`;
  $('#fileSel').onchange = e => { state.selectedFile = e.target.value; render(); };
}

function countBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) { const k = keyFn(x); m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// ----- Diagramm-Grundlagen -----
function chartBase() {
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = css('--muted');
  Chart.defaults.borderColor = css('--grid');
  Chart.defaults.locale = 'de-DE';
}
function timeScale(span) {
  return {
    type: 'time',
    time: { tooltipFormat: 'dd.MM.yyyy HH:mm', displayFormats: { minute: 'HH:mm', hour: 'dd.MM. HH:mm', day: 'dd.MM.', week: 'dd.MM.', month: 'MMM yyyy' } },
    grid: { color: css('--grid') },
    ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
    ...(span || {}),
  };
}
const zoomOpts = { zoom: { wheel: { enabled: true, modifierKey: 'ctrl' }, pinch: { enabled: true }, drag: { enabled: true, backgroundColor: 'rgba(176,112,62,.15)' }, mode: 'x' }, pan: { enabled: true, mode: 'x', modifierKey: 'shift' } };

// ----- Verlauf -----
const DEFAULT_SERIES = ['battery_state_report.soc', 'mileage.value', 'battery_state_report.charge_power', 'energy_contents.current_energy_content.physical_value', 'outdoor_temperature'];

function renderHistory() {
  chartBase();
  const el = $('#view-history');
  const fs = sortedFiles();
  const idx = fieldIndex();
  const numFields = [...idx.values()].filter(e => e.kind === 'num').map(e => e.f)
    .sort((a, b) => (meta(a).group + meta(a).label).localeCompare(meta(b).group + meta(b).label, 'de'));
  const enumFields = [...idx.values()].filter(e => e.kind === 'str' || e.kind === 'bool').map(e => e.f)
    .filter(f => !/(message_id|transaction_id|value_type)$/.test(f));
  let sel = store.get('series', DEFAULT_SERIES).filter(f => numFields.includes(f));
  if (!sel.length) sel = numFields.filter(f => DEFAULT_SERIES.includes(f));
  let enumSel = store.get('enumSeries', 'charging_state_report.current_charge_state');
  if (!enumFields.includes(enumSel)) enumSel = enumFields[0];

  const groups = new Map();
  for (const f of numFields) { const g = meta(f).group; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(f); }

  el.innerHTML = `
    ${fs.length < 2 ? `<div class="hint"><b>Für Verläufe mehrere Exporte laden.</b> Aktuell ist ${fs.length} Export mit Daten geladen. Mit einer fortlaufenden Anfrage im Portal entsteht etwa alle 15&nbsp;Minuten eine Datei – lade einfach den ganzen Ordner oder alle ZIPs auf einmal.</div>` : ''}
    <div class="card">
      <div class="card-head"><h3>Messgrößen</h3>
        <div class="toolbar">
          <label>Zeitachse <select id="timeBase">
            <option value="data" ${state.timeBase === 'data' ? 'selected' : ''}>letzte Meldung im Export</option>
            <option value="export" ${state.timeBase === 'export' ? 'selected' : ''}>Exportzeit (Dateiname)</option>
          </select></label>
          <span class="muted">Zoom: Bereich ziehen · Doppelklick zurücksetzen</span>
        </div>
      </div>
      ${[...groups].map(([g, fl]) => `<div style="margin-bottom:8px"><div class="muted" style="font-size:12px;margin-bottom:4px">${esc(g)}</div><div class="picker">${fl.map(f => `<label title="${esc(f)}"><input type="checkbox" value="${esc(f)}" ${sel.includes(f) ? 'checked' : ''}>${esc(meta(f).label)}</label>`).join('')}</div></div>`).join('')}
    </div>
    <div class="grid two" id="seriesGrid"></div>
    ${enumSel ? `<div class="card">
      <div class="card-head"><h3>Statusverlauf</h3>
        <select id="enumSel">${enumFields.map(f => `<option value="${esc(f)}" ${f === enumSel ? 'selected' : ''}>${esc(meta(f).label)}</option>`).join('')}</select>
      </div>
      <div class="chart-box"><canvas id="enumChart"></canvas></div>
    </div>` : ''}`;

  el.querySelectorAll('.picker input').forEach(cb => cb.onchange = () => {
    store.set('series', [...el.querySelectorAll('.picker input:checked')].map(i => i.value)); render();
  });
  $('#timeBase').onchange = e => { state.timeBase = e.target.value; store.set('timeBase', state.timeBase); render(); };
  if ($('#enumSel')) $('#enumSel').onchange = e => { store.set('enumSeries', e.target.value); render(); };

  const grid = $('#seriesGrid');
  const colors = [css('--series-1'), css('--series-2'), css('--series-3'), css('--series-4')];
  sel.forEach((f, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    const m = meta(f);
    card.innerHTML = `<div class="card-head"><h2>${esc(m.label)}${m.unit ? ` <span class="muted">(${esc(m.unit)})</span>` : ''}</h2><span class="muted mono" style="font-size:11px">${esc(f)}</span></div><div class="chart-box"><canvas></canvas></div>`;
    grid.appendChild(card);
    const pts = [];
    for (const file of fs) {
      const s = summary(file, f); const t = fileTime(file);
      if (!s || s.min === undefined || !t) continue;
      pts.push({ x: t.getTime(), min: scaled(f, s.min), max: scaled(f, s.max), med: scaled(f, s.median), n: s.nums.length, file: file.name });
    }
    const color = colors[i % colors.length];
    const band = color + '33';
    const chart = new Chart(card.querySelector('canvas'), {
      type: 'line',
      data: {
        datasets: [
          { label: 'Max', data: pts.map(p => ({ x: p.x, y: p.max })), borderWidth: 0, pointRadius: 0, fill: '+1', backgroundColor: band },
          { label: 'Min', data: pts.map(p => ({ x: p.x, y: p.min })), borderWidth: 0, pointRadius: 0, fill: false },
          { label: m.label, data: pts.map(p => ({ x: p.x, y: p.med, _p: p })), borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: pts.length > 60 ? 0 : 3, pointHoverRadius: 5, tension: 0.15, stepped: false },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, parsing: true,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: { x: timeScale(), y: { grid: { color: css('--grid') }, ticks: { callback: v => nf.format(v) } } },
        plugins: {
          legend: { display: false },
          zoom: zoomOpts,
          tooltip: {
            filter: it => it.datasetIndex === 2,
            callbacks: {
              label: it => {
                const p = it.raw._p; const u = m.unit ? ' ' + m.unit : '';
                return p.min === p.max ? `${nf.format(p.med)}${u}` : `${nf.format(p.min)}–${nf.format(p.max)}${u} (${p.n} Meldungen)`;
              },
              afterLabel: it => it.raw._p.file.split(/[\\/]/).pop(),
            },
          },
        },
      },
    });
    card.querySelector('canvas').ondblclick = () => chart.resetZoom();
    state.charts.push(chart);
  });
  if (!sel.length) grid.innerHTML = '<div class="muted">Oben Messgrößen auswählen.</div>';

  // Statusverlauf (Kategorien auf der y-Achse)
  if (enumSel) {
    const pts = [], cats = new Set();
    for (const file of fs) {
      const s = summary(file, enumSel); const t = fileTime(file);
      if (!s || !t) continue;
      for (const p of s.distinct) { const lbl = fmtParsed(enumSel, p); cats.add(lbl); pts.push({ x: t.getTime(), y: lbl }); }
    }
    const labels = [...cats];
    const c = new Chart($('#enumChart'), {
      type: 'scatter',
      data: { datasets: [{ data: pts, backgroundColor: css('--series-1'), pointRadius: 5, pointHoverRadius: 7 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        scales: { x: timeScale(), y: { type: 'category', labels, offset: true, grid: { color: css('--grid') } } },
        plugins: { legend: { display: false }, zoom: zoomOpts, tooltip: { callbacks: { label: it => it.raw.y } } },
      },
    });
    $('#enumChart').ondblclick = () => c.resetZoom();
    $('#enumChart').parentElement.style.height = Math.max(200, 60 + labels.length * 36) + 'px';
    state.charts.push(c);
  }
}

// ----- Aktivität -----
function renderActivity() {
  chartBase();
  const el = $('#view-activity');
  const seen = new Set(); const events = [];
  for (const file of state.files) for (const r of file.records) {
    if (r.p.t !== 'date' || !isCaptureField(r.f)) continue;
    const t = r.p.v.getTime();
    const k = r.f + '|' + t;
    if (seen.has(k)) continue; seen.add(k);
    events.push({ t, f: r.f, file: file.name });
  }
  events.sort((a, b) => a.t - b.t);
  // Meldezeitpunkte, die innerhalb von 60 s liegen, als ein Ereignis zusammenfassen
  const bursts = [];
  for (const e of events) {
    const last = bursts[bursts.length - 1];
    if (last && e.t - last.end <= 60e3) { last.end = e.t; last.n++; } else bursts.push({ start: e.t, end: e.t, n: 1 });
  }
  const span = events.length ? events[events.length - 1].t - events[0].t : 0;
  const unit = span > 5 * 86400e3 ? 'day' : 'hour';
  const bucket = t => { const d = new Date(t); if (unit === 'day') d.setHours(0, 0, 0, 0); else d.setMinutes(0, 0, 0); return d.getTime(); };
  const perBucket = countBy(bursts, b => bucket(b.start)).map(([x, y]) => ({ x: +x, y })).sort((a, b) => a.x - b.x);
  const perHour = Array(24).fill(0); bursts.forEach(b => perHour[new Date(b.start).getHours()]++);

  const allMsg = state.files.flatMap(f => f.byField.get('message_id') || []);
  const msgTypes = countBy(allMsg, p => String(p.v).replace(/_\d+$/, ''));
  const reportTypes = countBy(state.files.flatMap(f => f.byField.get('report_type') || []), p => enumLabel(p.v));
  const reasons = countBy(state.files.flatMap(f => f.byField.get('update_reason') || []), p => enumLabel(p.v));
  const bars = list => { const mx = Math.max(1, ...list.map(x => x[1])); return `<div class="bars">${list.map(([k, n]) => `<div class="bar-row"><span class="mono" title="${esc(k)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(k)}</span><div class="bar-track"><div class="bar-fill" style="width:${n / mx * 100}%"></div></div><span class="num muted">${n}</span></div>`).join('')}</div>`; };

  el.innerHTML = `
    <div class="grid kpis">
      <div class="card kpi"><div class="label">Fahrzeug-Aktivitäten</div><div class="value">${bursts.length}</div><div class="note">Meldezeitpunkte, ≤ 60 s zusammengefasst</div></div>
      <div class="card kpi"><div class="label">Einzelne Zeitstempel</div><div class="value">${events.length}</div><div class="note">aus allen Exporten, ohne Duplikate</div></div>
      <div class="card kpi"><div class="label">Erste Meldung</div><div class="value" style="font-size:17px">${esc(events.length ? fmtDate(new Date(events[0].t)) : '–')}</div></div>
      <div class="card kpi"><div class="label">Letzte Meldung</div><div class="value" style="font-size:17px">${esc(events.length ? fmtDate(new Date(events[events.length - 1].t)) : '–')}</div></div>
    </div>
    <div class="card"><div class="card-head"><h3>Aktivität pro ${unit === 'day' ? 'Tag' : 'Stunde'}</h3><span class="muted">Wann hat das Fahrzeug Daten gesendet?</span></div><div class="chart-box"><canvas id="actChart"></canvas></div></div>
    <div class="grid two">
      <div class="card"><div class="card-head"><h3>Tageszeit</h3><span class="muted">Ortszeit</span></div><div class="chart-box"><canvas id="hourChart"></canvas></div></div>
      <div class="card"><div class="card-head"><h3>Nachrichtentypen</h3></div>${bars(msgTypes) || '<span class="muted">keine</span>'}</div>
      ${reportTypes.length ? `<div class="card"><div class="card-head"><h3>Berichtstypen</h3></div>${bars(reportTypes)}</div>` : ''}
      ${reasons.length ? `<div class="card"><div class="card-head"><h3>Update-Gründe</h3></div>${bars(reasons)}</div>` : ''}
    </div>
    <div class="card"><div class="card-head"><h3>Zeitstempel</h3><span class="muted">neueste zuerst</span></div>
      <div class="table-wrap"><table><thead><tr><th>Zeit (Ortszeit)</th><th>Feld</th><th>Datei</th></tr></thead><tbody>
      ${events.slice().reverse().slice(0, 500).map(e => `<tr><td class="num">${esc(fmtDate(new Date(e.t)))}</td><td title="${esc(e.f)}">${esc(meta(e.f).label)}</td><td class="mono">${esc(e.file.split(/[\\/]/).pop())}</td></tr>`).join('')}
      </tbody></table></div></div>`;

  const c1 = new Chart($('#actChart'), {
    type: 'bar',
    data: { datasets: [{ data: perBucket, backgroundColor: css('--series-1'), borderRadius: 3, maxBarThickness: 28 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: { x: timeScale({ time: { unit, tooltipFormat: unit === 'day' ? 'dd.MM.yyyy' : 'dd.MM.yyyy HH:00', displayFormats: { hour: 'dd.MM. HH:mm', day: 'dd.MM.' } }, offset: true }), y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: css('--grid') } } },
      plugins: { legend: { display: false }, zoom: zoomOpts, tooltip: { callbacks: { label: it => `${it.raw.y} Aktivität${it.raw.y === 1 ? '' : 'en'}` } } },
    },
  });
  $('#actChart').ondblclick = () => c1.resetZoom();
  const c2 = new Chart($('#hourChart'), {
    type: 'bar',
    data: { labels: perHour.map((_, h) => String(h).padStart(2, '0')), datasets: [{ data: perHour, backgroundColor: css('--series-2'), borderRadius: 3 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: css('--grid') } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: it => `${it[0].label}:00–${it[0].label}:59 Uhr`, label: it => `${it.raw} Aktivität${it.raw === 1 ? '' : 'en'}` } } },
    },
  });
  state.charts.push(c1, c2);
}

// ----- Rohdaten -----
function renderRaw() {
  const el = $('#view-raw');
  const q = store.get('rawQuery', '');
  const fsel = state.rawFile || 'all';
  const fs = sortedFiles();
  el.innerHTML = `
    <div class="toolbar">
      <input type="search" id="rawSearch" placeholder="Feld oder Wert suchen …" value="${esc(q)}">
      <label>Export <select id="rawFile"><option value="all">alle (${fs.length})</option>${[...fs].reverse().map(f => `<option value="${esc(f.id)}" ${f.id === fsel ? 'selected' : ''}>${esc(fmtDate(fileTime(f)))}</option>`).join('')}</select></label>
      <button class="btn small" id="csvBtn" type="button">Als CSV speichern</button>
      <span class="muted" id="rawCount"></span>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Bezeichnung</th><th>Feld</th><th>Typ</th><th>Werte (Anzahl)</th><th>Exporte</th></tr></thead><tbody id="rawBody"></tbody></table></div>`;
  const kindDe = { num: 'Zahl', bool: 'Ja/Nein', date: 'Zeit', str: 'Text' };
  const fill = () => {
    const query = $('#rawSearch').value.trim().toLowerCase();
    const fid = $('#rawFile').value;
    store.set('rawQuery', query); state.rawFile = fid;
    const saved = state.files;
    const files = fid === 'all' ? saved : saved.filter(f => f.id === fid);
    const idx = new Map();
    for (const file of files) for (const [f, vals] of file.byField) {
      if (!idx.has(f)) idx.set(f, { f, files: new Set(), values: new Map(), types: new Set() });
      const e = idx.get(f); e.files.add(file.id);
      for (const p of vals) { e.types.add(p.t); const cur = e.values.get(p.raw); e.values.set(p.raw, { p, n: (cur?.n || 0) + 1 }); }
    }
    const rows = [...idx.values()]
      .map(e => ({ ...e, label: meta(e.f).label, group: meta(e.f).group }))
      .filter(e => !query || e.f.toLowerCase().includes(query) || e.label.toLowerCase().includes(query) ||
        [...e.values.values()].some(v => v.p.raw.toLowerCase().includes(query) || fmtParsed(e.f, v.p).toLowerCase().includes(query)))
      .sort((a, b) => (a.group + a.label).localeCompare(b.group + b.label, 'de'));
    $('#rawCount').textContent = `${rows.length} Felder`;
    $('#rawBody').innerHTML = rows.map(e => {
      const vals = [...e.values.values()].sort((a, b) => b.n - a.n);
      const shown = vals.slice(0, 12).map(v => `<span class="tag ${v.n > 1 ? 'accent' : ''}" title="Rohwert: ${esc(v.p.raw)}">${esc(fmtParsed(e.f, v.p))}${v.n > 1 ? ' ×' + v.n : ''}</span>`).join('');
      const kind = e.types.size === 1 ? kindDe[[...e.types][0]] : 'gemischt';
      return `<tr><td>${esc(e.label)}<div class="muted" style="font-size:11px">${esc(e.group)}</div></td><td class="mono">${esc(e.f)}</td><td>${kind}</td><td>${shown}${vals.length > 12 ? ` <span class="muted">+${vals.length - 12} weitere</span>` : ''}</td><td class="num">${e.files.size}</td></tr>`;
    }).join('');
  };
  $('#rawSearch').oninput = fill;
  $('#rawFile').onchange = fill;
  $('#csvBtn').onclick = exportCsv;
  fill();
}

function exportCsv() {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['datei', 'fin', 'exportzeit_utc', 'letzte_meldung_utc', 'feld', 'bezeichnung', 'wert_roh', 'wert'].join(';')];
  for (const f of sortedFiles()) for (const r of f.records) {
    lines.push([f.name, state.hideVin ? maskVin(f.vin) : f.vin, f.exportTime?.toISOString(), f.dataTo?.toISOString(), r.f, meta(r.f).label, r.raw,
      r.p.t === 'num' ? String(scaled(r.f, r.p.v)).replace('.', ',') : fmtParsed(r.f, r.p)].map(q).join(';'));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'cupra-export-daten.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ----- Dateien -----
function renderFiles() {
  const el = $('#view-files');
  const files = [...state.files].sort((a, b) => (fileTime(b)?.getTime() ?? 0) - (fileTime(a)?.getTime() ?? 0));
  const empty = files.filter(f => f.empty).length;
  el.innerHTML = `
    <div class="toolbar"><span class="muted">${files.length} Dateien${empty ? `, davon ${empty} ohne Inhalt` : ''} · gespeichert nur in diesem Browser</span></div>
    <div class="table-wrap"><table><thead><tr><th>Datei</th><th>Quelle</th><th>FIN</th><th>Exportzeit</th><th>Meldungen von – bis</th><th>Datensätze</th><th></th></tr></thead><tbody>
    ${files.map(f => `<tr>
      <td class="mono">${esc(f.name.split(/[\\/]/).pop())}${f.error ? `<div style="color:var(--bad)">${esc(f.error)}</div>` : ''}</td>
      <td class="mono muted">${esc(f.source === 'Datei' ? '–' : f.source.split(/[\\/]/).pop())}</td>
      <td class="mono">${esc(maskVin(f.vin))}</td>
      <td class="num">${esc(fmtDate(f.exportTime))}</td>
      <td class="num">${f.dataFrom ? esc(fmtShort(f.dataFrom) + ' – ' + fmtShort(f.dataTo)) : '–'}</td>
      <td class="num">${f.empty ? '<span class="tag">leer</span>' : f.records.length}</td>
      <td><button class="btn small ghost" data-del="${esc(f.id)}" type="button">Entfernen</button></td></tr>`).join('')}
    </tbody></table></div>`;
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    state.files = state.files.filter(f => f.id !== b.dataset.del);
    db.del(b.dataset.del); render();
  });
}

// ---------- Ereignisse ----------
async function filesFromDrop(dt) {
  const items = [...(dt.items || [])].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!items.length) return [...dt.files];
  const out = [];
  const walk = async (entry, path) => {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej));
      try { Object.defineProperty(f, 'webkitRelativePath', { value: path + f.name }); } catch { /* nur Anzeige */ }
      out.push(f);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e, path + entry.name + '/');
      } while (batch.length);
    }
  };
  for (const e of items) await walk(e, '');
  return out;
}

function bind() {
  $('#fileInput').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
  $('#dirInput').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
  $('#dropZone').onclick = () => $('#fileInput').click();
  $('#tabs').onclick = e => { const t = e.target.closest('button')?.dataset.tab; if (t) { state.tab = t; render(); } };
  $('#vinToggle').onclick = () => { state.hideVin = !state.hideVin; store.set('hideVin', state.hideVin); render(); };
  $('#clearBtn').onclick = async () => {
    if (!state.files.length) return;
    if (!confirm('Alle geladenen Exporte aus der App (und dem Browser-Speicher) entfernen? Die Originaldateien bleiben unberührt.')) return;
    state.files = []; await db.clear(); render();
  };
  let depth = 0;
  const ov = $('#dropOverlay');
  window.addEventListener('dragenter', e => { if ([...e.dataTransfer.types].includes('Files')) { depth++; ov.hidden = false; } });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) ov.hidden = true; });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', async e => {
    e.preventDefault(); depth = 0; ov.hidden = true;
    addFiles(await filesFromDrop(e.dataTransfer));
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => render());
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => state.charts.forEach(c => c.resize()), 150); });
}

async function init() {
  bind();
  const saved = await db.all();
  if (saved && saved.length) state.files = saved.map(p => buildFile(p));
  render();
}
init();
