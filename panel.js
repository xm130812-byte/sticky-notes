/* 便签 · Sticky Notes — 面板逻辑
 * 同一个页面同时服务两种容器：
 *   - 浏览器侧边栏：panel.html
 *   - 页面浮窗 iframe：panel.html?mode=floating
 * 每个便签独立存放在 chrome.storage.local 的 sn:note:<id> 键中，
 * 侧边栏与浮窗通过 storage.onChanged 实时同步，互不覆盖。
 */

'use strict';

(() => {
  const NOTE_PREFIX = 'sn:note:';
  const LAST_ACTIVE_KEY = 'sn:lastActiveId';
  const OPEN_KEY = 'sn:floatingOpen';
  const PENDING_KEY = 'sn:pending';

  const COLORS = [
    { id: 'yellow', label: '黄色' },
    { id: 'pink', label: '粉色' },
    { id: 'green', label: '绿色' },
    { id: 'blue', label: '蓝色' },
    { id: 'purple', label: '紫色' },
    { id: 'gray', label: '灰色' }
  ];

  const isFloating = new URLSearchParams(location.search).get('mode') === 'floating';
  if (isFloating) document.documentElement.classList.add('floating-mode');

  const $ = (id) => document.getElementById(id);

  const els = {
    app: $('app'),
    topbar: $('topbar'),
    viewList: $('view-list'),
    viewEditor: $('view-editor'),
    search: $('search'),
    btnNew: $('btn-new'),
    btnNewEmpty: $('btn-new-empty'),
    noteList: $('note-list'),
    emptyList: $('empty-list'),
    emptyTitle: $('empty-title'),
    emptySub: $('empty-sub'),
    countLabel: $('count-label'),
    editor: $('editor'),
    editorTime: $('editor-time'),
    saveState: $('save-state'),
    btnBack: $('btn-back'),
    btnPin: $('btn-pin'),
    btnDelete: $('btn-delete'),
    btnCopy: $('btn-copy'),
    btnInsert: $('btn-insert'),
    swatches: $('swatches'),
    btnFloat: $('btn-float'),
    btnMore: $('btn-more'),
    btnJournal: $('btn-journal'),
    btnSide: $('btn-side'),
    btnCollapse: $('btn-collapse'),
    btnClose: $('btn-close'),
    resizeGrip: $('resize-grip'),
    menu: $('menu'),
    toast: $('toast'),
    importFile: $('import-file'),
    dialog: $('dialog-shortcuts'),
    btnDialogClose: $('btn-dialog-close')
  };

  const state = {
    notes: [],
    activeId: null,
    view: 'list',
    query: '',
    floatingOpen: false,
    collapsed: false,
    dirty: false,
    saveTimer: null,
    toastTimer: null
  };

  let panelWindowId = null;
  let pendingTimer = null;
  let pendingAttempts = 0;
  let lastPendingId = null;

  try {
    chrome.windows
      .getCurrent()
      .then((win) => {
        panelWindowId = win.id;
      })
      .catch(() => {});
  } catch (err) {
    /* 某些环境没有 windows API */
  }

  // ---------------------------------------------------------------- 工具

  function uid() {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : `n-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function validColor(color) {
    return COLORS.some((item) => item.id === color) ? color : 'yellow';
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

  function sortNotes(list = state.notes) {
    list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
    return list;
  }

  function getNote(id) {
    return state.notes.find((note) => note.id === id) || null;
  }

  function activeNote() {
    return state.activeId ? getNote(state.activeId) : null;
  }

  function titleOf(content) {
    const line = String(content || '')
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find(Boolean);
    if (!line) return '空白便签';
    return line.length > 60 ? `${line.slice(0, 60).trimEnd()}…` : line;
  }

  function previewOf(content) {
    const lines = String(content || '').split(/\r?\n/);
    const firstIndex = lines.findIndex((line) => line.trim());
    if (firstIndex < 0) return '';
    const rest = lines
      .slice(firstIndex + 1)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return rest;
  }

  function relativeTime(timestamp) {
    const now = Date.now();
    const value = Number(timestamp) || now;
    const diff = Math.max(0, now - value);
    if (diff < 45 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return `${Math.max(1, Math.floor(diff / 60000))} 分钟前`;

    const date = new Date(value);
    const today = new Date();
    const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    if (date.toDateString() === today.toDateString()) return `今天 ${time}`;

    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;

    if (date.getFullYear() === today.getFullYear()) {
      return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
    }
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  }

  function charCount(text) {
    return Array.from(String(text || '')).length;
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

  // ---------------------------------------------------------------- 数据

  async function loadNotes() {
    const all = await chrome.storage.local.get(null);
    const notes = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(NOTE_PREFIX)) continue;
      notes.push(normalizeNote(value, key.slice(NOTE_PREFIX.length)));
    }
    return sortNotes(notes);
  }

  function setSaveState(kind) {
    const saving = kind === 'saving';
    els.saveState.classList.toggle('is-saving', saving);
    els.saveState.textContent = '';
    const dot = document.createElement('span');
    dot.className = 'dot';
    els.saveState.append(dot, document.createTextNode(saving ? '保存中…' : '已保存'));
  }

  function updateEditorMeta(note) {
    if (!note) {
      els.editorTime.textContent = '';
      return;
    }
    els.editorTime.textContent = `${relativeTime(note.updatedAt)} · ${charCount(note.content)} 字`;
  }

  function applyTheme(color) {
    const next = validColor(color);
    for (const item of COLORS) els.viewEditor.classList.remove(`note-color-${item.id}`);
    els.viewEditor.classList.add(`note-color-${next}`);
    for (const button of els.swatches.querySelectorAll('.swatch')) {
      button.classList.toggle('is-active', button.dataset.color === next);
      button.setAttribute('aria-pressed', String(button.dataset.color === next));
    }
  }

  function updatePinButton(note) {
    const pinned = !!(note && note.pinned);
    els.btnPin.classList.toggle('is-active', pinned);
    els.btnPin.setAttribute('aria-pressed', String(pinned));
    els.btnPin.title = pinned ? '取消置顶' : '置顶';
  }

  async function flushSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    const note = activeNote();
    if (!note || !state.dirty) return;
    state.dirty = false;
    note.updatedAt = Date.now();
    try {
      await chrome.storage.local.set({ [NOTE_PREFIX + note.id]: { ...note } });
      if (!state.dirty && state.activeId === note.id) setSaveState('saved');
    } catch (err) {
      state.dirty = true;
      setSaveState('saving');
      showToast('保存失败，请重试');
    }
  }

  function scheduleSave() {
    state.dirty = true;
    setSaveState('saving');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flushSave, 220);
  }

  async function persistNote(note, touch = true) {
    if (state.activeId === note.id) {
      state.dirty = false;
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
    }
    if (touch) note.updatedAt = Date.now();
    try {
      await chrome.storage.local.set({ [NOTE_PREFIX + note.id]: { ...note } });
      if (state.activeId === note.id && !state.dirty) setSaveState('saved');
    } catch (err) {
      if (state.activeId === note.id) {
        state.dirty = true;
        setSaveState('saving');
      }
      showToast('保存失败，请重试');
    }
  }

  async function removeNote(id, options = {}) {
    const note = getNote(id);
    if (!note) return;
    const undo = options.undo !== false;
    state.notes = state.notes.filter((item) => item.id !== id);

    if (state.activeId === id) {
      state.activeId = null;
      state.dirty = false;
      if (state.view === 'editor') {
        state.view = 'list';
        showView('list');
      }
    }

    try {
      await chrome.storage.local.remove(NOTE_PREFIX + id);
    } catch (err) {
      showToast('删除失败，请重试');
      return;
    }

    renderList();

    if (undo) {
      showToast('便签已删除', {
        label: '撤销',
        onClick: async () => {
          if (getNote(note.id)) return;
          state.notes.push(note);
          sortNotes();
          try {
            await chrome.storage.local.set({ [NOTE_PREFIX + note.id]: note });
            renderList();
            showToast('已恢复便签');
          } catch (err) {
            showToast('恢复失败');
          }
        }
      });
    }
  }

  // ---------------------------------------------------------------- 列表

  function renderList() {
    const query = state.query.trim().toLowerCase();
    const matches = state.notes.filter((note) => {
      if (!query) return true;
      return (
        note.content.toLowerCase().includes(query) ||
        titleOf(note.content).toLowerCase().includes(query)
      );
    });

    els.noteList.textContent = '';
    const fragment = document.createDocumentFragment();
    for (const note of matches) fragment.appendChild(renderCard(note));
    els.noteList.appendChild(fragment);

    const empty = matches.length === 0;
    els.emptyList.hidden = !empty;
    if (empty) {
      els.emptyTitle.textContent = query ? '没有找到便签' : '还没有便签';
      els.emptySub.textContent = query
        ? '换个关键词试试，或清空搜索框'
        : '把想法、地址、代码片段随手记下来';
      els.btnNewEmpty.hidden = !!query;
    }

    els.countLabel.textContent = query
      ? `${matches.length} / ${state.notes.length} 条`
      : `${state.notes.length} 条便签`;
  }

  function renderCard(note) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `note-card note-color-${note.color}${note.pinned ? ' is-pinned' : ''}`;
    card.dataset.id = note.id;

    const top = document.createElement('div');
    top.className = 'card-top';

    const title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = titleOf(note.content);

    const pin = document.createElement('span');
    pin.className = 'card-pin';
    pin.innerHTML = '<svg class="icon"><use href="#i-pin"></use></svg>';
    pin.title = '已置顶';

    top.append(title, pin);

    const preview = document.createElement('p');
    preview.className = 'card-preview';
    const body = previewOf(note.content);
    if (body) {
      preview.textContent = body;
    } else if (!note.content.trim()) {
      preview.textContent = '还没有内容';
      preview.classList.add('is-empty');
    } else {
      preview.hidden = true;
    }

    const foot = document.createElement('div');
    foot.className = 'card-foot';
    const time = document.createElement('span');
    time.className = 'card-time';
    time.textContent = relativeTime(note.updatedAt);
    const length = document.createElement('span');
    length.className = 'card-len';
    length.textContent = `${charCount(note.content)} 字`;
    foot.append(time, length);

    card.append(top, preview, foot);
    card.addEventListener('click', () => openEditor(note.id));
    return card;
  }

  function showView(view) {
    state.view = view;
    els.viewList.hidden = view !== 'list';
    els.viewEditor.hidden = view !== 'editor';
  }

  async function openEditor(id, options = {}) {
    const note = getNote(id);
    if (!note) return;
    await flushSave();

    state.activeId = id;
    state.dirty = false;
    els.editor.value = note.content;
    applyTheme(note.color);
    updatePinButton(note);
    updateEditorMeta(note);
    setSaveState('saved');
    showView('editor');

    chrome.storage.local.set({ [LAST_ACTIVE_KEY]: id }).catch(() => {});

    if (options.focus !== false) {
      requestAnimationFrame(() => {
        els.editor.focus({ preventScroll: true });
        const end = els.editor.value.length;
        try {
          els.editor.setSelectionRange(end, end);
        } catch (err) {
          /* textarea 未聚焦时忽略 */
        }
      });
    }
  }

  async function goBack() {
    await flushSave();
    const note = activeNote();
    if (note && !note.content.trim()) {
      await removeNote(note.id, { undo: false });
      showToast('空白便签已移除');
    }
    state.activeId = null;
    state.dirty = false;
    showView('list');
    renderList();
  }

  async function newNote() {
    await flushSave();
    const current = activeNote();
    if (current && !current.content.trim()) {
      await removeNote(current.id, { undo: false });
    }

    const now = Date.now();
    const note = {
      id: uid(),
      content: '',
      color: COLORS[state.notes.length % COLORS.length].id,
      pinned: false,
      createdAt: now,
      updatedAt: now
    };
    state.notes.push(note);
    sortNotes();
    renderList();
    await persistNote(note, false);
    openEditor(note.id);
  }

  // ---------------------------------------------------------------- 编辑

  async function setColor(color) {
    const note = activeNote();
    if (!note) return;
    note.color = validColor(color);
    applyTheme(note.color);
    await persistNote(note);
    updateEditorMeta(note);
  }

  async function togglePin() {
    const note = activeNote();
    if (!note) return;
    note.pinned = !note.pinned;
    updatePinButton(note);
    await persistNote(note);
    sortNotes();
    renderList();
    showToast(note.pinned ? '已置顶' : '已取消置顶');
  }

  async function copyActive() {
    const text = els.editor.value;
    if (!text.trim()) {
      showToast('便签是空的');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast('已复制全文');
    } catch (err) {
      const ok = fallbackCopy(text);
      showToast(ok ? '已复制全文' : '复制失败，请手动选择复制');
    }
  }

  function fallbackCopy(text) {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;';
    document.body.appendChild(helper);
    helper.focus();
    helper.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (err) {
      ok = false;
    }
    helper.remove();
    return ok;
  }

  async function insertActive() {
    const text = els.editor.value;
    if (!text.trim()) {
      showToast('便签是空的');
      return;
    }
    if (state.dirty) await flushSave();

    let tab = null;
    try {
      [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    } catch (err) {
      tab = null;
    }

    if (!tab || tab.id == null) {
      await copyActive();
      return;
    }

    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'sticky:insert', text });
      if (response && response.ok) {
        showToast('已插入到网页输入框');
        return;
      }
    } catch (err) {
      /* 页面没有 content script，例如 chrome:// 页面 */
    }

    try {
      await navigator.clipboard.writeText(text);
      showToast('当前页面无法插入，已复制到剪贴板');
    } catch (err) {
      const ok = fallbackCopy(text);
      showToast(ok ? '当前页面无法插入，已复制到剪贴板' : '无法插入，请手动复制');
    }
  }

  // ---------------------------------------------------------------- 菜单 / 导入导出

  function openMenu() {
    els.menu.hidden = false;
    els.btnMore.setAttribute('aria-expanded', 'true');
  }

  function closeMenu() {
    els.menu.hidden = true;
    els.btnMore.setAttribute('aria-expanded', 'false');
  }

  function exportNotes() {
    if (!state.notes.length) {
      showToast('还没有便签可以导出');
      return;
    }
    const payload = {
      app: 'sticky-notes',
      version: 1,
      exportedAt: new Date().toISOString(),
      notes: state.notes.map((note) => ({
        id: note.id,
        content: note.content,
        color: note.color,
        pinned: !!note.pinned,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt
      }))
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const date = new Date();
    const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(
      date.getDate()
    ).padStart(2, '0')}`;
    const link = document.createElement('a');
    link.href = url;
    link.download = `便签备份-${stamp}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast(`已导出 ${state.notes.length} 条便签`);
  }

  async function importNotes(file) {
    let data = null;
    try {
      data = JSON.parse(await file.text());
    } catch (err) {
      showToast('文件不是有效的 JSON');
      return;
    }

    const list = Array.isArray(data) ? data : Array.isArray(data && data.notes) ? data.notes : null;
    if (!list) {
      showToast('没有找到便签数据');
      return;
    }

    const patch = {};
    const seen = new Set(state.notes.map((note) => note.id));
    let count = 0;
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const content = typeof raw.content === 'string' ? raw.content : '';
      if (!content.trim()) continue;
      const rawId = typeof raw.id === 'string' && raw.id && !seen.has(raw.id) ? raw.id : uid();
      seen.add(rawId);
      const note = normalizeNote({ ...raw, id: rawId, content }, rawId);
      patch[NOTE_PREFIX + note.id] = note;
      count += 1;
    }

    if (!count) {
      showToast('没有可导入的便签');
      return;
    }

    try {
      await chrome.storage.local.set(patch);
      showToast(`已导入 ${count} 条便签`);
    } catch (err) {
      showToast('导入失败，请重试');
    }
  }

  // ---------------------------------------------------------------- 侧边栏 / 浮窗控制

  async function toggleFloating() {
    try {
      const stored = await chrome.storage.local.get(OPEN_KEY);
      const next = !stored[OPEN_KEY];
      await chrome.storage.local.set({ [OPEN_KEY]: next });
      state.floatingOpen = next;
      updateFloatButton();
      showToast(next ? '浮窗已开启，可拖动和缩放' : '浮窗已关闭');
    } catch (err) {
      showToast('无法切换浮窗');
    }
  }

  function updateFloatButton() {
    if (!els.btnFloat) return;
    els.btnFloat.classList.toggle('is-active', state.floatingOpen);
    els.btnFloat.title = state.floatingOpen ? '关闭页面浮窗' : '显示页面浮窗';
    els.btnFloat.setAttribute('aria-label', els.btnFloat.title);
  }

  function postToParent(payload) {
    if (!isFloating) return;
    try {
      window.parent.postMessage({ __stickyNotes: true, ...payload }, '*');
    } catch (err) {
      /* parent 不可用时忽略 */
    }
  }

  function applyCollapsed(collapsed) {
    state.collapsed = !!collapsed;
    els.app.classList.toggle('is-collapsed', state.collapsed);
    els.btnCollapse.classList.toggle('is-collapsed', state.collapsed);
    els.btnCollapse.title = state.collapsed ? '展开浮窗' : '收起浮窗';
    els.btnCollapse.setAttribute('aria-label', els.btnCollapse.title);
    if (state.collapsed) {
      closeMenu();
      hideToast();
    }
  }

  function toggleCollapse() {
    applyCollapsed(!state.collapsed);
    postToParent({ type: 'collapse', value: state.collapsed });
  }

  function openJournal() {
    try {
      const created = chrome.tabs.create({ url: chrome.runtime.getURL('journal.html') });
      if (created && typeof created.catch === 'function') {
        created.catch(() => showToast('无法打开日记本'));
      }
    } catch (err) {
      showToast('无法打开日记本');
    }
  }

  function openSidePanel() {
    const open = (windowId) => {
      chrome.sidePanel
        .open({ windowId })
        .then(() => {
          // 切到侧边栏后收起浮窗，避免同一份便签出现两个入口
          chrome.storage.local.set({ [OPEN_KEY]: false }).catch(() => {});
          showToast('已打开侧边栏');
        })
        .catch(() => showToast('无法打开侧边栏，请点击工具栏图标'));
    };

    if (panelWindowId != null) {
      open(panelWindowId);
      return;
    }

    chrome.windows
      .getCurrent()
      .then((win) => {
        panelWindowId = win.id;
        open(win.id);
      })
      .catch(() => showToast('无法打开侧边栏，请点击工具栏图标'));
  }

  function setupFloating() {
    applyCollapsed(false);
    postToParent({ type: 'ready' });

    window.addEventListener('message', (event) => {
      if (!isFloating || event.source !== window.parent) return;
      const data = event.data;
      if (!data || data.__stickyNotes !== true) return;
      if (data.type === 'state') applyCollapsed(!!data.collapsed);
    });

    let rafId = 0;

    els.topbar.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (event.target.closest('button, input, textarea, a')) return;
      event.preventDefault();

      const startX = event.screenX;
      const startY = event.screenY;
      let lastDx = 0;
      let lastDy = 0;
      postToParent({ type: 'drag', phase: 'start' });

      const flush = () => {
        rafId = 0;
        postToParent({ type: 'drag', phase: 'move', dx: lastDx, dy: lastDy });
      };

      const onMove = (ev) => {
        lastDx = ev.screenX - startX;
        lastDy = ev.screenY - startY;
        if (!rafId) rafId = requestAnimationFrame(flush);
      };

      const onUp = () => {
        els.topbar.removeEventListener('pointermove', onMove);
        els.topbar.removeEventListener('pointerup', onUp);
        els.topbar.removeEventListener('pointercancel', onUp);
        els.topbar.removeEventListener('lostpointercapture', onUp);
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
        postToParent({ type: 'drag', phase: 'move', dx: lastDx, dy: lastDy });
        postToParent({ type: 'drag', phase: 'end' });
      };

      try {
        els.topbar.setPointerCapture(event.pointerId);
      } catch (err) {
        /* 忽略 */
      }
      els.topbar.addEventListener('pointermove', onMove);
      els.topbar.addEventListener('pointerup', onUp);
      els.topbar.addEventListener('pointercancel', onUp);
      els.topbar.addEventListener('lostpointercapture', onUp);
    });

    els.topbar.addEventListener('dblclick', (event) => {
      if (event.target.closest('button')) return;
      toggleCollapse();
    });

    els.btnSide.addEventListener('click', openSidePanel);
    els.btnCollapse.addEventListener('click', toggleCollapse);
    els.btnClose.addEventListener('click', () => postToParent({ type: 'close' }));

    let resizeRaf = 0;
    els.resizeGrip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const startX = event.screenX;
      const startY = event.screenY;
      let lastDx = 0;
      let lastDy = 0;

      postToParent({ type: 'resize', phase: 'start' });

      const flush = () => {
        resizeRaf = 0;
        postToParent({ type: 'resize', phase: 'move', dx: lastDx, dy: lastDy });
      };

      const onMove = (ev) => {
        lastDx = ev.screenX - startX;
        lastDy = ev.screenY - startY;
        if (!resizeRaf) resizeRaf = requestAnimationFrame(flush);
      };

      const onUp = () => {
        els.resizeGrip.removeEventListener('pointermove', onMove);
        els.resizeGrip.removeEventListener('pointerup', onUp);
        els.resizeGrip.removeEventListener('pointercancel', onUp);
        els.resizeGrip.removeEventListener('lostpointercapture', onUp);
        if (resizeRaf) {
          cancelAnimationFrame(resizeRaf);
          resizeRaf = 0;
        }
        postToParent({ type: 'resize', phase: 'move', dx: lastDx, dy: lastDy });
        postToParent({ type: 'resize', phase: 'end' });
      };

      try {
        els.resizeGrip.setPointerCapture(event.pointerId);
      } catch (err) {
        /* 忽略 */
      }
      els.resizeGrip.addEventListener('pointermove', onMove);
      els.resizeGrip.addEventListener('pointerup', onUp);
      els.resizeGrip.addEventListener('pointercancel', onUp);
      els.resizeGrip.addEventListener('lostpointercapture', onUp);
    });
  }

  // ---------------------------------------------------------------- 事件绑定

  function setupHandlers() {
    els.btnNew.addEventListener('click', newNote);
    els.btnNewEmpty.addEventListener('click', newNote);
    els.btnBack.addEventListener('click', goBack);
    els.btnDelete.addEventListener('click', () => {
      const note = activeNote();
      if (!note) return;
      state.dirty = false;
      removeNote(note.id);
    });
    els.btnPin.addEventListener('click', togglePin);
    els.btnCopy.addEventListener('click', copyActive);
    els.btnInsert.addEventListener('click', insertActive);
    els.btnFloat.addEventListener('click', toggleFloating);
    els.btnJournal.addEventListener('click', openJournal);
    els.btnMore.addEventListener('click', (event) => {
      event.stopPropagation();
      if (els.menu.hidden) openMenu();
      else closeMenu();
    });

    els.editor.addEventListener('input', () => {
      const note = activeNote();
      if (!note) return;
      note.content = els.editor.value;
      note.updatedAt = Date.now();
      updateEditorMeta(note);
      scheduleSave();
    });

    els.editor.addEventListener('blur', () => {
      flushSave();
    });

    els.search.addEventListener('input', () => {
      state.query = els.search.value;
      renderList();
    });

    els.importFile.addEventListener('change', async () => {
      const file = els.importFile.files && els.importFile.files[0];
      els.importFile.value = '';
      if (file) await importNotes(file);
    });

    els.menu.addEventListener('click', (event) => {
      const item = event.target.closest('.menu-item');
      if (!item) return;
      closeMenu();
      const action = item.dataset.action;
      if (action === 'export') exportNotes();
      else if (action === 'import') els.importFile.click();
      else if (action === 'journal') openJournal();
      else if (action === 'shortcuts') els.dialog.showModal();
    });

    document.addEventListener('pointerdown', (event) => {
      if (els.menu.hidden) return;
      if (els.menu.contains(event.target) || els.btnMore.contains(event.target)) return;
      closeMenu();
    });

    els.btnDialogClose.addEventListener('click', () => els.dialog.close());
    els.dialog.addEventListener('click', (event) => {
      if (event.target === els.dialog) els.dialog.close();
    });

    document.addEventListener('keydown', (event) => {
      const target = event.target;
      const typing =
        target === els.editor ||
        (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'));

      if (event.key === '/' && !typing) {
        event.preventDefault();
        els.search.focus();
        return;
      }

      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        newNote();
        return;
      }

      if (event.key === 'Escape') {
        if (!els.menu.hidden) {
          closeMenu();
          return;
        }
        if (state.view === 'editor' && document.activeElement === els.editor) {
          els.editor.blur();
          return;
        }
        if (state.query) {
          els.search.value = '';
          state.query = '';
          renderList();
        }
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && state.view === 'editor') {
        event.preventDefault();
        insertActive();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushSave();
    });
    window.addEventListener('pagehide', () => {
      flushSave();
    });
  }

  function setupStorageListener() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;

      let listChanged = false;
      let activeChanged = false;
      let pending = null;

      for (const [key, change] of Object.entries(changes)) {
        if (key.startsWith(NOTE_PREFIX)) {
          const id = key.slice(NOTE_PREFIX.length);
          const index = state.notes.findIndex((note) => note.id === id);
          const editing =
            state.activeId === id &&
            state.view === 'editor' &&
            (state.dirty || document.activeElement === els.editor);

          if (change.newValue) {
            const note = normalizeNote(change.newValue, id);
            if (index >= 0) {
              if (!editing) state.notes[index] = note;
            } else {
              state.notes.push(note);
            }
          } else if (index >= 0) {
            state.notes.splice(index, 1);
          }
          listChanged = true;
          if (state.activeId === id) activeChanged = true;
        } else if (key === OPEN_KEY) {
          state.floatingOpen = !!change.newValue;
          updateFloatButton();
        } else if (key === PENDING_KEY && change.newValue) {
          pending = change.newValue;
        }
      }

      if (listChanged) {
        sortNotes();
        renderList();
      }

      if (activeChanged) syncEditorFromStore();
      if (pending) handlePending(pending);
    });
  }

  function syncEditorFromStore() {
    if (state.view !== 'editor') return;
    const note = activeNote();
    if (!note) {
      state.activeId = null;
      state.dirty = false;
      showView('list');
      renderList();
      showToast('这条便签已在其他窗口被删除');
      return;
    }
    if (document.activeElement === els.editor) return;
    if (els.editor.value !== note.content) els.editor.value = note.content;
    applyTheme(note.color);
    updatePinButton(note);
    updateEditorMeta(note);
    setSaveState(state.dirty ? 'saving' : 'saved');
  }

  function handlePending(pending) {
    if (!pending || !pending.id) return;
    if (pending.id !== lastPendingId) {
      lastPendingId = pending.id;
      pendingAttempts = 0;
    }
    if (Date.now() - Number(pending.at || 0) > 20000) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
      chrome.storage.local.remove(PENDING_KEY).catch(() => {});
      return;
    }
    if (getNote(pending.id)) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
      pendingAttempts = 0;
      openEditor(pending.id);
      chrome.storage.local.remove(PENDING_KEY).catch(() => {});
      return;
    }
    if (pendingAttempts >= 12) {
      chrome.storage.local.remove(PENDING_KEY).catch(() => {});
      return;
    }
    pendingAttempts += 1;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(async () => {
      const stored = await chrome.storage.local.get(PENDING_KEY).catch(() => ({}));
      const next = stored && stored[PENDING_KEY];
      if (next && next.id === pending.id) handlePending(next);
    }, 220);
  }

  // ---------------------------------------------------------------- 启动

  async function init() {
    els.swatches.textContent = '';
    for (const color of COLORS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch';
      button.dataset.color = color.id;
      button.title = color.label;
      button.setAttribute('aria-label', `${color.label}便签`);
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => setColor(color.id));
      els.swatches.appendChild(button);
    }

    setupHandlers();
    setupStorageListener();
    if (isFloating) setupFloating();

    let notes = [];
    let stored = {};
    try {
      [notes, stored] = await Promise.all([
        loadNotes(),
        chrome.storage.local.get([LAST_ACTIVE_KEY, OPEN_KEY, PENDING_KEY])
      ]);
    } catch (err) {
      showToast('读取便签失败');
    }

    state.notes = notes;
    state.activeId = stored[LAST_ACTIVE_KEY] || null;
    state.floatingOpen = !!stored[OPEN_KEY];
    updateFloatButton();
    applyTheme('yellow');
    renderList();
    setSaveState('saved');

    if (stored[PENDING_KEY]) handlePending(stored[PENDING_KEY]);

    setInterval(() => {
      if (state.view === 'list') {
        renderList();
      } else {
        const note = activeNote();
        if (note) updateEditorMeta(note);
      }
    }, 60000);
  }

  init();
})();
