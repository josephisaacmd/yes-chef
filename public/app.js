// yes-chef front-end. Plain JS modules, no framework.
// Talks to /api/* JSON endpoints; renders four tabbed views.

// ----------------------- tiny helpers -----------------------
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('unauthenticated'); }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const parts = [data.error, data.detail].filter(Boolean);
    throw new Error(parts.join(' — ') || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

const todayISO = () => toISO(new Date());
function toISO(d) {
  // local-date ISO (YYYY-MM-DD) to avoid UTC off-by-one
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
const fmtDate  = (iso) => new Date(iso + 'T00:00').toLocaleDateString(undefined, {
  weekday: 'short', month: 'short', day: 'numeric'
});
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function chip(name, { on = false, onClick } = {}) {
  const el = document.createElement('span');
  el.className = 'chip' + (on ? ' on' : '');
  el.textContent = name;
  if (onClick) el.addEventListener('click', () => onClick(el));
  return el;
}

// ----------------------- shared state -----------------------
const state = {
  tags: [],            // [{id, name, meal_count}]
  meals: [],           // [{id, name, notes, tags:[{id,name}]}]
  pickFilter: new Set(),
  mealsFilter: new Set(),
  current: null,       // last "picked" meal
};

async function refreshTags()  { state.tags  = await api('/api/tags'); }
async function refreshMeals() { state.meals = await api('/api/meals'); }

// ----------------------- tab routing -----------------------
function showTab(name) {
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.view').forEach(v => v.hidden = v.dataset.view !== name);
  const renderers = {
    home: renderHome, pick: renderPick, plan: renderPlan,
    history: renderHistory, photos: renderPhotos, meals: renderMeals,
    settings: renderSettings,
  };
  renderers[name]?.();
  // Keep the URL hash in sync for shareable links + browser back/forward.
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
}
$$('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
// Any [data-tab] element outside the nav (brand, link buttons, home cards) also navigates.
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-tab]');
  if (!el || el.classList.contains('tab')) return;
  ev.preventDefault();
  showTab(el.dataset.tab);
});

$('#logout-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/auth/logout', { method: 'POST' });
  location.href = '/login';
});

// ============================================================
//                          PICK
// ============================================================
function renderPickTags() {
  const wrap = $('#pick-tags');
  wrap.innerHTML = '';
  for (const t of state.tags) {
    wrap.appendChild(chip(t.name, {
      on: state.pickFilter.has(t.name),
      onClick: (el) => {
        if (state.pickFilter.has(t.name)) state.pickFilter.delete(t.name);
        else state.pickFilter.add(t.name);
        el.classList.toggle('on');
      },
    }));
  }
}

// Shared renderer used by both Pick and Try-Something-New buttons.
function showPicked(meal) {
  state.current = meal;
  $('#pick-name').textContent = meal.name;
  const tagsWrap = $('#pick-meal-tags');
  tagsWrap.innerHTML = '';
  meal.tags.forEach(t => tagsWrap.appendChild(chip(t.name)));
  const lastEl = $('#pick-last-eaten');
  if (meal._fallback) {
    lastEl.textContent = `⚠️ No meals outside the skip window — ${meal._fallback}.`;
    lastEl.hidden = false;
  } else {
    lastEl.hidden = true;
  }
  $('#pick-notes').textContent = meal.notes || '';
  $('#pick-date').value = todayISO();
  $('#pick-result').hidden = false;
}

function pickQueryString() {
  const params = new URLSearchParams();
  for (const t of state.pickFilter) params.append('tag', t);
  return params;
}

function currentVariety() {
  return parseFloat($('#pick-variety').value) || 0;
}

async function rollPick() {
  const params = pickQueryString();
  const avoid = parseInt($('#pick-avoid').value, 10);
  if (Number.isFinite(avoid) && avoid >= 0) params.set('avoid_days', String(avoid));
  params.set('variety', String(currentVariety()));
  try {
    const meal = await api('/api/meals/random?' + params.toString());
    showPicked(meal);
  } catch (err) {
    alert(err.message);
  }
}

async function rollNew() {
  try {
    const meal = await api('/api/meals/new?' + pickQueryString().toString());
    showPicked(meal);
  } catch (err) {
    alert(err.message);
  }
}

// Top-N recommendations using the same scoring algorithm.
async function showRecommendations() {
  const params = pickQueryString();
  const avoid = parseInt($('#pick-avoid').value, 10);
  if (Number.isFinite(avoid) && avoid >= 0) params.set('avoid_days', String(avoid));
  params.set('variety', String(currentVariety()));
  params.set('n', '5');
  const wrap = $('#pick-recommendations');
  wrap.hidden = false;
  wrap.innerHTML = '<p class="muted">Thinking…</p>';
  try {
    const data = await api('/api/v1/agent/recommendations?' + params.toString());
    wrap.innerHTML = '';
    const h = document.createElement('h4');
    h.textContent = `Top picks (variety ${data.variety.toFixed(2)})`;
    wrap.appendChild(h);
    for (const m of data.picks) {
      const row = document.createElement('div');
      row.className = 'rec-row';
      const days = m._days_since == null ? 'never eaten' : `${m._days_since}d ago`;
      const tagStr = (m.tags || []).map(t => t.name).join(' · ');
      row.innerHTML = `
        <div>
          <div><strong>${escapeHtml(m.name)}</strong></div>
          <div class="meta">${escapeHtml(days)} · eaten ${m._eaten_count}× ${tagStr ? '· ' + escapeHtml(tagStr) : ''}</div>
        </div>
        <button class="primary" data-id="${m.id}">Pick</button>`;
      row.querySelector('button').addEventListener('click', () => {
        showPicked(m);
        wrap.hidden = true;
      });
      wrap.appendChild(row);
    }
  } catch (err) {
    wrap.innerHTML = `<p class="error">${err.message}</p>`;
  }
}

async function logPickAs(status) {
  if (!state.current) return;
  await api('/api/entries', {
    method: 'POST',
    body: {
      meal_id: state.current.id,
      on_date: $('#pick-date').value || todayISO(),
      slot:    $('#pick-slot').value,
      status,
    },
  });
  alert(`Saved as ${status}.`);
}

async function renderPick() {
  await refreshTags();
  renderPickTags();
  $('#pick-date').value = $('#pick-date').value || todayISO();
}
$('#pick-roll').addEventListener('click', rollPick);
$('#pick-again').addEventListener('click', rollPick);
$('#pick-new').addEventListener('click', rollNew);
$('#pick-plan').addEventListener('click', () => logPickAs('planned'));
$('#pick-eaten').addEventListener('click', () => logPickAs('eaten'));
$('#pick-show-recs').addEventListener('click', showRecommendations);
$('#pick-variety').addEventListener('input', () => {
  $('#variety-value').textContent = currentVariety().toFixed(2);
});

// ============================================================
//                          PLAN
// ============================================================
// The plan is a single work-week of lunch meal-prep: a Lunch slot plus an
// optional Veggie side for each weekday (Mon–Fri). Breakfast & dinner are
// intentionally left off — figured out on the fly.
const SLOT_GROUPS = [
  { id: 'lunch', label: 'Lunch', sub: { id: 'side', label: 'Veggie side' } },
];
// Flat list used for data fetching / mark-all logic.
const SLOTS = SLOT_GROUPS.flatMap(g => g.sub ? [g.id, g.sub.id] : [g.id]);
// Work week is Monday–Friday.
const PLAN_DAYS = 5;

// Anchor date — any date inside the displayed week.
let planAnchor = new Date(); planAnchor.setHours(0, 0, 0, 0);

// Monday on/before the given date.
function weekStart(d) {
  const s = new Date(d); s.setHours(0, 0, 0, 0);
  const back = (s.getDay() + 6) % 7;    // days since Monday (Sun→6 … Mon→0)
  s.setDate(s.getDate() - back);
  return s;
}

function planStart() {
  return weekStart(planAnchor);
}

function buildSlotBlock(day, slotId, label, isSub) {
  const wrap = document.createElement('div');
  wrap.className = 'slot' + (isSub ? ' slot-sub' : '');

  const lbl = document.createElement('span');
  lbl.className = 'slot-label';
  lbl.textContent = label;
  wrap.appendChild(lbl);

  const row = document.createElement('div');
  row.className = 'slot-row';

  const list = (byDayRef.get(day)?.[slotId]) || [];
  if (list.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'name empty';
    empty.textContent = '+ add';
    empty.addEventListener('click', () => assignSlot(day, slotId));
    row.appendChild(empty);
  } else {
    const entry = list[0];
    const name = document.createElement('span');
    name.className = 'name' + (entry.status === 'eaten' ? ' eaten' : '');
    name.textContent = entry.meal?.name || '(deleted meal)';
    name.title = 'Click to change';
    name.addEventListener('click', () => assignSlot(day, slotId, entry));
    row.appendChild(name);

    if (entry.status !== 'eaten') {
      const eat = document.createElement('button');
      eat.className = 'ctrl'; eat.title = 'Mark eaten'; eat.textContent = '🍽️';
      eat.addEventListener('click', async () => {
        await api(`/api/entries/${entry.id}`, { method: 'PATCH', body: { status: 'eaten' } });
        renderPlan();
      });
      row.appendChild(eat);
    }
    const del = document.createElement('button');
    del.className = 'ctrl'; del.title = 'Remove'; del.textContent = '✕';
    del.addEventListener('click', async () => {
      await api(`/api/entries/${entry.id}`, { method: 'DELETE' });
      renderPlan();
    });
    row.appendChild(del);
  }
  wrap.appendChild(row);
  return wrap;
}

