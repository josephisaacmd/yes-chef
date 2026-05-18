// web-menu front-end. Plain JS modules, no framework.
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
    throw new Error(data.error || `HTTP ${res.status}`);
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
  const renderers = { pick: renderPick, plan: renderPlan, history: renderHistory, meals: renderMeals };
  renderers[name]?.();
}
$$('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

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

async function rollPick() {
  const params = pickQueryString();
  const avoid = parseInt($('#pick-avoid').value, 10);
  if (Number.isFinite(avoid) && avoid >= 0) params.set('avoid_days', String(avoid));
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

// ============================================================
//                          PLAN
// ============================================================
// Each group renders as a labelled section inside a day card.
// `sub` is an optional indented slot shown beneath the parent (e.g. veg side under lunch).
const SLOT_GROUPS = [
  { id: 'breakfast', label: 'Breakfast' },
  { id: 'lunch',     label: 'Lunch',   sub: { id: 'side', label: 'Veg side' } },
  { id: 'dinner',    label: 'Dinner' },
];
// Flat list used for data fetching / mark-all logic.
const SLOTS = SLOT_GROUPS.flatMap(g => g.sub ? [g.id, g.sub.id] : [g.id]);

// Anchor date for the plan view and current day-count preference.
let planAnchor = new Date(); planAnchor.setHours(0, 0, 0, 0);
let planDays = parseInt(localStorage.getItem('planDays') || '7', 10);
if (![1,2,3,5,7].includes(planDays)) planDays = 7;

function weekStart(d) {
  const s = new Date(d); s.setHours(0, 0, 0, 0);
  s.setDate(s.getDate() - s.getDay()); // back up to Sunday
  return s;
}

function planStart() {
  // 7-day view always starts on Sunday; other views start from the anchor itself.
  return planDays === 7 ? weekStart(planAnchor) : new Date(planAnchor);
}

function updateDaySelectorUI() {
  $$('#plan-day-selector button').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.days) === planDays);
  });
}

$$('#plan-day-selector button').forEach(b => {
  b.addEventListener('click', () => {
    planDays = Number(b.dataset.days);
    localStorage.setItem('planDays', planDays);
    // Snap anchor to today when switching views so you always see the present.
    planAnchor = new Date(); planAnchor.setHours(0,0,0,0);
    updateDaySelectorUI();
    renderPlan();
  });
});

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
  updateDaySelectorUI();
  const start = planStart();
  const days = Array.from({ length: planDays }, (_, i) => {
    const d = new Date(start); d.setDate(start.getDate() + i);
    return toISO(d);
  });

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
  grid.dataset.days = planDays;

  // Day-of-week headers — only show for the days being rendered
  const startDow = start.getDay();
  for (let i = 0; i < planDays; i++) {
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

$('#plan-prev').addEventListener('click', () => { planAnchor.setDate(planAnchor.getDate() - planDays); renderPlan(); });
$('#plan-next').addEventListener('click', () => { planAnchor.setDate(planAnchor.getDate() + planDays); renderPlan(); });
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
function pickMealDialog() {
  return new Promise((resolve) => {
    const dlg    = $('#meal-picker');
    const search = $('#meal-picker-search');
    const list   = $('#meal-picker-list');

    function paint(filter = '') {
      const q = filter.toLowerCase();
      list.innerHTML = '';
      for (const m of state.meals) {
        if (q && !m.name.toLowerCase().includes(q)) continue;
        const li = document.createElement('li');
        const tagStr = m.tags.map(t => t.name).join(' · ');
        li.innerHTML = `<strong>${m.name}</strong>${tagStr ? ` <span class="meta">— ${tagStr}</span>` : ''}`;
        li.addEventListener('click', () => { dlg.close(); cleanup(); resolve(m); });
        list.appendChild(li);
      }
    }
    function onInput() { paint(search.value); }
    function onClose() { cleanup(); resolve(null); }
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

// ============================================================
//                         HISTORY
// ============================================================
let historyAnchor = new Date(); historyAnchor.setDate(1); historyAnchor.setHours(0,0,0,0);

async function renderHistory() {
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
      item.title = `${e.slot}: ${e.meal?.name || '(deleted)'} — click to delete`;
      item.innerHTML = `<span class="slot-dot" data-slot="${e.slot}"></span><span class="hist-name">${e.meal?.name || '(deleted)'}</span>`;
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

// ============================================================
//                          MEALS
// ============================================================
const mealForm = $('#meal-form');

// While a brand-new meal is being created, photos chosen in the file picker
// are buffered here and uploaded after the meal is saved.
let pendingPhotos = [];
// Currently-edited meal's photos (server-side ones).
let currentPhotos = [];

function renderPhotoManager() {
  const wrap = $('#meal-photos');
  wrap.innerHTML = '';
  for (const p of currentPhotos) {
    const tile = document.createElement('div');
    tile.className = 'photo-tile';
    tile.innerHTML = `<img src="${p.url}" alt="" /><button type="button" class="photo-del" title="Remove">✕</button>`;
    tile.querySelector('.photo-del').addEventListener('click', async () => {
      const mealId = mealForm.id.value;
      if (mealId) {
        try { await api(`/api/meals/${mealId}/photos/${p.id}`, { method: 'DELETE' }); }
        catch (err) { alert(err.message); return; }
      }
      currentPhotos = currentPhotos.filter(x => x.id !== p.id);
      renderPhotoManager();
      refreshMeals().then(renderMealsList);
    });
    wrap.appendChild(tile);
  }
  for (const pp of pendingPhotos) {
    const tile = document.createElement('div');
    tile.className = 'photo-tile pending';
    tile.innerHTML = `<img src="${pp.preview}" alt="" /><span class="photo-pending">pending</span><button type="button" class="photo-del" title="Remove">✕</button>`;
    tile.querySelector('.photo-del').addEventListener('click', () => {
      pendingPhotos = pendingPhotos.filter(x => x !== pp);
      renderPhotoManager();
    });
    wrap.appendChild(tile);
  }
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

// ----------------------- boot -----------------------
showTab('pick');
