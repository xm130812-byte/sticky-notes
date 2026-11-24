/* 便签日记 · 全屏记录页
 * 按创建日期把便签排成一本连续的日记：左侧日期栏、右侧条目，不使用卡片。
 * 支持内联编辑、删除撤销、写一条、搜索和排序；数据与侧边栏共用 sn:note:*。
 */

'use strict';

(() => {
  const NOTE_PREFIX = 'sn:note:';
  const SORT_KEY = 'sn:journal-sort';

  const ACCENTS = {
    yellow: '#f59e0b',
    pink: '#ec4899',
    green: '#22c55e',
    blue: '#4176e6',
    purple: '#7c3aed',
    gray: '#a2a4a6'
  };

  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  const els = {
    search: document.getElementById('search'),
    sort: document.getElementById('btn-sort'),
    sortLabel: document.getElementById('btn-sort-label'),
    today: document.getElementById('btn-today'),
    newBtn: document.getElementById('btn-new'),
    body: document.getElementById('journal-body'),
    meta: document.getElementById('meta'),
    footCount: document.getElementById('foot-count'),
    toast: document.getElementById('toast')
  };

  const state = {
    notes: [],
    query: '',
    sort: localStorage.getItem(SORT_KEY) === 'asc' ? 'asc' : 'desc',
    editingId: null,
    editingNew: false,
    toastTimer: null
  };

  const pad = (value) => String(value).padStart(2, '0');

  function uid() {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : `n-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function validColor(color) {
    return Object.prototype.hasOwnProperty.call(ACCENTS, color) ? color : 'yellow';
  }

  function normalizeNote(raw, fallbackId) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const createdAt = Number(source.createdAt) || Date.now();
    return {
      id: typeof source.id === 'string' && source.id ? source.id : fallbackId || uid(),
      content: typeof source.content === 'string' ? source.content : '',
      color: validColor(source.color),
      pinned: !!source.pinned,
      createdAt,
      updatedAt: Number(source.updatedAt) || createdAt
    };
  }

  function accentFor(color) {
    return ACCENTS[validColor(color)];
  }

  function getNote(id) {
    return state.notes.find((note) => note.id === id) || null;
  }

  function dateKey(timestamp) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function startOfDay(timestamp) {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  function timeLabel(timestamp) {
    const date = new Date(timestamp);
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function weekdayLabel(timestamp) {
    return WEEKDAYS[new Date(timestamp).getDay()];
  }

  function editedLabel(note) {
    if (note.updatedAt - note.createdAt <= 60000) return '';
    const created = new Date(note.createdAt);
    const updated = new Date(note.updatedAt);
    const sameDay =
      created.getFullYear() === updated.getFullYear() &&
      created.getMonth() === updated.getMonth() &&
      created.getDate() === updated.getDate();
    if (sameDay) return `编辑于 ${timeLabel(note.updatedAt)}`;
    return `编辑于 ${updated.getMonth() + 1}月${updated.getDate()}日 ${timeLabel(note.updatedAt)}`;
  }

  async function loadNotes() {
    const all = await chrome.storage.local.get(null);
    const notes = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(NOTE_PREFIX)) continue;
      notes.push(normalizeNote(value, key.slice(NOTE_PREFIX.length)));
    }
    return notes;
  }

  function groupedNotes() {
    const query = state.query.trim().toLowerCase();
    const notes = state.notes.filter(
      (note) => !query || note.content.toLowerCase().includes(query)
    );

    const groups = new Map();
    for (const note of notes) {
      const key = dateKey(note.createdAt);
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          timestamp: startOfDay(note.createdAt),
          notes: []
        });
      }
      groups.get(key).notes.push(note);
    }

    const list = [...groups.values()];
    for (const group of list) {
      group.notes.sort((a, b) => {
        const delta = state.sort === 'desc' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt;
        return delta || a.id.localeCompare(b.id);
      });
    }
    list.sort((a, b) =>
      state.sort === 'desc' ? b.timestamp - a.timestamp : a.timestamp - b.timestamp
    );
    return list;
  }

  function showToast(message, action) {
    clearTimeout(state.toastTimer);
    els.toast.textContent = '';

    const label = document.createElement('span');
    label.textContent = message;
    els.toast.appendChild(label);

    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'toast-action';
      button.textContent = action.label;
      button.addEventListener('click', () => {
        hideToast();
        if (typeof action.onClick === 'function') action.onClick();
      });
      els.toast.appendChild(button);
    }

    els.toast.classList.add('show');
    state.toastTimer = setTimeout(hideToast, action ? 5200 : 2300);
  }

  function hideToast() {
    clearTimeout(state.toastTimer);
    state.toastTimer = null;
    els.toast.classList.remove('show');
  }

  function actionButton(action, id, label, icon, extraClass = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `entry-action${extraClass ? ` ${extraClass}` : ''}`;
    button.dataset.action = action;
    button.dataset.id = id;
    button.title = label;
    button.innerHTML = `<svg class="icon"><use href="#${icon}"></use></svg><span></span>`;
    button.querySelector('span').textContent = label;
    return button;
  }

  function renderEmpty() {
    const wrapper = document.createElement('div');
    wrapper.className = 'journal-empty';

    const icon = document.createElement('div');
    icon.className = 'empty-icon';
    icon.innerHTML = '<svg class="icon"><use href="#i-book"></use></svg>';

    const title = document.createElement('h2');
    const subtitle = document.createElement('p');
    const query = state.query.trim();

    if (query) {
      title.textContent = '没有找到记录';
      subtitle.textContent = '换个关键词试试，或清空搜索查看全部记录。';
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'outline-btn';
      clear.dataset.action = 'clear-search';
      clear.textContent = '清空搜索';
      wrapper.append(icon, title, subtitle, clear);
    } else {
      title.textContent = '还没有记录';
      subtitle.textContent = '把今天想留下的事情写下来，自动按日期归档。';
      const create = document.createElement('button');
      create.type = 'button';
      create.className = 'primary-btn';
      create.dataset.action = 'new';
      create.innerHTML = '<svg class="icon"><use href="#i-plus"></use></svg><span>写第一条</span>';
      wrapper.append(icon, title, subtitle, create);
    }

    return wrapper;
  }

  function renderEntry(note) {
    const editing = state.editingId === note.id;
    const entry = document.createElement('article');
    entry.className = `entry${editing ? ' is-editing' : ''}`;
    entry.dataset.id = note.id;

    const head = document.createElement('div');
    head.className = 'entry-head';

    const dot = document.createElement('span');
    dot.className = 'entry-dot';
    dot.style.background = accentFor(note.color);

    const time = document.createElement('span');
    time.className = 'entry-time';
    time.textContent = timeLabel(note.createdAt);

    head.append(dot, time);

    const edited = editedLabel(note);
    if (edited) {
      const editedSpan = document.createElement('span');
      editedSpan.className = 'entry-edited';
      editedSpan.textContent = edited;
      head.appendChild(editedSpan);
    }

    const actions = document.createElement('div');
    actions.className = 'entry-actions';
    if (editing) {
      actions.append(
        actionButton('save', note.id, '保存', 'i-check', 'primary'),
        actionButton('cancel', note.id, '取消', 'i-x')
      );
    } else {
      actions.append(
        actionButton('edit', note.id, '编辑', 'i-edit'),
        actionButton('delete', note.id, '删除', 'i-trash', 'danger')
      );
    }
    head.appendChild(actions);
    entry.appendChild(head);

    if (editing) {
      const editor = document.createElement('textarea');
      editor.className = 'entry-editor';
      editor.value = note.content;
      editor.placeholder = '写点什么…';
      editor.spellcheck = false;
      editor.setAttribute('aria-label', '编辑记录内容');
      entry.appendChild(editor);
    } else {
      const text = document.createElement('div');
      text.className = 'entry-text';
      const content = note.content;
      text.textContent = content.trim() ? content : '（空白）';
      if (!content.trim()) text.classList.add('is-empty');
      entry.appendChild(text);
    }

    return entry;
  }

  function renderDay(group) {
    const date = new Date(group.timestamp);
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const year = date.getFullYear();
    const weekday = weekdayLabel(group.timestamp);
    const isToday = dateKey(Date.now()) === group.key;

    const section = document.createElement('section');
    section.className = 'day';
    section.dataset.date = group.key;
    section.setAttribute(
      'aria-label',
      `${year}年${month}月${day}日 ${weekday}，${group.notes.length} 条记录`
    );

    const rail = document.createElement('div');
    rail.className = 'day-rail';

    const number = document.createElement('div');
    number.className = 'day-number';
    number.textContent = String(day);

    const caption = document.createElement('div');
    caption.className = 'day-caption';
    caption.append(
      Object.assign(document.createElement('span'), { textContent: `${month}月` }),
      Object.assign(document.createElement('span'), { className: 'day-dot', textContent: '·' }),
      Object.assign(document.createElement('span'), { textContent: weekday })
    );

    const yearLine = document.createElement('div');
    yearLine.className = 'day-year';
    yearLine.textContent = String(year);

    rail.append(number, caption, yearLine);

    if (isToday) {
      const today = document.createElement('span');
      today.className = 'day-today';
      today.textContent = '今天';
      rail.appendChild(today);
    }

    const entries = document.createElement('div');
    entries.className = 'day-entries';
    for (const note of group.notes) entries.appendChild(renderEntry(note));

    section.append(rail, entries);
    return section;
  }

  function render(options = {}) {
    const editing = !!state.editingId;
    els.search.disabled = editing;
    els.sort.disabled = editing;
    els.newBtn.disabled = editing;

    els.sortLabel.textContent = state.sort === 'desc' ? '最新在前' : '最早在前';
    els.sort.title = state.sort === 'desc' ? '当前最新在前，点击切换' : '当前最早在前，点击切换';

    const groups = groupedNotes();
    const visible = groups.reduce((total, group) => total + group.notes.length, 0);
    const total = state.notes.length;

    els.meta.textContent = state.query.trim()
      ? `${visible} / ${total} 条`
      : `共 ${total} 条 · ${groups.length} 天`;
    els.footCount.textContent = `共 ${total} 条记录`;

    els.body.textContent = '';
    if (!groups.length) {
      els.body.appendChild(renderEmpty());
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const group of groups) fragment.appendChild(renderDay(group));
    els.body.appendChild(fragment);

    if (editing && options.focusEditor !== false) {
      const editor = els.body.querySelector('.entry-editor');
      if (!editor) return;
      requestAnimationFrame(() => {
        editor.focus({ preventScroll: true });
        const end = editor.value.length;
        editor.setSelectionRange(end, end);
        autosize(editor);
        editor.closest('.entry')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    }
  }

  function renderPreservingScroll() {
    const y = window.scrollY;
    render();
    if (!state.editingId) {
      requestAnimationFrame(() => window.scrollTo(0, y));
    }
  }

  function autosize(editor) {
    editor.style.height = 'auto';
    editor.style.height = `${Math.max(96, editor.scrollHeight)}px`;
  }

  async function createNote() {
    if (state.editingId) {
      showToast('请先保存或取消当前编辑');
      return;
    }

    const now = Date.now();
    const note = {
      id: uid(),
      content: '',
      color: 'yellow',
      pinned: false,
      createdAt: now,
      updatedAt: now
    };

    state.notes.push(note);
    state.editingId = note.id;
    state.editingNew = true;
    state.query = '';
    els.search.value = '';
    try {
      await chrome.storage.local.set({ [NOTE_PREFIX + note.id]: note });
    } catch (err) {
      state.notes = state.notes.filter((item) => item.id !== note.id);
      state.editingId = null;
      state.editingNew = false;
      showToast('创建失败，请重试');
      renderPreservingScroll();
      return;
    }

    render({ focusEditor: true });
  }

  function startEdit(id) {
    if (state.editingId) {
      showToast('请先保存或取消当前编辑');
      return;
    }
    if (!getNote(id)) return;
    state.editingId = id;
    state.editingNew = false;
    render({ focusEditor: true });
  }

  async function saveEdit() {
    const id = state.editingId;
    if (!id) return;

    const editor = els.body.querySelector('.entry-editor');
    if (!editor) return;

    const content = editor.value;
    if (!content.trim()) {
      showToast('内容为空，无法保存');
      editor.focus();
      return;
    }

    const note = getNote(id);
    if (!note) {
      state.editingId = null;
      state.editingNew = false;
      renderPreservingScroll();
      showToast('这条记录已被删除');
      return;
    }

    const previous = { ...note };
    note.content = content;
    note.updatedAt = Date.now();

    try {
      await chrome.storage.local.set({ [NOTE_PREFIX + id]: { ...note } });
    } catch (err) {
      Object.assign(note, previous);
      showToast('保存失败，请重试');
      return;
    }

    state.editingId = null;
    state.editingNew = false;
    renderPreservingScroll();
    showToast('已保存');
  }

  async function cancelEdit() {
    const id = state.editingId;
    if (!id) return;

    const wasNew = state.editingNew;
    state.editingId = null;
    state.editingNew = false;

    if (wasNew) {
      state.notes = state.notes.filter((note) => note.id !== id);
      try {
        await chrome.storage.local.remove(NOTE_PREFIX + id);
      } catch (err) {
        /* 忽略：下次刷新会重新出现 */
      }
    }

    renderPreservingScroll();
    if (wasNew) showToast('已取消');
  }

  async function deleteNote(id) {
    if (state.editingId && state.editingId !== id) {
      showToast('请先保存或取消当前编辑');
      return;
    }

    const note = getNote(id);
    if (!note) return;

    if (state.editingId === id) {
      state.editingId = null;
      state.editingNew = false;
    }

    state.notes = state.notes.filter((item) => item.id !== id);

    try {
      await chrome.storage.local.remove(NOTE_PREFIX + id);
    } catch (err) {
      state.notes.push(note);
      showToast('删除失败，请重试');
      return;
    }

    renderPreservingScroll();
    showToast('已删除这条记录', {
      label: '撤销',
      onClick: async () => {
        if (getNote(note.id)) return;
        state.notes.push(note);
        try {
          await chrome.storage.local.set({ [NOTE_PREFIX + note.id]: note });
          renderPreservingScroll();
          showToast('已恢复');
        } catch (err) {
          state.notes = state.notes.filter((item) => item.id !== note.id);
          showToast('恢复失败');
        }
      }
    });
  }

  function toggleSort() {
    if (state.editingId) {
      showToast('请先保存或取消当前编辑');
      return;
    }
    state.sort = state.sort === 'desc' ? 'asc' : 'desc';
    try {
      localStorage.setItem(SORT_KEY, state.sort);
    } catch (err) {
      /* localStorage 不可用时只在本次生效 */
    }
    renderPreservingScroll();
  }

  function scrollToToday() {
    const key = dateKey(Date.now());
    const target = els.body.querySelector(`.day[data-date="${key}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      showToast('今天还没有记录');
    }
  }

  function setupEvents() {
    document.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action]');
      if (!target) return;

      const action = target.dataset.action;
      const id = target.dataset.id;

      if (action === 'new') createNote();
      else if (action === 'edit') startEdit(id);
      else if (action === 'save') saveEdit();
      else if (action === 'cancel') cancelEdit();
      else if (action === 'delete') deleteNote(id);
      else if (action === 'clear-search') {
        state.query = '';
        els.search.value = '';
        render();
        window.scrollTo(0, 0);
      }
    });

    els.body.addEventListener('dblclick', (event) => {
      const text = event.target.closest('.entry-text');
      if (!text) return;
      const entry = text.closest('.entry');
      if (entry) startEdit(entry.dataset.id);
    });

    els.body.addEventListener('input', (event) => {
      if (event.target.classList.contains('entry-editor')) autosize(event.target);
    });

    els.body.addEventListener('keydown', (event) => {
      if (!event.target.classList.contains('entry-editor')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelEdit();
      } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        saveEdit();
      }
    });

    els.sort.addEventListener('click', toggleSort);
    els.today.addEventListener('click', scrollToToday);

    els.search.addEventListener('input', () => {
      if (state.editingId) {
        els.search.value = state.query;
        showToast('请先保存或取消当前编辑');
        return;
      }
      state.query = els.search.value.trim();
      render();
      window.scrollTo(0, 0);
    });

    els.search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        state.query = '';
        els.search.value = '';
        render();
      }
    });

    window.addEventListener('resize', () => {
      const editor = els.body.querySelector('.entry-editor');
      if (editor) autosize(editor);
    });

    document.addEventListener('keydown', (event) => {
      const target = event.target;
      const typing =
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (event.key === '/' && !typing) {
        event.preventDefault();
        els.search.focus();
      }
    });
  }

  function setupStorageListener() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;

      let relevant = false;
      for (const [key, change] of Object.entries(changes)) {
        if (!key.startsWith(NOTE_PREFIX)) continue;
        relevant = true;
        const id = key.slice(NOTE_PREFIX.length);
        const index = state.notes.findIndex((note) => note.id === id);

        if (change.newValue) {
          const note = normalizeNote(change.newValue, id);
          if (index >= 0) state.notes[index] = note;
          else state.notes.push(note);
        } else if (index >= 0) {
          state.notes.splice(index, 1);
        }
      }

      if (!relevant) return;
      if (state.editingId) return;
      renderPreservingScroll();
    });
  }

  async function init() {
    setupEvents();
    setupStorageListener();
    try {
      state.notes = await loadNotes();
    } catch (err) {
      showToast('读取记录失败');
    }
    render();
  }

  init();
})();

