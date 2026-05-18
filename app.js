'use strict';

/* ── Telegram WebApp init ── */
const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.enableClosingConfirmation();
}

/* ── Constants ── */
const MAX_MAIN     = 3;
const MAX_ACTIVE   = 6;
const MAX_SUB      = 10;
const STORAGE_KEY  = 'lifequest_data';

/* ── Server sync ──────────────────────────────────────────────────────────
   Telegram подписывает initData своим ключом — сервер проверяет подпись
   и сам достаёт userId. Клиент не передаёт userId явно.
────────────────────────────────────────────────────────────────────────── */
const INIT_DATA = tg?.initData || '';   // подписанная строка от Telegram

let _syncTimer = null;

function authHeaders() {
  return { 'Content-Type': 'application/json', 'X-Init-Data': INIT_DATA };
}

async function syncToServer() {
  if (!INIT_DATA) return;
  try {
    await fetch('/api/quests', {
      method:  'POST',
      headers: authHeaders(),
      body:    JSON.stringify({ quests: state.quests }),
    });
  } catch { /* offline — localStorage keeps data safe */ }
}

async function loadFromServer() {
  if (!INIT_DATA) return false;
  try {
    const res  = await fetch('/api/quests', { headers: { 'X-Init-Data': INIT_DATA } });
    if (!res.ok) return false;
    const data = await res.json();
    // found:true → сервер знает пользователя, его данные авторитетны
    if (data.found && Array.isArray(data.quests)) {
      state.quests = data.quests;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.quests));
      return true;
    }
  } catch { /* offline — localStorage остаётся как fallback */ }
  return false;
}

function scheduleSyncToServer() {
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(syncToServer, 600);
}

/* ── State ── */
let state = {
  quests: [],      // top-level quests
  activeTab: 'main',
  editingQuestId: null,
  detailQuestId: null,
};

/* ── Persistence ── */
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.quests)); } catch {}
  scheduleSyncToServer();
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state.quests = JSON.parse(raw);
  } catch { state.quests = []; }
}

/* ── ID generation ── */
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

/* ── Quest model ── */
function makeQuest({ type = 'side', title = '', description = '', nextGoal = '',
  deadline = '', progress = null, active = true, subQuests = [] } = {}) {
  return { id: uid(), type, title, description, nextGoal, deadline, progress, active, subQuests };
}

/* progress = null | { type: 'percent', value: 0 } | { type: 'numeric', current: 0, target: 100, unit: '₽' } */

/* ── Helpers ── */
function findQuest(id, list = state.quests) {
  for (const q of list) {
    if (q.id === id) return q;
    const found = findQuest(id, q.subQuests);
    if (found) return found;
  }
  return null;
}

function countActiveMain() { return state.quests.filter(q => q.type === 'main').length; }
function countActiveSide() { return state.quests.filter(q => q.type === 'side' && q.active).length; }

function formatDeadline(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((target - today) / 86400000);

  const fmt = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });

  if (diff < 0)  return { text: `Просрочен: ${fmt}`, cls: 'deadline-passed' };
  if (diff === 0) return { text: 'Сегодня!',           cls: 'deadline-urgent' };
  if (diff <= 3)  return { text: `${diff} дн.`,         cls: 'deadline-urgent' };
  if (diff <= 14) return { text: fmt,                   cls: 'deadline-soon' };
  return { text: fmt, cls: 'deadline-ok' };
}

function progressPercent(p) {
  if (!p) return null;
  if (p.type === 'percent') return Math.min(100, Math.max(0, p.value));
  if (p.type === 'numeric' && p.target > 0) return Math.min(100, Math.max(0, Math.round(p.current / p.target * 100)));
  return null;
}

function progressLabel(p) {
  if (!p) return '';
  if (p.type === 'percent') return `${p.value}%`;
  if (p.type === 'numeric') {
    const unit = p.unit || '';
    return `${formatNum(p.current)} ${unit} / ${formatNum(p.target)} ${unit}`.trim();
  }
  return '';
}

function formatNum(n) {
  return Number(n).toLocaleString('ru-RU');
}

/* ── Render ── */
function render() {
  renderQuestList();
  renderCounts();
}