// Shared reference so buildSlotBlock can read it without re-fetching.
let byDayRef = new Map();

async function renderPlan() {
  const start = planStart();
  const days = Array.from({ length: PLAN_DAYS }, (_, i) => {
    const d = new Date(start); d.setDate(start.getDate() + i);
    return toISO(d);
  });

  // Header reflects the week being shown.
  const titleEl = $('#plan-title');
  if (titleEl) {
    const startD = new Date(days[0] + 'T00:00');
    const endD = new Date(days[days.length - 1] + 'T00:00');
    const thisWeek = toISO(weekStart(new Date()));
    const opts = { month: 'short', day: 'numeric' };
    titleEl.textContent = (days[0] === thisWeek ? 'This week' : 'Week') +
      ` · ${startD.toLocaleDateString(undefined, opts)} – ${endD.toLocaleDateString(undefined, opts)}`;
  }

  await refreshMeals();
  const entries = await api(`/api/entries?from=${days[0]}&to=${days[days.length - 1]}`);
  const byDay = new Map();
  for (const d of days) byDay.set(d, {});
  for (const e of entries) {
    const bag = byDay.get(e.on_date);
    if (!bag) continue;
    bag[e.slot] = bag[e.slot] || [];
    bag[e.slot].push(e);
  }
  byDayRef = byDay;

  const grid = $('#plan-grid');
  grid.innerHTML = '';
  grid.dataset.days = PLAN_DAYS;

  // Day-of-week headers (Mon–Fri).
  const startDow = start.getDay();
  for (let i = 0; i < PLAN_DAYS; i++) {
    const dh = document.createElement('div');
    dh.className = 'dow-head';
    dh.textContent = DOW_SHORT[(startDow + i) % 7];
    grid.appendChild(dh);
  }

  for (const day of days) {
    const card = document.createElement('div');
    card.className = 'day' + (day === todayISO() ? ' today' : '');

    const header = document.createElement('div');
    header.className = 'day-head';
    const dt = new Date(day + 'T00:00');
    const label = document.createElement('span');
    label.className = 'day-label';
    label.innerHTML = `<span class="day-num">${dt.getDate()}</span> <span class="day-mon">${dt.toLocaleDateString(undefined, { month: 'short' })}</span>`;
    header.appendChild(label);

    const slotsForDay = SLOTS.map(s => (byDay.get(day)[s] || [])[0]).filter(Boolean);
    const plannedHere = slotsForDay.filter(e => e.status !== 'eaten');
    if (plannedHere.length > 0) {
      const allBtn = document.createElement('button');
      allBtn.className = 'ctrl all-eaten';
      allBtn.title = 'Mark all meals as eaten';
      allBtn.textContent = '🍽️';
      allBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await Promise.all(plannedHere.map(e =>
          api(`/api/entries/${e.id}`, { method: 'PATCH', body: { status: 'eaten' } })
        ));
        renderPlan();
      });
      header.appendChild(allBtn);
    }
    card.appendChild(header);

    for (const group of SLOT_GROUPS) {
      card.appendChild(buildSlotBlock(day, group.id, group.label, false));
      if (group.sub) {
        card.appendChild(buildSlotBlock(day, group.sub.id, group.sub.label, true));
      }
    }
    grid.appendChild(card);
  }
}

$('#plan-prev').addEventListener('click', () => { planAnchor.setDate(planAnchor.getDate() - 7); renderPlan(); });
$('#plan-next').addEventListener('click', () => { planAnchor.setDate(planAnchor.getDate() + 7); renderPlan(); });
$('#plan-today').addEventListener('click', () => { planAnchor = new Date(); planAnchor.setHours(0,0,0,0); renderPlan(); });

async function assignSlot(date, slot, existing = null) {
  const meal = await pickMealDialog();
  if (!meal) return;
  if (existing) {
    await api(`/api/entries/${existing.id}`, { method: 'PATCH', body: { meal_id: meal.id } });
  } else {
    await api('/api/entries', {
      method: 'POST',
      body: { meal_id: meal.id, on_date: date, slot, status: 'planned' },
    });
  }
  renderPlan();
}

// Reusable modal meal picker. Resolves with the chosen meal or null.
// Typing a name that doesn't exist offers a "+ Create" row so a brand-new
// meal can be added without leaving the Plan/History flow.
function pickMealDialog() {
  return new Promise((resolve) => {
    const dlg    = $('#meal-picker');
    const search = $('#meal-picker-search');
    const list   = $('#meal-picker-list');
    let settled = false;

    function finish(value) {
      if (settled) return;
      settled = true;
      cleanup();
      dlg.close();
      resolve(value);
    }

    function paint(filter = '') {
      const raw = filter.trim();
      const q = raw.toLowerCase();
      list.innerHTML = '';
      let exact = false;
      for (const m of state.meals) {
        if (q && !m.name.toLowerCase().includes(q)) continue;
        if (q && m.name.toLowerCase() === q) exact = true;
        const li = document.createElement('li');
        const tagStr = m.tags.map(t => t.name).join(' · ');
        li.innerHTML = `<strong>${escapeHtml(m.name)}</strong>${tagStr ? ` <span class="meta">— ${escapeHtml(tagStr)}</span>` : ''}`;
        li.addEventListener('click', () => finish(m));
        list.appendChild(li);
      }
      // Offer to create a new meal from the typed text.
      if (raw && !exact) {
        const li = document.createElement('li');
        li.className = 'create-new';
        li.innerHTML = `<strong>+ Create “${escapeHtml(raw)}”</strong> <span class="meta">— new meal</span>`;
        li.addEventListener('click', async () => {
          if (settled) return;
          li.classList.add('busy');
          try {
            const meal = await createMealInline(raw);
            finish(meal);
          } catch (err) {
            li.classList.remove('busy');
            alert(err.message);
          }
        });
        list.appendChild(li);
      }
    }
    function onInput() { paint(search.value); }
    function onClose() { finish(null); }
    function cleanup() {
      search.removeEventListener('input', onInput);
      dlg.removeEventListener('close', onClose);
    }

    search.value = '';
    paint();
    search.addEventListener('input', onInput);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    setTimeout(() => search.focus(), 0);
  });
}

// Create a meal on the fly and keep local state in sync so it's immediately
// available in every picker / list.
async function createMealInline(name) {
  const created = await api('/api/meals', { method: 'POST', body: { name } });
  await refreshMeals();
  return state.meals.find(m => m.id === created.id) || created;
}

// ============================================================
//                         HISTORY
// ============================================================
let historyAnchor = new Date(); historyAnchor.setDate(1); historyAnchor.setHours(0,0,0,0);

async function renderStats() {
  const body = $('#stats-body');
  const summary = $('#stats-summary');
  try {
    const s = await api('/api/v1/agent/stats?days=365');
    summary.textContent = `${s.total_eaten} meals · ${s.unique_meals} unique · variety ${s.variety_index.toFixed(2)} · ${s.streak_days}-day streak`;
    const top = s.top_meals.slice(0, 5)
      .map(m => `<li><strong>${escapeHtml(m.name)}</strong> <span class="muted">×${m.count}</span></li>`).join('');
    const tags = s.by_tag.slice(0, 8)
      .map(t => `<span class="chip">${escapeHtml(t.tag)} <span class="muted">×${t.count}</span></span>`).join(' ');
    const slots = s.by_slot
      .map(b => `<span class="chip">${escapeHtml(b.slot)} <span class="muted">×${b.count}</span></span>`).join(' ');
    body.innerHTML = `
      <div class="stat-row">
        <div class="stat-card">
          <div class="stat-label">Total eaten (1y)</div>
          <div class="stat-num">${s.total_eaten}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Unique meals</div>
          <div class="stat-num">${s.unique_meals}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Variety index</div>
          <div class="stat-num">${s.variety_index.toFixed(2)}</div>
          <div class="muted" style="font-size:.7rem">0 = monotonous · 1 = perfectly varied</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Current streak</div>
          <div class="stat-num">${s.streak_days}d</div>
        </div>
      </div>
      <div class="stat-section">
        <h4>Most-eaten</h4>
        <ol class="top-meals">${top || '<li class="muted">No data yet.</li>'}</ol>
      </div>
      <div class="stat-section">
        <h4>By slot</h4>
        <div class="tag-chips read-only">${slots || '<span class="muted">No data yet.</span>'}</div>
      </div>
      <div class="stat-section">
        <h4>Most-used tags</h4>
        <div class="tag-chips read-only">${tags || '<span class="muted">No data yet.</span>'}</div>
      </div>
    `;
  } catch (err) {
    body.innerHTML = `<p class="error">${err.message}</p>`;
  }
}

