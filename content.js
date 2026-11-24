/* 便签 · Sticky Notes — 页面浮窗 + 插入文本
 * 浮窗本体是一个扩展页 iframe（panel.html?mode=floating），
 * 这里只负责宿主容器：显示 / 隐藏、拖动、缩放、位置持久化。
 * 便签数据由面板自身读写 chrome.storage，所以侧边栏与浮窗实时同步。
 */

(() => {
  if (window.__stickyNotesFloatingLoaded) return;
  window.__stickyNotesFloatingLoaded = true;

  const OPEN_KEY = 'sn:floatingOpen';
  const GEOM_KEY = 'sn:floatingGeom';
  const DEFAULT_WIDTH = 344;
  const DEFAULT_HEIGHT = 480;
  const MIN_WIDTH = 280;
  const MIN_HEIGHT = 320;
  const MAX_WIDTH = 620;
  const HEADER_HEIGHT = 44;

  let host = null;
  let shadow = null;
  let iframe = null;
  let geom = null;
  let dragBase = null;
  let resizeBase = null;
  let mounted = false;
  let mounting = false;
  let desiredOpen = false;
  let openTouched = false;
  let persistTimer = null;
  let lastEditable = null;

  const isDark = () =>
    window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

  function normalizeGeom(input) {
    const viewportW = Math.max(240, window.innerWidth);
    const viewportH = Math.max(240, window.innerHeight);
    const rawWidth = Number(input && input.width) || DEFAULT_WIDTH;
    const rawHeight = Number(input && input.height) || DEFAULT_HEIGHT;
    const width = clamp(rawWidth, MIN_WIDTH, Math.min(MAX_WIDTH, viewportW - 16));
    const height = clamp(rawHeight, MIN_HEIGHT, Math.max(MIN_HEIGHT, viewportH - 16));
    let left = input && input.left != null ? Number(input.left) : NaN;
    let top = input && input.top != null ? Number(input.top) : NaN;
    if (!Number.isFinite(left)) left = viewportW - width - 24;
    if (!Number.isFinite(top)) top = 96;
    left = clamp(left, 8, viewportW - width - 8);
    top = clamp(top, 8, Math.max(8, viewportH - HEADER_HEIGHT - 8));
    return {
      left: Math.round(left),
      top: Math.round(top),
      width: Math.round(width),
      height: Math.round(height),
      collapsed: !!(input && input.collapsed)
    };
  }

  async function readGeom() {
    const stored = await chrome.storage.local.get([GEOM_KEY, OPEN_KEY]);
    return {
      open: !!stored[OPEN_KEY],
      geom: normalizeGeom(stored[GEOM_KEY] || {})
    };
  }

  function saveGeom() {
    if (!geom) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      chrome.storage.local.set({ [GEOM_KEY]: { ...geom } }).catch(() => {});
    }, 120);
  }

  function applyGeom() {
    if (!host || !geom) return;
    host.style.left = `${geom.left}px`;
    host.style.top = `${geom.top}px`;
    host.style.width = `${geom.width}px`;
    host.style.height = `${geom.collapsed ? HEADER_HEIGHT : geom.height}px`;
  }

  function createHost() {
    const stale = document.getElementById('sticky-notes-floating-host');
    if (stale) stale.remove();

    host = document.createElement('div');
    host.id = 'sticky-notes-floating-host';
    host.setAttribute('data-sticky-notes', 'floating');
    host.style.cssText = [
      'all: initial',
      'position: fixed',
      'display: block',
      'box-sizing: border-box',
      'z-index: 2147483647',
      'border-radius: 16px',
      'overflow: hidden',
      `background: ${isDark() ? '#1b1b1c' : '#ffffff'}`,
      `border: 0.5px solid ${isDark() ? 'rgba(255,255,255,.12)' : 'rgba(15,17,21,.10)'}`,
      isDark()
        ? 'box-shadow: 0 16px 40px rgba(0,0,0,.55), 0 4px 12px rgba(0,0,0,.35)'
        : 'box-shadow: 0 16px 40px rgba(15,17,21,.14), 0 4px 12px rgba(15,17,21,.08)',
      'contain: layout style paint'
    ].join(';');

    shadow = host.attachShadow({ mode: 'open' });

    iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('panel.html?mode=floating');
    iframe.title = '便签浮窗';
    iframe.setAttribute('allow', 'clipboard-write; clipboard-read');
    // 全部用内联样式，避免页面严格的 style-src CSP 拦截 <style>。
    iframe.style.cssText =
      'display:block;width:100%;height:100%;border:0;background:transparent;color-scheme:normal;';

    shadow.append(iframe);
    document.documentElement.appendChild(host);
  }

  function destroyHost() {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    shadow = null;
    iframe = null;
    dragBase = null;
    resizeBase = null;
  }

  async function mount() {
    if (mounted || mounting) return;
    if (!document.documentElement) return;
    mounting = true;
    try {
      const data = await readGeom();
      if (!data.open || !desiredOpen || mounted) return;
      geom = data.geom;
      createHost();
      applyGeom();
      mounted = true;
    } finally {
      mounting = false;
    }
  }

  function unmount() {
    mounted = false;
    destroyHost();
  }

  function persistPosition() {
    if (!geom) return;
    saveGeom();
  }

  function handleDragMessage(data) {
    if (!geom || !host) return;
    if (data.phase === 'start') {
      dragBase = { left: geom.left, top: geom.top };
      host.style.transition = 'none';
      return;
    }
    if (data.phase === 'end') {
      dragBase = null;
      persistPosition();
      return;
    }
    if (data.phase !== 'move' || !dragBase) return;
    const dx = Number(data.dx) || 0;
    const dy = Number(data.dy) || 0;
    const maxLeft = Math.max(4, window.innerWidth - geom.width - 4);
    const maxTop = Math.max(4, window.innerHeight - HEADER_HEIGHT - 4);
    const left = clamp(dragBase.left + dx, 4, maxLeft);
    const top = clamp(dragBase.top + dy, 4, maxTop);
    geom.left = Math.round(left);
    geom.top = Math.round(top);
    applyGeom();
  }

  function setCollapsed(collapsed) {
    if (!geom) return;
    geom.collapsed = !!collapsed;
    if (geom.collapsed) resizeBase = null;
    applyGeom();
    persistPosition();
  }

  function handleResizeMessage(data) {
    if (!geom || !host) return;
    if (data.phase === 'start') {
      resizeBase = { width: geom.width, height: geom.height };
      return;
    }
    if (data.phase === 'end') {
      resizeBase = null;
      persistPosition();
      return;
    }
    if (data.phase !== 'move' || !resizeBase) return;

    const dx = Number(data.dx) || 0;
    const dy = Number(data.dy) || 0;
    const maxWidth = Math.max(
      MIN_WIDTH,
      Math.min(MAX_WIDTH, window.innerWidth - geom.left - 8)
    );
    const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - geom.top - 8);
    geom.width = Math.round(clamp(resizeBase.width + dx, MIN_WIDTH, maxWidth));
    geom.height = Math.round(clamp(resizeBase.height + dy, MIN_HEIGHT, maxHeight));
    applyGeom();
  }

  window.addEventListener('message', (event) => {
    if (!iframe || event.source !== iframe.contentWindow) return;
    const data = event.data;
    if (!data || data.__stickyNotes !== true) return;

    switch (data.type) {
      case 'ready':
        try {
          iframe.contentWindow.postMessage(
            { __stickyNotes: true, type: 'state', collapsed: !!(geom && geom.collapsed) },
            '*'
          );
        } catch (err) {
          /* iframe 尚未就绪 */
        }
        break;
      case 'drag':
        handleDragMessage(data);
        break;
      case 'resize':
        handleResizeMessage(data);
        break;
      case 'collapse':
        setCollapsed(!!data.value);
        break;
      case 'close':
        chrome.storage.local.set({ [OPEN_KEY]: false }).catch(() => {});
        break;
      default:
        break;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (Object.prototype.hasOwnProperty.call(changes, OPEN_KEY)) {
      openTouched = true;
      desiredOpen = !!changes[OPEN_KEY].newValue;
      if (desiredOpen) mount();
      else unmount();
    }

    if (
      Object.prototype.hasOwnProperty.call(changes, GEOM_KEY) &&
      mounted &&
      !dragBase &&
      !resizeBase &&
      changes[GEOM_KEY].newValue
    ) {
      geom = normalizeGeom({ ...geom, ...changes[GEOM_KEY].newValue });
      applyGeom();
    }
  });

  window.addEventListener('resize', () => {
    if (!mounted || !geom || dragBase || resizeBase) return;
    geom = normalizeGeom(geom);
    applyGeom();
  });

  window.addEventListener('pageshow', async (event) => {
    if (!event.persisted) return;
    try {
      const data = await readGeom();
      desiredOpen = data.open;
      if (desiredOpen) {
        geom = data.geom;
        await mount();
      } else {
        unmount();
      }
    } catch (err) {
      /* bfcache 恢复失败时忽略 */
    }
  });

  // ---------- 插入到网页输入框 ----------

  function isEditable(el) {
    if (!el || !(el instanceof Element)) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return !el.disabled && !el.readOnly;
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['password', 'hidden', 'file', 'checkbox', 'radio', 'submit', 'button', 'reset', 'image'].includes(type)) {
        return false;
      }
      return !el.disabled && !el.readOnly;
    }
    return false;
  }

  document.addEventListener(
    'focusin',
    (event) => {
      if (isEditable(event.target)) lastEditable = event.target;
    },
    true
  );

  function insertIntoElement(el, text) {
    el.focus({ preventScroll: false });

    if (el.isContentEditable) {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || !el.contains(selection.anchorNode)) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      if (document.execCommand('insertText', false, text)) return true;
      const range = window.getSelection().getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return true;
    }

    let value = text;
    if (el.tagName === 'INPUT') value = text.replace(/\r?\n+/g, ' ');

    try {
      if (document.execCommand('insertText', false, value)) return true;
    } catch (err) {
      /* 某些输入框不支持 execCommand，走下面的兜底 */
    }

    const start = el.selectionStart == null ? el.value.length : el.selectionStart;
    const end = el.selectionEnd == null ? el.value.length : el.selectionEnd;
    if (typeof el.setRangeText === 'function') {
      el.setRangeText(value, start, end, 'end');
    } else {
      el.value = el.value.slice(0, start) + value + el.value.slice(end);
      el.selectionStart = el.selectionEnd = start + value.length;
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    return true;
  }

  function insertText(text) {
    let target = isEditable(document.activeElement) ? document.activeElement : lastEditable;
    if (!target || !target.isConnected) return false;
    if (target.ownerDocument !== document) return false;
    return insertIntoElement(target, text);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'sticky:insert') return undefined;
    let ok = false;
    try {
      ok = insertText(String(message.text == null ? '' : message.text));
    } catch (err) {
      console.warn('[便签] 插入失败', err);
    }
    sendResponse({ ok });
    return undefined;
  });

  // ---------- 启动：读取开关，决定是否显示浮窗 ----------
  (async () => {
    try {
      const data = await readGeom();
      if (!openTouched) desiredOpen = data.open;
      if (desiredOpen) {
        geom = data.geom;
        await mount();
      }
    } catch (err) {
      console.warn('[便签] 初始化浮窗失败', err);
    }
  })();
})();