function renderCounts() {
  const main = state.quests.filter(q => q.type === 'main').length;
  const side = state.quests.filter(q => q.type === 'side').length;
  document.getElementById('main-count').textContent = `${main}/${MAX_MAIN}`;
  document.getElementById('side-count').textContent = side;
}

function renderQuestList() {
  const container = document.getElementById('quest-list');
  const tab = state.activeTab;
  const list = state.quests.filter(q => q.type === tab);

  container.innerHTML = '';

  if (list.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">${tab === 'main' ? '🗡️' : '📜'}</div>
        <p>${tab === 'main' ? 'Нет главных квестов' : 'Нет дополнительных квестов'}</p>
        <p class="empty-sub">Нажмите + чтобы добавить квест</p>
      </div>`;
    return;
  }

  list.forEach(q => {
    const card = buildQuestCard(q);
    container.appendChild(card);
  });
}

function buildQuestCard(q) {
  const div = document.createElement('div');
  div.className = `quest-card type-${q.type}${q.type === 'side' && !q.active ? ' inactive' : ''}`;
  div.dataset.id = q.id;

  const dl = q.deadline ? formatDeadline(q.deadline) : null;
  const pct = progressPercent(q.progress);
  const subCount = q.subQuests?.length || 0;

  let deadlineBadge = '';
  if (dl) {
    const urgent = dl.cls === 'deadline-urgent' || dl.cls === 'deadline-passed';
    deadlineBadge = `<span class="quest-deadline-badge${urgent ? ' urgent' : ''}">⏳ ${dl.text}</span>`;
  }

  let activeBadge = '';
  if (q.type === 'side') {
    activeBadge = `<button class="quest-active-toggle ${q.active ? 'active-on' : 'active-off'}" data-action="toggle" data-id="${q.id}">
      ${q.active ? '● Активен' : '○ Неактивен'}
    </button>`;
  }

  let nextGoalHtml = '';
  if (q.nextGoal) {
    nextGoalHtml = `<div class="quest-next-goal"><span class="quest-next-goal-icon">⚡</span><span>${escHtml(q.nextGoal)}</span></div>`;
  }

  let progressHtml = '';
  if (pct !== null) {
    progressHtml = `
      <div class="progress-wrap">
        <div class="progress-label">
          <span>Прогресс</span>
          <span>${progressLabel(q.progress)}</span>
        </div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" style="width:${pct}%"></div>
        </div>
      </div>`;
  }

  let subHtml = '';
  if (subCount > 0) {
    subHtml = `<div class="sub-count"><span class="sub-count-icon">📋</span><span>${subCount} вложенных квестов</span></div>`;
  }

  div.innerHTML = `
    <div class="quest-card-header">
      <div class="quest-card-title-wrap">
        <div class="quest-type-label">${q.type === 'main' ? 'Главный квест' : 'Доп. квест'}</div>
        <div class="quest-title">${escHtml(q.title)}</div>
      </div>
      <div class="quest-card-meta">
        ${deadlineBadge}
        ${activeBadge}
      </div>
    </div>
    ${nextGoalHtml}
    ${progressHtml}
    ${subHtml}`;

  div.addEventListener('click', e => {
    if (e.target.closest('[data-action="toggle"]')) return;
    openDetail(q.id);
  });

  const toggleBtn = div.querySelector('[data-action="toggle"]');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', e => {
      e.stopPropagation();
      toggleActive(q.id);
    });
  }

  return div;
}

/* ── Actions ── */
function toggleActive(id) {
  const q = findQuest(id);
  if (!q || q.type !== 'side') return;

  if (!q.active && countActiveSide() >= MAX_ACTIVE) {
    showToast(`Максимум ${MAX_ACTIVE} активных доп. квестов`, 'error');
    return;
  }
  q.active = !q.active;
  save();
  render();
  showToast(q.active ? `«${q.title}» активирован` : `«${q.title}» деактивирован`, 'success');
}

function deleteQuest(id) {
  const idx = state.quests.findIndex(q => q.id === id);
  if (idx !== -1) {
    state.quests.splice(idx, 1);
  } else {
    // search in subQuests
    for (const q of state.quests) {
      const si = q.subQuests.findIndex(s => s.id === id);
      if (si !== -1) { q.subQuests.splice(si, 1); break; }
    }
  }
  save();
  render();
}

/* ── Quest Form Modal ── */
function openAddModal(type = 'side', parentId = null) {
  state.editingQuestId = null;

  document.getElementById('quest-id').value = '';
  document.getElementById('quest-parent-id').value = parentId || '';
  document.getElementById('quest-title').value = '';
  document.getElementById('quest-description').value = '';
  document.getElementById('quest-next-goal').value = '';
  document.getElementById('quest-deadline').value = '';
  document.querySelector('[name="progress-type"][value="none"]').checked = true;
  document.getElementById('progress-percent-val').value = '';
  document.getElementById('progress-current').value = '';
  document.getElementById('progress-target').value = '';
  document.getElementById('progress-unit').value = '';
  updateProgressFields();

  const typeGroup = document.getElementById('quest-type-group');
  if (parentId) {
    typeGroup.style.display = 'none';
    document.getElementById('modal-title').textContent = 'Новый вложенный квест';
  } else {
    typeGroup.style.display = '';
    document.querySelector(`[name="quest-type"][value="${type}"]`).checked = true;
    document.getElementById('modal-title').textContent = 'Новый квест';
  }

  document.getElementById('quest-modal').hidden = false;
  setTimeout(() => document.getElementById('quest-title').focus(), 100);
}

function openEditModal(id) {
  const q = findQuest(id);
  if (!q) return;
  state.editingQuestId = id;

  document.getElementById('quest-id').value = q.id;
  document.getElementById('quest-parent-id').value = '';
  document.getElementById('quest-title').value = q.title;
  document.getElementById('quest-description').value = q.description || '';
  document.getElementById('quest-next-goal').value = q.nextGoal || '';
  document.getElementById('quest-deadline').value = q.deadline || '';
  document.getElementById('modal-title').textContent = 'Редактировать квест';

  const typeGroup = document.getElementById('quest-type-group');
  typeGroup.style.display = '';
  document.querySelector(`[name="quest-type"][value="${q.type}"]`).checked = true;

  const p = q.progress;
  if (!p) {
    document.querySelector('[name="progress-type"][value="none"]').checked = true;
  } else if (p.type === 'percent') {
    document.querySelector('[name="progress-type"][value="percent"]').checked = true;
    document.getElementById('progress-percent-val').value = p.value;
  } else if (p.type === 'numeric') {
    document.querySelector('[name="progress-type"][value="numeric"]').checked = true;
    document.getElementById('progress-current').value = p.current;
    document.getElementById('progress-target').value = p.target;
    document.getElementById('progress-unit').value = p.unit || '';
  }
  updateProgressFields();

  document.getElementById('quest-modal').hidden = false;
  setTimeout(() => document.getElementById('quest-title').focus(), 100);
}

function saveQuestForm() {
  const title = document.getElementById('quest-title').value.trim();
  if (!title) { showToast('Введите название квеста', 'error'); return; }

  const type     = document.querySelector('[name="quest-type"]:checked')?.value || 'side';
  const desc     = document.getElementById('quest-description').value.trim();
  const nextGoal = document.getElementById('quest-next-goal').value.trim();
  const deadline = document.getElementById('quest-deadline').value;
  const parentId = document.getElementById('quest-parent-id').value;
  const editId   = document.getElementById('quest-id').value;

  const progressType = document.querySelector('[name="progress-type"]:checked').value;
  let progress = null;
  if (progressType === 'percent') {
    const v = parseFloat(document.getElementById('progress-percent-val').value) || 0;
    progress = { type: 'percent', value: Math.min(100, Math.max(0, v)) };
  } else if (progressType === 'numeric') {
    const cur = parseFloat(document.getElementById('progress-current').value) || 0;
    const tgt = parseFloat(document.getElementById('progress-target').value) || 0;
    const unit = document.getElementById('progress-unit').value.trim();
    if (tgt <= 0) { showToast('Укажите целевое значение', 'error'); return; }
    progress = { type: 'numeric', current: cur, target: tgt, unit };
  }

  if (editId) {
    // editing existing
    const q = findQuest(editId);
    if (!q) return;
    const oldType = q.type;
    if (type === 'main' && oldType !== 'main' && countActiveMain() >= MAX_MAIN) {
      showToast(`Максимум ${MAX_MAIN} главных квестов`, 'error'); return;
    }
    q.type = type; q.title = title; q.description = desc;
    q.nextGoal = nextGoal; q.deadline = deadline; q.progress = progress;
  } else if (parentId) {
    // new sub-quest
    const parent = findQuest(parentId);
    if (!parent) return;
    if (parent.subQuests.length >= MAX_SUB) {
      showToast(`Максимум ${MAX_SUB} вложенных квестов`, 'error'); return;
    }
    const sub = makeQuest({ type: parent.type, title, description: desc, nextGoal, deadline, progress, active: true });
    parent.subQuests.push(sub);
  } else {
    // new top-level
    if (type === 'main' && countActiveMain() >= MAX_MAIN) {
      showToast(`Максимум ${MAX_MAIN} главных квестов`, 'error'); return;
    }
    if (type === 'side' && countActiveSide() >= MAX_ACTIVE) {
      showToast(`Максимум ${MAX_ACTIVE} активных доп. квестов. Деактивируйте один.`, 'error'); return;
    }
    const q = makeQuest({ type, title, description: desc, nextGoal, deadline, progress, active: true });
    state.quests.push(q);
  }

  save();
  render();
  closeQuestModal();

  if (parentId) {
    openDetail(parentId);
  }
  showToast('Квест сохранён ✓', 'success');
}

function closeQuestModal() {
  document.getElementById('quest-modal').hidden = true;
  state.editingQuestId = null;
}

function updateProgressFields() {
  const val = document.querySelector('[name="progress-type"]:checked')?.value;
  const fields = document.getElementById('progress-fields');
  const prow = document.getElementById('progress-percent-row');
  const nrow = document.getElementById('progress-numeric-row');
  if (val === 'none') {
    fields.classList.add('hidden');
  } else {
    fields.classList.remove('hidden');
    prow.hidden = val !== 'percent';
    nrow.hidden = val !== 'numeric';
  }
}

/* ── Detail Modal ── */
function openDetail(id) {
  const q = findQuest(id);
  if (!q) return;
  state.detailQuestId = id;

  const badge = document.getElementById('detail-badge');
  badge.textContent = q.type === 'main' ? 'Главный квест' : 'Доп. квест';
  badge.className = `detail-type-badge ${q.type === 'main' ? 'main-badge' : 'side-badge'}`;

  document.getElementById('detail-title').textContent = q.title;
  document.getElementById('detail-description').textContent = q.description || '';

  const ngSection = document.getElementById('detail-next-goal-section');
  if (q.nextGoal) {
    ngSection.style.display = '';
    document.getElementById('detail-next-goal').textContent = q.nextGoal;
  } else {
    ngSection.style.display = 'none';
  }

  const pSection = document.getElementById('detail-progress-section');
  const pct = progressPercent(q.progress);
  if (pct !== null) {
    pSection.style.display = '';
    document.getElementById('detail-progress-wrap').innerHTML = `
      <div class="progress-label" style="margin-bottom:6px">
        <span>${progressLabel(q.progress)}</span>
        <span>${pct}%</span>
      </div>
      <div class="progress-bar-track">
        <div class="progress-bar-fill" style="width:${pct}%"></div>
      </div>`;
  } else {
    pSection.style.display = 'none';
  }

  const dlSection = document.getElementById('detail-deadline-section');
  if (q.deadline) {
    dlSection.style.display = '';
    const dl = formatDeadline(q.deadline);
    document.getElementById('detail-deadline').innerHTML = `<span class="${dl.cls}">${dl.text}</span>`;
  } else {
    dlSection.style.display = 'none';
  }

  // Sub-quests
  const subBtn = document.getElementById('btn-add-sub');
  subBtn.disabled = (q.subQuests.length >= MAX_SUB);
  renderSubQuests(q);

  document.getElementById('detail-modal').hidden = false;
}

function renderSubQuests(q) {
  const list = document.getElementById('sub-quest-list');
  list.innerHTML = '';
  if (!q.subQuests.length) {
    list.innerHTML = '<p class="sub-quest-empty">Нет вложенных квестов</p>';
    return;
  }
  q.subQuests.forEach(sub => {
    const pct = progressPercent(sub.progress);
    const item = document.createElement('div');
    item.className = 'sub-quest-item';
    item.innerHTML = `
      <div class="sub-quest-item-content">
        <div class="sub-quest-item-title">${escHtml(sub.title)}</div>
        ${sub.nextGoal ? `<div class="sub-quest-item-goal">⚡ ${escHtml(sub.nextGoal)}</div>` : ''}
        ${pct !== null ? `
          <div class="sub-quest-progress">
            <div class="progress-bar-track" style="margin-top:6px">
              <div class="progress-bar-fill" style="width:${pct}%"></div>
            </div>
            <div style="font-size:11px;color:var(--text-dim);margin-top:3px">${progressLabel(sub.progress)}</div>
          </div>` : ''}
      </div>
      <div class="sub-quest-item-actions">
        <button class="sub-delete-btn" data-sub-id="${sub.id}" title="Удалить">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
          </svg>
        </button>
      </div>`;

    item.querySelector('.sub-quest-item-content').addEventListener('click', () => {
      closeDetailModal();
      setTimeout(() => openEditModal(sub.id), 50);
    });

    item.querySelector('.sub-delete-btn').addEventListener('click', e => {
      e.stopPropagation();
      if (confirm(`Удалить вложенный квест «${sub.title}»?`)) {
        deleteSubQuest(q.id, sub.id);
      }
    });

    list.appendChild(item);
  });
}

function deleteSubQuest(parentId, subId) {
  const parent = findQuest(parentId);
  if (!parent) return;
  const idx = parent.subQuests.findIndex(s => s.id === subId);
  if (idx !== -1) parent.subQuests.splice(idx, 1);
  save();
  renderSubQuests(parent);
  document.getElementById('btn-add-sub').disabled = parent.subQuests.length >= MAX_SUB;
  showToast('Вложенный квест удалён', 'success');
}

function closeDetailModal() {
  document.getElementById('detail-modal').hidden = true;
  state.detailQuestId = null;
  render();
}

/* ── Export ── */
function buildExportText() {
  const lines = ['# LifeQuest — Экспорт квестов', `Дата: ${new Date().toLocaleDateString('ru-RU')}`, ''];

  const mainQ = state.quests.filter(q => q.type === 'main');
  const sideQ = state.quests.filter(q => q.type === 'side');

  lines.push('## ГЛАВНЫЕ КВЕСТЫ', '');
  if (!mainQ.length) { lines.push('Нет главных квестов.', ''); }
  mainQ.forEach((q, i) => { lines.push(...questToText(q, i + 1, '🗡️')); lines.push(''); });

  lines.push('## ДОПОЛНИТЕЛЬНЫЕ КВЕСТЫ', '');
  const activeS = sideQ.filter(q => q.active);
  const inactS  = sideQ.filter(q => !q.active);

  if (activeS.length) {
    lines.push('### Активные:', '');
    activeS.forEach((q, i) => { lines.push(...questToText(q, i + 1, '📌')); lines.push(''); });
  }
  if (inactS.length) {
    lines.push('### Неактивные:', '');
    inactS.forEach((q, i) => { lines.push(...questToText(q, i + 1, '○')); lines.push(''); });
  }
  if (!sideQ.length) lines.push('Нет дополнительных квестов.', '');

  return lines.join('\n');
}

function questToText(q, num, icon) {
  const lines = [`${num}. ${icon} ${q.title}`];
  if (q.description) lines.push(`   Описание: ${q.description}`);
  if (q.nextGoal)    lines.push(`   Ближайшая цель: ${q.nextGoal}`);
  if (q.progress) {
    const pct = progressPercent(q.progress);
    lines.push(`   Прогресс: ${progressLabel(q.progress)} (${pct}%)`);
  }
  if (q.deadline) {
    const dl = formatDeadline(q.deadline);
    lines.push(`   Дедлайн: ${q.deadline} (${dl.text})`);
  }
  if (q.subQuests?.length) {
    lines.push(`   Вложенные квесты (${q.subQuests.length}):`);
    q.subQuests.forEach((s, i) => {
      lines.push(`     ${i + 1}. ${s.title}`);
      if (s.nextGoal) lines.push(`        Цель: ${s.nextGoal}`);
      if (s.progress) lines.push(`        Прогресс: ${progressLabel(s.progress)}`);
    });
  }
  return lines;
}

function openExportModal() {
  document.getElementById('export-text').value = buildExportText();
  document.getElementById('export-modal').hidden = false;
}

/* ── Toast ── */
let _toastTimer;
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  clearTimeout(_toastTimer);
  requestAnimationFrame(() => {
    t.classList.add('show');
    _toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  });
}

/* ── Utils ── */
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Event Wiring ── */
function wireEvents() {
  // Tabs
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeTab = btn.dataset.tab;
      render();
    });
  });

  // Add quest
  document.getElementById('btn-add-quest').addEventListener('click', () => {
    openAddModal(state.activeTab === 'main' ? 'main' : 'side');
  });

  // Progress type radios
  document.querySelectorAll('[name="progress-type"]').forEach(r => {
    r.addEventListener('change', updateProgressFields);
  });

  // Quest form modal
  document.getElementById('modal-close').addEventListener('click', closeQuestModal);
  document.getElementById('modal-cancel').addEventListener('click', closeQuestModal);
  document.getElementById('modal-save').addEventListener('click', saveQuestForm);
  document.getElementById('quest-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeQuestModal();
  });

  // Detail modal
  document.getElementById('detail-close').addEventListener('click', closeDetailModal);
  document.getElementById('detail-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeDetailModal();
  });
  document.getElementById('detail-edit').addEventListener('click', () => {
    const id = state.detailQuestId;
    closeDetailModal();
    setTimeout(() => openEditModal(id), 50);
  });
  document.getElementById('detail-delete').addEventListener('click', () => {
    const id = state.detailQuestId;
    const q = findQuest(id);
    if (!q) return;
    if (confirm(`Удалить квест «${q.title}»?`)) {
      closeDetailModal();
      deleteQuest(id);
      showToast('Квест удалён', 'success');
    }
  });
  document.getElementById('btn-add-sub').addEventListener('click', () => {
    const parentId = state.detailQuestId;
    closeDetailModal();
    setTimeout(() => openAddModal('side', parentId), 50);
  });

  // Export
  document.getElementById('btn-export').addEventListener('click', openExportModal);
  document.getElementById('export-close').addEventListener('click', () => {
    document.getElementById('export-modal').hidden = true;
  });
  document.getElementById('export-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) document.getElementById('export-modal').hidden = true;
  });
  document.getElementById('btn-copy-export').addEventListener('click', () => {
    const txt = document.getElementById('export-text').value;
    navigator.clipboard.writeText(txt)
      .then(() => showToast('Скопировано!', 'success'))
      .catch(() => showToast('Не удалось скопировать', 'error'));
  });

  // Back button (Telegram)
  if (tg) {
    tg.BackButton.onClick(() => {
      if (!document.getElementById('export-modal').hidden) {
        document.getElementById('export-modal').hidden = true;
      } else if (!document.getElementById('quest-modal').hidden) {
        closeQuestModal();
      } else if (!document.getElementById('detail-modal').hidden) {
        closeDetailModal();
      } else {
        tg.BackButton.hide();
      }
    });

    // Show/hide Telegram back button based on modals
    const observer = new MutationObserver(() => {
      const anyOpen = !document.getElementById('quest-modal').hidden ||
                      !document.getElementById('detail-modal').hidden ||
                      !document.getElementById('export-modal').hidden;
      anyOpen ? tg.BackButton.show() : tg.BackButton.hide();
    });
    ['quest-modal', 'detail-modal', 'export-modal'].forEach(id => {
      observer.observe(document.getElementById(id), { attributes: true, attributeFilter: ['hidden'] });
    });
  }
}

/* ── Bootstrap ── */
load();
wireEvents();
render();

// Try to load fresher data from server after first paint
loadFromServer().then(loaded => { if (loaded) render(); });