async function renderHistory() {
  renderStats();
  const year  = historyAnchor.getFullYear();
  const month = historyAnchor.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const lastOfMonth  = new Date(year, month + 1, 0);

  // Calendar grid: start on Sunday on/before the 1st, end on Saturday on/after last day.
  const gridStart = new Date(firstOfMonth);
  gridStart.setDate(1 - firstOfMonth.getDay());
  const gridEnd = new Date(lastOfMonth);
  gridEnd.setDate(lastOfMonth.getDate() + (6 - lastOfMonth.getDay()));

  const fromISO = toISO(gridStart);
  const toISOStr = toISO(gridEnd);

  $('#history-title').textContent = firstOfMonth.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });

  const entries = await api(`/api/entries?status=eaten&from=${fromISO}&to=${toISOStr}`);
  const byDay = new Map();
  for (const e of entries) {
    if (!byDay.has(e.on_date)) byDay.set(e.on_date, []);
    byDay.get(e.on_date).push(e);
  }

  const wrap = $('#history-calendar');
  wrap.innerHTML = '';

  for (let i = 0; i < 7; i++) {
    const dh = document.createElement('div');
    dh.className = 'dow-head';
    dh.textContent = DOW_SHORT[i];
    wrap.appendChild(dh);
  }

  const today = todayISO();
  for (let d = new Date(gridStart); d <= gridEnd; d.setDate(d.getDate() + 1)) {
    const iso = toISO(d);
    const inMonth = d.getMonth() === month;
    const cell = document.createElement('div');
    cell.className = 'day hist-day' + (inMonth ? '' : ' out') + (iso === today ? ' today' : '');

    const head = document.createElement('div');
    head.className = 'day-head';
    head.innerHTML = `<span class="day-num">${d.getDate()}</span>`;
    cell.appendChild(head);

    const list = byDay.get(iso) || [];
    for (const e of list) {
      const item = document.createElement('div');
      item.className = 'hist-entry';
      const nm = e.meal?.name || '(deleted)';
      item.title = `${e.slot ? e.slot + ': ' : ''}${nm} — click to delete`;
      item.innerHTML = `<span class="slot-dot" data-slot="${e.slot || ''}"></span><span class="hist-name">${escapeHtml(nm)}</span>`;
      item.addEventListener('click', async () => {
        if (!confirm('Delete this history entry?')) return;
        await api(`/api/entries/${e.id}`, { method: 'DELETE' });
        renderHistory();
      });
      cell.appendChild(item);
    }
    wrap.appendChild(cell);
  }
}

$('#history-prev').addEventListener('click', () => { historyAnchor.setMonth(historyAnchor.getMonth() - 1); renderHistory(); });
$('#history-next').addEventListener('click', () => { historyAnchor.setMonth(historyAnchor.getMonth() + 1); renderHistory(); });
$('#history-today').addEventListener('click', () => { historyAnchor = new Date(); historyAnchor.setDate(1); historyAnchor.setHours(0,0,0,0); renderHistory(); });

// Add an eaten meal directly from the History page.
$('#history-add').addEventListener('click', () => {
  $('#history-add-date').value = todayISO();
  $('#history-add-slot').value = '';
  $('#history-add-status').textContent = '';
  $('#history-add-dialog').showModal();
});
$('#history-add-pick').addEventListener('click', async () => {
  const date = $('#history-add-date').value;
  const slot = $('#history-add-slot').value;
  if (!date) { $('#history-add-status').textContent = 'Pick a date first.'; return; }
  $('#history-add-dialog').close();
  const meal = await pickMealDialog();          // supports inline create
  if (!meal) return;
  try {
    await api('/api/entries', { method: 'POST', body: { meal_id: meal.id, on_date: date, slot, status: 'eaten' } });
    renderHistory();
  } catch (err) { alert(err.message); }
});

// ============================================================
//                          MEALS
// ============================================================
const mealForm = $('#meal-form');

// While a brand-new meal is being created, photos chosen in the file picker
// are buffered here and uploaded after the meal is saved.
let pendingPhotos = [];
// Currently-edited meal's photos (server-side ones).
let currentPhotos = [];

// ============================================================
//               COMFYUI IMAGE GENERATION
// ============================================================
let comfyInfo = { enabled: false, base_url: '', prompt_template: '' };

async function refreshComfyInfo() {
  try {
    const data = await api('/api/v1/agent/comfyui');
    comfyInfo = data.info || comfyInfo;
    return data.config || {};
  } catch {
    comfyInfo = { enabled: false, base_url: '', prompt_template: '' };
    return {};
  }
}

// Generate an image for the meal currently loaded in the form.
$('#meal-generate-img')?.addEventListener('click', async () => {
  const id = mealForm.id.value;
  if (!id) return;
  const btn = $('#meal-generate-img');
  const status = $('#meal-photo-status');
  btn.disabled = true;
  status.textContent = '🎨 Generating image via ComfyUI… (this can take a while)';
  try {
    const added = await api(`/api/meals/${id}/generate-image`, { method: 'POST', body: {} });
    currentPhotos.push({ id: added.id, filename: added.filename, url: added.url });
    renderPhotoManager();
    status.textContent = 'Image generated.';
    refreshMeals().then(renderMealsList);
  } catch (err) {
    status.textContent = 'ComfyUI error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

// -------- ComfyUI settings (Settings tab) --------
async function renderComfySettings() {
  const cfg = await refreshComfyInfo();
  const base = $('#comfy-base-url'); if (base) base.value = cfg.base_url || '';
  const tpl  = $('#comfy-prompt-template'); if (tpl) tpl.value = cfg.prompt_template || '';
  const wf   = $('#comfy-workflow'); if (wf) wf.value = cfg.workflow_json || '';
}

$('#comfy-save')?.addEventListener('click', async () => {
  const status = $('#comfy-status');
  status.classList.remove('error');
  status.textContent = 'Saving…';
  try {
    await api('/api/v1/agent/comfyui', { method: 'PUT', body: {
      base_url:        $('#comfy-base-url').value.trim(),
      prompt_template: $('#comfy-prompt-template').value.trim(),
      workflow_json:   $('#comfy-workflow').value.trim(),
    }});
    await refreshComfyInfo();
    status.textContent = comfyInfo.enabled ? '✓ Saved — image generation is enabled.' : '✓ Saved (add a base URL + workflow to enable generation).';
  } catch (err) {
    status.textContent = '✗ ' + err.message;
    status.classList.add('error');
  }
});

$('#comfy-test-btn')?.addEventListener('click', async () => {
  const status = $('#comfy-status');
  status.classList.remove('error');
  status.textContent = 'Testing connection…';
  try {
    const r = await api('/api/v1/agent/comfyui/test', { method: 'POST', body: { base_url: $('#comfy-base-url').value.trim() } });
    status.textContent = `✓ Reachable at ${r.base_url}.` + (r.has_workflow ? '' : ' (no workflow saved yet)');
  } catch (err) {
    status.textContent = '✗ ' + err.message;
    status.classList.add('error');
  }
});

// ============================================================
//                      AI CONFIG MANAGEMENT
// ============================================================
let aiInfo    = { enabled: false, provider: 'none', id: null };
let aiConfigs = [];                                    // last loaded list

async function refreshAiInfo() {
  try {
    const data = await api('/api/v1/agent/ai/configs');
    aiConfigs = data.configs || [];
    aiInfo    = data.active  || aiInfo;
  } catch {
    aiConfigs = []; aiInfo = { enabled: false, provider: 'none', id: null };
  }
  paintAiCard();
}

function paintAiCard() {
  const card = document.getElementById('ai-card');
  if (!card) return;
  const sum = document.getElementById('ai-summary');
  if (sum) {
    if (!aiConfigs.length)        sum.textContent = '· no configurations · open Settings →';
    else if (!aiInfo.enabled)     sum.textContent = `· ${aiInfo.label || aiInfo.provider} (disabled — missing key)`;
    else                          sum.textContent = `· ${aiInfo.label || aiInfo.provider} · ${aiInfo.model || '(no model)'}`;
  }

  // Quick-switch dropdown
  const sel = document.getElementById('ai-quick-switch');
  if (sel) {
    sel.innerHTML = '';
    if (!aiConfigs.length) {
      const opt = document.createElement('option');
      opt.textContent = '(none — add one in Settings)';
      opt.disabled = true;
      sel.appendChild(opt);
      sel.disabled = true;
    } else {
      sel.disabled = false;
      for (const c of aiConfigs) {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = `${c.label} — ${c.provider}${c.model ? ' / ' + c.model : ''}` + (c.has_api_key || c.provider === 'ollama' || c.provider === 'openai-compatible' ? '' : ' ⚠ no key');
        if (c.is_active) opt.selected = true;
        sel.appendChild(opt);
      }
    }
  }

  // Warnings from diagnostics (best-effort)
  const warn = document.getElementById('ai-warnings');
  if (warn) {
    warn.innerHTML = '';
    api('/api/v1/agent/diagnostics').then(d => {
      const ws = d?.ai?.warnings || [];
      if (!ws.length) return;
      const head = document.createElement('div');
      head.className = 'ai-warn-head';
      head.textContent = '⚠ Possible misconfiguration on active config';
      warn.appendChild(head);
      for (const w of ws) {
        const li = document.createElement('div');
        li.className = 'ai-warn-row';
        li.textContent = w;
        warn.appendChild(li);
      }
    }).catch(() => {});
  }
}

// Quick-switch handler (Meals tab)
document.getElementById('ai-quick-switch')?.addEventListener('change', async (ev) => {
  const id = parseInt(ev.target.value, 10);
  if (!Number.isFinite(id)) return;
  try {
    await api(`/api/v1/agent/ai/configs/${id}/activate`, { method: 'POST' });
    await refreshAiInfo();
    const out = document.getElementById('ai-test-result');
    if (out) { out.textContent = '✓ Switched active model.'; out.classList.remove('error'); }
  } catch (err) {
    alert('Switch failed: ' + err.message);
  }
});

// Test the currently-active config (Meals tab button)
document.getElementById('ai-test-btn')?.addEventListener('click', async () => {
  const out = document.getElementById('ai-test-result');
  const btn = document.getElementById('ai-test-btn');
  btn.disabled = true;
  out.textContent = 'Testing…';
  out.classList.remove('error');
  try {
    const r = await api('/api/v1/agent/ai/test');
    out.textContent = formatTestResult(r);
  } catch (err) {
    out.textContent = '✗ ' + err.message;
    out.classList.add('error');
  } finally {
    btn.disabled = false;
  }
});

function formatTestResult(r) {
  const models = r.models ? `models: ${r.models.slice(0,6).join(', ')}${r.models.length > 6 ? ` (+${r.models.length-6})` : ''}.` : '';
  const want = r.configured_model || '';
  const missing = want && r.models && !r.models.some(m => m === want || m.startsWith(want.split(':')[0]));
  return `✓ ${r.label || r.provider} at ${r.base_url}. ${models}` +
    (missing ? ` ⚠ model "${want}" not in this list.` : '');
}

// -------- Diagnostics dialog --------
function showDiagnostics() {
  const dlg = document.getElementById('diagnostics-dialog');
  const out = document.getElementById('diagnostics-output');
  out.textContent = 'Loading…';
  dlg.showModal();
  refreshDiagnostics();
}
async function refreshDiagnostics() {
  const out = document.getElementById('diagnostics-output');
  try {
    const data = await api('/api/v1/agent/diagnostics');
    out.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    out.textContent = 'Error: ' + err.message;
  }
}
document.getElementById('diagnostics-btn')?.addEventListener('click', showDiagnostics);
document.getElementById('diagnostics-refresh')?.addEventListener('click', refreshDiagnostics);

// -------- Settings tab renderer --------
async function renderSettings() {
  await refreshAiInfo();
  paintAiConfigsList();
  await renderComfySettings();
  await renderTokens();
}

// ============================================================
//                     AGENT TOKEN MANAGEMENT
// ============================================================
async function renderTokens() {
  const wrap = document.getElementById('tokens-list');
  if (!wrap) return;
  let tokens = [];
  try { tokens = (await api('/api/v1/agent/tokens')).tokens || []; }
  catch (err) { wrap.innerHTML = `<p class="muted">Could not load tokens: ${escapeHtml(err.message)}</p>`; return; }
  wrap.innerHTML = '';
  if (!tokens.length) {
    wrap.innerHTML = '<p class="muted">No tokens yet. Click <strong>+ Create token</strong> to make one for your agent.</p>';
    return;
  }
  for (const t of tokens) {
    const used = t.last_used_at ? `last used ${t.last_used_at}` : 'never used';
    const row = document.createElement('div');
    row.className = 'ai-config-row';
    row.innerHTML = `
      <div class="ai-config-info">
        <div class="ai-config-label-row"><strong>${escapeHtml(t.label)}</strong></div>
        <div class="ai-config-meta">
          <span><b>Prefix:</b> ${escapeHtml(t.token_prefix)}…</span>
          <span><b>Created:</b> ${escapeHtml(t.created_at)}</span>
          <span>${escapeHtml(used)}</span>
        </div>
      </div>
      <div class="ai-config-actions">
        <button type="button" class="danger" data-act="revoke">Revoke</button>
      </div>`;
    row.querySelector('[data-act="revoke"]').addEventListener('click', async () => {
      if (!confirm(`Revoke "${t.label}"? Any agent using it will immediately get 401s.`)) return;
      try { await api(`/api/v1/agent/tokens/${t.id}`, { method: 'DELETE' }); await renderTokens(); }
      catch (err) { alert(err.message); }
    });
    wrap.appendChild(row);
  }
}

document.getElementById('token-add-btn')?.addEventListener('click', () => {
  document.getElementById('token-label').value = '';
  document.getElementById('token-create-status').textContent = '';
  document.getElementById('token-create-dialog').showModal();
});

document.getElementById('token-create-save')?.addEventListener('click', async () => {
  const label = document.getElementById('token-label').value.trim();
  const status = document.getElementById('token-create-status');
  if (!label) { status.textContent = 'Label is required.'; status.classList.add('error'); return; }
  status.textContent = 'Creating…'; status.classList.remove('error');
  try {
    const created = await api('/api/v1/agent/tokens', { method: 'POST', body: { label } });
    document.getElementById('token-create-dialog').close();
    // Reveal the raw secret once.
    document.getElementById('token-reveal-value').textContent = created.token;
    document.getElementById('token-reveal-dialog').showModal();
    await renderTokens();
  } catch (err) {
    status.textContent = '✗ ' + err.message;
    status.classList.add('error');
  }
});

document.getElementById('token-copy-btn')?.addEventListener('click', async () => {
  const val = document.getElementById('token-reveal-value').textContent;
  const btn = document.getElementById('token-copy-btn');
  try {
    await navigator.clipboard.writeText(val);
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = '📋 Copy'; }, 1500);
  } catch {
    // Clipboard API may be blocked on non-HTTPS; fall back to selection.
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('token-reveal-value'));
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    btn.textContent = 'Select + ⌘C';
  }
});

