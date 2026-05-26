// =============================================================
// track-service · frontend
// Vanilla JS app con hash routing. No build step.
// =============================================================

const state = {
  config: null,
  snapshot: null,   // { objects: [...], positions: [...] }
  selectedId: null, // id del vehículo elegido para reenvío/detalle
  fetchedAt: null,
};

// ---------- helpers genéricos ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k === 'html') e.innerHTML = String(v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === true) continue;
    if (c instanceof Node) e.appendChild(c);
    else if (typeof c === 'string' || typeof c === 'number') e.appendChild(document.createTextNode(String(c)));
    else console.warn('el(): hijo ignorado de tipo inesperado', { tag, child: c });
  }
  return e;
};
const fmtDate = (s) => {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d) ? String(s) : d.toLocaleString('es-CL', { hour12: false });
};
const fmtNum = (n, d = 0) => (n == null || isNaN(Number(n))) ? '—' : Number(n).toLocaleString('es-CL', { maximumFractionDigits: d, minimumFractionDigits: d });

// pick: extrae el primer campo no-nulo de un objeto, probando varias rutas
function pick(obj, paths, fallback = undefined) {
  if (!obj) return fallback;
  for (const p of paths) {
    const v = p.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
    if (v != null && v !== '') return v;
  }
  return fallback;
}

function toArray(x) {
  if (Array.isArray(x)) return x;
  if (x && Array.isArray(x.items)) return x.items;
  if (x && Array.isArray(x.data)) return x.data;
  if (x && Array.isArray(x.objects)) return x.objects;
  return x ? [x] : [];
}

function vehicleFields(o) {
  return {
    id: pick(o, ['id', 'object_id', 'uuid', 'imei']),
    name: pick(o, ['name', 'label', 'description'], '—'),
    imei: pick(o, ['imei', 'identifier'], '—'),
    model: pick(o, ['vehicle_params.model', 'model', 'object_model', 'manufacturer']),
    plate: pick(o, ['vehicle_params.plate_number', 'plate', 'license_plate', 'registration_number']),
    raw: o,
  };
}

function positionFields(p) {
  const lat = pick(p, ['position.latitude']);
  const lng = pick(p, ['position.longitude']);
  return {
    objectId: pick(p, ['object_id']),
    ts: pick(p, ['datetime']),
    lat: lat != null ? Number(lat) : null,
    lng: lng != null ? Number(lng) : null,
    speed: pick(p, ['position.speed']),
    direction: pick(p, ['position.direction']),
    altitude: pick(p, ['position.altitude']),
    ignition: pick(p, ['ignition_status']),
    sats: pick(p, ['position.satellites_count']),
    hdop: pick(p, ['device_inputs.hdop']),
    raw: p,
  };
}

function combineSnapshot(snap) {
  if (!snap) return [];
  const objs = toArray(snap.objects?.data);
  const poss = toArray(snap.positions?.data);
  const posIndex = new Map();
  for (const p of poss) {
    const id = pick(p, ['object_id', 'id']);
    if (id != null) posIndex.set(String(id), p);
  }
  return objs.map((o) => {
    const v = vehicleFields(o);
    const p = posIndex.get(String(v.id));
    return { ...v, position: p ? positionFields(p) : null };
  });
}

function ageMinutes(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (isNaN(d)) return null;
  return (Date.now() - d.getTime()) / 60000;
}
function statusFromAge(min) {
  if (min == null) return { label: 'sin datos', cls: 'muted' };
  if (min < 15) return { label: 'activo', cls: 'ok' };
  if (min < 60 * 24) return { label: 'inactivo', cls: 'warn' };
  return { label: 'sin reportes', cls: 'err' };
}

function toast(msg, kind = 'ok') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show ' + kind;
  setTimeout(() => { t.className = ''; }, 2800);
}

function relativeTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d)) return '—';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 0) return 'recién';
  if (s < 60) return `hace ${s}s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
}

// ---------- vehicleStore (localStorage + merge) ----------
// Mantiene la última posición conocida por vehículo. Solo sobrescribe si llega
// un datetime distinto al guardado. Siempre actualiza lastCheckedAt.
const VS_KEY = 'track-service.vehicles.v1';
const VS_GROUPS_KEY = 'track-service.fmGroups.v1';
const vehicleStore = {
  data: (() => { try { return JSON.parse(localStorage.getItem(VS_KEY) || '{}'); } catch { return {}; } })(),
  fmGroups: (() => { try { return JSON.parse(localStorage.getItem(VS_GROUPS_KEY) || '[]'); } catch { return []; } })(),
  groupsByVehicle: new Map(),
  listeners: new Set(),

  _rebuildGroupIndex() {
    this.groupsByVehicle = new Map();
    for (const g of this.fmGroups) {
      for (const vid of g.vehicles || []) {
        const key = String(vid);
        if (!this.groupsByVehicle.has(key)) this.groupsByVehicle.set(key, []);
        this.groupsByVehicle.get(key).push(g);
      }
    }
  },

  update(snapshot) {
    if (!snapshot) return;
    const now = new Date().toISOString();
    const objs = toArray(snapshot.objects?.data);
    const positions = toArray(snapshot.positions?.data);
    const posByObj = new Map();
    for (const p of positions) {
      const id = pick(p, ['object_id', 'id']);
      if (id != null) posByObj.set(String(id), p);
    }
    for (const o of objs) {
      const id = String(pick(o, ['id', 'object_id', 'uuid', 'imei']) || '');
      if (!id) continue;
      const prev = this.data[id] || {};
      let position = prev.position || null;
      let positionUpdatedAt = prev.positionUpdatedAt || null;
      const incoming = posByObj.get(id);
      if (incoming) {
        const newTs = pick(incoming, ['datetime']);
        const prevTs = position ? pick(position, ['datetime']) : null;
        if (newTs && newTs !== prevTs) {
          position = incoming;
          positionUpdatedAt = now;
        }
      }
      this.data[id] = { vehicle: o, position, positionUpdatedAt, lastCheckedAt: now };
    }
    // Grupos fm-track
    const incomingGroups = toArray(snapshot.groups?.data);
    if (incomingGroups.length) {
      this.fmGroups = incomingGroups;
      try { localStorage.setItem(VS_GROUPS_KEY, JSON.stringify(this.fmGroups)); } catch {}
    }
    this._rebuildGroupIndex();
    try { localStorage.setItem(VS_KEY, JSON.stringify(this.data)); } catch {}
    for (const fn of this.listeners) { try { fn(); } catch (e) { console.error(e); } }
  },

  list() {
    return Object.entries(this.data).map(([id, d]) => {
      const v = vehicleFields(d.vehicle);
      const p = d.position ? positionFields(d.position) : null;
      const grps = this.groupsByVehicle.get(String(id)) || [];
      return { ...v, position: p, positionUpdatedAt: d.positionUpdatedAt, lastCheckedAt: d.lastCheckedAt, fmGroups: grps };
    });
  },

  groupsList() { return this.fmGroups; },
  get(id) { return this.data[String(id)]; },
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  clear() {
    this.data = {}; this.fmGroups = []; this.groupsByVehicle = new Map();
    try { localStorage.removeItem(VS_KEY); localStorage.removeItem(VS_GROUPS_KEY); } catch {}
    for (const fn of this.listeners) try { fn(); } catch {}
  },
};
vehicleStore._rebuildGroupIndex();

// ---------- polling ----------
const POLL_INTERVAL_MS = 10000;
let pollTimer = null;
let lastPollAt = null;
async function pollSnapshot() {
  try {
    const r = await api('/api/snapshot');
    if (!r || r.error) return;
    state.snapshot = r;
    state.fetchedAt = new Date().toISOString();
    lastPollAt = state.fetchedAt;
    vehicleStore.update(r);
    updatePollPill();

    // Log raw para inspección desde DevTools
    const objs = toArray(r.objects?.data);
    const poss = toArray(r.positions?.data);
    console.groupCollapsed(`%c[poll ${new Date().toLocaleTimeString('es-CL', { hour12: false })}] %c${objs.length} objetos · ${poss.length} posiciones`,
      'color: #5b8def; font-weight: 600;', 'color: inherit;');
    console.log('objects (fm-track GET /objects):', objs);
    console.log('positions (último por vehículo):', poss);
    console.log('snapshot completo:', r);
    console.groupEnd();
  } catch (err) {
    console.warn('[poll] error', err);
  }
}
function startPolling() {
  if (pollTimer) return;
  pollSnapshot();
  pollTimer = setInterval(pollSnapshot, POLL_INTERVAL_MS);
  setInterval(updatePollPill, 1000); // refresca el "hace Xs" en topbar
}
function updatePollPill() {
  const pill = $('#pollPill');
  if (!pill) return;
  if (!lastPollAt) { pill.textContent = 'auto · esperando'; pill.className = 'pill warn'; return; }
  pill.textContent = `auto · ${relativeTime(lastPollAt)}`;
  pill.className = 'pill ok';
}

// ---------- API client ----------
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function loadConfig() {
  state.config = await api('/api/config');
  const c = state.config;
  $('#cfgFmTrack').innerHTML = `fm-track key: ${c.fmTrackKeyConfigured ? '<span class="badge ok">ok</span>' : '<span class="badge err">falta</span>'}`;
  $('#cfgTarget').innerHTML = `destino: ${c.targetApiUrl ? `<span class="badge ok">${shortUrl(c.targetApiUrl)}</span>` : '<span class="badge muted">sin set</span>'}`;
  const ok = c.fmTrackKeyConfigured;
  $('#connPill').className = 'pill ' + (ok ? 'ok' : 'err');
  $('#connPill').textContent = ok ? 'API key cargada' : 'API key faltante';
}
function shortUrl(u) { try { return new URL(u).host; } catch { return u; } }

async function loadSnapshot() {
  const view = $('#view');
  const r = await api('/api/snapshot');
  if (r.error) { toast(r.error, 'err'); return null; }
  state.snapshot = r;
  state.fetchedAt = new Date().toISOString();
  return r;
}

// ---------- views ----------
const views = {};

views.resumen = async () => {
  $('#pageTitle').textContent = 'Resumen';
  const view = $('#view');
  const c = state.config || {};
  if (!c.fmTrackKeyConfigured) {
    view.replaceChildren(emptyState('Falta la API key', 'Edita <code>.env</code> y agrega <code>FM_TRACK_API_KEY</code>, luego reinicia el servidor.'));
    return;
  }

  view.innerHTML = '';
  view.appendChild(loadingCard('Cargando snapshot…'));

  const [snap, qaH, faH] = await Promise.all([
    loadSnapshot(),
    api('/api/schedules/history?limit=500').catch(() => ({ entries: [] })),
    api('/api/falabella/history?limit=500').catch(() => ({ entries: [] })),
  ]);
  if (!snap) { view.innerHTML = ''; view.appendChild(emptyState('No se pudo cargar', 'Revisa los logs.')); return; }
  const okObjs = snap.objects?.ok, okPos = snap.positions?.ok;
  const combined = combineSnapshot(snap);
  const active = combined.filter(v => v.position && ageMinutes(v.position.ts) < 15).length;

  // Métricas de envíos últimas 24h
  const dayAgo = Date.now() - 86400 * 1000;
  const allSends = [
    ...(qaH.entries || []).map(e => ({ ...e, kind: 'qa', service: 'Q Analytics',
      accepted: e.ok, patente: e.payload?.PLACA || e.vehicleId,
      eventTs: e.payload?.FH_RPT_GPS, speed: e.payload?.VEL })),
    ...(faH.entries || []).map(e => ({ ...e, kind: 'falabella', service: 'Falabella',
      patente: e.payload?.vehicleId || e.vehicleId,
      eventTs: e.payload?.timestamp, speed: e.payload?.speed?.value })),
  ].sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const last24 = allSends.filter(e => new Date(e.ts).getTime() >= dayAgo);
  const accepted24 = last24.filter(e => e.accepted).length;
  const errors24 = last24.filter(e => !e.ok).length;

  view.innerHTML = '';
  view.appendChild(el('div', { class: 'grid cols-4' },
    kpi('Vehículos', combined.length),
    kpi('Activos (<15m)', active, 'ok'),
    kpi('Envíos últimas 24h', last24.length),
    kpi('Aceptados / errores 24h', `${accepted24} / ${errors24}`, errors24 ? 'warn' : 'ok'),
  ));

  view.appendChild(el('div', { class: 'split' },
    card('Estado del sistema',
      el('div', { class: 'kv' },
        kv('fm-track GET /objects', `HTTP ${snap.objects?.status} ${okObjs ? '✓' : '✗'}`),
        kv('Última actualización', new Date(state.fetchedAt).toLocaleString('es-CL', { hour12: false })),
        kv('Base URL', state.config.fmTrackBaseUrl),
        kv('Q Analytics token', c.qaTokenConfigured
          ? el('span', { class: 'badge ok' }, 'configurado')
          : el('span', { class: 'badge warn' }, 'sin token')),
        kv('Falabella apikey TEST', el('span', { class: 'badge ok' }, 'configurada')),
      ),
    ),
    card('Vehículos recientes',
      combined.length === 0
        ? el('div', { class: 'empty' }, 'Sin vehículos en la respuesta')
        : compactTable(combined.slice(0, 6))
    ),
  ));

  // Grupos pre-armados en fm-track — acceso rápido desde el resumen
  try {
    const fmGroupsRes = await api('/api/fm-track/groups');
    const fmGroups = fmGroupsRes.groups || [];
    const tmsConfigRes = await api('/api/falabella/groups');
    const tmsGroups = tmsConfigRes.groups || {};
    if (fmGroups.length) {
      view.appendChild(renderFmTrackGroupsCardSync(fmGroups, vehicleStore.list(), tmsGroups, c));
    }
  } catch {}

  // Historial de envíos compacto
  const recentSends = allSends.slice(0, 15);
  const sendsCard = el('div', { class: 'card' });
  sendsCard.appendChild(el('div', { class: 'card-header' },
    el('h2', {}, 'Envíos recientes'),
    el('div', { class: 'spacer' }),
    el('span', { class: 'badge muted' }, `${allSends.length} totales`),
    el('a', { href: '#/envios', style: 'margin-left: 8px; font-size: 12px;' }, 'Ver todos →'),
  ));
  if (!recentSends.length) {
    sendsCard.appendChild(el('div', { class: 'card-body' },
      el('div', { class: 'empty' }, 'Aún no se ha enviado nada. Activa el auto-envío en algún grupo para empezar.')));
  } else {
    const tbl = el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Patente'),
        el('th', {}, 'Servicio'),
        el('th', {}, 'Fecha envío'),
        el('th', {}, 'Velocidad'),
        el('th', {}, 'Estado'),
      )),
      el('tbody', {}, ...recentSends.map(e => {
        const statusCls = !e.ok ? 'badge err' : (e.accepted ? 'badge ok' : 'badge warn');
        const statusText = e.error ? 'error' : (e.accepted ? '✓ aceptado'
          : (e.ok ? (e.response?.message || 'rechazado') : `HTTP ${e.status || 0}`));
        return el('tr', {},
          el('td', {}, el('b', {}, String(e.patente || '—'))),
          el('td', {}, el('span', { class: 'badge muted' }, e.service)),
          el('td', {}, fmtDate(e.ts)),
          el('td', {}, e.speed != null ? String(e.speed) : '—'),
          el('td', {}, el('span', { class: statusCls }, statusText)),
        );
      })),
    );
    sendsCard.appendChild(el('div', { class: 'card-body tight' }, tbl));
  }
  view.appendChild(sendsCard);
};

let vehiculosUnsub = null;
let vehiculosOpenId = null;
views.vehiculos = async () => {
  $('#pageTitle').textContent = 'Vehículos';
  if (!state.config?.fmTrackKeyConfigured) return $('#view').replaceChildren(emptyState('Falta la API key'));

  const view = $('#view');

  const search = el('input', { type: 'search', placeholder: 'Filtrar por nombre, IMEI, patente…' });
  const groupFilter = el('select', { style: 'min-width: 180px;' });
  const totalsBadge = el('span', { class: 'badge muted' });
  function rebuildGroupFilter() {
    const prev = groupFilter.value;
    groupFilter.innerHTML = '';
    groupFilter.appendChild(el('option', { value: '' }, 'Todos los grupos'));
    for (const g of vehicleStore.groupsList()) {
      groupFilter.appendChild(el('option', { value: g.id }, `${g.name} (${g.vehicles.length})`));
    }
    groupFilter.value = prev;
  }
  rebuildGroupFilter();

  const tbl = el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {},
      el('th', { style: 'width: 28px;' }, ''),
      el('th', {}, 'Nombre'), el('th', {}, 'IMEI'),
      el('th', {}, 'Grupos fm-track'),
      el('th', {}, 'Última posición'), el('th', {}, 'Antigüedad'),
      el('th', {}, 'Velocidad'), el('th', {}, 'Estado'),
      el('th', { title: 'Cuándo se hizo la última consulta a fm-track para este vehículo' }, 'Consultado'),
    )),
  );
  const body = el('tbody');
  tbl.appendChild(body);

  function renderRows() {
    rebuildGroupFilter();
    const combined = vehicleStore.list().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const q = search.value.trim().toLowerCase();
    const gid = groupFilter.value;
    const rows = combined.filter(v => {
      if (gid && !(v.fmGroups || []).some(g => g.id === gid)) return false;
      if (!q) return true;
      return String(v.name).toLowerCase().includes(q) ||
        String(v.imei).toLowerCase().includes(q) ||
        String(v.plate || '').toLowerCase().includes(q);
    });
    totalsBadge.textContent = `${rows.length} de ${combined.length}`;
    body.innerHTML = '';
    if (!rows.length) {
      body.appendChild(el('tr', {}, el('td', { colspan: 9, class: 'empty' }, 'Sin resultados')));
      return;
    }
    for (const v of rows) {
      const id = String(v.id);
      const st = statusFromAge(v.position ? ageMinutes(v.position.ts) : null);
      const groupsCell = (v.fmGroups || []).length
        ? el('div', { style: 'display:flex; flex-wrap:wrap; gap:4px;' },
            ...v.fmGroups.map(g => el('span', { class: 'badge muted', title: g.id }, g.name)))
        : el('span', { class: 'badge muted' }, '—');

      const isOpen = vehiculosOpenId === id;
      const chevron = el('span', { style: 'display: inline-block; transition: transform 0.15s; transform: rotate(' + (isOpen ? '90' : '0') + 'deg); color: var(--text-dim);' }, '▸');
      const detailRow = el('tr', { class: 'detail-row', style: 'display: ' + (isOpen ? '' : 'none') + '; background: var(--bg-soft);' },
        el('td', { colspan: 9, style: 'padding: 0;' },
          el('div', { style: 'padding: 16px 20px;' }, isOpen ? renderDetailInline(v) : ''),
        ),
      );
      const tr = el('tr', { class: isOpen ? 'selected' : '', style: 'cursor: pointer;' },
        el('td', {}, chevron),
        el('td', {}, v.name),
        el('td', {}, String(v.imei)),
        el('td', {}, groupsCell),
        el('td', {}, v.position ? fmtDate(v.position.ts) : '—'),
        el('td', {}, v.position ? relativeTime(v.position.ts) : el('span', { class: 'badge muted' }, 'sin datos')),
        el('td', {}, v.position?.speed != null ? fmtNum(v.position.speed, 1) + ' km/h' : '—'),
        el('td', {}, el('span', { class: 'badge ' + st.cls }, st.label)),
        el('td', {}, el('small', { style: 'color: var(--text-dim)' }, relativeTime(v.lastCheckedAt))),
      );
      tr.addEventListener('click', () => {
        vehiculosOpenId = vehiculosOpenId === id ? null : id;
        state.selectedId = vehiculosOpenId;
        renderRows();
      });
      body.appendChild(tr);
      body.appendChild(detailRow);
    }
  }
  search.addEventListener('input', renderRows);
  groupFilter.addEventListener('change', renderRows);

  view.innerHTML = '';
  view.appendChild(el('div', { class: 'card' },
    el('div', { class: 'toolbar' }, search, groupFilter, totalsBadge,
      el('span', { style: 'flex:1' }),
      el('button', { class: 'ghost', onclick: () => { if (confirm('Borrar caché localStorage de vehículos?')) { vehicleStore.clear(); pollSnapshot(); } } }, 'Limpiar caché'),
    ),
    el('div', { class: 'card-body tight' }, tbl),
  ));
  renderRows();

  // Auto-rerender cuando llegue nueva data
  if (vehiculosUnsub) vehiculosUnsub();
  vehiculosUnsub = vehicleStore.subscribe(() => {
    if (currentView() !== 'vehiculos') { vehiculosUnsub?.(); vehiculosUnsub = null; return; }
    renderRows();
  });
};

// Versión del renderDetail sin el contenedor card (para ir dentro de la fila expandida)
function renderDetailInline(v) {
  return el('div', {},
    el('div', { class: 'kv', style: 'margin-bottom: 18px;' },
      kv('ID', String(v.id)),
      kv('IMEI', String(v.imei)),
      kv('Modelo', v.model || '—'),
      kv('Patente', v.plate || '—'),
      ...(v.position ? [
        kv('Latitud', fmtNum(v.position.lat, 6)),
        kv('Longitud', fmtNum(v.position.lng, 6)),
        kv('Velocidad', v.position.speed != null ? fmtNum(v.position.speed, 1) + ' km/h' : '—'),
        kv('Dirección', v.position.direction != null ? fmtNum(v.position.direction, 0) + '°' : '—'),
        kv('Altitud', v.position.altitude != null ? fmtNum(v.position.altitude, 0) + ' m' : '—'),
        kv('Satélites', v.position.sats != null ? String(v.position.sats) : '—'),
        kv('HDOP', v.position.hdop != null ? String(v.position.hdop) : '—'),
        kv('Ignición', v.position.ignition || '—'),
        kv('GPS time', fmtDate(v.position.ts)),
      ] : [kv('Posición', el('span', { class: 'badge muted' }, 'sin reportes'))]),
    ),
    el('div', { class: 'split' },
      el('div', {},
        el('h2', { style: 'font-size: 0.9rem; margin: 0 0 8px;' }, 'fm-track · objeto crudo'),
        el('pre', { style: 'max-height: 240px;' }, JSON.stringify(v.raw, null, 2)),
      ),
      v.position
        ? el('div', {},
            el('h2', { style: 'font-size: 0.9rem; margin: 0 0 8px;' }, 'fm-track · posición cruda'),
            el('pre', { style: 'max-height: 240px;' }, JSON.stringify(v.position.raw, null, 2)),
          )
        : el('div', {}),
    ),
  );
}

function renderDetail(v) {
  const qaSection = el('div', {},
    el('div', { class: 'empty', style: 'padding: 20px 0;' },
      el('span', { class: 'spinner' }), ' construyendo payload Q Analytics…'),
  );
  loadQAPreviewInto(v.id, qaSection);

  return el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('h2', {}, v.name),
      el('div', { class: 'spacer' }),
      el('button', { class: 'ghost', onclick: () => { state.selectedId = String(v.id); location.hash = '#/reenviar'; } }, 'Ver en scheduler →'),
    ),
    el('div', { class: 'card-body' },
      el('div', { class: 'kv' },
        kv('ID', String(v.id)),
        kv('IMEI', String(v.imei)),
        kv('Modelo', v.model || '—'),
        kv('Patente', v.plate || '—'),
        ...(v.position ? [
          kv('Latitud', fmtNum(v.position.lat, 6)),
          kv('Longitud', fmtNum(v.position.lng, 6)),
          kv('Velocidad', v.position.speed != null ? fmtNum(v.position.speed, 1) + ' km/h' : '—'),
          kv('Dirección', v.position.direction != null ? fmtNum(v.position.direction, 0) + '°' : '—'),
          kv('Altitud', v.position.altitude != null ? fmtNum(v.position.altitude, 0) + ' m' : '—'),
          kv('Satélites', v.position.sats != null ? String(v.position.sats) : '—'),
          kv('HDOP', v.position.hdop != null ? String(v.position.hdop) : '—'),
          kv('Ignición', v.position.ignition || '—'),
          kv('GPS time', fmtDate(v.position.ts)),
        ] : [kv('Posición', el('span', { class: 'badge muted' }, 'sin reportes'))]),
      ),

      el('h2', { style: 'font-size: 0.9rem; margin: 18px 0 8px;' }, 'Payload Q Analytics'),
      qaSection,

      el('h2', { style: 'font-size: 0.9rem; margin: 18px 0 8px;' }, 'fm-track · objeto crudo'),
      el('pre', { style: 'max-height: 240px;' }, JSON.stringify(v.raw, null, 2)),
      v.position && el('div', {},
        el('h2', { style: 'font-size: 0.9rem; margin: 18px 0 8px;' }, 'fm-track · posición cruda'),
        el('pre', { style: 'max-height: 240px;' }, JSON.stringify(v.position.raw, null, 2)),
      ),
    ),
  );
}

async function loadQAPreviewInto(vehicleId, container) {
  const r = await api('/api/schedules/' + encodeURIComponent(vehicleId) + '/preview');
  container.innerHTML = '';
  if (!r.ok) {
    container.appendChild(el('div', { class: 'empty' },
      el('div', { class: 'em-title' }, 'No se puede construir payload'),
      r.error || 'sin datos suficientes',
    ));
    return;
  }
  const p = r.payload;

  const plateInput = el('input', { type: 'text', value: p.PLACA, placeholder: 'PLACA', style: 'width: 140px;' });
  const refreshBtn = el('button', { class: 'ghost', onclick: async () => {
    await api('/api/schedules/' + encodeURIComponent(vehicleId), {
      method: 'PUT', body: JSON.stringify({ plate: plateInput.value }),
    });
    loadQAPreviewInto(vehicleId, container);
  } }, '↻ Aplicar y recalcular');

  const respPre = el('pre', { style: 'max-height: 200px;' }, '(aún no se envía)');
  const statusBox = el('span', {});

  const sendBtn = el('button', { onclick: async () => {
    if (!state.config?.qaTokenConfigured) {
      toast('Falta QA_API_TOKEN en .env', 'err'); return;
    }
    sendBtn.disabled = true; sendBtn.textContent = 'enviando…';
    await api('/api/schedules/' + encodeURIComponent(vehicleId), {
      method: 'PUT', body: JSON.stringify({ plate: plateInput.value }),
    });
    const send = await api('/api/schedules/' + encodeURIComponent(vehicleId) + '/run-now', {
      method: 'POST', body: JSON.stringify({ plate: plateInput.value }),
    });
    sendBtn.disabled = false; sendBtn.textContent = 'Enviar a Q ahora';
    statusBox.innerHTML = `<span class="badge ${send.ok ? 'ok' : 'err'}">HTTP ${send.status ?? 0}</span>`;
    respPre.textContent = JSON.stringify(send.response ?? send, null, 2);
    toast(`HTTP ${send.status ?? 0}`, send.ok ? 'ok' : 'err');
  } }, 'Enviar a Q ahora');

  container.appendChild(el('div', {},
    el('div', { class: 'row', style: 'margin-bottom: 10px;' },
      field('PLACA (editable)', plateInput),
      refreshBtn,
    ),
    el('div', { class: 'kv' },
      kv('COD_VEH', String(p.COD_VEH)),
      kv('PLACA', String(p.PLACA)),
      kv('LAT', String(p.LAT)),
      kv('LON', String(p.LON)),
      kv('FH_SVR_GPS', String(p.FH_SVR_GPS)),
      kv('FH_RPT_GPS', String(p.FH_RPT_GPS)),
      kv('VEL', String(p.VEL)),
      kv('SENT', String(p.SENT)),
      kv('CANT_SAT', String(p.CANT_SAT)),
      kv('HDOP', String(p.HDOP)),
      kv('IGN', String(p.IGN)),
      ...(p.ALT != null ? [kv('ALT', String(p.ALT))] : []),
    ),
    el('h2', { style: 'font-size: 0.85rem; margin: 14px 0 6px; color: var(--text-dim);' }, 'JSON exacto que se POSTea'),
    el('pre', { style: 'max-height: 200px;' }, JSON.stringify([p], null, 2)),
    el('div', { class: 'row', style: 'margin-top: 12px;' }, sendBtn, statusBox),
    el('h2', { style: 'font-size: 0.85rem; margin: 14px 0 6px; color: var(--text-dim);' }, 'Respuesta de Q Analytics'),
    respPre,
  ));
}

let mapInstance = null;
let markerLayer = null;
views.mapa = async () => {
  $('#pageTitle').textContent = 'Mapa';
  if (!state.config.fmTrackKeyConfigured) return $('#view').replaceChildren(emptyState('Falta la API key'));

  const view = $('#view');
  view.innerHTML = '';
  view.appendChild(loadingCard('Cargando posiciones…'));

  if (!state.snapshot) await loadSnapshot();
  const combined = combineSnapshot(state.snapshot).filter(v => v.position && v.position.lat != null && v.position.lng != null);

  view.innerHTML = '';
  const mapDiv = el('div', { id: 'map' });
  view.appendChild(card('Posiciones en tiempo real',
    combined.length === 0
      ? el('div', { class: 'empty' }, el('div', { class: 'em-title' }, 'Sin posiciones'), 'Las respuestas no tienen lat/lng o vienen con otros nombres de campo.')
      : mapDiv));

  if (combined.length === 0) return;

  // Inicializar mapa
  if (mapInstance) { mapInstance.remove(); mapInstance = null; }
  mapInstance = L.map('map').setView([combined[0].position.lat, combined[0].position.lng], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 19,
  }).addTo(mapInstance);
  markerLayer = L.layerGroup().addTo(mapInstance);

  const bounds = [];
  for (const v of combined) {
    const m = L.marker([v.position.lat, v.position.lng]).addTo(markerLayer);
    m.bindPopup(`<b>${escapeHtml(v.name)}</b><br>IMEI: ${escapeHtml(String(v.imei))}<br>${fmtDate(v.position.ts)}<br>${fmtNum(v.position.speed, 1)} km/h`);
    bounds.push([v.position.lat, v.position.lng]);
  }
  if (bounds.length > 1) mapInstance.fitBounds(bounds, { padding: [40, 40] });
};

// ---------- vista: Q Analytics scheduler ----------
let reenviarRefresh = null;
views.reenviar = async () => {
  $('#pageTitle').textContent = 'Q Analytics · envío programado';
  const view = $('#view');
  view.innerHTML = '';
  view.appendChild(loadingCard('Cargando vehículos y programaciones…'));

  await renderScheduler();

  // refresco automático del historial cada 3s mientras la vista está abierta
  if (reenviarRefresh) clearInterval(reenviarRefresh);
  reenviarRefresh = setInterval(async () => {
    if (currentView() !== 'reenviar') { clearInterval(reenviarRefresh); reenviarRefresh = null; return; }
    await refreshHistoryAndStatuses();
  }, 3000);
};

async function renderScheduler() {
  const view = $('#view');
  const data = await api('/api/schedules');
  const vehicles = data.vehicles || [];
  const schedules = data.schedules || {};
  const cfg = state.config;

  view.innerHTML = '';

  // Status bar
  view.appendChild(card('Destino',
    el('div', { class: 'kv' },
      kv('URL', cfg.qaApiUrl || '—'),
      kv('Token', cfg.qaTokenConfigured
        ? el('span', { class: 'badge ok' }, 'configurado')
        : el('span', { class: 'badge err' }, 'falta QA_API_TOKEN en .env')),
      kv('Vehículos disponibles', String(vehicles.length)),
      kv('Programaciones activas', String(Object.values(schedules).filter(s => s.enabled).length)),
    ),
  ));

  // Tabla de vehículos con controles
  const tbl = el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Vehículo'),
      el('th', {}, 'COD_VEH'),
      el('th', {}, 'PLACA'),
      el('th', {}, 'Intervalo (seg)'),
      el('th', {}, 'Estado'),
      el('th', {}, 'Última ejecución'),
      el('th', {}, 'Acciones'),
    )),
  );
  const tbody = el('tbody');
  tbl.appendChild(tbody);

  for (const v of vehicles) {
    const sch = schedules[v.id] || { intervalSec: 60, enabled: false };
    const plate = sch.plate ?? v.plate ?? '';

    const plateInput = el('input', { type: 'text', value: plate, placeholder: 'PLACA', style: 'width: 120px;' });
    const intervalInput = el('input', { type: 'number', min: '5', value: String(sch.intervalSec || 60), style: 'width: 90px;' });
    const toggle = el('input', { type: 'checkbox', ...(sch.enabled ? { checked: 'checked' } : {}) });

    const savePartial = debounce(async () => {
      await api('/api/schedules/' + encodeURIComponent(v.id), {
        method: 'PUT',
        body: JSON.stringify({
          plate: plateInput.value,
          intervalSec: Number(intervalInput.value) || 60,
          enabled: toggle.checked,
        }),
      });
      toast(`${v.name || v.id}: configuración guardada`);
    }, 400);

    plateInput.addEventListener('input', savePartial);
    intervalInput.addEventListener('input', savePartial);
    toggle.addEventListener('change', savePartial);

    const sendNowBtn = el('button', { class: 'ghost', onclick: async () => {
      sendNowBtn.disabled = true; sendNowBtn.textContent = '…';
      const r = await api('/api/schedules/' + encodeURIComponent(v.id) + '/run-now', {
        method: 'POST',
        body: JSON.stringify({ plate: plateInput.value }),
      });
      sendNowBtn.disabled = false; sendNowBtn.textContent = 'Enviar ahora';
      toast(`${v.name || v.id}: HTTP ${r.status ?? 0}`, r.ok ? 'ok' : 'err');
      await refreshHistoryAndStatuses();
    } }, 'Enviar ahora');

    const previewBtn = el('button', { class: 'ghost', onclick: async () => {
      // guardamos la placa primero para que el preview la use
      await api('/api/schedules/' + encodeURIComponent(v.id), {
        method: 'PUT', body: JSON.stringify({ plate: plateInput.value }),
      });
      const r = await api('/api/schedules/' + encodeURIComponent(v.id) + '/preview');
      openPreviewModal(v, r);
    } }, 'Vista previa');

    const lastBadge = sch.lastStatus === 'ok' ? el('span', { class: 'badge ok' }, `HTTP ${sch.lastHttp}`)
      : sch.lastStatus === 'err' ? el('span', { class: 'badge err' }, `HTTP ${sch.lastHttp}`)
      : el('span', { class: 'badge muted' }, '—');

    tbody.appendChild(el('tr', { 'data-vid': v.id },
      el('td', {}, el('div', {}, v.name || '(sin nombre)'), el('small', { style: 'color:var(--text-dim)' }, v.imei || '')),
      el('td', {}, el('code', {}, v.id)),
      el('td', {}, plateInput),
      el('td', {}, intervalInput),
      el('td', {}, el('label', { style: 'display:flex; gap:6px; align-items:center;' }, toggle, sch.enabled ? 'enviando' : 'pausado')),
      el('td', { 'data-col': 'last' },
        sch.lastRunAt ? el('div', {}, fmtDate(sch.lastRunAt)) : el('span', { class: 'badge muted' }, 'nunca'),
        ' ', lastBadge),
      el('td', {}, el('div', { class: 'row', style: 'gap: 6px; flex-wrap: nowrap;' }, sendNowBtn, previewBtn)),
    ));
  }

  view.appendChild(card('Vehículos',
    vehicles.length === 0 ? el('div', { class: 'empty' }, 'Sin vehículos en fm-track') : tbl,
  ));

  // Historial
  const historyBox = el('div', { id: 'historyBox' }, el('div', { class: 'empty' }, el('span', { class: 'spinner' }), ' cargando historial…'));
  view.appendChild(card('Historial de envíos',
    el('div', {},
      el('div', { class: 'row', style: 'margin-bottom: 10px;' },
        el('button', { class: 'ghost', onclick: refreshHistoryAndStatuses }, '↻ Refrescar'),
        el('small', { style: 'color: var(--text-dim)' }, 'se actualiza solo cada 3s'),
      ),
      historyBox,
    ),
  ));

  await refreshHistoryAndStatuses();
}

async function refreshHistoryAndStatuses() {
  // Actualizar tabla de programaciones (lastRunAt, lastStatus)
  try {
    const data = await api('/api/schedules');
    for (const [id, sch] of Object.entries(data.schedules || {})) {
      const tr = document.querySelector(`tr[data-vid="${cssEscape(id)}"]`);
      if (!tr) continue;
      const cell = tr.querySelector('[data-col="last"]');
      if (!cell) continue;
      cell.innerHTML = '';
      cell.appendChild(sch.lastRunAt ? el('div', {}, fmtDate(sch.lastRunAt)) : el('span', { class: 'badge muted' }, 'nunca'));
      cell.appendChild(document.createTextNode(' '));
      const badge = sch.lastStatus === 'ok' ? el('span', { class: 'badge ok' }, `HTTP ${sch.lastHttp}`)
        : sch.lastStatus === 'err' ? el('span', { class: 'badge err' }, `HTTP ${sch.lastHttp}`)
        : el('span', { class: 'badge muted' }, '—');
      cell.appendChild(badge);
    }
  } catch {}

  // Historial
  const box = document.getElementById('historyBox');
  if (!box) return;
  try {
    const h = await api('/api/schedules/history?limit=50');
    const entries = h.entries || [];
    if (entries.length === 0) { box.innerHTML = '<div class="empty">sin envíos aún</div>'; return; }
    const t = el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Cuándo'), el('th', {}, 'Vehículo'), el('th', {}, 'Tipo'),
        el('th', {}, 'HTTP'), el('th', {}, 'Detalle'),
      )),
      el('tbody', {}, ...entries.map(e => {
        const okCls = e.ok ? 'badge ok' : 'badge err';
        const detail = e.error ? e.error : (typeof e.response === 'string' ? e.response : JSON.stringify(e.response || ''));
        const row = el('tr', {},
          el('td', {}, fmtDate(e.ts)),
          el('td', {}, el('code', {}, String(e.vehicleId))),
          el('td', {}, e.manual ? el('span', { class: 'badge muted' }, 'manual') : el('span', { class: 'badge muted' }, 'auto')),
          el('td', {}, el('span', { class: okCls }, `HTTP ${e.status ?? 0}`)),
          el('td', { style: 'max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;', title: detail }, detail.slice(0, 160)),
        );
        row.addEventListener('click', () => alert(JSON.stringify({ payload: e.payload, response: e.response, error: e.error }, null, 2)));
        return row;
      })),
    );
    box.innerHTML = '';
    box.appendChild(t);
  } catch {}
}

function debounce(fn, ms) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function cssEscape(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c); }

function openPreviewModal(vehicle, result) {
  const overlay = el('div', {
    style: 'position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 9998; display: flex; align-items: center; justify-content: center; padding: 24px;',
    onclick: (e) => { if (e.target === overlay) document.body.removeChild(overlay); },
  });
  const box = el('div', {
    style: 'background: var(--bg-elev); border: 1px solid var(--border); border-radius: 10px; max-width: 1100px; width: 100%; max-height: 90vh; display: flex; flex-direction: column; overflow: hidden;',
  });
  const header = el('div', { class: 'card-header' },
    el('h2', {}, `Vista previa · ${vehicle.name || vehicle.id}`),
    el('div', { class: 'spacer' }),
    el('button', { class: 'ghost', onclick: () => document.body.removeChild(overlay) }, 'Cerrar'),
  );
  const body = el('div', { style: 'padding: 18px; overflow: auto;' });

  if (!result.ok) {
    body.appendChild(el('div', { class: 'empty' },
      el('div', { class: 'em-title' }, 'No se pudo construir el payload'),
      el('div', {}, result.error || 'error desconocido'),
    ));
  } else {
    const p = result.payload;
    body.appendChild(el('div', {},
      el('h2', { style: 'font-size: 0.95rem; margin: 0 0 10px;' }, 'Payload que se enviará a Q Analytics'),
      el('div', { class: 'kv', style: 'margin-bottom: 14px;' },
        kv('COD_VEH', String(p.COD_VEH)),
        kv('PLACA', String(p.PLACA)),
        kv('LAT', String(p.LAT)),
        kv('LON', String(p.LON)),
        kv('FH_SVR_GPS', String(p.FH_SVR_GPS)),
        kv('FH_RPT_GPS', String(p.FH_RPT_GPS)),
        kv('VEL (km/h)', String(p.VEL)),
        kv('SENT (°)', String(p.SENT)),
        kv('CANT_SAT', String(p.CANT_SAT)),
        kv('HDOP', String(p.HDOP)),
        kv('IGN', String(p.IGN)),
        ...(p.ALT != null ? [kv('ALT (m)', String(p.ALT))] : []),
      ),
      el('pre', {}, JSON.stringify([p], null, 2)),
      el('div', { class: 'split', style: 'margin-top: 18px;' },
        el('div', {},
          el('h2', { style: 'font-size: 0.9rem; margin: 0 0 6px;' }, 'fm-track · objeto crudo'),
          el('pre', { style: 'max-height: 280px;' }, JSON.stringify(result.raw?.object, null, 2)),
        ),
        el('div', {},
          el('h2', { style: 'font-size: 0.9rem; margin: 0 0 6px;' }, 'fm-track · posición cruda'),
          el('pre', { style: 'max-height: 280px;' }, JSON.stringify(result.raw?.position, null, 2)),
        ),
      ),
    ));
  }

  box.appendChild(header); box.appendChild(body); overlay.appendChild(box);
  document.body.appendChild(overlay);
}

// ---------- vista: Falabella ----------
let falabellaUnsub = null;
let falabellaLastCount = -1;
const falabellaSelected = new Set();

views.falabella = async () => {
  $('#pageTitle').textContent = 'TMS · envío de posiciones GPS';
  const view = $('#view');
  view.innerHTML = '';
  view.appendChild(loadingCard('Cargando grupos y configuración…'));

  // Si el store está vacío, forzar un poll inmediato para que aparezcan los camiones
  if (vehicleStore.list().length === 0) pollSnapshot();

  await renderFalabella();

  // Suscribirse para re-renderizar cuando lleguen nuevos vehículos (solo si cambia el conteo)
  if (falabellaUnsub) falabellaUnsub();
  falabellaLastCount = vehicleStore.list().length;
  falabellaUnsub = vehicleStore.subscribe(() => {
    if (currentView() !== 'falabella') { falabellaUnsub?.(); falabellaUnsub = null; return; }
    const n = vehicleStore.list().length;
    if (n !== falabellaLastCount) { falabellaLastCount = n; renderFalabella(); }
  });
};

async function renderFalabella() {
  const view = $('#view');
  const [cfg, groupsRes] = await Promise.all([
    api('/api/falabella/config'),
    api('/api/falabella/groups'),
  ]);
  const groups = groupsRes.groups || {};
  const vehicles = vehicleStore.list().sort((a, b) => String(a.name).localeCompare(String(b.name)));

  view.innerHTML = '';

  // Config (las credenciales viven en .env)
  const providerOk = Boolean(cfg.defaultProvider?.dni && cfg.defaultProvider?.name);
  view.appendChild(card('Configuración',
    el('div', { class: 'kv' },
      kv('URL Test', cfg.testUrl),
      kv('URL Prod', cfg.prodUrl),
      kv('apikey TEST', cfg.apikeyTestConfigured ? el('span', { class: 'badge ok' }, 'configurada') : el('span', { class: 'badge err' }, 'falta')),
      kv('apikey PROD', cfg.apikeyProdConfigured ? el('span', { class: 'badge ok' }, 'configurada') : el('span', { class: 'badge muted' }, 'pendiente')),
      kv('Provider (.env)', providerOk
        ? el('span', { class: 'badge ok' }, 'configurado')
        : el('span', { class: 'badge warn' }, 'falta FALABELLA_PROVIDER_DNI / NAME')),
      kv('País default', cfg.defaultCountry),
      kv('User-Agent', cfg.userAgent),
    ),
  ));

  // Grupos (los devuelve fm-track con su config de envío local mezclada)
  const groupsList = el('div');
  const groupKeys = Object.keys(groups);
  if (groupKeys.length === 0) {
    groupsList.appendChild(el('div', { class: 'empty', style: 'padding: 30px 12px;' },
      el('div', { class: 'em-title' }, 'fm-track no devolvió grupos'),
      'Crea grupos en la plataforma fm-track y aparecerán acá automáticamente.'));
  } else {
    for (const gid of groupKeys) groupsList.appendChild(renderFalabellaGroup(groups[gid], vehicles, cfg));
  }
  view.appendChild(card('Grupos (sincronizados desde fm-track)', groupsList));
}

// Versión sincrónica usada en el Resumen (los grupos ya están fetcheados)
function renderFmTrackGroupsCardSync(fmGroups, vehicles, _tmsGroups, _cfg) {
  const vById = new Map(vehicles.map(v => [String(v.id), v]));

  const cardEl = el('div', { class: 'card' });
  cardEl.appendChild(el('div', { class: 'card-header' },
    el('h2', {}, 'Grupos pre-armados en fm-track'),
    el('div', { class: 'spacer' }),
    el('small', { style: 'color: var(--text-dim)' }, 'GET /object-groups'),
    el('a', { href: '#/falabella', style: 'margin-left: 10px; font-size: 12px;' }, 'Configurar envíos →'),
  ));

  const tbody = el('tbody');
  for (const g of fmGroups) {
    const names = g.vehicles.map(vid => vById.get(String(vid))?.plate || vById.get(String(vid))?.name || vid.slice(0, 8)).slice(0, 6);
    const overflow = g.vehicles.length > 6 ? ` +${g.vehicles.length - 6}` : '';

    const detailRow = el('tr', { class: 'detail-row', style: 'display: none; background: var(--bg-soft);' },
      el('td', { colspan: 4, style: 'padding: 0;' },
        el('div', { style: 'padding: 12px 16px;' },
          el('div', { style: 'display: flex; flex-wrap: wrap; gap: 6px;' },
            ...g.vehicles.map(vid => {
              const v = vById.get(String(vid));
              const label = v?.plate || v?.name || String(vid).slice(0, 8);
              return el('span', { class: 'badge muted', title: vid }, label);
            }),
          ),
        ),
      ),
    );

    const detailBtn = el('button', { class: 'ghost', onclick: (ev) => {
      ev.stopPropagation();
      const showing = detailRow.style.display !== 'none';
      detailRow.style.display = showing ? 'none' : '';
    } }, 'Ver detalle');

    const row = el('tr', {},
      el('td', {}, g.name || '(sin nombre)'),
      el('td', {}, String(g.vehicles.length)),
      el('td', {}, el('small', { style: 'color: var(--text-dim)' }, names.join(', ') + overflow)),
      el('td', {}, detailBtn),
    );
    tbody.appendChild(row);
    tbody.appendChild(detailRow);
  }

  const tbl = el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Nombre fm-track'),
      el('th', {}, 'Vehículos'),
      el('th', {}, 'Patentes / nombres'),
      el('th', { style: 'width: 120px;' }, 'Acciones'),
    )),
    tbody,
  );
  cardEl.appendChild(el('div', { class: 'card-body tight' }, tbl));
  return cardEl;
}

async function renderFmTrackGroupsCard(vehicles, falabellaGroups, cfg) {
  const cardEl = el('div', { class: 'card' });
  cardEl.appendChild(el('div', { class: 'card-header' },
    el('h2', {}, 'Grupos pre-armados en fm-track'),
    el('div', { class: 'spacer' }),
    el('small', { style: 'color: var(--text-dim)' }, 'GET /object-groups'),
  ));

  const body = el('div', { class: 'card-body' },
    el('div', { class: 'empty' }, el('span', { class: 'spinner' }), ' consultando fm-track…'));
  cardEl.appendChild(body);

  let groups = [];
  try {
    const r = await api('/api/fm-track/groups');
    groups = r.groups || [];
    console.groupCollapsed('%c[fm-track] grupos pre-armados', 'color: #5b8def; font-weight: 600;');
    console.log(groups);
    console.groupEnd();
  } catch (err) {
    body.innerHTML = '';
    body.appendChild(el('div', { class: 'empty' }, 'Error: ' + String(err)));
    return cardEl;
  }

  body.innerHTML = '';
  if (!groups.length) {
    body.appendChild(el('div', { class: 'empty' }, 'fm-track no devolvió grupos.'));
    return cardEl;
  }

  // Index para mapear id → vehículo (para mostrar nombres)
  const vById = new Map(vehicles.map(v => [String(v.id), v]));
  // Set de ids que ya están en algún grupo Falabella
  const falabellaVehicleIds = new Set();
  for (const fg of Object.values(falabellaGroups)) {
    for (const vid of fg.vehicles || []) falabellaVehicleIds.add(String(vid));
  }

  const tbl = el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Nombre fm-track'),
      el('th', {}, 'Vehículos'),
      el('th', {}, 'Patentes / nombres'),
      el('th', {}, 'Estado'),
      el('th', {}, 'Acciones'),
    )),
  );
  const tbody = el('tbody');
  tbl.appendChild(tbody);

  for (const g of groups) {
    const names = g.vehicles.map(vid => vById.get(String(vid))?.plate || vById.get(String(vid))?.name || vid.slice(0, 8)).slice(0, 6);
    const overflow = g.vehicles.length > 6 ? ` +${g.vehicles.length - 6}` : '';
    const inFalabella = g.vehicles.filter(vid => falabellaVehicleIds.has(String(vid))).length;
    const importBtn = el('button', { class: 'ghost', onclick: async () => {
      importBtn.disabled = true; importBtn.textContent = 'importando…';
      const created = await api('/api/falabella/groups', {
        method: 'POST',
        body: JSON.stringify({
          name: g.name,
          x_country: cfg.defaultCountry || 'CL',
          env: 'test',
          provider: cfg.defaultProvider || {},
          vehicles: g.vehicles,
        }),
      });
      importBtn.disabled = false; importBtn.textContent = 'Importar';
      console.log('[fm-track group importado]', created);
      toast(`Grupo "${g.name}" importado con ${g.vehicles.length} vehículos`);
      renderFalabella();
    } }, 'Importar');
    const previewBtn = el('button', { class: 'ghost', onclick: () => {
      console.groupCollapsed(`%c[fm-track group preview] %c${g.name}`, 'color: #5b8def; font-weight: 600;', 'color: inherit;');
      console.log('id:', g.id);
      console.log('vehicleIds:', g.vehicles);
      console.log('vehículos resueltos:', g.vehicles.map(vid => vById.get(String(vid)) || { id: vid, name: '?' }));
      console.groupEnd();
      toast('Ver detalle en consola (F12)');
    } }, 'Ver detalle');
    tbody.appendChild(el('tr', {},
      el('td', {}, g.name || '(sin nombre)'),
      el('td', {}, String(g.vehicles.length)),
      el('td', {}, el('small', { style: 'color: var(--text-dim)' }, names.join(', ') + overflow)),
      el('td', {}, inFalabella > 0
        ? el('span', { class: 'badge ok' }, `${inFalabella}/${g.vehicles.length} ya en Falabella`)
        : el('span', { class: 'badge muted' }, 'no importado')),
      el('td', {}, el('div', { class: 'row', style: 'gap: 6px; flex-wrap: nowrap;' }, importBtn, previewBtn)),
    ));
  }

  body.appendChild(tbl);
  return cardEl;
}

function renderFalabellaCatalog(vehicles, groups, cfg) {
  const cardEl = el('div', { class: 'card' });

  if (!vehicles.length) {
    cardEl.appendChild(el('div', { class: 'card-header' }, el('h2', {}, 'Catálogo de vehículos')));
    cardEl.appendChild(el('div', { class: 'card-body' }, el('div', { class: 'empty' },
      el('span', { class: 'spinner' }), ' esperando la primera respuesta de fm-track…',
      el('div', { style: 'margin-top: 10px; color: var(--text-dim);' },
        'El polling automático cargará los vehículos en unos segundos.'))));
    return cardEl;
  }

  const search = el('input', { type: 'search', placeholder: 'Filtrar por patente, nombre o IMEI…', style: 'min-width: 240px;' });
  const selectionInfo = el('span', { class: 'badge muted' }, `${falabellaSelected.size} seleccionados`);

  const groupSelect = el('select', { style: 'min-width: 160px;' },
    el('option', { value: '' }, '— elegir grupo destino —'),
    ...Object.values(groups).map(g => el('option', { value: g.id }, `${g.name} (${g.vehicles?.length || 0})`)),
  );

  const addToGroupBtn = el('button', { class: 'ghost', onclick: async () => {
    const gid = groupSelect.value;
    if (!gid) return toast('Elige un grupo destino', 'err');
    if (!falabellaSelected.size) return toast('Selecciona vehículos primero', 'err');
    const g = groups[gid];
    const merged = Array.from(new Set([...(g.vehicles || []), ...falabellaSelected]));
    await api('/api/falabella/groups/' + encodeURIComponent(gid), {
      method: 'PUT', body: JSON.stringify({ vehicles: merged }),
    });
    toast(`Agregados al grupo "${g.name}"`);
    falabellaSelected.clear();
    renderFalabella();
  } }, 'Agregar a grupo');

  const newGroupName = el('input', { type: 'text', placeholder: 'Nombre del nuevo grupo', style: 'min-width: 200px;' });
  const createFromSelectionBtn = el('button', { onclick: async () => {
    if (!falabellaSelected.size) return toast('Selecciona vehículos primero', 'err');
    if (!newGroupName.value.trim()) return toast('Pon un nombre al grupo', 'err');
    await api('/api/falabella/groups', {
      method: 'POST',
      body: JSON.stringify({
        name: newGroupName.value.trim(),
        x_country: cfg.defaultCountry || 'CL',
        env: 'test',
        provider: cfg.defaultProvider || {},
        vehicles: Array.from(falabellaSelected),
      }),
    });
    toast(`Grupo "${newGroupName.value}" creado con ${falabellaSelected.size} vehículos`);
    newGroupName.value = '';
    falabellaSelected.clear();
    renderFalabella();
  } }, 'Crear grupo con selección');

  const tbl = el('table', { class: 'tbl' });
  const head = el('thead', {}, el('tr', {},
    el('th', { style: 'width: 30px;' }, ''),
    el('th', {}, 'Nombre'),
    el('th', {}, 'Patente'),
    el('th', {}, 'IMEI'),
    el('th', {}, 'Última pos.'),
    el('th', {}, 'Velocidad'),
    el('th', {}, 'Estado'),
    el('th', {}, 'En grupos'),
  ));
  const tbody = el('tbody');
  tbl.appendChild(head); tbl.appendChild(tbody);

  // Mapa vehículo → grupos en que aparece (para mostrar)
  const vehicleInGroups = new Map();
  for (const g of Object.values(groups)) {
    for (const vid of g.vehicles || []) {
      if (!vehicleInGroups.has(String(vid))) vehicleInGroups.set(String(vid), []);
      vehicleInGroups.get(String(vid)).push(g.name);
    }
  }

  function renderRows() {
    const q = search.value.trim().toLowerCase();
    tbody.innerHTML = '';
    const rows = vehicles.filter(v => !q ||
      String(v.name).toLowerCase().includes(q) ||
      String(v.plate || '').toLowerCase().includes(q) ||
      String(v.imei).toLowerCase().includes(q));
    if (!rows.length) {
      tbody.appendChild(el('tr', {}, el('td', { colspan: 8, class: 'empty' }, 'Sin resultados')));
      return;
    }
    for (const v of rows) {
      const id = String(v.id);
      const isSelected = falabellaSelected.has(id);
      const cb = el('input', { type: 'checkbox', ...(isSelected ? { checked: 'checked' } : {}) });
      cb.addEventListener('change', () => {
        if (cb.checked) falabellaSelected.add(id); else falabellaSelected.delete(id);
        selectionInfo.textContent = `${falabellaSelected.size} seleccionados`;
        tr.classList.toggle('selected', cb.checked);
      });
      const st = statusFromAge(v.position ? ageMinutes(v.position.ts) : null);
      const inGroups = vehicleInGroups.get(id) || [];
      const groupsBadge = inGroups.length
        ? el('span', { class: 'badge muted', title: inGroups.join(', ') }, `${inGroups.length}`)
        : el('span', { class: 'badge muted' }, '—');
      const tr = el('tr', { class: isSelected ? 'selected' : '' },
        el('td', {}, cb),
        el('td', {}, v.name || '—'),
        el('td', {}, v.plate || el('span', { class: 'badge muted' }, '—')),
        el('td', {}, String(v.imei || '')),
        el('td', {}, v.position ? fmtDate(v.position.ts) : '—'),
        el('td', {}, v.position?.speed != null ? fmtNum(v.position.speed, 1) + ' km/h' : '—'),
        el('td', {}, el('span', { class: 'badge ' + st.cls }, st.label)),
        el('td', {}, groupsBadge),
      );
      // click en la fila también toggle (excepto si fue en la checkbox)
      tr.addEventListener('click', (ev) => {
        if (ev.target.tagName === 'INPUT') return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      });
      tbody.appendChild(tr);
    }
  }

  const selectAllBtn = el('button', { class: 'ghost', onclick: () => {
    const q = search.value.trim().toLowerCase();
    for (const v of vehicles) {
      const matches = !q || String(v.name).toLowerCase().includes(q) ||
        String(v.plate || '').toLowerCase().includes(q) ||
        String(v.imei).toLowerCase().includes(q);
      if (matches) falabellaSelected.add(String(v.id));
    }
    renderRows();
    selectionInfo.textContent = `${falabellaSelected.size} seleccionados`;
  } }, 'Seleccionar visibles');

  const clearSelBtn = el('button', { class: 'ghost', onclick: () => {
    falabellaSelected.clear();
    renderRows();
    selectionInfo.textContent = '0 seleccionados';
  } }, 'Limpiar');

  search.addEventListener('input', renderRows);

  cardEl.appendChild(el('div', { class: 'card-header' },
    el('h2', {}, `Catálogo de vehículos (${vehicles.length})`),
    el('div', { class: 'spacer' }),
    selectionInfo,
  ));
  cardEl.appendChild(el('div', { class: 'toolbar' },
    search,
    selectAllBtn,
    clearSelBtn,
    el('span', { style: 'flex: 1;' }),
    newGroupName, createFromSelectionBtn,
    el('span', { style: 'width: 12px;' }),
    groupSelect, addToGroupBtn,
  ));
  cardEl.appendChild(el('div', { class: 'card-body tight' }, tbl));

  renderRows();
  return cardEl;
}

function renderFalabellaGroup(g, allVehicles, cfg) {
  const cardEl = el('div', { class: 'card', style: 'margin-bottom: 10px;' });

  // Nombre y país vienen de fm-track / .env — solo lectura
  const envSel = el('select', {},
    el('option', { value: 'test', ...(g.env === 'test' ? { selected: 'selected' } : {}) }, 'test'),
    el('option', { value: 'prod', ...(g.env === 'prod' ? { selected: 'selected' } : {}) }, 'prod'),
  );
  const intervalInput = el('input', { type: 'number', min: '5', value: String(g.intervalSec || 20), style: 'width: 80px;' });
  const enabledToggle = el('input', { type: 'checkbox', ...(g.enabled ? { checked: 'checked' } : {}) });

  const saveDebounced = debounce(async () => {
    await api('/api/falabella/groups/' + encodeURIComponent(g.id), {
      method: 'PUT',
      body: JSON.stringify({
        env: envSel.value,
        intervalSec: Number(intervalInput.value) || 20,
        enabled: enabledToggle.checked,
      }),
    });
  }, 400);
  intervalInput.addEventListener('input', saveDebounced);
  [envSel, enabledToggle].forEach(e => e.addEventListener('change', saveDebounced));

  // Chips de vehículos (solo lectura — la lista la administra fm-track)
  const chipsBox = el('div', { style: 'display:flex; flex-wrap:wrap; gap:6px; margin:10px 0;' });
  if (!g.vehicles?.length) {
    chipsBox.appendChild(el('div', { class: 'empty', style: 'padding: 12px;' }, 'Grupo sin vehículos en fm-track'));
  } else {
    for (const vid of g.vehicles) {
      const v = allVehicles.find(x => String(x.id) === String(vid));
      const label = v?.plate || v?.name || String(vid).slice(0, 8);
      const sendOne = el('button', {
        class: 'ghost',
        style: 'padding:2px 7px; font-size:11px; line-height:1;',
        title: 'Enviar este vehículo ahora',
        onclick: async (ev) => {
          ev.stopPropagation();
          sendOne.disabled = true; sendOne.textContent = '…';
          const r = await api('/api/falabella/send-one', {
            method: 'POST', body: JSON.stringify({ vehicleId: vid, groupId: g.id }),
          });
          sendOne.disabled = false; sendOne.textContent = '↗';
          const detail = r.error || (r.accepted ? `id ${(r.response?.id || '').slice(0, 8)}` : (r.response?.message || `HTTP ${r.status}`));
          console.groupCollapsed(`%c[falabella send-one] %c${label} → HTTP ${r.status ?? 0}`,
            'color: #36d399; font-weight: 600;', 'color: inherit;');
          console.log('payload:', r.payload);
          console.log('response:', r.response);
          if (r.error) console.warn('error:', r.error);
          console.groupEnd();
          toast(`${label}: ${detail}`, r.accepted ? 'ok' : 'err');
        },
      }, '↗');
      const chip = el('span', {
        style: 'display:inline-flex; align-items:center; gap:6px; padding:3px 6px 3px 10px; background:var(--bg-soft); border:1px solid var(--border); border-radius:4px; font-size:12px;',
      }, label, sendOne);
      chipsBox.appendChild(chip);
    }
  }

  const sendGroupBtn = el('button', { onclick: async () => {
    if (!g.vehicles?.length) return toast('Grupo vacío', 'err');
    sendGroupBtn.disabled = true;
    sendGroupBtn.textContent = `enviando ${g.vehicles.length}…`;
    const r = await api('/api/falabella/groups/' + encodeURIComponent(g.id) + '/send', {
      method: 'POST', body: JSON.stringify({}),
    });
    sendGroupBtn.disabled = false; sendGroupBtn.textContent = 'Enviar grupo';
    const results = r.results || [];
    const accepted = results.filter(x => x.accepted).length;
    const noTracking = results.filter(x => x.ok && !x.accepted).length;
    const failed = results.filter(x => !x.ok).length;
    console.groupCollapsed(`%c[falabella send-group "${g.name}"] %c${accepted} aceptados · ${noTracking} sin tracking · ${failed} fallidos`,
      'color: #5b8def; font-weight: 600;', 'color: inherit;');
    for (const x of results) {
      console.log(`${x.vehicleId}:`, { http: x.status, accepted: x.accepted, response: x.response, payload: x.payload, error: x.error });
    }
    console.log('respuesta completa:', r);
    console.groupEnd();
    toast(`Aceptados ${accepted} · sin tracking ${noTracking} · fallidos ${failed}`, failed ? 'err' : 'ok');
  } }, 'Enviar grupo');

  // Badge de estado en el header (se actualiza reactivamente)
  const schedBadge = el('span', { class: 'badge' });
  function refreshSchedBadge() {
    if (enabledToggle.checked) {
      schedBadge.className = 'badge ok';
      schedBadge.textContent = `auto · cada ${Number(intervalInput.value) || 20}s`;
    } else {
      schedBadge.className = 'badge muted';
      schedBadge.textContent = 'auto pausado';
    }
  }
  refreshSchedBadge();
  enabledToggle.addEventListener('change', refreshSchedBadge);
  intervalInput.addEventListener('input', refreshSchedBadge);

  const lastInfo = g.lastRunAt
    ? el('small', { style: 'color: var(--text-dim);' },
        `último: ${fmtDate(g.lastRunAt)} · ${g.lastSummary?.accepted ?? 0}/${g.lastSummary?.total ?? 0} aceptados`)
    : el('small', { style: 'color: var(--text-dim);' }, 'sin envíos automáticos aún');

  // Switch grande de Auto-envío con estado reactivo
  const statusLabel = el('span', { class: 'label-status' });
  function refreshStatusLabel() {
    statusLabel.textContent = enabledToggle.checked ? 'Enviando automáticamente' : 'Pausado';
    statusLabel.style.color = enabledToggle.checked ? 'var(--ok)' : 'var(--text-dim)';
  }
  refreshStatusLabel();
  enabledToggle.addEventListener('change', refreshStatusLabel);

  const switchEl = el('label', { class: 'toggle-switch' },
    enabledToggle,
    el('span', { class: 'track' }),
    el('span', { class: 'knob' }),
  );

  const toggleRow = el('div', { class: 'toggle-row' },
    el('span', { class: 'label-main' }, 'Auto-envío'),
    switchEl,
    statusLabel,
  );

  // Body inicialmente colapsado
  const body = el('div', { class: 'card-body', style: 'display: none;' },
    toggleRow,
    el('div', { class: 'row', style: 'margin-bottom: 10px;' },
      field('Entorno', envSel),
      field('Intervalo (seg)', intervalInput),
    ),
    lastInfo,
    chipsBox,
  );

  const chevron = el('span', { style: 'display: inline-block; transition: transform 0.15s; color: var(--text-dim); width: 14px;' }, '▸');
  const header = el('div', {
    class: 'card-header',
    style: 'cursor: pointer; user-select: none;',
    onclick: (ev) => {
      // No togglear si el click fue en algo interactivo (botón, input, select, etc.)
      if (ev.target.closest('button, input, select, label, a')) return;
      const showing = body.style.display !== 'none';
      body.style.display = showing ? 'none' : '';
      chevron.style.transform = showing ? 'rotate(0deg)' : 'rotate(90deg)';
    },
  },
    chevron,
    el('span', { style: 'font-weight: 600; font-size: 0.95rem;' }, g.name || '(sin nombre)'),
    el('span', { class: 'badge muted' }, g.env || 'test'),
    el('span', { class: 'badge muted' }, g.x_country || 'CL'),
    el('span', { class: 'badge muted' }, `${g.vehicles?.length || 0} vehículos`),
    schedBadge,
    el('div', { class: 'spacer' }),
    sendGroupBtn,
  );

  cardEl.appendChild(header);
  cardEl.appendChild(body);
  return cardEl;
}

async function loadFalabellaHistory() {
  const box = document.getElementById('falabellaHistoryBox');
  if (!box) return;
  try {
    const h = await api('/api/falabella/history?limit=100');
    const entries = h.entries || [];
    if (!entries.length) { box.innerHTML = '<div class="empty">sin envíos aún</div>'; return; }

    const rows = [];
    for (const e of entries) {
      const accepted = e.accepted;
      // HTTP code: verde para 2xx, rojo para el resto. El status semántico va en RESULTADO.
      const statusCls = e.ok ? 'badge ok' : 'badge err';
      const resultCls = e.error || !e.ok ? 'badge err' : (accepted ? 'badge ok' : 'badge warn');
      const resultText = e.error
        ? e.error
        : (accepted ? `✓ id ${String(e.response?.id || '').slice(0, 12)}` : (e.response?.message || 'rechazado'));

      const detailRow = el('tr', { class: 'detail-row', style: 'display: none; background: var(--bg-soft);' },
        el('td', { colspan: 6, style: 'padding: 0;' },
          el('div', { style: 'padding: 14px 16px;' },
            el('div', { class: 'split' },
              el('div', {},
                el('h2', { style: 'font-size: 0.85rem; margin: 0 0 6px; color: var(--text-dim);' }, 'Payload enviado'),
                el('pre', { style: 'max-height: 320px; margin: 0;' },
                  e.payload ? JSON.stringify(e.payload, null, 2) : '(sin payload — el envío no llegó a construirse)'),
              ),
              el('div', {},
                el('h2', { style: 'font-size: 0.85rem; margin: 0 0 6px; color: var(--text-dim);' }, 'Respuesta de Falabella'),
                el('pre', { style: 'max-height: 320px; margin: 0;' },
                  e.error
                    ? String(e.error)
                    : (typeof e.response === 'string' ? e.response : JSON.stringify(e.response, null, 2))),
              ),
            ),
            el('div', { class: 'kv', style: 'margin-top: 12px;' },
              kv('X-txref', e.txref || '—'),
              kv('Grupo', e.groupId || '—'),
              kv('Aceptado por Falabella', accepted ? 'sí' : 'no'),
              ...(e.url ? [kv('URL', e.url)] : []),
            ),
          ),
        ),
      );
      const row = el('tr', { style: 'cursor: pointer;' },
        el('td', {}, fmtDate(e.ts)),
        el('td', {}, el('code', {}, String(e.vehicleId).slice(0, 12))),
        el('td', {}, e.groupId || '—'),
        el('td', {}, el('span', { class: statusCls }, `HTTP ${e.status ?? 0}`)),
        el('td', {}, el('span', { class: resultCls }, resultText)),
        el('td', {}, el('code', { style: 'font-size: 11px; color: var(--text-dim);' }, String(e.txref || '').slice(0, 8))),
      );
      row.addEventListener('click', () => {
        const showing = detailRow.style.display !== 'none';
        detailRow.style.display = showing ? 'none' : '';
        row.classList.toggle('selected', !showing);
      });
      rows.push(row, detailRow);
    }
    const tbl = el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Cuándo'), el('th', {}, 'Vehículo'), el('th', {}, 'Grupo'),
        el('th', {}, 'HTTP'), el('th', {}, 'Resultado'), el('th', {}, 'X-txref'),
      )),
      el('tbody', {}, ...rows),
    );
    box.innerHTML = '';
    box.appendChild(tbl);
  } catch (err) { box.innerHTML = '<div class="empty">' + escapeHtml(String(err)) + '</div>'; }
}

views.explorar = async () => {
  $('#pageTitle').textContent = 'Explorar API';
  const view = $('#view');

  const preset = el('select', {},
    ...['/objects', '/objects/last-known-position', '/drivers', '/geozones', '/object-groups'].map(p => el('option', {}, p)),
    el('option', { value: '' }, '— personalizado —'),
  );
  const pathInput = el('input', { type: 'text', value: '/objects', style: 'flex: 1; min-width: 280px;' });
  preset.addEventListener('change', () => { if (preset.value) pathInput.value = preset.value; });

  const status = el('div');
  const out = el('pre', {}, '(sin datos)');

  const goBtn = el('button', { onclick: async () => {
    const p = pathInput.value.trim();
    if (!p) return;
    status.innerHTML = '<span class="spinner"></span> consultando…';
    out.textContent = '';
    const r = await api('/api/fm-track?path=' + encodeURIComponent(p));
    if (r.error) { status.innerHTML = `<span class="badge err">${escapeHtml(r.error)}</span>`; return; }
    status.innerHTML = `<span class="badge ${r.ok ? 'ok' : 'err'}">HTTP ${r.status}</span>`;
    out.textContent = JSON.stringify(r.data ?? r, null, 2);
  } }, 'Fetch');

  view.innerHTML = '';
  view.appendChild(card('Consulta directa a fm-track',
    el('div', {},
      el('div', { class: 'row' }, preset, pathInput, goBtn),
      el('p', { style: 'margin: 12px 0 0; color: var(--text-dim); font-size: 12px;' },
        'El servidor inyecta la API key como ', el('code', {}, '?api_key=…'),
        ' y también como header ', el('code', {}, 'X-Api-Key'), '.'),
      el('div', { style: 'margin-top: 10px;' }, status),
    )
  ));
  view.appendChild(card('Respuesta cruda', out));
};

// ---------- vista: Envíos (historial unificado Q Analytics + Falabella) ----------
let enviosState = null;
let enviosEntries = [];
let enviosTimer = null;

views.envios = async () => {
  $('#pageTitle').textContent = 'Resultados de envíos';
  buildEnviosView();
  await refreshEnvios();
  if (enviosTimer) clearInterval(enviosTimer);
  enviosTimer = setInterval(() => {
    if (currentView() !== 'envios') { clearInterval(enviosTimer); enviosTimer = null; return; }
    // Pausa el refresh si hay alguna fila de detalle abierta (para no perder la vista del usuario)
    if (countOpenEnviosDetails() > 0) { updateEnviosRefreshHint(true); return; }
    updateEnviosRefreshHint(false);
    refreshEnvios();
  }, 5000);
};

function countOpenEnviosDetails() {
  return Array.from(document.querySelectorAll('#view tr.detail-row'))
    .filter(r => r.style.display !== 'none').length;
}
function updateEnviosRefreshHint(paused) {
  const hint = document.getElementById('enviosRefreshHint');
  if (!hint) return;
  hint.textContent = paused
    ? '⏸ auto-refresh pausado · cierra los detalles para reanudar'
    : 'auto-refresca cada 5s · click en una fila para ver detalle';
  hint.style.color = paused ? 'var(--warn)' : 'var(--text-dim)';
}

function buildEnviosView() {
  const view = $('#view');
  const search = el('input', { type: 'search', placeholder: 'Filtrar por patente…', style: 'min-width: 200px;' });
  const serviceFilter = el('select', { style: 'min-width: 160px;' },
    el('option', { value: '' }, 'Todos los servicios'),
    el('option', { value: 'Falabella' }, 'Falabella'),
    el('option', { value: 'Q Analytics' }, 'Q Analytics'),
  );
  const resultFilter = el('select', { style: 'min-width: 180px;' },
    el('option', { value: '' }, 'Todos los resultados'),
    el('option', { value: 'accepted' }, '✓ Aceptados'),
    el('option', { value: 'rejected' }, '⚠ Sin tracking / rechazo'),
    el('option', { value: 'error' }, '✗ Errores'),
  );
  const countBadge = el('span', { class: 'badge muted' }, '— envíos');

  const body = el('tbody');
  const tbl = el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Patente'),
      el('th', {}, 'Fecha evento (GPS)'),
      el('th', {}, 'Fecha envío'),
      el('th', {}, 'Velocidad'),
      el('th', {}, 'Servicio'),
      el('th', {}, 'Estado'),
      el('th', { style: 'width: 60px;' }, ''),
    )),
    body,
  );

  for (const inp of [search, serviceFilter, resultFilter]) {
    inp.addEventListener('input', renderEnviosRows);
    inp.addEventListener('change', renderEnviosRows);
  }

  view.innerHTML = '';
  view.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('h2', {}, 'Resultados de envíos'),
      el('div', { class: 'spacer' }),
      countBadge,
      el('button', { class: 'ghost', onclick: refreshEnvios }, '↻ Refrescar'),
    ),
    el('div', { class: 'toolbar' }, search, serviceFilter, resultFilter,
      el('small', { id: 'enviosRefreshHint', style: 'color: var(--text-dim); margin-left: 8px;' },
        'auto-refresca cada 5s · click en una fila para ver detalle'),
    ),
    el('div', { class: 'card-body tight' }, tbl),
  ));

  enviosState = { search, serviceFilter, resultFilter, body, countBadge };
}

async function refreshEnvios() {
  if (!enviosState) return;
  const [qaH, faH] = await Promise.all([
    api('/api/schedules/history?limit=500').catch(() => ({ entries: [] })),
    api('/api/falabella/history?limit=500').catch(() => ({ entries: [] })),
  ]);
  const merged = [];
  for (const e of qaH.entries || []) {
    const okMsg = e.response && typeof e.response === 'object' &&
      String(e.response.message || '').toLowerCase().includes('correct');
    merged.push({
      kind: 'qa', service: 'Q Analytics',
      ts: e.ts,
      patente: e.payload?.PLACA || e.vehicleId,
      eventTs: e.payload?.FH_RPT_GPS,
      speed: e.payload?.VEL,
      status: e.status, ok: e.ok,
      accepted: Boolean(e.ok && (okMsg || (e.status >= 200 && e.status < 300))),
      payload: e.payload, response: e.response, error: e.error,
      vehicleId: e.vehicleId, manual: e.manual,
    });
  }
  for (const e of faH.entries || []) {
    merged.push({
      kind: 'falabella', service: 'Falabella',
      ts: e.ts,
      patente: e.payload?.vehicleId || e.vehicleId,
      eventTs: e.payload?.timestamp,
      speed: e.payload?.speed?.value,
      status: e.status, ok: e.ok, accepted: Boolean(e.accepted),
      payload: e.payload, response: e.response, error: e.error,
      vehicleId: e.vehicleId, txref: e.txref, url: e.url, groupId: e.groupId,
    });
  }
  merged.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  enviosEntries = merged;
  renderEnviosRows();
}

function renderEnviosRows() {
  if (!enviosState) return;
  const { search, serviceFilter, resultFilter, body, countBadge } = enviosState;
  const q = search.value.trim().toLowerCase();
  const sf = serviceFilter.value;
  const rf = resultFilter.value;

  let rows = enviosEntries;
  if (q) rows = rows.filter(e => String(e.patente || '').toLowerCase().includes(q) ||
    String(e.vehicleId || '').toLowerCase().includes(q));
  if (sf) rows = rows.filter(e => e.service === sf);
  if (rf === 'accepted') rows = rows.filter(e => e.accepted);
  else if (rf === 'rejected') rows = rows.filter(e => e.ok && !e.accepted);
  else if (rf === 'error') rows = rows.filter(e => !e.ok);

  countBadge.textContent = `${rows.length} de ${enviosEntries.length} envíos`;

  body.innerHTML = '';
  if (!rows.length) {
    body.appendChild(el('tr', {}, el('td', { colspan: 7, class: 'empty' }, 'Sin resultados')));
    return;
  }

  for (const e of rows) {
    const statusCls = !e.ok ? 'badge err' : (e.accepted ? 'badge ok' : 'badge warn');
    const statusText = e.error ? 'error red'
      : (e.accepted ? '✓ aceptado'
        : (e.ok ? (e.response?.message || 'rechazado') : `HTTP ${e.status || 0}`));
    const serviceCls = e.kind === 'falabella' ? 'badge' : 'badge muted';
    const serviceStyle = e.kind === 'falabella'
      ? 'background: rgba(91,141,239,0.15); border-color: rgba(91,141,239,0.35); color: #5b8def;'
      : '';

    const detailRow = el('tr', { class: 'detail-row', style: 'display: none; background: var(--bg-soft);' },
      el('td', { colspan: 7, style: 'padding: 0;' },
        el('div', { style: 'padding: 14px 16px;' },
          el('div', { class: 'split' },
            el('div', {},
              el('h2', { style: 'font-size: 0.85rem; margin: 0 0 6px; color: var(--text-dim);' }, 'Payload enviado'),
              el('pre', { style: 'max-height: 320px; margin: 0;' },
                e.payload ? JSON.stringify(e.payload, null, 2) : '(sin payload — no se construyó)'),
            ),
            el('div', {},
              el('h2', { style: 'font-size: 0.85rem; margin: 0 0 6px; color: var(--text-dim);' }, 'Respuesta'),
              el('pre', { style: 'max-height: 320px; margin: 0;' },
                e.error ? String(e.error)
                  : (typeof e.response === 'string' ? e.response : JSON.stringify(e.response, null, 2))),
            ),
          ),
          el('div', { class: 'kv', style: 'margin-top: 12px;' },
            kv('Servicio', e.service),
            kv('Patente', String(e.patente || '—')),
            kv('Vehicle ID', String(e.vehicleId || '—')),
            kv('HTTP', String(e.status ?? 0)),
            kv('Aceptado', e.accepted ? 'sí' : 'no'),
            ...(e.txref ? [kv('X-txref', e.txref)] : []),
            ...(e.url ? [kv('URL', e.url)] : []),
            ...(e.groupId ? [kv('Grupo', e.groupId)] : []),
            ...(e.manual != null ? [kv('Origen', e.manual ? 'manual' : 'auto-scheduler')] : []),
          ),
        ),
      ),
    );

    const eyeBtn = el('button', { class: 'ghost', style: 'padding: 2px 10px;', title: 'Ver detalle' }, '👁');
    const row = el('tr', { style: 'cursor: pointer;' },
      el('td', {}, el('b', {}, String(e.patente || '—'))),
      el('td', {}, fmtDate(e.eventTs)),
      el('td', {}, fmtDate(e.ts)),
      el('td', {}, e.speed != null ? String(e.speed) : '—'),
      el('td', {}, el('span', { class: serviceCls, style: serviceStyle }, e.service)),
      el('td', {}, el('span', { class: statusCls }, statusText)),
      el('td', {}, eyeBtn),
    );

    const toggle = () => {
      const showing = detailRow.style.display !== 'none';
      detailRow.style.display = showing ? 'none' : '';
      row.classList.toggle('selected', !showing);
      updateEnviosRefreshHint(countOpenEnviosDetails() > 0);
    };
    row.addEventListener('click', (ev) => { if (ev.target !== eyeBtn) toggle(); });
    eyeBtn.addEventListener('click', (ev) => { ev.stopPropagation(); toggle(); });

    body.appendChild(row);
    body.appendChild(detailRow);
  }
}

views.logs = async () => {
  $('#pageTitle').textContent = 'Logs de actividad';
  const view = $('#view');
  view.innerHTML = '';
  view.appendChild(loadingCard('Cargando…'));

  const r = await api('/api/logs?limit=200');
  const entries = r.entries || [];

  const tbl = el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Cuándo'), el('th', {}, 'Tipo'), el('th', {}, 'HTTP'),
      el('th', {}, 'Detalle'),
    )),
    el('tbody', {}, ...entries.map(e => {
      const okBadge = e.ok === undefined ? '' : e.ok ? 'badge ok' : 'badge err';
      const detail = e.path || e.targetUrl || e.error || '';
      return el('tr', {},
        el('td', {}, fmtDate(e.ts)),
        el('td', {}, el('code', {}, e.kind || '—')),
        el('td', {}, e.status != null ? el('span', { class: okBadge }, `HTTP ${e.status}`) : '—'),
        el('td', {}, String(detail).slice(0, 140)),
      );
    })),
  );

  view.innerHTML = '';
  view.appendChild(card(`Actividad reciente (${entries.length})`,
    entries.length === 0 ? el('div', { class: 'empty' }, 'Sin actividad') : tbl));
};

// ---------- builders ----------
function card(title, body) {
  return el('div', { class: 'card' },
    title && el('div', { class: 'card-header' }, el('h2', {}, title)),
    el('div', { class: 'card-body' }, body),
  );
}
function kpi(label, value, badge) {
  return el('div', { class: 'card kpi' },
    el('div', { class: 'label' }, label),
    el('div', { class: 'value' }, String(value)),
    badge && el('div', { class: 'delta' }, el('span', { class: 'badge ' + badge }, badge)),
  );
}
function kv(k, v) {
  return el('div', { style: 'display: contents;' },
    el('div', { class: 'k' }, k),
    el('div', { class: 'v' }, typeof v === 'string' ? v : v || '—'),
  );
}
function field(label, control) {
  return el('div', { class: 'field' }, el('label', {}, label), control);
}
function emptyState(title, hint) {
  return el('div', { class: 'card' }, el('div', { class: 'empty' },
    el('div', { class: 'em-title' }, title),
    hint ? el('div', { html: hint }) : null,
  ));
}
function loadingCard(msg) {
  return el('div', { class: 'card' }, el('div', { class: 'empty' },
    el('span', { class: 'spinner' }), ' ', el('span', {}, msg),
  ));
}
function compactTable(rows) {
  return el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Nombre'), el('th', {}, 'IMEI'), el('th', {}, 'Última pos.'), el('th', {}, 'Estado'))),
    el('tbody', {}, ...rows.map(v => {
      const st = statusFromAge(v.position ? ageMinutes(v.position.ts) : null);
      return el('tr', {},
        el('td', {}, v.name), el('td', {}, String(v.imei)),
        el('td', {}, v.position ? fmtDate(v.position.ts) : '—'),
        el('td', {}, el('span', { class: 'badge ' + st.cls }, st.label)),
      );
    })),
  );
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- router ----------
function currentView() {
  return (location.hash.replace(/^#\//, '') || 'resumen').split('/')[0];
}
async function route() {
  const v = currentView();
  $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.view === v));
  const fn = views[v] || views.resumen;
  try { await fn(); } catch (err) { $('#view').replaceChildren(emptyState('Error al renderizar', escapeHtml(String(err)))); console.error(err); }
}

window.addEventListener('hashchange', route);
$('#refreshBtn').addEventListener('click', async () => { state.snapshot = null; await route(); });
window.addEventListener('keydown', (e) => { if (e.key === 'r' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) $('#refreshBtn').click(); });

(async () => {
  await loadConfig();
  if (!location.hash) location.hash = '#/resumen';
  // Arranca el polling solo si la API key está cargada
  if (state.config?.fmTrackKeyConfigured) startPolling();
  await route();
})();
