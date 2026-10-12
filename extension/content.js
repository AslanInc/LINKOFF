// LinkOff content script.
// Runs on linkedin.com, shows a panel on the Connections page, and automates
// the "More actions -> Remove connection -> Remove" clicks for selected people.
//
// LinkedIn changes its markup often, so elements are found by visible text and
// aria-labels instead of CSS class names.

(() => {
  if (window.__linkoffLoaded) return;
  window.__linkoffLoaded = true;

  const CONNECTIONS_PATH = '/mynetwork/invite-connect/connections';
  const SETTINGS_DEFAULTS = { minDelay: 3, maxDelay: 7, maxPerRun: 100 };

  const MORE_ACTIONS_RE = /more actions|more options|show more actions/i;
  const REMOVE_ITEM_RE = /^remove connection$/i;
  const CONFIRM_RE = /^remove$/i;
  const LOAD_MORE_RE = /^(show more results|load more)$/i;

  // ---------- small helpers ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randDelay = (minS, maxS) => sleep((minS + Math.random() * (maxS - minS)) * 1000);

  const storage = {
    async get(key, fallback) {
      const res = await chrome.storage.local.get(key);
      return res[key] ?? fallback;
    },
    set(key, value) {
      return chrome.storage.local.set({ [key]: value });
    },
  };

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  }

  function labelOf(el) {
    return (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // Polls until fn() returns something truthy, or throws after timeout.
  async function waitFor(fn, timeout = 5000, interval = 150) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    throw new Error('timed out');
  }

  function slugFromHref(href) {
    const m = /\/in\/([^/?#]+)/.exec(href || '');
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  }

  function realClick(el) {
    el.scrollIntoView({ block: 'center' });
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    el.click();
  }

  // Finds the first visible clickable element whose own text matches re.
  function findClickableByText(re, root = document) {
    const candidates = root.querySelectorAll(
      'button, [role="button"], [role="menuitem"], a, li, div, span'
    );
    const matches = [...candidates].filter((el) =>
      re.test((el.textContent || '').replace(/\s+/g, ' ').trim()) && isVisible(el));
    // Prefer the innermost match so we don't grab a wrapper around the real item.
    const el = matches.find((m) => !matches.some((o) => o !== m && m.contains(o)));
    return el ? el.closest('button, [role="button"], [role="menuitem"], a') || el : null;
  }

  // ---------- reading connections from the page ----------

  function profileAnchors() {
    const root = document.querySelector('main') || document.body;
    return [...root.querySelectorAll('a[href*="/in/"]')];
  }

  function isMoreActionsButton(el) {
    return MORE_ACTIONS_RE.test(el.getAttribute('aria-label') || '') ||
      MORE_ACTIONS_RE.test((el.textContent || '').trim());
  }

  // Walks up from a profile link to the smallest element that also holds that
  // person's "More actions" button and no other person's links.
  function cardFor(anchor, slug) {
    let el = anchor.parentElement;
    while (el && el !== document.body) {
      const btn = [...el.querySelectorAll('button, [role="button"]')].find(isMoreActionsButton);
      if (btn) {
        const slugs = new Set(
          [...el.querySelectorAll('a[href*="/in/"]')].map((a) => slugFromHref(a.href))
        );
        if (slugs.size === 1 && slugs.has(slug)) return { card: el, moreBtn: btn };
        return null;
      }
      el = el.parentElement;
    }
    return null;
  }

  function scanVisibleConnections() {
    const found = new Map();
    for (const a of profileAnchors()) {
      const slug = slugFromHref(a.href);
      if (!slug || found.has(slug)) continue;
      const hit = cardFor(a, slug);
      if (!hit) continue;
      const lines = hit.card.innerText.split('\n').map((s) => s.trim()).filter(Boolean)
        .filter((s) => !/^(message|more actions|show more actions)$/i.test(s));
      const name = (a.innerText || '').split('\n').map((s) => s.trim()).find(Boolean) || lines[0] || slug;
      const rest = lines.filter((s) => s !== name);
      const connected = rest.find((s) => /^connected/i.test(s)) || '';
      const headline = rest.find((s) => s !== connected) || '';
      found.set(slug, { slug, name, headline, connected, url: `https://www.linkedin.com/in/${slug}/` });
    }
    return found;
  }

  function findCard(slug) {
    for (const a of profileAnchors()) {
      if (slugFromHref(a.href) !== slug) continue;
      const hit = cardFor(a, slug);
      if (hit) return hit;
    }
    return null;
  }

  // Scrolls / clicks "Show more results" until the list stops growing.
  async function loadAllConnections(onProgress, shouldStop) {
    const all = new Map();
    let stableRounds = 0;
    while (stableRounds < 4 && !shouldStop()) {
      const before = all.size;
      for (const [k, v] of scanVisibleConnections()) all.set(k, v);
      onProgress(all.size);

      const more = findClickableByText(LOAD_MORE_RE, document.querySelector('main') || document);
      if (more) realClick(more);
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(1500);

      stableRounds = all.size === before ? stableRounds + 1 : 0;
    }
    window.scrollTo(0, 0);
    return all;
  }

  // ---------- removing one connection ----------

  async function removeConnection(slug, { dryRun }) {
    let hit = findCard(slug);
    if (!hit) {
      // The list can be virtualized; scroll through it to bring the card back.
      for (let y = 0; y < document.body.scrollHeight && !hit; y += window.innerHeight * 0.8) {
        window.scrollTo(0, y);
        await sleep(300);
        hit = findCard(slug);
      }
    }
    if (!hit) throw new Error('card not found on page');

    realClick(hit.moreBtn);
    const item = await waitFor(() => findClickableByText(REMOVE_ITEM_RE), 4000)
      .catch(() => { throw new Error('"Remove connection" menu item not found'); });

    if (dryRun) {
      closeMenus();
      await sleep(300);
      return;
    }

    realClick(item);
    const dialog = await waitFor(() =>
      [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].find(isVisible), 4000)
      .catch(() => { throw new Error('confirmation dialog did not appear'); });
    const confirm = await waitFor(() =>
      [...dialog.querySelectorAll('button')].find((b) => isVisible(b) && CONFIRM_RE.test(labelOf(b))), 3000)
      .catch(() => { throw new Error('"Remove" confirm button not found'); });
    realClick(confirm);
    await waitFor(() => !isVisible(dialog), 6000).catch(() => {});
  }

  function closeMenus() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.body.click();
  }

  // ---------- panel UI ----------

  const state = {
    connections: [], // [{slug, name, headline, connected, url}]
    selected: new Set(),
    keep: {}, // slug -> name
    settings: { ...SETTINGS_DEFAULTS },
    filter: '',
    busy: false,
    stop: false,
  };

  let host, shadow, ui;

  function buildPanel() {
    host = document.createElement('div');
    host.id = 'linkoff-host';
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
        .fab { background:#0a66c2;color:#fff;border:0;border-radius:24px;padding:12px 18px;font-weight:700;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);font-size:14px; }
        .panel { width:400px;max-width:calc(100vw - 32px);height:600px;max-height:calc(100vh - 32px);background:#fff;color:#1d2226;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.3);display:flex;flex-direction:column;overflow:hidden;font-size:13px; }
        header { display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:#0a66c2;color:#fff; }
        header b { font-size:15px; }
        header button { background:none;border:0;color:#fff;font-size:18px;cursor:pointer; }
        .section { padding:10px 14px;border-bottom:1px solid #e8e8e8;display:flex;flex-wrap:wrap;gap:6px;align-items:center; }
        button.btn { border:1px solid #0a66c2;color:#0a66c2;background:#fff;border-radius:16px;padding:5px 12px;cursor:pointer;font-size:12px;font-weight:600; }
        button.btn:hover { background:#eef3f8; }
        button.btn:disabled { opacity:.5;cursor:default; }
        button.danger { background:#cc1016;border-color:#cc1016;color:#fff;width:100%;padding:10px;font-size:14px;border-radius:20px; }
        button.danger:hover { background:#a00c11; }
        input[type=search] { flex:1;min-width:0;padding:6px 10px;border:1px solid #ccc;border-radius:16px;font-size:12px; }
        .list { flex:1;overflow:auto; }
        .row { display:flex;gap:8px;align-items:flex-start;padding:8px 14px;border-bottom:1px solid #f2f2f2; }
        .row.kept { background:#f3faf3; }
        .row.done { opacity:.4;text-decoration:line-through; }
        .row.fail { background:#fff1f1; }
        .who { flex:1;min-width:0; }
        .who a { color:#1d2226;font-weight:600;text-decoration:none; }
        .who a:hover { text-decoration:underline; }
        .sub { color:#666;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
        .keep { font-size:11px;border:1px solid #057642;color:#057642;background:#fff;border-radius:12px;padding:2px 8px;cursor:pointer;white-space:nowrap; }
        .row.kept .keep { background:#057642;color:#fff; }
        .status { padding:8px 14px;color:#444;font-size:12px;min-height:32px; }
        .empty { padding:24px 14px;color:#666;text-align:center;line-height:1.5; }
        details { width:100%; } summary { cursor:pointer;color:#555;font-size:12px; }
        .settings label { display:flex;justify-content:space-between;align-items:center;margin:6px 0;font-size:12px; }
        .settings input[type=number] { width:64px;padding:3px; }
      </style>
      <button class="fab" part="fab">LinkOff</button>
      <div class="panel" hidden>
        <header><b>LinkOff</b><button class="close" title="Minimize">–</button></header>
        <div class="section">
          <button class="btn scan">1. Scan my connections</button>
          <button class="btn stop" hidden>Stop</button>
          <span class="count"></span>
        </div>
        <div class="section">
          <input type="search" placeholder="Search name or headline…">
          <button class="btn sel-unknown" title="Select everyone you haven't marked Keep">Select all not kept</button>
          <button class="btn sel-none">Clear</button>
        </div>
        <div class="list"><div class="empty">Click <b>Scan my connections</b> to load your list.<br>Then click <b>Keep</b> next to people you know.</div></div>
        <div class="status"></div>
        <div class="section">
          <button class="btn danger remove" disabled>Remove selected (0)</button>
          <details class="settings">
            <summary>Settings</summary>
            <label>Min delay between removals (sec) <input type="number" class="minDelay" min="1"></label>
            <label>Max delay between removals (sec) <input type="number" class="maxDelay" min="1"></label>
            <label>Max removals per run <input type="number" class="maxPerRun" min="1"></label>
            <label>Dry run (open menus, don't remove) <input type="checkbox" class="dryRun"></label>
          </details>
        </div>
      </div>`;
    document.documentElement.appendChild(host);

    const $ = (s) => shadow.querySelector(s);
    ui = {
      fab: $('.fab'), panel: $('.panel'), close: $('.close'), scan: $('.scan'), stop: $('.stop'),
      count: $('.count'), search: $('input[type=search]'), selUnknown: $('.sel-unknown'),
      selNone: $('.sel-none'), list: $('.list'), status: $('.status'), remove: $('.remove'),
      minDelay: $('.minDelay'), maxDelay: $('.maxDelay'), maxPerRun: $('.maxPerRun'), dryRun: $('.dryRun'),
    };

    ui.fab.onclick = () => { ui.fab.hidden = true; ui.panel.hidden = false; };
    ui.close.onclick = () => { ui.panel.hidden = true; ui.fab.hidden = false; };
    ui.scan.onclick = onScan;
    ui.stop.onclick = () => { state.stop = true; setStatus('Stopping after the current step…'); };
    ui.search.oninput = () => { state.filter = ui.search.value.toLowerCase(); renderList(); };
    ui.selUnknown.onclick = () => {
      for (const c of filtered()) if (!state.keep[c.slug]) state.selected.add(c.slug);
      renderList();
    };
    ui.selNone.onclick = () => { state.selected.clear(); renderList(); };
    ui.remove.onclick = onRemove;

    for (const key of ['minDelay', 'maxDelay', 'maxPerRun']) {
      ui[key].value = state.settings[key];
      ui[key].onchange = () => {
        state.settings[key] = Math.max(1, Number(ui[key].value) || SETTINGS_DEFAULTS[key]);
        ui[key].value = state.settings[key];
        storage.set('settings', state.settings);
      };
    }
  }

  function filtered() {
    if (!state.filter) return state.connections;
    return state.connections.filter((c) =>
      (c.name + ' ' + c.headline).toLowerCase().includes(state.filter));
  }

  function setStatus(msg) { ui.status.textContent = msg; }

  function updateRemoveButton() {
    const n = state.selected.size;
    ui.remove.textContent = `Remove selected (${n})`;
    ui.remove.disabled = n === 0 || state.busy;
  }

  function renderList() {
    if (!state.connections.length) { updateRemoveButton(); return; }
    const rows = filtered();
    ui.list.textContent = '';
    for (const c of rows) {
      const kept = !!state.keep[c.slug];
      const row = document.createElement('div');
      row.className = 'row' + (kept ? ' kept' : '') + (c.status ? ' ' + c.status : '');
      row.dataset.slug = c.slug;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.selected.has(c.slug);
      cb.disabled = kept || state.busy || c.status === 'done';
      cb.onchange = () => {
        cb.checked ? state.selected.add(c.slug) : state.selected.delete(c.slug);
        updateRemoveButton();
      };

      const who = document.createElement('div');
      who.className = 'who';
      const link = document.createElement('a');
      link.href = c.url; link.target = '_blank'; link.rel = 'noopener';
      link.textContent = c.name;
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = c.headline;
      sub.title = c.headline;
      who.append(link, sub);
      if (c.connected) {
        const when = document.createElement('div');
        when.className = 'sub';
        when.textContent = c.connected;
        who.append(when);
      }
      if (c.error) {
        const err = document.createElement('div');
        err.className = 'sub';
        err.style.color = '#cc1016';
        err.textContent = c.error;
        who.append(err);
      }

      const keepBtn = document.createElement('button');
      keepBtn.className = 'keep';
      keepBtn.textContent = kept ? 'Kept ✓' : 'Keep';
      keepBtn.title = 'People you Keep are never removed';
      keepBtn.disabled = state.busy;
      keepBtn.onclick = () => {
        if (state.keep[c.slug]) delete state.keep[c.slug];
        else { state.keep[c.slug] = c.name; state.selected.delete(c.slug); }
        storage.set('keep', state.keep);
        renderList();
      };

      row.append(cb, who, keepBtn);
      ui.list.append(row);
    }
    if (!rows.length) ui.list.innerHTML = '<div class="empty">No matches.</div>';
    const keptCount = state.connections.filter((c) => state.keep[c.slug]).length;
    ui.count.textContent = `${state.connections.length} found · ${keptCount} kept`;
    updateRemoveButton();
  }

  function setBusy(busy) {
    state.busy = busy;
    state.stop = false;
    ui.scan.disabled = busy;
    ui.stop.hidden = !busy;
    ui.selUnknown.disabled = busy;
    ui.selNone.disabled = busy;
    renderList();
  }

  async function onScan() {
    setBusy(true);
    setStatus('Loading your connections… (this scrolls the page)');
    try {
      const all = await loadAllConnections(
        (n) => { ui.count.textContent = `${n} found…`; },
        () => state.stop
      );
      state.connections = [...all.values()];
      state.selected = new Set([...state.selected].filter((s) => all.has(s)));
      setStatus(all.size
        ? `Loaded ${all.size} connections. Click Keep next to people you know, then "Select all not kept".`
        : 'No connections found. Make sure you are on your Connections page and logged in.');
    } catch (e) {
      setStatus('Scan failed: ' + e.message);
    }
    setBusy(false);
  }

  async function onRemove() {
    const queue = state.connections.filter((c) => state.selected.has(c.slug) && !state.keep[c.slug]);
    const { minDelay, maxDelay, maxPerRun } = state.settings;
    const dryRun = ui.dryRun.checked;
    const batch = queue.slice(0, maxPerRun);
    if (!batch.length) return;

    const msg = dryRun
      ? `Dry run on ${batch.length} people. Menus will open but nobody is removed. Continue?`
      : `Remove ${batch.length} connection(s)?\n\nThis can't be undone. You'd have to send them a new invite to reconnect.` +
        (queue.length > batch.length ? `\n\n(Limited to ${maxPerRun} per run, see Settings.)` : '');
    if (!confirm(msg)) return;

    setBusy(true);
    let ok = 0, failed = 0, consecutiveFails = 0;
    for (let i = 0; i < batch.length; i++) {
      if (state.stop) break;
      const c = batch[i];
      setStatus(`${dryRun ? 'Dry run' : 'Removing'} ${i + 1}/${batch.length}: ${c.name}`);
      try {
        await removeConnection(c.slug, { dryRun });
        c.status = dryRun ? '' : 'done';
        c.error = dryRun ? 'Dry run OK' : '';
        if (!dryRun) state.selected.delete(c.slug);
        ok++;
        consecutiveFails = 0;
        if (!dryRun) await logRemoval(c);
      } catch (e) {
        closeMenus();
        c.status = 'fail';
        c.error = 'Failed: ' + e.message;
        failed++;
        consecutiveFails++;
      }
      renderList();
      if (consecutiveFails >= 3) {
        setStatus('Stopped after 3 failures in a row. LinkedIn may have changed its page or be rate-limiting you. Try again later.');
        break;
      }
      if (i < batch.length - 1 && !state.stop) await randDelay(minDelay, Math.max(minDelay, maxDelay));
    }
    setBusy(false);
    if (consecutiveFails < 3) {
      setStatus(`${dryRun ? 'Dry run finished' : 'Done'}: ${ok} ${dryRun ? 'OK' : 'removed'}, ${failed} failed.` +
        (state.stop ? ' (stopped early)' : ''));
    }
  }

  async function logRemoval(c) {
    const log = await storage.get('removed', []);
    log.push({ slug: c.slug, name: c.name, headline: c.headline, removedAt: new Date().toISOString() });
    await storage.set('removed', log);
  }

  // ---------- boot (LinkedIn is a single-page app, so watch the URL) ----------

  async function init() {
    state.keep = await storage.get('keep', {});
    state.settings = { ...SETTINGS_DEFAULTS, ...(await storage.get('settings', {})) };
    buildPanel();
    const sync = () => {
      host.style.display = location.pathname.startsWith(CONNECTIONS_PATH) ? '' : 'none';
    };
    sync();
    setInterval(sync, 1000);
  }

  init();
})();