function paintAiConfigsList() {
  const wrap = document.getElementById('ai-configs-list');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!aiConfigs.length) {
    wrap.innerHTML = '<p class="muted">No configurations yet. Click <strong>+ Add configuration</strong> above to set up Anthropic, OpenAI, Ollama, or OpenRouter.</p>';
    return;
  }
  for (const c of aiConfigs) {
    const row = document.createElement('div');
    row.className = 'ai-config-row' + (c.is_active ? ' active' : '');
    row.innerHTML = `
      <div class="ai-config-info">
        <div class="ai-config-label-row">
          <strong>${escapeHtml(c.label)}</strong>
          ${c.is_active ? '<span class="ai-active-pill">active</span>' : ''}
        </div>
        <div class="ai-config-meta">
          <span><b>Provider:</b> ${escapeHtml(c.provider)}</span>
          <span><b>Model:</b> ${escapeHtml(c.model || '(default)')}</span>
          <span><b>Base URL:</b> ${escapeHtml(c.base_url || '(default)')}</span>
          <span><b>Key:</b> ${c.has_api_key ? escapeHtml(c.api_key) : '<em class="muted">none</em>'}</span>
        </div>
        <div class="ai-config-test-out muted" data-test-out></div>
      </div>
      <div class="ai-config-actions">
        ${c.is_active ? '' : '<button type="button" data-act="activate">Activate</button>'}
        <button type="button" data-act="test">Test</button>
        <button type="button" data-act="edit">Edit</button>
        <button type="button" class="danger" data-act="delete">Delete</button>
      </div>`;
    row.querySelector('[data-act="test"]').addEventListener('click', () => testConfigInline(c, row));
    row.querySelector('[data-act="edit"]').addEventListener('click', () => openAiEditDialog(c));
    row.querySelector('[data-act="delete"]').addEventListener('click', () => deleteAiConfig(c, row));
    const actBtn = row.querySelector('[data-act="activate"]');
    if (actBtn) actBtn.addEventListener('click', async () => {
      try { await api(`/api/v1/agent/ai/configs/${c.id}/activate`, { method: 'POST' }); await refreshAiInfo(); paintAiConfigsList(); }
      catch (err) { alert(err.message); }
    });
    wrap.appendChild(row);
  }
}

async function testConfigInline(c, row) {
  const out = row.querySelector('[data-test-out]');
  out.textContent = 'Testing…';
  out.classList.remove('error');
  try {
    const r = await api(`/api/v1/agent/ai/configs/${c.id}/test`, { method: 'POST' });
    out.textContent = formatTestResult(r);
  } catch (err) {
    out.textContent = '✗ ' + err.message;
    out.classList.add('error');
  }
}

async function deleteAiConfig(c, row) {
  if (!confirm(`Delete "${c.label}"? This only removes the configuration; nothing else is affected.`)) return;
  try {
    await api(`/api/v1/agent/ai/configs/${c.id}`, { method: 'DELETE' });
    await refreshAiInfo();
    paintAiConfigsList();
  } catch (err) { alert(err.message); }
}

// -------- Add/edit dialog --------
let editingConfigId = null;
function openAiEditDialog(c) {
  editingConfigId = c?.id || null;
  document.getElementById('ai-edit-title').textContent = c ? `Edit "${c.label}"` : 'Add AI configuration';
  document.getElementById('ai-edit-label').value    = c?.label    || '';
  document.getElementById('ai-edit-provider').value = c?.provider || 'anthropic';
  document.getElementById('ai-edit-model').value    = c?.model    || '';
  document.getElementById('ai-edit-apikey').value   = '';
  document.getElementById('ai-edit-baseurl').value  = c?.base_url || '';
  document.getElementById('ai-edit-activate').checked = !!c?.is_active;
  document.getElementById('ai-edit-status').textContent = '';
  document.getElementById('ai-edit-status').classList.remove('error');
  updateAiEditHint();
  document.getElementById('ai-edit-dialog').showModal();
}
document.getElementById('ai-add-btn')?.addEventListener('click', () => openAiEditDialog(null));

const PROVIDER_HINTS = {
  anthropic:           { model: 'e.g. claude-3-5-sonnet-latest, claude-3-haiku-20240307',          base: 'leave blank (defaults to api.anthropic.com)' },
  openai:              { model: 'e.g. gpt-4o-mini, gpt-4o',                                       base: 'leave blank (defaults to api.openai.com)' },
  openrouter:          { model: 'e.g. anthropic/claude-3.5-sonnet, openai/gpt-4o-mini — MUST include vendor/ prefix', base: 'leave blank (defaults to openrouter.ai/api/v1)' },
  ollama:              { model: 'e.g. llava, bakllava, llama3.2-vision (vision-capable models only)', base: 'e.g. http://localhost:11434 or http://your-server:11434' },
  'openai-compatible': { model: 'whatever your server exposes (LM Studio shows it in the UI)',    base: 'required — e.g. http://localhost:1234/v1' },
};
function updateAiEditHint() {
  const p = document.getElementById('ai-edit-provider').value;
  const h = PROVIDER_HINTS[p] || {};
  document.getElementById('ai-edit-hint').textContent = h.model || '';
  document.getElementById('ai-edit-model').placeholder    = h.model || '';
  document.getElementById('ai-edit-baseurl').placeholder = h.base  || '';
}
document.getElementById('ai-edit-provider')?.addEventListener('change', updateAiEditHint);

