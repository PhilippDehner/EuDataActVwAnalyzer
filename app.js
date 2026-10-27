'use strict';
/* Cupra / VW Group EU-Data-Act-Export – lokale Visualisierung.
 * Die Exportdateien enthalten Datensätze {key, dataFieldName, value} ohne eigene Zeitangabe;
 * Werte lassen sich daher nur der jeweiligen Datei (dem Export) zuordnen.
 * Zwei Formate werden erkannt: das ältere (snake_case) und das neuere (camelCase, teils mit
 * Ladehistorie). Gleichbedeutende Felder werden über FIELD_ALIAS (fields.js) zusammengeführt;
 * was nur das neuere Format liefert, wird zusätzlich ausgewertet (Tab „Laden“). Das Feld
 * timestampUtc des neueren Formats ist unbrauchbar (Sekunden als Millisekunden → 1970) und wird ignoriert. */

// ---------- Hilfsfunktionen ----------
const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let nf, nf0, dtf, dtfShort;   // abhängig von der Sprache, siehe setFormatters()
function setFormatters() {
  const L = t('locale');
  nf = new Intl.NumberFormat(L, { maximumFractionDigits: 2 });
  nf0 = new Intl.NumberFormat(L, { maximumFractionDigits: 0 });
  dtf = new Intl.DateTimeFormat(L, { dateStyle: 'medium', timeStyle: 'medium' });
  dtfShort = new Intl.DateTimeFormat(L, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
setFormatters();
const fmtDate = d => (d instanceof Date && !isNaN(d)) ? dtf.format(d) : '–';
const fmtShort = d => (d instanceof Date && !isNaN(d)) ? dtfShort.format(d) : '–';
const lastSeg = f => f.split('.').pop();
const isTimeField = f => /(time|timestamp)$/i.test(lastSeg(f));
// Felder, deren Zeitwert den Erfassungszeitpunkt einer Meldung beschreibt (keine Prognosen)
// (Zeitstempel in Listen wie powerCurve.[].timeCurve.[] sind Messpunkte, keine Meldungen)
const isCaptureField = f => /(captured_time|captured_utc_timestamp)$/.test(f) || (lastSeg(f) === 'timestamp' && !f.includes('[]'));
// Codierwerte von Steuergeräten haben keinen Klarnamen, nur eine ID wie 1224751803-0-188
const isCodingField = f => /^\d+-\d+-\d+$/.test(f);
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
    // Unix-Sekunden: budgetStartTime, carCapturedTimeStamp.seconds …
    if ((isTimeField(field) || /Time[sS]tamp\.seconds$/.test(field)) && n > 1e9 && n < 1e11) return { t: 'date', v: new Date(n * 1000), raw: s };
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
  if (isCodingField(field)) return 'ID ' + field;
  const seg = field.split('.').filter(s => s !== '[]').slice(-2).join(' · ').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}
function meta(f) {
  const m = FIELD_META[f];
  if (!m) return { label: prettyName(f), group: guessGroup(f) };
  if (lang === 'de') return m;
  return { ...m, label: FIELD_EN[f] || m.label, note: m.note && (NOTE_EN[m.note] || m.note) };
}
const META_ORDER = Object.keys(FIELD_META);
// Gruppen sind intern deutsche Schlüssel
const groupLabel = g => lang === 'en' ? (GROUP_EN[g] || g) : g;
function guessGroup(f) {
  if (/^setup_real_speed_ratios/.test(f)) return 'Geschwindigkeitsprofil';
  if (/^(chargingSession|powerCurve|aggregation)\./.test(f)) return 'Ladehistorie';
  if (isCodingField(f)) return 'Steuergerät';
  if (/^profiles\./.test(f)) return 'Ladeprofil';
  if (/charg/i.test(f)) return 'Laden';
  if (/clima/i.test(f)) return 'Klima';
  if (/battery|energy/i.test(f)) return 'Batterie';
  if (isTimeField(f)) return 'Zeit';
  return 'Sonstiges';
}

function enumLabel(s) {
  const dict = lang === 'en' ? ENUM_EN : ENUM_DE;
  if (dict[s]) return dict[s];
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
    case 'bool': return p.v ? t('yes') : t('no');
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
      userId = json.user_id || json.userId || null;
      recs = findRecords(json) ?? flatten(json).filter(r => !/^(vin|user_?id)$/i.test(r.dataFieldName));
    }
  } catch (e) {
    return { ...base, error: e.message, records: [], byField: new Map() };
  }
  const records = recs.map(r => {
    const orig = String(r.dataFieldName ?? r.field ?? r.name ?? '').trim();
    const raw = typeof r.value === 'object' && r.value !== null ? JSON.stringify(r.value) : r.value;
    return normalizeRecord(orig, raw == null ? '' : String(raw), r.key || null);
  }).filter(r => r.f);
  const byField = new Map();
  for (const r of records) { if (!byField.has(r.f)) byField.set(r.f, []); byField.get(r.f).push(r.p); }
  const charging = extractCharging(records);
  // Format: neueres, wenn Felder umbenannt werden mussten oder camelCase überwiegt
  const camel = records.filter(r => /[a-z][A-Z]/.test(r.orig.split('.')[0])).length;
  const format = records.some(r => r.alias) || camel > records.length * 0.2 ? 'B' : 'A';

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
    ...base, vin, userId, records, byField, exportTime, format, charging,
    dataFrom: minT !== null ? new Date(minT) : null,
    dataTo: maxT !== null ? new Date(maxT) : null,
    empty: records.length === 0,
  };
}

