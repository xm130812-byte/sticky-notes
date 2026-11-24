/* 便签 · Sticky Notes — service worker
 * 负责：右键菜单、快捷键、欢迎便签、侧边栏行为。
 * 便签数据直接存放在 chrome.storage.local，每个便签一个 key，避免并发覆盖。
 */

const NOTE_PREFIX = 'sn:note:';
const OPEN_KEY = 'sn:floatingOpen';
const GEOM_KEY = 'sn:floatingGeom';
const PENDING_KEY = 'sn:pending';
const LAST_ACTIVE_KEY = 'sn:lastActiveId';
const INSTALLED_KEY = 'sn:installedAt';

const WELCOME_TEXT = [
  '欢迎使用便签 👋',
  '',
  '· 点击「新建」记录想法，内容会自动保存',
  '· 点击「复制」复制全文，点击「插入」直接写进网页输入框',
  '· 右上角可开启页面浮窗，拖动到顺手的位置',
  '· 按 Ctrl+Shift+Y 随时打开侧边栏',
  '',
  '删掉这条便签，开始记录吧。'
].join('\n');

function uid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `n-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function createNote(content = '', color = 'yellow', pinned = false) {
  const now = Date.now();
  const note = {
    id: uid(),
    content,
    color,
    pinned,
    createdAt: now,
    updatedAt: now
  };
  await chrome.storage.local.set({
    [NOTE_PREFIX + note.id]: note,
    [PENDING_KEY]: { id: note.id, at: now },
    [LAST_ACTIVE_KEY]: note.id
  });
  return note;
}

async function toggleFloating() {
  const stored = await chrome.storage.local.get(OPEN_KEY);
  await chrome.storage.local.set({ [OPEN_KEY]: !stored[OPEN_KEY] });
}

async function openSidePanel(windowId) {
  try {
    if (windowId != null) {
      await chrome.sidePanel.open({ windowId });
    } else {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: win.id });
    }
  } catch (err) {
    console.warn('[便签] 打开侧边栏失败', err);
  }
}

// 必须在用户手势的同一个任务里调用 sidePanel.open，先发后建便签。
function requestOpenSidePanel(windowId) {
  if (windowId != null) {
    chrome.sidePanel.open({ windowId }).catch((err) => {
      console.warn('[便签] 打开侧边栏失败', err);
    });
    return;
  }
  chrome.windows
    .getCurrent()
    .then((win) => chrome.sidePanel.open({ windowId: win.id }))
    .catch((err) => console.warn('[便签] 打开侧边栏失败', err));
}

async function ensureDefaults() {
  const stored = await chrome.storage.local.get([OPEN_KEY, GEOM_KEY, INSTALLED_KEY]);
  const patch = {};
  if (typeof stored[OPEN_KEY] !== 'boolean') patch[OPEN_KEY] = false;
  if (!stored[GEOM_KEY]) {
    patch[GEOM_KEY] = { left: null, top: 96, width: 344, height: 480, collapsed: false };
  }
  if (!stored[INSTALLED_KEY]) patch[INSTALLED_KEY] = Date.now();
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

async function createContextMenus() {
  await new Promise((resolve) => chrome.contextMenus.removeAll(resolve));
  chrome.contextMenus.create({
    id: 'sn-open',
    title: '打开便签侧边栏',
    contexts: ['action', 'page']
  });
  chrome.contextMenus.create({
    id: 'sn-floating',
    title: '显示 / 隐藏便签浮窗',
    contexts: ['action']
  });
  chrome.contextMenus.create({
    id: 'sn-journal',
    title: '打开全屏日记本',
    contexts: ['action']
  });
  chrome.contextMenus.create({
    id: 'sn-save-selection',
    title: '把所选文字存为便签',
    contexts: ['selection']
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureDefaults();
  await createContextMenus();

  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.warn('[便签] 设置侧边栏行为失败', err);
  }

  if (details.reason === 'install') {
    const all = await chrome.storage.local.get(null);
    const hasNotes = Object.keys(all).some((key) => key.startsWith(NOTE_PREFIX));
    if (!hasNotes) await createNote(WELCOME_TEXT, 'yellow');
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaults();
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.warn('[便签] 设置侧边栏行为失败', err);
  }
});

// service worker 每次启动都确保点击图标会打开侧边栏
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'sn-open') {
    await openSidePanel(tab && tab.windowId);
    return;
  }
  if (info.menuItemId === 'sn-floating') {
    await toggleFloating();
    return;
  }
  if (info.menuItemId === 'sn-journal') {
    try {
      const created = chrome.tabs.create({ url: chrome.runtime.getURL('journal.html') });
      if (created && typeof created.catch === 'function') {
        created.catch((err) => console.warn('[便签] 打开日记本失败', err));
      }
    } catch (err) {
      console.warn('[便签] 打开日记本失败', err);
    }
    return;
  }
  if (info.menuItemId === 'sn-save-selection') {
    const text = (info.selectionText || '').trim();
    if (!text) return;
    requestOpenSidePanel(tab && tab.windowId);
    await createNote(text.slice(0, 20000), 'blue');
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'toggle-floating') {
    await toggleFloating();
    return;
  }
  if (command === 'new-note') {
    requestOpenSidePanel(tab && tab.windowId);
    await createNote('', 'yellow');
  }
});