function collectEditPayload() {
  const apiKeyRaw = document.getElementById('ai-edit-apikey').value;
  const body = {
    label:    document.getElementById('ai-edit-label').value.trim(),
    provider: document.getElementById('ai-edit-provider').value,
    model:    document.getElementById('ai-edit-model').value.trim(),
    base_url: document.getElementById('ai-edit-baseurl').value.trim(),
  };
  // Only send api_key if user actually typed something (empty = keep existing on edit)
  if (apiKeyRaw) body.api_key = apiKeyRaw;
  else if (!editingConfigId) body.api_key = '';
  return body;
}

document.getElementById('ai-edit-save')?.addEventListener('click', async () => {
  const status = document.getElementById('ai-edit-status');
  const body = collectEditPayload();
  if (!body.label) { status.textContent = 'Label is required.'; status.classList.add('error'); return; }
  body.activate = document.getElementById('ai-edit-activate').checked;
  status.textContent = 'Saving…'; status.classList.remove('error');
  try {
    if (editingConfigId) {
      await api(`/api/v1/agent/ai/configs/${editingConfigId}`, { method: 'PATCH', body });
      if (body.activate) await api(`/api/v1/agent/ai/configs/${editingConfigId}/activate`, { method: 'POST' });
    } else {
      await api('/api/v1/agent/ai/configs', { method: 'POST', body });
    }
    document.getElementById('ai-edit-dialog').close();
    await refreshAiInfo();
    paintAiConfigsList();
  } catch (err) {
    status.textContent = '✗ ' + err.message;
    status.classList.add('error');
  }
});

document.getElementById('ai-edit-test')?.addEventListener('click', async () => {
  const status = document.getElementById('ai-edit-status');
  status.textContent = 'Testing (will save first if new)…';
  status.classList.remove('error');
  try {
    const body = collectEditPayload();
    if (!body.label) { status.textContent = 'Label is required.'; status.classList.add('error'); return; }
    // For testing without persisting changes: save (or update) then test that id.
    let id = editingConfigId;
    if (id) {
      await api(`/api/v1/agent/ai/configs/${id}`, { method: 'PATCH', body });
    } else {
      const created = await api('/api/v1/agent/ai/configs', { method: 'POST', body });
      id = created.config.id;
      editingConfigId = id;
      document.getElementById('ai-edit-title').textContent = `Edit "${body.label}"`;
    }
    const r = await api(`/api/v1/agent/ai/configs/${id}/test`, { method: 'POST' });
    status.textContent = formatTestResult(r);
    await refreshAiInfo();
    paintAiConfigsList();
  } catch (err) {
    status.textContent = '✗ ' + err.message;
    status.classList.add('error');
  }
});

// Two-step delete: 1st click arms (red border + "Confirm?" button + 4s timer),
// 2nd click within 4s deletes. Click anywhere else cancels.
function armDelete(tile, doDelete) {
  if (tile.dataset.armed === '1') return;       // already armed
  tile.dataset.armed = '1';
  tile.classList.add('arming');
  const btn = tile.querySelector('.photo-del');
  const originalLabel = btn.innerHTML;
  btn.innerHTML = '✓ Confirm';
  btn.title = 'Click again to delete · clears in 4s';

  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    tile.dataset.armed = '0';
    tile.classList.remove('arming');
    btn.innerHTML = originalLabel;
    btn.title = 'Remove';
    document.removeEventListener('click', onDocClick, true);
    clearTimeout(timer);
  };
  const onDocClick = (ev) => {
    // Cancel if click is outside this tile (or on a non-delete element within).
    if (!tile.contains(ev.target) || !ev.target.closest('.photo-del')) cancel();
  };
  const timer = setTimeout(cancel, 4000);
  // Defer attaching so this very click event doesn't trigger cancel itself.
  setTimeout(() => document.addEventListener('click', onDocClick, true), 0);

  const onConfirm = async (ev) => {
    if (cancelled) return;
    ev.stopPropagation();
    cancel();
    try { await doDelete(); } catch (err) { alert(err.message); }
  };
  btn.addEventListener('click', onConfirm, { once: true });
}

function renderPhotoManager() {
  const wrap = $('#meal-photos');
  wrap.innerHTML = '';
  for (const p of currentPhotos) {
    const tile = document.createElement('div');
    tile.className = 'photo-tile';
    tile.innerHTML = `
      <img src="${p.url}" alt="" />
      <div class="photo-broken" hidden>
        <div class="photo-broken-icon">⚠</div>
        <div class="photo-broken-text">Image failed to load</div>
      </div>
      <button type="button" class="photo-del" title="Remove">✕</button>`;
    const img = tile.querySelector('img');
    img.addEventListener('error', () => {
      img.style.display = 'none';
      tile.querySelector('.photo-broken').hidden = false;
      tile.classList.add('broken');
    });
    tile.querySelector('.photo-del').addEventListener('click', (ev) => {
      ev.stopPropagation();
      armDelete(tile, async () => {
        const mealId = mealForm.id.value;
        if (mealId) await api(`/api/meals/${mealId}/photos/${p.id}`, { method: 'DELETE' });
        currentPhotos = currentPhotos.filter(x => x.id !== p.id);
        renderPhotoManager();
        refreshMeals().then(renderMealsList);
      });
    });
    img.addEventListener('click', () => openLightbox(p.url, p));
    wrap.appendChild(tile);
  }
  for (const pp of pendingPhotos) {
    const tile = document.createElement('div');
    tile.className = 'photo-tile pending';
    tile.innerHTML = `<img src="${pp.preview}" alt="" /><span class="photo-pending">pending</span><button type="button" class="photo-del" title="Remove">✕</button>`;
    tile.querySelector('.photo-del').addEventListener('click', (ev) => {
      ev.stopPropagation();
      armDelete(tile, () => {
        pendingPhotos = pendingPhotos.filter(x => x !== pp);
        renderPhotoManager();
      });
    });
    wrap.appendChild(tile);
  }
}

// Minimal lightbox (click-through, esc/click to close).
function openLightbox(url, photo) {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox';
  overlay.innerHTML = `
    <button class="lightbox-close" title="Close">✕</button>
    <img src="${url}" alt="" />`;
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay || ev.target.classList.contains('lightbox-close')) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function uploadPhotoForMeal(mealId, dataUrl) {
  return api(`/api/meals/${mealId}/photos`, { method: 'POST', body: { data: dataUrl } });
}

$('#meal-photo-input').addEventListener('change', async (e) => {
  const status = $('#meal-photo-status');
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;
  const mealId = mealForm.id.value;
  if (mealId) {
    status.textContent = `Uploading ${files.length} photo${files.length === 1 ? '' : 's'}…`;
    try {
      for (const f of files) {
        const dataUrl = await fileToDataURL(f);
        const added = await uploadPhotoForMeal(mealId, dataUrl);
        currentPhotos.push(added);
      }
      status.textContent = 'Uploaded.';
      renderPhotoManager();
      refreshMeals().then(renderMealsList);
    } catch (err) {
      status.textContent = 'Error: ' + err.message;
    }
  } else {
    // Buffer until the meal is created.
    for (const f of files) {
      pendingPhotos.push({ file: f, preview: await fileToDataURL(f) });
    }
    status.textContent = `${pendingPhotos.length} photo${pendingPhotos.length === 1 ? '' : 's'} ready to upload on save.`;
    renderPhotoManager();
  }
});

async function analyzePhoto(photo) {
  const status = $('#meal-photo-status');
  status.textContent = `Analyzing with ${aiInfo.provider}…`;
  try {
    const result = await api(`/api/v1/agent/photos/${photo.id}/analyze`, { method: 'POST' });
    // Update in-memory photo with new analysis and re-render.
    const idx = currentPhotos.findIndex(p => p.id === photo.id);
    if (idx >= 0) {
      currentPhotos[idx] = { ...currentPhotos[idx], analysis: result.analysis, analyzed_at: new Date().toISOString() };
    }
    renderPhotoManager();
    status.textContent = 'Analysis complete. Click the photo to view.';
    showAnalysisDialog(currentPhotos[idx]);
  } catch (err) {
    status.textContent = 'AI error: ' + err.message;
  }
}