// Listenindizes zusammenfassen (chargingSession.[3].startSoc → chargingSession.[].startSoc) und
// Felder des neueren Formats auf den gleichbedeutenden Namen des älteren abbilden.
// f = Feld für die Auswertung, orig = Feldname wie in der Datei, alias = umbenanntes Muster.
function normalizeRecord(orig, raw, key) {
  const pat = orig.replace(/\[\d+\]/g, '[]');
  const [f, pre] = [].concat(FIELD_ALIAS[pat] || pat);
  const s = raw.trim();
  const p = parseValue(orig, pre && /^[A-Z0-9_]+$/.test(s) && !s.startsWith(pre) ? pre + s : s);
  p.raw = s;   // Rohwert bleibt so, wie er in der Datei steht
  return { f, orig, alias: f !== pat ? pat : null, raw, p, key };
}

// Ladehistorie (nur im neueren Format): Ladevorgänge, Ladekurven, Tages- und Monatssummen
function extractCharging(records) {
  const at = (m, i) => { if (!m.has(i)) m.set(i, {}); return m.get(i); };
  const sess = new Map(), curves = new Map(), agg = { day: new Map(), month: new Map() };
  for (const r of records) {
    const o = r.orig; let m;
    if ((m = o.match(/^chargingSession\.\[(\d+)\]\.(\w+)/))) {
      const s = at(sess, +m[1]);
      if (m[2] === 'chargeMode') (s.chargeMode ||= []).push(r.raw); else s[m[2]] = r.p.v;
    } else if ((m = o.match(/^powerCurve\.\[(\d+)\]\.timeCurve\.\[(\d+)\]\.(\w+)$/))) {
      const c = at(curves, +m[1]); c.pts ||= new Map(); at(c.pts, +m[2])[m[3]] = r.p.v;
    } else if ((m = o.match(/^powerCurve\.\[(\d+)\]\.sessionId$/))) at(curves, +m[1]).sessionId = r.raw;
    else if ((m = o.match(/^aggregation\.(day|month)\.\[(\d+)\]\.(\w+)$/))) at(agg[m[1]], +m[2])[m[3]] = r.p.v;
  }
  const num = v => typeof v === 'number' ? v : null;
  const date = v => v instanceof Date ? v : null;
  const sessions = [...sess.values()].filter(s => s.sessionId).map(s => ({
    id: String(s.sessionId), type: s.chargeType || null, modes: s.chargeMode || [],
    connect: date(s.connectionTimestamp), disconnect: date(s.disconnectionTimestamp),
    start: date(s.startChargingTimestamp), stop: date(s.stopChargingTimestamp),
    socFrom: num(s.startSoc), socTo: num(s.endSoc), kwh: num(s.totalEnergyCharged),
    avg: num(s.averageChargePower), peak: num(s.peakChargePower), active: num(s.activeChargingTime),
  }));
  const curveList = [...curves.entries()].filter(([, c]) => c.pts).map(([i, c]) => ({
    id: c.sessionId || 'curve-' + i,
    pts: [...c.pts.values()].filter(p => p.timestamp instanceof Date)
      .map(p => ({ t: p.timestamp.getTime(), kw: num(p.chargePower), soc: num(p.soc), de: num(p.deltaChargeEnergy) }))
      .sort((a, b) => a.t - b.t),
  })).filter(c => c.pts.length);
  const sums = m => [...m.values()].filter(d => d.date instanceof Date && typeof d.chargedEnergy === 'number')
    .map(d => ({ t: d.date.getTime(), kwh: d.chargedEnergy })).sort((a, b) => a.t - b.t);
  const days = sums(agg.day), months = sums(agg.month);
  return sessions.length || curveList.length || days.length || months.length ? { sessions, curves: curveList, days, months } : null;
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
  const msg = [t('toastLoaded', added)];
  if (empty) msg.push(t('toastEmpty', empty));
  if (dup) msg.push(t('toastDup', dup));
  if (err) msg.push(t('toastErr', err));
  if (skipped) msg.push(t('toastSkipped', skipped));
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
  $('#vinToggle').textContent = state.hideVin ? t('showVin') : t('hideVin');
  const vins = [...new Set(state.files.map(f => f.vin).filter(Boolean))];
  const fs = sortedFiles();
  $('#vehicleLine').textContent = has
    ? `${vins.length ? t('vin') + ' ' + vins.map(maskVin).join(', ') : t('vinUnknown')} · ${t('nExports', fs.length)}` +
      (fs.length > 1 ? ` · ${fmtShort(fileTime(fs[0]))} – ${fmtShort(fileTime(fs[fs.length - 1]))}` : fs.length ? ` · ${fmtShort(fileTime(fs[0]))}` : '')
    : t('tagline');
  // Tab „Laden“ nur, wenn ein Export Ladehistorie enthält (neueres Format)
  const hasCharging = fs.some(f => f.charging);
  $('#tabs [data-tab="charging"]').hidden = !hasCharging;
  if (state.tab === 'charging' && !hasCharging) state.tab = 'overview';
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
  for (const v of ['overview', 'charging', 'history', 'activity', 'raw', 'files']) $('#view-' + v).hidden = !has || v !== state.tab;
  destroyCharts();
  if (!has) return;
  ({ overview: renderOverview, charging: renderCharging, history: renderHistory, activity: renderActivity, raw: renderRaw, files: renderFiles })[state.tab]();
  document.querySelectorAll('table[id]').forEach(restoreSort);
}

