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
  quests: [],
  activeTab: 'main',
  editingQuestId: null,
  expandedQuestId: null,
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
  deadline = '', progress = null, active = true, subQuests = [], completed = false } = {}) {
  return { id: uid(), type, title, description, nextGoal, deadline, progress, active, subQuests, completed };
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

function countActiveMain() { return state.quests.filter(q => q.type === 'main' && !q.completed).length; }
function countActiveSide() { return state.quests.filter(q => q.type === 'side' && q.active && !q.completed).length; }

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
  const main = state.quests.filter(q => q.type === 'main' && !q.completed).length;
  const side = state.quests.filter(q => q.type === 'side' && !q.completed).length;
  document.getElementById('main-count').textContent = `${main}/${MAX_MAIN}`;
  document.getElementById('side-count').textContent = side;
}

function renderQuestList() {
  const container = document.getElementById('quest-list');
  const tab = state.activeTab;
  const active = state.quests.filter(q => q.type === tab && !q.completed);
  const completed = state.quests.filter(q => q.type === tab && q.completed);

  container.innerHTML = '';

  if (active.length === 0 && completed.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">${tab === 'main' ? '🗡️' : '📜'}</div>
        <p>${tab === 'main' ? 'Нет главных квестов' : 'Нет дополнительных квестов'}</p>
        <p class="empty-sub">Нажмите + чтобы добавить квест</p>
      </div>`;
    return;
  }

  active.forEach(q => container.appendChild(buildQuestCard(q)));

  if (completed.length > 0) {
    const sep = document.createElement('div');
    sep.className = 'completed-section-header';
    sep.textContent = '✓ Завершённые квесты';
    container.appendChild(sep);
    completed.forEach(q => container.appendChild(buildQuestCard(q)));
  }
}

function buildQuestCard(q) {
  const div = document.createElement('div');
  const isExpanded = q.id === state.expandedQuestId;
  div.className = `quest-card type-${q.type}${q.type === 'side' && !q.active && !q.completed ? ' inactive' : ''}${q.completed ? ' completed' : ''}${isExpanded ? ' expanded' : ''}`;
  div.dataset.id = q.id;

  const dl = q.deadline ? formatDeadline(q.deadline) : null;
  const subCount = q.subQuests?.length || 0;

  let deadlineBadge = '';
  if (dl) {
    const urgent = dl.cls === 'deadline-urgent' || dl.cls === 'deadline-passed';
    deadlineBadge = `<span class="quest-deadline-badge${urgent ? ' urgent' : ''}">⏳ ${dl.text}</span>`;
  }

  let activeBadge = '';
  if (q.type === 'side' && !q.completed) {
    activeBadge = `<button class="quest-active-toggle ${q.active ? 'active-on' : 'active-off'}" data-action="toggle" data-id="${q.id}">
      ${q.active ? '● Активен' : '○ Неактивен'}
    </button>`;
  }

  const completedBadge = q.completed ? `<span class="quest-completed-badge">✓ Завершён</span>` : '';
  const subBadge = subCount > 0 ? `<span class="quest-sub-badge">📋 ${subCount}</span>` : '';
  const icon = q.type === 'main' ? '⚔️' : '📜';

  div.innerHTML = `
    <div class="quest-card-top">
      <div class="quest-icon">${icon}</div>
      <div class="quest-info">
        <div class="quest-type-label">${q.type === 'main' ? 'Главный квест' : 'Доп. квест'}</div>
        <div class="quest-title">${escHtml(q.title)}</div>
        <div class="quest-card-meta">${completedBadge}${deadlineBadge}${activeBadge}${subBadge}</div>
      </div>
      <button class="quest-chevron" aria-label="Развернуть">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
    </div>
    <div class="quest-card-body">
      <div class="quest-card-body-inner">
        ${buildQuestBody(q)}
      </div>
    </div>`;

  div.querySelector('.quest-card-top').addEventListener('click', e => {
    if (e.target.closest('[data-action="toggle"]')) return;
    toggleExpand(q.id);
  });

  const toggleBtn = div.querySelector('[data-action="toggle"]');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', e => {
      e.stopPropagation();
      toggleActive(q.id);
    });
  }

  div.querySelector('.btn-quest-edit').addEventListener('click', e => {
    e.stopPropagation();
    openEditModal(q.id);
  });

  div.querySelector('.btn-quest-delete').addEventListener('click', e => {
    e.stopPropagation();
    if (confirm(`Удалить квест «${q.title}»?`)) {
      state.expandedQuestId = null;
      deleteQuest(q.id);
      showToast('Квест удалён', 'success');
    }
  });

  div.querySelector('.btn-quest-add-sub').addEventListener('click', e => {
    e.stopPropagation();
    openAddModal('side', q.id);
  });

  div.querySelectorAll('.sub-quest-item-content[data-sub-id]').forEach(content => {
    content.addEventListener('click', e => {
      e.stopPropagation();
      openEditModal(content.dataset.subId);
    });
  });

  div.querySelectorAll('.sub-delete-btn[data-sub-id]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const sub = findQuest(btn.dataset.subId);
      if (sub && confirm(`Удалить «${sub.title}»?`)) {
        deleteSubQuest(q.id, btn.dataset.subId);
      }
    });
  });

  const completeBtn = div.querySelector('.btn-quest-complete');
  if (completeBtn) {
    completeBtn.addEventListener('click', e => {
      e.stopPropagation();
      completeQuest(q.id);
    });
  }

  const reviveBtn = div.querySelector('.btn-quest-revive');
  if (reviveBtn) {
    reviveBtn.addEventListener('click', e => {
      e.stopPropagation();
      reviveQuest(q.id);
    });
  }

  return div;
}

function buildQuestBody(q) {
  const pct = progressPercent(q.progress);
  let html = '';

  if (q.description) {
    html += `<div class="qb-description">${escHtml(q.description)}</div>`;
  }

  if (q.nextGoal) {
    html += `<div class="qb-section">
      <div class="qb-label">⚡ Ближайшая цель</div>
      <div class="qb-value">${escHtml(q.nextGoal)}</div>
    </div>`;
  }

  if (pct !== null) {
    html += `<div class="qb-section">
      <div class="qb-label">📊 Прогресс</div>
      <div class="progress-label">
        <span>${progressLabel(q.progress)}</span><span>${pct}%</span>
      </div>
      <div class="progress-bar-track">
        <div class="progress-bar-fill" style="width:${pct}%"></div>
      </div>
    </div>`;
  }

  html += `<div class="qb-section">
    <div class="qb-label-row">
      <span>📋 Вложенные квесты</span>
      <button class="btn-add-sub btn-quest-add-sub"${q.subQuests.length >= MAX_SUB ? ' disabled' : ''}>+ Добавить</button>
    </div>
    <div class="qb-sub-list">${buildSubQuestItems(q)}</div>
  </div>`;

  if (!q.completed) {
    html += `<button class="btn btn-complete btn-quest-complete">✓ Завершить квест</button>`;
  }

  html += `<div class="qb-actions">
    ${!q.completed
      ? `<button class="btn btn-secondary btn-quest-edit">Редактировать</button>`
      : `<button class="btn btn-secondary btn-quest-revive">↩ Возобновить</button>`}
    <button class="btn btn-danger btn-quest-delete">Удалить квест</button>
  </div>`;

  return html;
}

function buildSubQuestItems(q) {
  if (!q.subQuests.length) {
    return '<p class="sub-quest-empty">Нет вложенных квестов</p>';
  }
  return q.subQuests.map(sub => {
    const pct = progressPercent(sub.progress);
    return `<div class="sub-quest-item">
      <div class="sub-quest-item-content" data-sub-id="${sub.id}">
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
      </div>
    </div>`;
  }).join('');
}

function toggleExpand(id) {
  const prevId = state.expandedQuestId;

  if (prevId && prevId !== id) {
    const prevCard = document.querySelector(`.quest-card[data-id="${prevId}"]`);
    if (prevCard) prevCard.classList.remove('expanded');
  }

  if (prevId === id) {
    state.expandedQuestId = null;
    const card = document.querySelector(`.quest-card[data-id="${id}"]`);
    if (card) card.classList.remove('expanded');
  } else {
    state.expandedQuestId = id;
    const card = document.querySelector(`.quest-card[data-id="${id}"]`);
    if (card) card.classList.add('expanded');
  }
}

/* ── Actions ── */
function toggleActive(id) {
  const q = findQuest(id);
  if (!q || q.type !== 'side') return;

  if (!q.active && countActiveSide() >= MAX_ACTIVE) {
    tg?.HapticFeedback?.notificationOccurred('error');
    showToast(`Максимум ${MAX_ACTIVE} активных доп. квестов`, 'error');
    return;
  }
  tg?.HapticFeedback?.impactOccurred('light');
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

  if (parentId) state.expandedQuestId = parentId;
  tg?.HapticFeedback?.impactOccurred('light');
  save();
  render();
  closeQuestModal();
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

function deleteSubQuest(parentId, subId) {
  const parent = findQuest(parentId);
  if (!parent) return;
  const idx = parent.subQuests.findIndex(s => s.id === subId);
  if (idx !== -1) parent.subQuests.splice(idx, 1);
  save();
  render();
  showToast('Вложенный квест удалён', 'success');
}

function completeQuest(id) {
  const q = findQuest(id);
  if (!q || q.completed) return;

  tg?.HapticFeedback?.notificationOccurred('success');

  const card = document.querySelector(`.quest-card[data-id="${id}"]`);
  if (card) {
    card.classList.add('completing');
    const banner = document.createElement('div');
    banner.className = 'quest-complete-banner';
    banner.textContent = '✓ Выполнено!';
    card.appendChild(banner);
    setTimeout(() => banner.remove(), 850);
  }

  state.expandedQuestId = null;
  setTimeout(() => {
    q.completed = true;
    if (q.type === 'side') q.active = false;
    save();
    render();
    showToast('Квест выполнен! 🎉', 'success');
  }, 650);
}

function reviveQuest(id) {
  const q = findQuest(id);
  if (!q || !q.completed) return;

  tg?.HapticFeedback?.impactOccurred('medium');

  q.completed = false;
  if (q.type === 'side' && countActiveSide() < MAX_ACTIVE) q.active = true;
  save();
  render();
  showToast(`«${q.title}» возобновлён`, 'success');
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
  if (type === 'error') tg?.HapticFeedback?.notificationOccurred('error');
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
      } else {
        tg.BackButton.hide();
      }
    });

    const observer = new MutationObserver(() => {
      const anyOpen = !document.getElementById('quest-modal').hidden ||
                      !document.getElementById('export-modal').hidden;
      anyOpen ? tg.BackButton.show() : tg.BackButton.hide();
    });
    ['quest-modal', 'export-modal'].forEach(id => {
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