function showAnalysisDialog(photo) {
  const a = photo.analysis;
  if (!a) return;
  const dlg = document.createElement('dialog');
  dlg.className = 'analysis-dialog';
  const n = a.nutrition || {};
  const portion = a.portion || {};
  dlg.innerHTML = `
    <form method="dialog">
      <h3>${escapeHtml(a.dish_name || 'Food analysis')}</h3>
      <p class="muted">${escapeHtml(a.description || '')}</p>
      <div class="kv">
        ${a.cuisine ? `<div><span class="muted">Cuisine:</span> ${escapeHtml(a.cuisine)}</div>` : ''}
        ${portion.size ? `<div><span class="muted">Portion:</span> ${escapeHtml(portion.size)}${portion.estimated_grams ? ' · ~' + portion.estimated_grams + 'g' : ''}</div>` : ''}
        ${typeof a.confidence === 'number' ? `<div><span class="muted">Confidence:</span> ${(a.confidence * 100).toFixed(0)}%</div>` : ''}
      </div>
      ${(a.tags && a.tags.length) ? `<div class="tag-chips read-only" style="margin:.5rem 0">${a.tags.map(t => `<span class="chip">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      <div class="nutrition-grid" style="margin:.5rem 0">
        ${nutritionRow('Calories', n.calories)}
        ${nutritionRow('Protein', n.protein_g, 'g')}
        ${nutritionRow('Carbs', n.carbs_g, 'g')}
        ${nutritionRow('Fat', n.fat_g, 'g')}
        ${nutritionRow('Fiber', n.fiber_g, 'g')}
        ${nutritionRow('Sodium', n.sodium_mg, 'mg')}
      </div>
      ${(a.ingredients && a.ingredients.length) ? `<p class="muted" style="font-size:.85rem"><strong>Ingredients:</strong> ${escapeHtml(a.ingredients.join(', '))}</p>` : ''}
      <div class="row">
        <button type="button" data-apply="tags">Apply tags</button>
        <button type="button" data-apply="nutrition">Apply nutrition</button>
        <button type="button" data-apply="description">Apply description</button>
        <button type="button" data-apply="all" class="primary">Apply all</button>
        <button value="cancel">Close</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.querySelectorAll('[data-apply]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const which = btn.dataset.apply;
      const body = which === 'all'
        ? { tags: true, nutrition: true, description: true }
        : { [which]: true };
      try {
        await api(`/api/v1/agent/photos/${photo.id}/apply`, { method: 'POST', body });
        // Reload the meal into the form to reflect the changes.
        const meal = await api(`/api/meals/${mealForm.id.value}`);
        fillForm(meal);
        dlg.close();
        refreshMeals().then(renderMealsList);
      } catch (err) {
        alert(err.message);
      }
    });
  });
  dlg.showModal();
}

function nutritionRow(label, val, unit = '') {
  if (val == null) return `<div class="nu"><span class="muted">${label}</span><span>—</span></div>`;
  return `<div class="nu"><span class="muted">${label}</span><span>${val}${unit ? ' ' + unit : ''}</span></div>`;
}

function fillForm(meal) {
  mealForm.id.value    = meal?.id || '';
  mealForm.name.value  = meal?.name || '';
  mealForm.notes.value = meal?.notes || '';
  mealForm.tags.value  = (meal?.tags || []).map(t => t.name).join(', ');
  $('#meal-form-title').textContent = meal ? `Edit: ${meal.name}` : 'Add a meal';
  currentPhotos = (meal?.photos || []).slice();
  pendingPhotos = [];
  $('#meal-photo-status').textContent = '';
  renderPhotoManager();
  // The "Generate image" button only applies to an already-saved meal and
  // only when ComfyUI is configured.
  const genBtn = $('#meal-generate-img');
  if (genBtn) genBtn.hidden = !(meal?.id && comfyInfo.enabled);
  mealForm.name.focus();
  mealForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#meal-form-reset').addEventListener('click', () => fillForm(null));

mealForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id    = mealForm.id.value;
  const body  = {
    name:  mealForm.name.value.trim(),
    notes: mealForm.notes.value.trim(),
    tags:  mealForm.tags.value.split(',').map(s => s.trim()).filter(Boolean),
  };
  try {
    let saved;
    if (id) saved = await api(`/api/meals/${id}`, { method: 'PUT', body });
    else    saved = await api('/api/meals',        { method: 'POST', body });

    if (pendingPhotos.length) {
      $('#meal-photo-status').textContent = `Uploading ${pendingPhotos.length} photo(s)…`;
      for (const pp of pendingPhotos) {
        try { await uploadPhotoForMeal(saved.id, pp.preview); }
        catch (err) { console.warn('photo upload failed', err); }
      }
      pendingPhotos = [];
    }
    fillForm(null);
    renderMeals();
  } catch (err) {
    alert(err.message);
  }
});

function renderMealsFilterTags() {
  const wrap = $('#meals-filter-tags');
  wrap.innerHTML = '';
  for (const t of state.tags) {
    wrap.appendChild(chip(t.name, {
      on: state.mealsFilter.has(t.name),
      onClick: (el) => {
        if (state.mealsFilter.has(t.name)) state.mealsFilter.delete(t.name);
        else state.mealsFilter.add(t.name);
        el.classList.toggle('on');
        renderMealsList();
      },
    }));
  }
}

function renderMealsList() {
  const q = $('#meals-search').value.toLowerCase();
  const filterTags = state.mealsFilter;
  const wrap = $('#meals-list');
  wrap.innerHTML = '';
  const filtered = state.meals.filter(m => {
    if (q && !m.name.toLowerCase().includes(q)) return false;
    for (const t of filterTags) {
      if (!m.tags.some(mt => mt.name.toLowerCase() === t.toLowerCase())) return false;
    }
    return true;
  });
  if (!filtered.length) {
    wrap.innerHTML = '<p class="muted">No meals match. Add some above.</p>';
    return;
  }
  for (const m of filtered) {
    const tile = document.createElement('div');
    tile.className = 'meal-tile';
    const cover = (m.photos && m.photos[0]) ? m.photos[0].url : '';
    const tagStr = m.tags.map(t => `<span class="chip">${escapeHtml(t.name)}</span>`).join(' ');
    const count = (m.photos || []).length;
    tile.innerHTML = `
      <div class="tile-cover" ${cover ? `style="background-image:url('${cover}')"` : ''}>
        ${cover ? '' : '<span class="tile-placeholder">🍽️</span>'}
        ${count > 1 ? `<span class="tile-count">📷 ${count}</span>` : ''}
        <button class="tile-del danger" title="Delete meal" data-act="del">✕</button>
      </div>
      <div class="tile-body">
        <div class="tile-name"><strong>${escapeHtml(m.name)}</strong></div>
        ${m.notes ? `<div class="meta">${escapeHtml(m.notes)}</div>` : ''}
        ${tagStr ? `<div class="tag-chips read-only">${tagStr}</div>` : ''}
      </div>`;
    tile.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-act=del]')) return;
      fillForm(m);
    });
    tile.querySelector('[data-act=del]').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Delete "${m.name}"? This also removes its history entries and photos.`)) return;
      await api(`/api/meals/${m.id}`, { method: 'DELETE' });
      renderMeals();
    });
    wrap.appendChild(tile);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

$('#meals-search').addEventListener('input', renderMealsList);

function renderTagsManage() {
  const wrap = $('#tags-manage');
  wrap.innerHTML = '';
  if (!state.tags.length) {
    wrap.innerHTML = '<p class="muted">No tags yet. Add tags when creating or editing a meal.</p>';
    return;
  }
  for (const t of state.tags) {
    const row = document.createElement('div');
    row.className = 'tag-row';
    row.innerHTML = `
      <input type="text" value="${t.name.replace(/"/g, '&quot;')}" data-orig="${t.name.replace(/"/g, '&quot;')}" />
      <span class="meta">${t.meal_count} meal${t.meal_count === 1 ? '' : 's'}</span>
      <button data-act="save">Save</button>
      <button class="danger" data-act="del">✕</button>`;
    const input = row.querySelector('input');
    row.querySelector('[data-act=save]').addEventListener('click', async () => {
      const name = input.value.trim();
      if (!name || name === t.name) return;
      try {
        await api(`/api/tags/${t.id}`, { method: 'PUT', body: { name } });
        await Promise.all([refreshTags(), refreshMeals()]);
        renderTagsManage();
        renderMealsFilterTags();
        renderMealsList();
      } catch (err) { alert(err.message); }
    });
    row.querySelector('[data-act=del]').addEventListener('click', async () => {
      if (!confirm(`Delete tag "${t.name}"? It will be removed from ${t.meal_count} meal${t.meal_count === 1 ? '' : 's'}.`)) return;
      try {
        await api(`/api/tags/${t.id}`, { method: 'DELETE' });
        state.mealsFilter.delete(t.name);
        state.pickFilter.delete(t.name);
        await Promise.all([refreshTags(), refreshMeals()]);
        renderTagsManage();
        renderMealsFilterTags();
        renderMealsList();
      } catch (err) { alert(err.message); }
    });
    wrap.appendChild(row);
  }
}

async function renderMeals() {
  await Promise.all([refreshTags(), refreshMeals()]);
  renderTagsManage();
  renderMealsFilterTags();
  renderMealsList();
}

// ---- CSV import (Meals tab) ----
$('#csv-import').addEventListener('click', async () => {
  const fileEl = $('#csv-file');
  const status = $('#csv-status');
  const file = fileEl.files[0];
  if (!file) { status.textContent = 'Pick a .csv file first.'; return; }
  status.textContent = 'Parsing…';
  try {
    const text = await file.text();
    const records = parseCsvForUpload(text);
    if (!records.length) { status.textContent = 'No rows found.'; return; }
    status.textContent = `Uploading ${records.length} rows…`;
    const result = await api('/api/meals/bulk', {
      method: 'POST',
      body: { meals: records, merge_tags: !$('#csv-replace').checked },
    });
    status.textContent =
      `✓ created ${result.created} · updated ${result.updated} · skipped ${result.skipped}` +
      (result.errors?.length ? ` · ${result.errors.length} errors (see console)` : '');
    if (result.errors?.length) console.warn('CSV import errors:', result.errors);
    fileEl.value = '';
    renderMeals();
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
  }
});