// ---------- Tabellen sortieren ----------
// Klick auf eine Spaltenüberschrift sortiert (auf-, dann absteigend). Zellen können mit
// data-sort einen Sortierwert vorgeben (z. B. Zeitstempel), sonst zählt der sichtbare Text.
// Die Auswahl gilt je Tabellen-ID und überlebt erneutes Rendern.
const sorts = store.get('sorts', {});
function sortTable(table, col, dir) {
  const tbody = table.tBodies[0]; if (!tbody) return;
  const val = tr => { const td = tr.cells[col]; return td ? (td.dataset.sort ?? td.textContent.trim()) : ''; };
  const cmp = (a, b) => {
    if (a === '' || b === '') return (a === '') - (b === '');   // Leere immer ans Ende
    const na = Number(a), nb = Number(b);
    if (!isNaN(na) && !isNaN(nb)) return (na - nb) * dir;
    return a.localeCompare(b, lang, { numeric: true, sensitivity: 'base' }) * dir;
  };
  const rows = [...tbody.rows].map(tr => [tr, val(tr)]).sort((x, y) => cmp(x[1], y[1]));
  tbody.append(...rows.map(r => r[0]));
  [...table.tHead.rows[0].cells].forEach((th, i) => {
    th.classList.toggle('sorted', i === col);
    if (th.hasAttribute('data-nosort')) return;
    th.setAttribute('aria-sort', i === col ? (dir > 0 ? 'ascending' : 'descending') : 'none');
  });
}
function restoreSort(table) {
  if (!table?.tHead) return;
  [...table.tHead.rows[0].cells].forEach(th => { if (!th.hasAttribute('data-nosort')) th.classList.add('sortable'); });
  const s = sorts[table.id];
  if (s) sortTable(table, s.col, s.dir);
}