// Same CSV grammar as scripts/import-csv.js: quoted fields, "" escapes a quote.
function parseCsvForUpload(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (!(row.length === 1 && row[0] === '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (rows.length < 2) return [];
  // Header aliases. Keep in sync with scripts/import-csv.js.
  const NAME_ALIASES  = ['name', 'dish', 'dish name', 'meal', 'meal name', 'food'];
  const TAGS_ALIASES  = ['tags', 'tag', 'category', 'categories', 'cuisine', 'cuisine type', 'type'];
  const NOTES_ALIASES = ['notes', 'note', 'description', 'comment', 'comments'];
  const headers = rows[0].map(h => h.trim().toLowerCase());
  const find = (al) => headers.findIndex(h => al.includes(h));
  const ni = find(NAME_ALIASES);
  const ti = find(TAGS_ALIASES);
  const di = find(NOTES_ALIASES);
  if (ni === -1) throw new Error(`CSV needs a name column (one of: ${NAME_ALIASES.join(', ')})`);
  return rows.slice(1)
    .map(r => ({ name: r[ni], tags: ti > -1 ? r[ti] : '', notes: di > -1 ? r[di] : '' }))
    .filter(r => (r.name || '').trim());
}

// ============================================================
//                           HOME
// ============================================================
function greeting() {
  const h = new Date().getHours();
  if (h < 5)  return 'Up late 🌙';
  if (h < 12) return 'Good morning ☀️';
  if (h < 17) return 'Good afternoon 👋';
  if (h < 22) return 'Good evening 🍷';
  return 'Up late 🌙';
}

async function renderHome() {
  // Greeting + date
  $('#home-greeting').textContent = greeting();
  $('#home-date').textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const today = todayISO();

  // ----- This week's lunches card -----
  // Show this work-week's planned lunches (Mon–Fri), each with its veggie side.
  const mon = weekStart(new Date());
  const weekDays = Array.from({ length: 5 }, (_, i) => {
    const d = new Date(mon); d.setDate(mon.getDate() + i); return toISO(d);
  });
  let weekEntries = [];
  try { weekEntries = await api(`/api/entries?from=${weekDays[0]}&to=${weekDays[4]}`); } catch { weekEntries = []; }
  const lunchByDay = new Map();
  for (const e of weekEntries) {
    if (e.slot !== 'lunch' && e.slot !== 'side') continue;
    if (!lunchByDay.has(e.on_date)) lunchByDay.set(e.on_date, {});
    lunchByDay.get(e.on_date)[e.slot] = e;
  }

  const todayWrap = $('#home-today-slots');
  todayWrap.innerHTML = '';
  const plannedDays = weekDays.filter(d => lunchByDay.get(d)?.lunch);
  if (!plannedDays.length) {
    todayWrap.innerHTML = `<p class="muted">No lunches planned this week. <a href="#plan" data-tab="plan">Open the plan</a> or <button class="link-btn" id="home-week-fill">auto-fill the week →</button></p>`;
    $('#home-week-fill')?.addEventListener('click', () => openSuggestDialog());
  } else {
    for (const d of weekDays) {
      const lunch = lunchByDay.get(d)?.lunch;
      if (!lunch) continue;
      const side = lunchByDay.get(d)?.side;
      const dow = DOW_SHORT[new Date(d + 'T00:00').getDay()];
      const sideStr = side ? ` <span class="muted">+ ${escapeHtml(side.meal?.name || '')}</span>` : '';
      const row = document.createElement('div');
      row.className = 'home-slot' + (lunch.status === 'eaten' ? ' eaten' : '') + (d === today ? ' today' : '');
      row.innerHTML = `
        <span class="home-slot-label">${dow}</span>
        <span class="home-slot-name">${escapeHtml(lunch.meal?.name || '(deleted meal)')}${sideStr}</span>
        ${lunch.status === 'eaten' ? '<span class="home-slot-tag">✓ eaten</span>' : '<button class="ctrl home-eat" title="Mark eaten">🍽️</button>'}`;
      const eatBtn = row.querySelector('.home-eat');
      if (eatBtn) eatBtn.addEventListener('click', async () => {
        await api(`/api/entries/${lunch.id}`, { method: 'PATCH', body: { status: 'eaten' } });
        renderHome();
      });
      todayWrap.appendChild(row);
    }
  }

  // Upcoming planned entries (any slot) over the next ~10 days.
  let entries = [];
  try { entries = await api(`/api/entries?from=${today}&to=${isoDateOffset(today, 10)}&status=planned`); } catch { entries = []; }
  const upcoming = entries.filter(e => e.on_date >= today).slice(0, 6);

  // ----- Stats card -----
  try {
    const s = await api('/api/v1/agent/stats?days=365');
    $('#home-stats-grid').innerHTML = `
      <div class="stat-card"><div class="stat-label">Eaten</div><div class="stat-num">${s.total_eaten}</div></div>
      <div class="stat-card"><div class="stat-label">Unique</div><div class="stat-num">${s.unique_meals}</div></div>
      <div class="stat-card"><div class="stat-label">Variety</div><div class="stat-num">${s.variety_index.toFixed(2)}</div></div>
      <div class="stat-card"><div class="stat-label">Streak</div><div class="stat-num">${s.streak_days}d</div></div>`;
  } catch {
    $('#home-stats-grid').innerHTML = '<p class="muted">Stats unavailable.</p>';
  }

  // ----- Upcoming card -----
  const upWrap = $('#home-upcoming-list');
  upWrap.innerHTML = '';
  if (!upcoming.length) {
    upWrap.innerHTML = '<p class="muted">No meals planned for the next 7 days. <button class="link-btn" id="home-upcoming-fill">Auto-fill the week →</button></p>';
    $('#home-upcoming-fill')?.addEventListener('click', () => openSuggestDialog());
  } else {
    for (const e of upcoming) {
      const row = document.createElement('div');
      row.className = 'home-upcoming-row';
      const d = new Date(e.on_date + 'T00:00');
      row.innerHTML = `
        <span class="home-upcoming-date">${d.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' })}</span>
        <span class="home-upcoming-slot">${escapeHtml(e.slot)}</span>
        <span class="home-upcoming-name">${escapeHtml(e.meal?.name || '(deleted)')}</span>`;
      upWrap.appendChild(row);
    }
  }

  // ----- Recent photos card -----
  await refreshMeals();
  const all = state.meals.flatMap(m => (m.photos || []).map(p => ({ ...p, meal: m })));
  all.sort((a, b) => b.id - a.id);
  const recent = all.slice(0, 8);
  const stripWrap = $('#home-recent-photos');
  stripWrap.innerHTML = '';
  if (!recent.length) {
    stripWrap.innerHTML = '<p class="muted">No photos yet. Add some on the Meals tab.</p>';
  } else {
    for (const p of recent) {
      const tile = document.createElement('div');
      tile.className = 'photo-strip-tile';
      tile.style.backgroundImage = `url('${p.url}')`;
      tile.title = p.meal.name;
      tile.innerHTML = `<span class="photo-strip-name">${escapeHtml(p.meal.name)}</span>`;
      tile.addEventListener('click', () => {
        fillForm(p.meal);
        showTab('meals');
      });
      stripWrap.appendChild(tile);
    }
  }
}

function isoDateOffset(iso, days) {
  const d = new Date(iso + 'T00:00');
  d.setDate(d.getDate() + days);
  return toISO(d);
}

// ============================================================
//                          PHOTOS
// ============================================================
async function renderPhotos() {
  await refreshMeals();
  paintPhotosGrid();
}
function paintPhotosGrid() {
  const q = ($('#photos-search').value || '').toLowerCase();
  const all = state.meals.flatMap(m => (m.photos || []).map(p => ({ ...p, meal: m })));
  const filtered = all.filter(p => {
    if (q && !p.meal.name.toLowerCase().includes(q)) return false;
    return true;
  });
  filtered.sort((a, b) => b.id - a.id);
  $('#photos-count').textContent = `${filtered.length} of ${all.length} photos`;
  const grid = $('#photos-grid');
  grid.innerHTML = '';
  if (!filtered.length) {
    grid.innerHTML = '<p class="muted">No photos match.</p>';
    return;
  }
  for (const p of filtered) {
    const tile = document.createElement('div');
    tile.className = 'photos-tile';
    tile.innerHTML = `
      <div class="photos-cover" style="background-image:url('${p.url}')"></div>
      <div class="photos-caption">
        <div class="photos-name">${escapeHtml(p.meal.name)}</div>
        ${p.meal.tags?.length ? `<div class="muted" style="font-size:.75rem">${escapeHtml(p.meal.tags.map(t => t.name).join(' · '))}</div>` : ''}
      </div>`;
    tile.addEventListener('click', () => {
      fillForm(p.meal);
      showTab('meals');
    });
    grid.appendChild(tile);
  }
}
$('#photos-search').addEventListener('input', paintPhotosGrid);

// ============================================================
//                     SUGGEST (auto-fill) DIALOG
// ============================================================
let suggestedSlots = [];     // current preview, mutable for rerolls
let suggestedExcludeIds = new Set();

async function openSuggestDialog() {
  // Make sure tags are loaded so the chip selector is populated.
  if (!state.tags.length) { try { await refreshTags(); } catch {} }
  const dlg = $('#suggest-dialog');
  $('#suggest-step1').hidden = false;
  $('#suggest-step2').hidden = true;
  applyDatePreset('weekdays');
  $('#suggest-variety').value = '0.6';
  $('#suggest-variety-val').textContent = '0.6';
  renderSuggestTags();
  suggestedSlots = [];
  suggestedExcludeIds = new Set();
  dlg.showModal();
}

function applyDatePreset(preset) {
  const today = new Date(); today.setHours(0,0,0,0);
  let from, to;
  if (preset === 'tomorrow') {
    from = isoOffsetDate(today, 1);
    to   = from;
  } else if (preset === 'weekdays') {
    // Next 5 weekdays starting tomorrow (skip Sat/Sun).
    const days = [];
    const cursor = new Date(today);
    while (days.length < 5) {
      cursor.setDate(cursor.getDate() + 1);
      if (cursor.getDay() !== 0 && cursor.getDay() !== 6) days.push(toISO(cursor));
    }
    from = days[0]; to = days[days.length - 1];
  } else if (preset === 'week7') {
    from = isoOffsetDate(today, 1);
    to   = isoOffsetDate(today, 7);
  } else if (preset === 'weekend') {
    // Next Sat + Sun
    const cursor = new Date(today);
    while (cursor.getDay() !== 6) cursor.setDate(cursor.getDate() + 1);
    from = toISO(cursor);
    cursor.setDate(cursor.getDate() + 1);
    to = toISO(cursor);
  }
  $('#suggest-from').value = from;
  $('#suggest-to').value = to;
}
function isoOffsetDate(date, days) {
  const d = new Date(date); d.setDate(d.getDate() + days);
  return toISO(d);
}

function renderSuggestTags() {
  const wrap = $('#suggest-tags');
  wrap.innerHTML = '';
  const selected = new Set();
  for (const t of state.tags) {
    wrap.appendChild(chip(t.name, {
      on: false,
      onClick: (el) => {
        if (selected.has(t.name)) selected.delete(t.name);
        else selected.add(t.name);
        el.classList.toggle('on');
      },
    }));
  }
  wrap.dataset.selected = '';  // placeholder; we'll read via .chip.on
}

function readSelectedSuggestTags() {
  return $$('#suggest-tags .chip.on').map(el => el.textContent);
}

function datesBetween(fromISO, toISOStr) {
  const out = [];
  if (!fromISO || !toISOStr) return out;
  const a = new Date(fromISO + 'T00:00');
  const b = new Date(toISOStr + 'T00:00');
  if (b < a) return out;
  for (const d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) out.push(toISO(d));
  return out;
}

async function generateSuggestions() {
  const from = $('#suggest-from').value;
  const to   = $('#suggest-to').value;
  const dates = datesBetween(from, to);
  if (!dates.length) { alert('Pick a valid date range.'); return; }
  const slots = $$('#suggest-step1 input[name="slot"]:checked').map(c => c.value);
  if (!slots.length) { alert('Pick at least one slot.'); return; }

  const body = {
    dates, slots,
    tags: readSelectedSuggestTags(),
    variety: parseFloat($('#suggest-variety').value),
    avoid_days: parseInt($('#suggest-avoid').value, 10),
    skip_filled: $('#suggest-skip-filled').checked,
  };
  const genBtn = $('#suggest-generate');
  genBtn.disabled = true;
  genBtn.textContent = 'Thinking…';
  try {
    const data = await api('/api/v1/agent/plan/suggest', { method: 'POST', body });
    suggestedSlots = data.suggestions || [];
    suggestedExcludeIds = new Set(suggestedSlots.map(s => s.meal.id));
    $('#suggest-summary').textContent = `${data.fills} of ${data.requested} slots filled${data.fallback ? ' · ' + data.fallback : ''}`;
    renderSuggestPreview();
    $('#suggest-step1').hidden = true;
    $('#suggest-step2').hidden = false;
  } catch (err) {
    alert(err.message);
  } finally {
    genBtn.disabled = false;
    genBtn.textContent = 'Generate suggestions';
  }
}

function renderSuggestPreview() {
  const wrap = $('#suggest-preview');
  wrap.innerHTML = '';
  if (!suggestedSlots.length) {
    wrap.innerHTML = '<p class="muted">No suggestions to show.</p>';
    return;
  }
  // Group by date for readability.
  const byDate = new Map();
  for (const s of suggestedSlots) {
    if (!byDate.has(s.on_date)) byDate.set(s.on_date, []);
    byDate.get(s.on_date).push(s);
  }
  for (const [date, items] of byDate) {
    const day = document.createElement('div');
    day.className = 'sg-day';
    const d = new Date(date + 'T00:00');
    day.innerHTML = `<div class="sg-day-head">${d.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' })}</div>`;
    for (const s of items) {
      const row = document.createElement('div');
      row.className = 'sg-row';
      row.innerHTML = `
        <span class="sg-slot">${escapeHtml(s.slot)}</span>
        <span class="sg-name">${escapeHtml(s.meal.name)}</span>
        <button type="button" class="sg-reroll" title="Different suggestion">🔄</button>
        <button type="button" class="sg-remove danger" title="Skip this slot">✕</button>`;
      row.querySelector('.sg-reroll').addEventListener('click', () => rerollSuggestion(s));
      row.querySelector('.sg-remove').addEventListener('click', () => removeSuggestion(s));
      day.appendChild(row);
    }
    wrap.appendChild(day);
  }
}

async function rerollSuggestion(s) {
  try {
    const data = await api('/api/v1/agent/plan/suggest', {
      method: 'POST',
      body: {
        dates: [s.on_date],
        slots: [s.slot],
        tags: readSelectedSuggestTags(),
        variety: parseFloat($('#suggest-variety').value),
        avoid_days: parseInt($('#suggest-avoid').value, 10),
        skip_filled: false,
        exclude_meal_ids: Array.from(suggestedExcludeIds),
      },
    });
    const fresh = data.suggestions?.[0];
    if (!fresh) { alert('No other meals match those filters.'); return; }
    // Replace the entry in-place; rotate the exclusion set.
    suggestedExcludeIds.delete(s.meal.id);
    suggestedExcludeIds.add(fresh.meal.id);
    const idx = suggestedSlots.findIndex(x => x.on_date === s.on_date && x.slot === s.slot);
    if (idx >= 0) suggestedSlots[idx] = fresh;
    renderSuggestPreview();
  } catch (err) {
    alert(err.message);
  }
}

function removeSuggestion(s) {
  suggestedSlots = suggestedSlots.filter(x => !(x.on_date === s.on_date && x.slot === s.slot));
  suggestedExcludeIds.delete(s.meal.id);
  renderSuggestPreview();
}

async function applySuggestions() {
  if (!suggestedSlots.length) { $('#suggest-dialog').close(); return; }
  const btn = $('#suggest-apply');
  btn.disabled = true;
  btn.textContent = 'Adding…';
  try {
    for (const s of suggestedSlots) {
      await api('/api/entries', {
        method: 'POST',
        body: { meal_id: s.meal.id, on_date: s.on_date, slot: s.slot, status: 'planned' },
      });
    }
    $('#suggest-dialog').close();
    // If we're on the plan view, refresh it.
    if (!$('section[data-view="plan"]').hidden) renderPlan();
    if (!$('section[data-view="home"]').hidden) renderHome();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add all to plan';
  }
}

// Wire up controls
$$('#suggest-step1 [data-preset]').forEach(b => b.addEventListener('click', () => applyDatePreset(b.dataset.preset)));
$('#suggest-variety').addEventListener('input', (e) => {
  $('#suggest-variety-val').textContent = parseFloat(e.target.value).toFixed(2);
});
$('#suggest-generate').addEventListener('click', generateSuggestions);
$('#suggest-back').addEventListener('click', () => {
  $('#suggest-step1').hidden = false;
  $('#suggest-step2').hidden = true;
});
$('#suggest-apply').addEventListener('click', applySuggestions);
$('#plan-autofill').addEventListener('click', openSuggestDialog);
$('#home-autofill').addEventListener('click', openSuggestDialog);

// ============================================================
//                     AGENT NOTES BANNER
// ============================================================
// Notes are pushed by external agents (or by the user) and surface as a
// dismissable banner across the top of the app.

async function refreshNotesBanner() {
  try {
    const notes = await api('/api/v1/agent/notes?dismissed=0');
    const banner = $('#notes-banner');
    if (!notes.length) { banner.hidden = true; banner.innerHTML = ''; return; }
    banner.hidden = false;
    banner.innerHTML = '';
    for (const n of notes) {
      const row = document.createElement('div');
      row.className = 'note note-' + (n.kind || 'info');
      const meta = [n.source, n.due_date].filter(Boolean).join(' · ');
      row.innerHTML = `
        <span class="note-kind">${escapeHtml(n.kind)}</span>
        <span class="note-text">${escapeHtml(n.text)}</span>
        ${meta ? `<span class="note-meta">${escapeHtml(meta)}</span>` : ''}
        <button class="note-dismiss" title="Dismiss">✕</button>`;
      row.querySelector('.note-dismiss').addEventListener('click', async () => {
        await api(`/api/v1/agent/notes/${n.id}`, { method: 'PATCH', body: { dismissed: true } });
        refreshNotesBanner();
      });
      banner.appendChild(row);
    }
  } catch { /* offline / unauthenticated */ }
}

// ----------------------- boot -----------------------
(async () => {
  await refreshComfyInfo();
  await refreshNotesBanner();
  // Poll for new notes every 5 minutes so external agents can push reminders.
  setInterval(refreshNotesBanner, 5 * 60 * 1000);
})();
// Honour an existing hash (e.g. landed via /#photos), otherwise default to home.
const initialTab = (location.hash || '#home').slice(1);
showTab(['home','pick','plan','history','photos','meals','settings'].includes(initialTab) ? initialTab : 'home');