// ----- Übersicht -----
function renderOverview() {
  const el = $('#view-overview');
  const fs = sortedFiles();
  if (!fs.length) { el.innerHTML = `<div class="hint">${t('noDataHtml')}</div>`; return; }
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
    if (target) marks.push(`<div class="battery-mark" style="left:${target.max}%" title="${esc(t('markTargetTitle'))}"><span>${esc(t('markTarget'))} ${nf.format(target.max)}&nbsp;%</span></div>`);
    if (care && (!target || care.max !== target.max)) marks.push(`<div class="battery-mark" style="left:${care.max}%;opacity:.5" title="${esc(t('markCareTitle'))}"><span>${esc(t('markCare'))} ${nf.format(care.max)}&nbsp;%</span></div>`);
    hero = `<div class="card kpi hero">
      <div class="label">${esc(t('soc'))}</div>
      <div class="value">${lo === hi ? nf.format(lo) : nf.format(lo) + '–' + nf.format(hi)}<small>%</small></div>
      <div class="note">${esc(soc.nums.length > 1 ? t('socNoteMulti', soc.nums.length, soc.nums.map(n => nf.format(n)).join(' · ')) : t('socNoteOne'))}</div>
      <div class="battery">
        <div class="battery-bar" role="img" aria-label="${esc(t('socAria', lo, hi))}">
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
    const note = extra || (multi ? t('nMessages', s.vals.length) : (m.note || ''));
    return `<div class="card kpi" title="${esc(field)}${m.note ? ' – ' + esc(m.note) : ''}">
      <div class="label">${esc(label || m.label)}</div>
      <div class="value">${esc(num)}${unit.length ? `<small>${esc(unit.join(' '))}</small>` : ''}</div>
      <div class="note">${esc(note)}</div></div>`;
  };

  let energyExtra = '';
  if (eCur && eMax) energyExtra = t('energyOf', fmtNum('energy_contents.maximal_energy_content.physical_value', eMax.max), nf0.format(eCur.max / eMax.max * 100));

  const tiles = [
    tile('energy_contents.current_energy_content.physical_value', { extra: energyExtra }),
    tile('mileage.value', { prefer: 'max' }),
    tile('batteryStatus.cruisingRange.range'),
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
    'charging_state_report.charging_scenario', 'plugStatusItem.plugConnectionState', 'plugStatusItem.plugLockState', 'careMode',
    'climatisation_state', 'window_heating_state', 'locked', 'open', 'parking_light_left', 'parking_light_right', 'update_reason'];
  const chips = statusFields.map(f => {
    const s = S(f); if (!s) return '';
    const vals = s.distinct.map(p => {
      const tone = p.t === 'str' ? ENUM_TONE[p.v] : (f === 'locked' ? (p.v ? 'good' : 'warn') : null);
      return `<span><span class="dot ${tone || ''}"></span>${esc(fmtParsed(f, p))}</span>`;
    });
    return `<div class="chip" title="${esc(f)}"><span class="k">${esc(meta(f).label)}</span><span class="v">${vals.join('<span class="alt"> / </span>')}</span></div>`;
  }).join('');

  // Reihenfolge wie in fields.js, unbekannte Felder dahinter; Nanosekunden-Anteile weglassen
  const order = f => { const i = META_ORDER.indexOf(f); return i < 0 ? 1e9 : i; };
  const kvBlock = (title, fields) => {
    const rows = fields.filter(f => !/\.nanos$/.test(f)).sort((a, b) => order(a) - order(b)).map(f => { const s = S(f); return s ? `<div title="${esc(f)}">${esc(meta(f).label)}</div><div>${esc(displaySummary(f, s))}</div>` : ''; }).join('');
    return rows ? `<div class="card"><div class="card-head"><h3>${esc(title)}</h3></div><div class="kv">${rows}</div></div>` : '';
  };
  const allFields = [...file.byField.keys()];
  const byGroup = g => allFields.filter(f => meta(f).group === g);

  const range = file.dataFrom ? `${fmtDate(file.dataFrom)} – ${fmtDate(file.dataTo)}` : '–';
  const msgTypes = countBy(file.byField.get('message_id') || [], p => String(p.v).replace(/_\d+$/, ''));

  el.innerHTML = `
    <div class="toolbar">
      <label>${esc(t('snapshot'))} <select id="fileSel">${opts}</select></label>
      <span class="muted">${esc(t('messagesInExport', range))}</span>
    </div>
    <div class="hint">${t('rangeHintHtml')}</div>
    <div class="grid kpis">${hero}${tiles}</div>
    ${chips ? `<div class="card"><div class="card-head"><h3>${esc(t('status'))}</h3><span class="muted">${esc(t('statusNote'))}</span></div><div class="chips">${chips}</div></div>` : ''}
    <div class="grid two">
      ${kvBlock(t('chargeSettings'), [...byGroup('Laden').filter(f => /^settings\.|battery_care|charge_rate_unit|^careMode$/.test(f)), 'settings.target_soc'].filter((f, i, a) => a.indexOf(f) === i))}
      ${kvBlock(groupLabel('Ladeoptionen'), byGroup('Ladeoptionen'))}
      ${kvBlock(groupLabel('Ladetimer'), byGroup('Ladetimer'))}
      ${kvBlock(groupLabel('Ladeprofil'), byGroup('Ladeprofil').filter(f => !/uuid|recurring/.test(f)))}
      ${kvBlock(groupLabel('Stecker'), byGroup('Stecker'))}
      ${kvBlock(t('doorsWindows'), byGroup('Zugang').filter(f => f !== 'locked' && f !== 'open'))}
      ${kvBlock(groupLabel('Service'), byGroup('Service'))}
      ${kvBlock(groupLabel('Klima'), byGroup('Klima').filter(f => f !== 'climatisation_state' && f !== 'window_heating_state' && f !== 'remaining_climate_time'))}
      ${kvBlock(t('consumptionBattery'), [...byGroup('Verbrauch'), 'energy_contents.maximal_energy_content.physical_value', 'battery_level_HV.value', 'battery_level_HV.state', 'mileage.state'])}
      <div class="card"><div class="card-head"><h3>${esc(t('export'))}</h3></div><div class="kv">
        <div>${esc(t('file'))}</div><div class="mono">${esc(file.name.split(/[\\/]/).pop())}</div>
        <div>${esc(t('colFormat'))}</div><div>${esc(formatLabel(file))}</div>
        <div>${esc(t('vin'))}</div><div class="mono">${esc(maskVin(file.vin))}</div>
        <div>${esc(t('exportTimeName'))}</div><div>${esc(fmtDate(file.exportTime))}</div>
        <div>${esc(t('firstMessage'))}</div><div>${esc(fmtDate(file.dataFrom))}</div>
        <div>${esc(t('lastMessage'))}</div><div>${esc(fmtDate(file.dataTo))}</div>
        <div>${esc(t('recordsFields'))}</div><div>${file.records.length} / ${file.byField.size}</div>
      </div>
      ${msgTypes.length ? `<div style="margin-top:12px">${msgTypes.map(([k, n]) => `<span class="tag" title="${esc(t('messageType'))}">${esc(k)} ×${n}</span>`).join('')}</div>` : ''}
      </div>
    </div>`;
  $('#fileSel').onchange = e => { state.selectedFile = e.target.value; render(); };
}

const formatLabel = f => f.empty || f.error ? '–' : t(f.format === 'B' ? 'formatB' : 'formatA') + (f.charging ? ' · ' + t('withCharging') : '');

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
  Chart.defaults.locale = t('locale');
}
function timeScale(span) {
  return {
    type: 'time',
    time: { tooltipFormat: t('chartFmt').tooltip, displayFormats: { minute: 'HH:mm', hour: t('chartFmt').hour, day: t('chartFmt').day, week: t('chartFmt').day, month: 'MMM yyyy' } },
    grid: { color: css('--grid') },
    ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
    ...(span || {}),
  };
}
const zoomOpts = { zoom: { wheel: { enabled: true, modifierKey: 'ctrl' }, pinch: { enabled: true }, drag: { enabled: true, backgroundColor: 'rgba(176,112,62,.15)' }, mode: 'x' }, pan: { enabled: true, mode: 'x', modifierKey: 'shift' } };

// ----- Laden (Ladehistorie des neueren Formats) -----
// Mehrere Exporte überlappen sich: Ladevorgänge und Kurven über ihre sessionId, Tages- und
// Monatssummen über das Datum zusammenführen; der jüngere Export gewinnt.
function chargingData() {
  const sess = new Map(), curves = new Map(), days = new Map(), months = new Map();
  for (const f of sortedFiles()) {
    const c = f.charging; if (!c) continue;
    c.sessions.forEach(s => sess.set(s.id, s));
    c.curves.forEach(k => { const cur = curves.get(k.id); if (!cur || k.pts.length >= cur.pts.length) curves.set(k.id, k); });
    c.days.forEach(d => days.set(d.t, d));
    c.months.forEach(d => months.set(d.t, d));
  }
  const byT = (a, b) => a.t - b.t;
  const sessT = s => (s.start || s.connect)?.getTime() ?? 0;
  return {
    sessions: [...sess.values()].sort((a, b) => sessT(a) - sessT(b)),
    curves: [...curves.values()].sort((a, b) => a.pts[0].t - b.pts[0].t),
    days: [...days.values()].sort(byT), months: [...months.values()].sort(byT),
  };
}
function fmtDur(sec) {
  if (sec == null) return '–';
  const h = Math.floor(sec / 3600), m = Math.round(sec % 3600 / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

function renderCharging() {
  chartBase();
  const el = $('#view-charging');
  const { sessions, curves, days, months } = chargingData();
  const sum = (a, k) => a.reduce((s, x) => s + (x[k] || 0), 0);
  const kwh = n => `${nf.format(n)} kWh`;
  const total = sum(sessions, 'kwh');
  const ac = sessions.filter(s => s.type === 'AC').length, dc = sessions.filter(s => s.type === 'DC').length;
  const peak = sessions.reduce((b, s) => s.peak != null && s.peak > (b?.peak ?? -1) ? s : b, null);
  const first = sessions[0]?.start, last = sessions.at(-1)?.stop || sessions.at(-1)?.start;
  const sessById = new Map(sessions.map(s => [s.id, s]));

  // Energie pro Tag: Aggregation des Fahrzeugs, sonst aus den Ladevorgängen summiert
  const fromAgg = days.length > 0;
  let perDay = days.map(d => ({ x: d.t, y: d.kwh }));
  if (!fromAgg) {
    const m = new Map();
    for (const s of sessions) { if (!s.start || s.kwh == null) continue; const d = new Date(s.start); d.setHours(0, 0, 0, 0); m.set(d.getTime(), (m.get(d.getTime()) || 0) + s.kwh); }
    perDay = [...m].map(([x, y]) => ({ x, y })).sort((a, b) => a.x - b.x);
  }
  const monthFmt = new Intl.DateTimeFormat(t('locale'), { month: 'long', year: 'numeric', timeZone: 'UTC' });

  const curve = curves.find(c => c.id === state.curve) || curves.at(-1);
  const curveLabel = c => { const s = sessById.get(c.id); return `${fmtDate(new Date(c.pts[0].t))}${s?.kwh != null ? ' · ' + kwh(s.kwh) : ''} · ${t('nPoints', c.pts.length)}`; };

  const kpi = (label, value, unit, note) => `<div class="card kpi"><div class="label">${esc(label)}</div><div class="value">${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ''}</div><div class="note">${esc(note || '')}</div></div>`;
  const modes = s => [...new Set(s.modes)].map(enumLabel).join(', ');

  el.innerHTML = `
    <div class="hint">${t('chHintHtml')}</div>
    <div class="grid kpis">
      ${kpi(t('chSessions'), String(sessions.length), '', t('chSessionsNote', ac, dc))}
      ${kpi(t('chTotal'), nf.format(total), 'kWh', first ? `${fmtShort(first)} – ${fmtShort(last)}` : '')}
      ${kpi(t('chAvg'), sessions.length ? nf.format(total / sessions.length) : '–', 'kWh', '')}
      ${kpi(t('chPeak'), peak ? nf.format(peak.peak) : '–', 'kW', peak ? `${peak.type || ''} · ${fmtShort(peak.start)}` : '')}
      ${kpi(t('chActive'), fmtDur(sum(sessions, 'active')), '', t('chActiveNote'))}
      ${months.map(m => kpi(monthFmt.format(new Date(m.t)), nf.format(m.kwh), 'kWh', t('chMonthNote'))).join('')}
    </div>
    ${perDay.length ? `<div class="card"><div class="card-head"><h3>${esc(t('chPerDay'))}</h3><span class="muted">${esc(fromAgg ? t('chSrcAgg') : t('chSrcSess'))}</span></div><div class="chart-box"><canvas id="dayChart"></canvas></div></div>` : ''}
    ${curve ? `<div class="card" id="curveCard"><div class="card-head"><h3>${esc(t('chCurve'))}</h3>
      <select id="curveSel">${[...curves].reverse().map(c => `<option value="${esc(c.id)}" ${c === curve ? 'selected' : ''}>${esc(curveLabel(c))}</option>`).join('')}</select></div>
      <div class="chart-box"><canvas id="curveChart"></canvas></div></div>` : ''}
    ${sessions.length ? `<div class="card"><div class="card-head"><h3>${esc(t('chTable'))}</h3><span class="muted">${esc(t('chTableNote'))}</span></div>
      <div class="table-wrap"><table id="sessTable"><thead><tr>
        <th>${esc(t('colStart'))}</th><th>${esc(t('colEnd'))}</th><th>${esc(t('colDuration'))}</th><th>${esc(t('colChType'))}</th>
        <th>${esc(t('colSoc'))}</th><th>${esc(t('colEnergy'))}</th><th>${esc(t('colAvg'))}</th><th>${esc(t('colPeak'))}</th><th>${esc(t('colMode'))}</th><th data-nosort></th>
      </tr></thead><tbody>
      ${[...sessions].reverse().map(s => `<tr>
        <td class="num" data-sort="${s.start?.getTime() ?? ''}" title="${esc(t('chConnected', fmtDate(s.connect), fmtDate(s.disconnect)))}">${esc(fmtShort(s.start))}</td>
        <td class="num" data-sort="${s.stop?.getTime() ?? ''}">${esc(fmtShort(s.stop))}</td>
        <td class="num" data-sort="${s.active ?? ''}">${esc(fmtDur(s.active))}</td>
        <td>${esc(s.type || '–')}</td>
        <td class="num" data-sort="${s.socTo ?? ''}">${s.socFrom != null ? `${nf0.format(s.socFrom)} → ${nf0.format(s.socTo)} %` : '–'}</td>
        <td class="num" data-sort="${s.kwh ?? ''}">${s.kwh != null ? esc(kwh(s.kwh)) : '–'}</td>
        <td class="num" data-sort="${s.avg ?? ''}">${s.avg != null ? esc(nf.format(s.avg) + ' kW') : '–'}</td>
        <td class="num" data-sort="${s.peak ?? ''}">${s.peak != null ? esc(nf.format(s.peak) + ' kW') : '–'}</td>
        <td>${esc(modes(s))}</td>
        <td>${curves.some(c => c.id === s.id) ? `<button class="btn small ghost" data-curve="${esc(s.id)}" type="button">${esc(t('chShowCurve'))}</button>` : ''}</td>
      </tr>`).join('')}
      </tbody></table></div></div>` : ''}`;

  if (perDay.length) {
    const c = new Chart($('#dayChart'), {
      type: 'bar',
      data: { datasets: [{ data: perDay, backgroundColor: css('--series-1'), borderRadius: 3, maxBarThickness: 28 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        scales: { x: timeScale({ time: { unit: 'day', tooltipFormat: t('chartFmt').dayTooltip, displayFormats: { day: t('chartFmt').day } }, offset: true }), y: { beginAtZero: true, grid: { color: css('--grid') }, ticks: { callback: v => nf.format(v) } } },
        plugins: { legend: { display: false }, zoom: zoomOpts, tooltip: { callbacks: { label: it => kwh(it.raw.y) } } },
      },
    });
    $('#dayChart').ondblclick = () => c.resetZoom();
    state.charts.push(c);
  }
  if (curve) {
    const c = new Chart($('#curveChart'), {
      type: 'line',
      data: {
        datasets: [
          { label: t('chCurvePower'), data: curve.pts.map(p => ({ x: p.t, y: p.kw })), borderColor: css('--series-1'), backgroundColor: css('--series-1'), borderWidth: 2, pointRadius: 0, stepped: true, yAxisID: 'y' },
          { label: t('chCurveSoc'), data: curve.pts.map(p => ({ x: p.t, y: p.soc })), borderColor: css('--series-2'), backgroundColor: css('--series-2'), borderWidth: 2, borderDash: [5, 4], pointRadius: 0, yAxisID: 'y1' },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          x: timeScale(),
          y: { beginAtZero: true, title: { display: true, text: 'kW' }, grid: { color: css('--grid') }, ticks: { callback: v => nf.format(v) } },
          y1: { position: 'right', min: 0, max: 100, title: { display: true, text: '%' }, grid: { display: false } },
        },
        plugins: { legend: { display: true, labels: { boxWidth: 12 } }, zoom: zoomOpts, tooltip: { callbacks: { label: it => `${it.dataset.label}: ${nf.format(it.raw.y)}` } } },
      },
    });
    $('#curveChart').ondblclick = () => c.resetZoom();
    state.charts.push(c);
    $('#curveSel').onchange = e => { state.curve = e.target.value; render(); };
  }
  el.querySelectorAll('[data-curve]').forEach(b => b.onclick = () => {
    state.curve = b.dataset.curve; render(); $('#curveCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// ----- Verlauf -----
const DEFAULT_SERIES = ['battery_state_report.soc', 'mileage.value', 'battery_state_report.charge_power', 'energy_contents.current_energy_content.physical_value', 'outdoor_temperature'];

function renderHistory() {
  chartBase();
  const el = $('#view-history');
  const fs = sortedFiles();
  const idx = fieldIndex();
  // Listenfelder (Ladehistorie), Nanosekunden-Anteile und Codierwerte sind keine Messgrößen eines Exports
  const noSeries = f => f.includes('[]') || /\.nanos$/.test(f) || isCodingField(f);
  const numFields = [...idx.values()].filter(e => e.kind === 'num' && !noSeries(e.f)).map(e => e.f)
    .sort((a, b) => (meta(a).group + meta(a).label).localeCompare(meta(b).group + meta(b).label, lang));
  const enumFields = [...idx.values()].filter(e => (e.kind === 'str' || e.kind === 'bool') && !noSeries(e.f)).map(e => e.f)
    .filter(f => !/(message_id|transaction_id|value_type|uuid|identifier|sessionId|UserID)$/i.test(f));
  let sel = store.get('series', DEFAULT_SERIES).filter(f => numFields.includes(f));
  if (!sel.length) sel = numFields.filter(f => DEFAULT_SERIES.includes(f));
  let enumSel = store.get('enumSeries', 'charging_state_report.current_charge_state');
  if (!enumFields.includes(enumSel)) enumSel = enumFields[0];

  const groups = new Map();
  for (const f of numFields) { const g = meta(f).group; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(f); }

  el.innerHTML = `
    ${fs.length < 2 ? `<div class="hint">${t('fewExportsHtml', fs.length)}</div>` : ''}
    <div class="card">
      <div class="card-head"><h3>${esc(t('metrics'))}</h3>
        <div class="toolbar">
          <label>${esc(t('timeAxis'))} <select id="timeBase">
            <option value="data" ${state.timeBase === 'data' ? 'selected' : ''}>${esc(t('timeBaseData'))}</option>
            <option value="export" ${state.timeBase === 'export' ? 'selected' : ''}>${esc(t('timeBaseExport'))}</option>
          </select></label>
          <span class="muted">${esc(t('zoomHint'))}</span>
        </div>
      </div>
      ${[...groups].map(([g, fl]) => `<div style="margin-bottom:8px"><div class="muted" style="font-size:12px;margin-bottom:4px">${esc(groupLabel(g))}</div><div class="picker">${fl.map(f => `<label title="${esc(f)}"><input type="checkbox" value="${esc(f)}" ${sel.includes(f) ? 'checked' : ''}>${esc(meta(f).label)}</label>`).join('')}</div></div>`).join('')}
    </div>
    <div class="grid two" id="seriesGrid"></div>
    ${enumSel ? `<div class="card">
      <div class="card-head"><h3>${esc(t('statusHistory'))}</h3>
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
                return p.min === p.max ? `${nf.format(p.med)}${u}` : `${nf.format(p.min)}–${nf.format(p.max)}${u} (${t('nMessages', p.n)})`;
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
  if (!sel.length) grid.innerHTML = `<div class="muted">${esc(t('selectMetrics'))}</div>`;

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
      <div class="card kpi"><div class="label">${esc(t('actVehicle'))}</div><div class="value">${bursts.length}</div><div class="note">${esc(t('actVehicleNote'))}</div></div>
      <div class="card kpi"><div class="label">${esc(t('actStamps'))}</div><div class="value">${events.length}</div><div class="note">${esc(t('actStampsNote'))}</div></div>
      <div class="card kpi"><div class="label">${esc(t('firstMessage'))}</div><div class="value" style="font-size:17px">${esc(events.length ? fmtDate(new Date(events[0].t)) : '–')}</div></div>
      <div class="card kpi"><div class="label">${esc(t('lastMessage'))}</div><div class="value" style="font-size:17px">${esc(events.length ? fmtDate(new Date(events[events.length - 1].t)) : '–')}</div></div>
    </div>
    <div class="card"><div class="card-head"><h3>${esc(t('actPer', unit))}</h3><span class="muted">${esc(t('actWhen'))}</span></div><div class="chart-box"><canvas id="actChart"></canvas></div></div>
    <div class="grid two">
      <div class="card"><div class="card-head"><h3>${esc(t('timeOfDay'))}</h3><span class="muted">${esc(t('localTime'))}</span></div><div class="chart-box"><canvas id="hourChart"></canvas></div></div>
      <div class="card"><div class="card-head"><h3>${esc(t('msgTypes'))}</h3></div>${msgTypes.length ? bars(msgTypes) : `<span class="muted">${esc(t('none'))}</span>`}</div>
      ${reportTypes.length ? `<div class="card"><div class="card-head"><h3>${esc(t('reportTypes'))}</h3></div>${bars(reportTypes)}</div>` : ''}
      ${reasons.length ? `<div class="card"><div class="card-head"><h3>${esc(t('updateReasons'))}</h3></div>${bars(reasons)}</div>` : ''}
    </div>
    <div class="card"><div class="card-head"><h3>${esc(t('timestamps'))}</h3><span class="muted">${esc(t('newestFirst'))}</span></div>
      <div class="table-wrap"><table id="actTable"><thead><tr><th>${esc(t('colTimeLocal'))}</th><th>${esc(t('colField'))}</th><th>${esc(t('file'))}</th></tr></thead><tbody>
      ${events.slice().reverse().slice(0, 500).map(e => `<tr><td class="num" data-sort="${e.t}">${esc(fmtDate(new Date(e.t)))}</td><td title="${esc(e.f)}">${esc(meta(e.f).label)}</td><td class="mono">${esc(e.file.split(/[\\/]/).pop())}</td></tr>`).join('')}
      </tbody></table></div></div>`;

  const c1 = new Chart($('#actChart'), {
    type: 'bar',
    data: { datasets: [{ data: perBucket, backgroundColor: css('--series-1'), borderRadius: 3, maxBarThickness: 28 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: { x: timeScale({ time: { unit, tooltipFormat: unit === 'day' ? t('chartFmt').dayTooltip : t('chartFmt').hourTooltip, displayFormats: { hour: t('chartFmt').hour, day: t('chartFmt').day } }, offset: true }), y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: css('--grid') } } },
      plugins: { legend: { display: false }, zoom: zoomOpts, tooltip: { callbacks: { label: it => t('nActivities', it.raw.y) } } },
    },
  });
  $('#actChart').ondblclick = () => c1.resetZoom();
  const c2 = new Chart($('#hourChart'), {
    type: 'bar',
    data: { labels: perHour.map((_, h) => String(h).padStart(2, '0')), datasets: [{ data: perHour, backgroundColor: css('--series-2'), borderRadius: 3 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: css('--grid') } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: it => t('hourRange', it[0].label), label: it => t('nActivities', it.raw) } } },
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
      <input type="search" id="rawSearch" placeholder="${esc(t('searchPh'))}" value="${esc(q)}">
      <label>${esc(t('export'))} <select id="rawFile"><option value="all">${esc(t('allN', fs.length))}</option>${[...fs].reverse().map(f => `<option value="${esc(f.id)}" ${f.id === fsel ? 'selected' : ''}>${esc(fmtDate(fileTime(f)))}</option>`).join('')}</select></label>
      <button class="btn small" id="csvBtn" type="button">${esc(t('saveCsv'))}</button>
      <span class="muted" id="rawCount"></span>
    </div>
    <div class="table-wrap"><table id="rawTable"><thead><tr><th>${esc(t('colLabel'))}</th><th>${esc(t('colField'))}</th><th>${esc(t('colType'))}</th><th>${esc(t('colValues'))}</th><th>${esc(t('colExports'))}</th></tr></thead><tbody id="rawBody"></tbody></table></div>`;
  const kinds = t('kind');
  const fill = () => {
    const query = $('#rawSearch').value.trim().toLowerCase();
    const fid = $('#rawFile').value;
    store.set('rawQuery', query); state.rawFile = fid;
    const saved = state.files;
    const files = fid === 'all' ? saved : saved.filter(f => f.id === fid);
    const idx = new Map();
    for (const file of files) for (const r of file.records) {
      if (!idx.has(r.f)) idx.set(r.f, { f: r.f, files: new Set(), values: new Map(), types: new Set(), aliases: new Set() });
      const e = idx.get(r.f), p = r.p; e.files.add(file.id);
      if (r.alias) e.aliases.add(r.alias);
      e.types.add(p.t); const cur = e.values.get(p.raw); e.values.set(p.raw, { p, n: (cur?.n || 0) + 1 });
    }
    const rows = [...idx.values()]
      .map(e => ({ ...e, label: meta(e.f).label, group: groupLabel(meta(e.f).group) }))
      .filter(e => !query || e.f.toLowerCase().includes(query) || e.label.toLowerCase().includes(query) ||
        [...e.values.values()].some(v => v.p.raw.toLowerCase().includes(query) || fmtParsed(e.f, v.p).toLowerCase().includes(query)))
      .sort((a, b) => (a.group + a.label).localeCompare(b.group + b.label, lang));
    $('#rawCount').textContent = t('nFields', rows.length);
    $('#rawBody').innerHTML = rows.map(e => {
      const vals = [...e.values.values()].sort((a, b) => b.n - a.n);
      const shown = vals.slice(0, 12).map(v => `<span class="tag ${v.n > 1 ? 'accent' : ''}" title="${esc(t('rawValue', v.p.raw))}">${esc(fmtParsed(e.f, v.p))}${v.n > 1 ? ' ×' + v.n : ''}</span>`).join('');
      const kind = e.types.size === 1 ? kinds[[...e.types][0]] : t('mixed');
      return `<tr><td>${esc(e.label)}<div class="muted" style="font-size:11px">${esc(e.group)}</div></td><td class="mono">${esc(e.f)}${e.aliases.size ? `<div class="muted" style="font-size:11px">${esc(t('rawAlias', [...e.aliases].join(', ')))}</div>` : ''}</td><td>${esc(kind)}</td><td data-sort="${vals.length}">${shown}${vals.length > 12 ? ` <span class="muted">${esc(t('nMore', vals.length - 12))}</span>` : ''}</td><td class="num">${e.files.size}</td></tr>`;
    }).join('');
    restoreSort($('#rawTable'));
  };
  $('#rawSearch').oninput = fill;
  $('#rawFile').onchange = fill;
  $('#csvBtn').onclick = exportCsv;
  fill();
}

function exportCsv() {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [t('csvHead').join(';')];
  const num = n => t('decimalComma') ? String(n).replace('.', ',') : String(n);
  for (const f of sortedFiles()) for (const r of f.records) {
    lines.push([f.name, state.hideVin ? maskVin(f.vin) : f.vin, f.exportTime?.toISOString(), f.dataTo?.toISOString(), r.f, meta(r.f).label, r.raw,
      r.p.t === 'num' ? num(scaled(r.f, r.p.v)) : fmtParsed(r.f, r.p)].map(q).join(';'));
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
    <div class="toolbar"><span class="muted">${esc(t('filesSummary', files.length, empty))}</span></div>
    <div class="table-wrap"><table id="filesTable"><thead><tr><th>${esc(t('file'))}</th><th>${esc(t('colSource'))}</th><th>${esc(t('colFormat'))}</th><th>${esc(t('vin'))}</th><th>${esc(t('colExportTime'))}</th><th>${esc(t('colRange'))}</th><th>${esc(t('colRecords'))}</th><th data-nosort></th></tr></thead><tbody>
    ${files.map(f => `<tr>
      <td class="mono">${esc(f.name.split(/[\\/]/).pop())}${f.error ? `<div style="color:var(--bad)">${esc(t('readError', f.error))}</div>` : ''}</td>
      <td class="mono muted">${esc(f.source === 'Datei' ? '–' : f.source.split(/[\\/]/).pop())}</td>
      <td>${esc(formatLabel(f))}</td>
      <td class="mono">${esc(maskVin(f.vin))}</td>
      <td class="num" data-sort="${f.exportTime?.getTime() ?? ''}">${esc(fmtDate(f.exportTime))}</td>
      <td class="num" data-sort="${f.dataFrom?.getTime() ?? ''}">${f.dataFrom ? esc(fmtShort(f.dataFrom) + ' – ' + fmtShort(f.dataTo)) : '–'}</td>
      <td class="num" data-sort="${f.records.length}">${f.empty ? `<span class="tag">${esc(t('emptyTag'))}</span>` : f.records.length}</td>
      <td><button class="btn small ghost" data-del="${esc(f.id)}" type="button">${esc(t('remove'))}</button></td></tr>`).join('')}
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
  // Zweistufig statt confirm(): manche Umgebungen unterdrücken Browser-Dialoge, confirm() liefert dann sofort false
  const clearBtn = $('#clearBtn');
  const resetClear = () => { clearTimeout(clearBtn._t); clearBtn.classList.remove('confirm'); clearBtn.textContent = t('clearAll'); };
  clearBtn.onclick = async () => {
    if (!state.files.length) return;
    if (!clearBtn.classList.contains('confirm')) {
      clearBtn.classList.add('confirm'); clearBtn.textContent = t('confirmClearBtn');
      toast(t('confirmClear'), 4000);
      clearBtn._t = setTimeout(resetClear, 4000);
      return;
    }
    resetClear();
    state.files = []; await db.clear(); render();
    toast(t('toastCleared'));
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
  $('#themeSwitch').onclick = e => { const v = e.target.closest('button')?.dataset.themeOpt; if (v) setTheme(v); };
  $('#langSwitch').onclick = e => { const v = e.target.closest('button')?.dataset.langOpt; if (v) setLang(v); };
  $('#main').addEventListener('click', e => {
    const th = e.target.closest('th.sortable'); const table = th?.closest('table[id]');
    if (!table) return;
    const col = th.cellIndex, cur = sorts[table.id];
    sorts[table.id] = { col, dir: cur && cur.col === col ? -cur.dir : 1 };
    store.set('sorts', sorts);
    sortTable(table, col, sorts[table.id].dir);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => render());
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => state.charts.forEach(c => c.resize()), 150); });
}

// ---------- Farbschema & Sprache ----------
function setTheme(theme) {
  store.set('theme', theme);
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  syncSwitches();
  render();   // Diagramme lesen Farben beim Zeichnen aus den CSS-Variablen
}
function setLang(l) {
  if (!I18N[l] || l === lang) return;
  lang = l; store.set('lang', l);
  setFormatters();
  applyStaticTexts();
  render();
}
function syncSwitches() {
  const theme = store.get('theme', 'system');
  document.querySelectorAll('[data-theme-opt]').forEach(b => b.setAttribute('aria-pressed', b.dataset.themeOpt === theme));
  document.querySelectorAll('[data-lang-opt]').forEach(b => b.setAttribute('aria-pressed', b.dataset.langOpt === lang));
}
function applyStaticTexts() {
  document.documentElement.lang = lang;
  document.title = t('appTitle');
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); el.setAttribute('aria-label', el.title); });
  syncSwitches();
}

async function init() {
  applyStaticTexts();
  bind();
  const saved = await db.all();
  if (saved && saved.length) state.files = saved.map(p => buildFile(p));
  render();
}
init();
