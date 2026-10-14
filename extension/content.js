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
  const REMOVE_ITEM_RE = /^remove( this)? connection$/i;
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

  // querySelectorAll that also looks inside open shadow roots. LinkedIn renders
  // some menus and dialogs inside one (e.g. #interop-outlet). Skips our own panel.
  function deepQueryAll(selector, root = document) {
    const out = [];
    const visit = (node) => {
      out.push(...node.querySelectorAll(selector));
      for (const el of node.querySelectorAll('*')) {
        if (el.shadowRoot && el !== host) visit(el.shadowRoot);
      }
    };
    visit(root);
    return out;
  }

  // Rendered text only (innerText skips hidden icon titles), whitespace collapsed.
  function textOf(el) {
    return (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  // Finds the first visible clickable element whose text or aria-label matches re.
  function findClickableByText(re, root = document) {
    const candidates = deepQueryAll(
      'button, [role="button"], [role="menuitem"], a, li, div, span, p', root
    );
    // Buttons and menu items have short text; skipping long ones keeps this fast on big pages.
    const matches = candidates.filter((el) =>
      ((el.textContent || '').length < 120 && re.test(textOf(el)) ||
        re.test((el.getAttribute('aria-label') || '').trim())) && isVisible(el));
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
      const name = ((a.innerText || '').split('\n').map((s) => s.trim()).find(Boolean) || lines[0] || slug)
        .replace(/\s+(undefined|null)$/i, '');
      const rest = lines.filter((s) => s !== name);
      const connected = rest.find((s) => /^connected/i.test(s)) || '';
      const headline = rest.find((s) => s !== connected) || '';
      found.set(slug, { slug, name, headline, connected, photo: photoFrom(hit.card), url: `https://www.linkedin.com/in/${slug}/` });
    }
    return found;
  }

  // Profile photo URL from a card. Pictures load lazily, so check the deferred-URL attributes too.
  function photoFrom(card) {
    for (const img of card.querySelectorAll('img')) {
      const src = img.currentSrc || img.src || img.getAttribute('data-delayed-url') || '';
      if (/^https?:/.test(src) && !/ghost|static\.licdn\.com\/sc\//.test(src)) return src;
    }
    return '';
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
      for (const [k, v] of scanVisibleConnections()) {
        all.set(k, { ...v, photo: v.photo || all.get(k)?.photo || '' });
      }
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
    const item = await waitFor(() => findClickableByText(REMOVE_ITEM_RE), 5000).catch(() => null);

    if (!item) {
      // The menu didn't show the option we expected. Fall back to the request
      // LinkedIn's own site sends, and report what the menu showed if that fails too.
      const seen = visibleMenuTexts();
      closeMenus();
      if (dryRun) throw new Error(menuError(seen));
      try {
        await removeViaApi(slug);
        return;
      } catch (e) {
        throw new Error(`${menuError(seen)} Backup method also failed (${e.message}).`);
      }
    }

    if (dryRun) {
      closeMenus();
      await sleep(300);
      return;
    }

    realClick(item);
    const dialog = await waitFor(() =>
      deepQueryAll('[role="dialog"], [role="alertdialog"], dialog').find(isVisible), 5000)
      .catch(() => { throw new Error('confirmation dialog did not appear'); });
    const confirm = await waitFor(() =>
      deepQueryAll('button', dialog).find((b) => isVisible(b) &&
        (CONFIRM_RE.test(textOf(b)) || CONFIRM_RE.test(labelOf(b)))), 3000)
      .catch(() => { throw new Error('"Remove" confirm button not found'); });
    realClick(confirm);
    await waitFor(() => !isVisible(dialog), 6000).catch(() => {});
  }

  // Short texts of whatever menu items are on screen, for error messages.
  function visibleMenuTexts() {
    const items = deepQueryAll('[role="menuitem"], [role="menu"] li, [role="menu"] button, .artdeco-dropdown__item')
      .filter(isVisible).map(textOf).filter((t) => t && t.length < 40);
    return [...new Set(items)].slice(0, 6);
  }

  function menuError(seen) {
    return seen.length
      ? `Menu showed: ${seen.map((t) => `"${t}"`).join(', ')}, but no "Remove connection".`
      : 'The "…" menu did not open.';
  }

  // Asks LinkedIn to remove the connection directly, the same request its site makes.
  async function removeViaApi(slug) {
    const jsession = /(?:^|;\s*)JSESSIONID="?([^";]+)"?/.exec(document.cookie);
    if (!jsession) throw new Error('not logged in');
    const res = await fetch(
      `/voyager/api/identity/profiles/${encodeURIComponent(slug)}/profileActions?action=disconnect`,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'csrf-token': jsession[1],
          'x-restli-protocol-version': '2.0.0',
          accept: 'application/vnd.linkedin.normalized+json+2.1',
        },
      }
    );
    if (!res.ok) throw new Error(`LinkedIn replied ${res.status}`);
  }

  function closeMenus() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.body.click();
  }

  // ---------- panel UI ----------

  const state = {
    connections: [], // [{slug, name, headline, connected, url, photo, status, error}]
    keep: {}, // slug -> name
    settings: { ...SETTINGS_DEFAULTS },
    filter: '',
    busy: false,
    stop: false,
    viewing: null, // slug shown in the big photo view
  };

  let host, shadow, ui;

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    [hidden] { display: none !important; }
    button { font: inherit; cursor: pointer; }
    button:disabled { opacity: .5; cursor: default; }

    .fab { background:#0a66c2;color:#fff;border:0;border-radius:30px;padding:16px 24px;font-size:17px;font-weight:700;box-shadow:0 6px 20px rgba(0,0,0,.3); }
    .fab:hover { background:#004182; }

    .panel { position:relative;width:460px;max-width:calc(100vw - 32px);height:calc(100vh - 32px);max-height:860px;background:#fff;color:#1d2226;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden;font-size:15px; }
    header { display:flex;align-items:center;justify-content:space-between;padding:14px 18px;background:#0a66c2;color:#fff; }
    header .title { font-size:20px;font-weight:800; }
    header .close { background:rgba(255,255,255,.15);border:0;color:#fff;width:36px;height:36px;border-radius:50%;font-size:18px; }

    .big { width:100%;border:0;border-radius:28px;padding:16px;font-size:18px;font-weight:700; }
    .primary { background:#0a66c2;color:#fff; } .primary:hover:not(:disabled) { background:#004182; }
    .danger { background:#cc1016;color:#fff; } .danger:hover:not(:disabled) { background:#a00c11; }
    .grey { background:#e9e5df;color:#1d2226; }

    .start { flex:1;display:flex;flex-direction:column;justify-content:center;padding:24px 28px;gap:18px;text-align:center; }
    .start h2 { margin:0;font-size:24px; }
    .steps { text-align:left;margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:12px; }
    .steps li { display:flex;align-items:center;gap:12px;font-size:16px; }
    .steps .n { flex:none;width:32px;height:32px;border-radius:50%;background:#eef3f8;color:#0a66c2;font-weight:800;display:flex;align-items:center;justify-content:center; }

    .toolbar { display:flex;flex-direction:column;gap:10px;padding:12px 16px;border-bottom:1px solid #e8e8e8; }
    .toolbar input { width:100%;padding:12px 16px;border:1px solid #bbb;border-radius:24px;font-size:16px; }
    .toolbar .row2 { display:flex;align-items:center;justify-content:space-between;gap:10px; }
    .count { color:#555;font-size:14px; }
    .review { border:2px solid #0a66c2;background:#fff;color:#0a66c2;border-radius:20px;padding:8px 14px;font-weight:700;font-size:14px; }

    .list { flex:1;overflow:auto;padding:12px 16px;display:flex;flex-direction:column;gap:12px;background:#f4f2ee; }
    .card { background:#fff;border:2px solid #e0dfdc;border-radius:14px;padding:14px;display:grid;grid-template-columns:96px 1fr;gap:12px 14px;align-items:center; }
    .card.kept { border-color:#057642;background:#f3faf5; }
    .card.done { opacity:.5; }
    .card.fail { border-color:#cc1016; }
    .photo-btn { padding:0;border:0;background:none;border-radius:50%;width:96px;height:96px;position:relative; }
    .photo-btn::after { content:"🔍";position:absolute;right:0;bottom:0;background:#fff;border-radius:50%;width:28px;height:28px;font-size:14px;line-height:28px;box-shadow:0 1px 4px rgba(0,0,0,.3); }
    .photo, .initials { width:100%;height:100%;border-radius:50%;object-fit:cover;display:flex;align-items:center;justify-content:center;background:#c9d7e6;color:#0a3a6b;font-weight:800;font-size:32px; }
    .info { min-width:0; }
    .name { color:#1d2226;font-size:18px;font-weight:700;text-decoration:none;display:block; }
    .name:hover { text-decoration:underline; }
    .headline { color:#555;font-size:14px;margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden; }
    .meta { color:#777;font-size:13px;margin-top:4px; }
    .meta.err { color:#cc1016; }
    .actions { grid-column:1 / -1;display:flex;gap:10px; }
    .actions button, .viewer-actions button { flex:1;border-radius:24px;padding:14px 10px;font-size:17px;font-weight:700; }
    .keep { border:2px solid #057642;background:#fff;color:#057642; }
    .kept .keep, .keep.on { background:#057642;color:#fff; }
    .remove { border:2px solid #cc1016;background:#cc1016;color:#fff; }
    .remove[data-armed] { background:#7a0a0d;border-color:#7a0a0d; }
    .done-label { grid-column:1 / -1;text-align:center;font-weight:700;color:#555;padding:10px; }
    .busy .actions button, .busy .viewer-actions button { pointer-events:none;opacity:.5; }

    .status { padding:12px 16px;background:#fff8e6;border-top:1px solid #f0e2b6;font-size:15px; }
    footer { padding:12px 16px 16px;border-top:1px solid #e8e8e8;display:flex;flex-direction:column;gap:10px; }
    details summary { cursor:pointer;color:#555;font-size:14px; }
    .settings label { display:flex;justify-content:space-between;align-items:center;margin:10px 0;font-size:14px; }
    .settings input[type=number] { width:70px;padding:6px;font-size:14px; }
    .settings input[type=checkbox] { width:20px;height:20px; }
    .rescan { border:1px solid #0a66c2;color:#0a66c2;background:#fff;border-radius:20px;padding:8px 14px;font-weight:600; }

    .viewer { position:absolute;inset:0;top:64px;background:#fff;display:flex;flex-direction:column;align-items:center;padding:16px 24px 20px;gap:12px;overflow:auto; }
    .back { align-self:flex-start;border:0;background:none;color:#0a66c2;font-size:16px;font-weight:700;padding:4px 0; }
    .big-photo { width:260px;height:260px;flex:none; }
    .big-photo .initials { font-size:90px; }
    .viewer h2 { margin:4px 0 0;font-size:26px;text-align:center; }
    .viewer h2 a { color:inherit;text-decoration:none; } .viewer h2 a:hover { text-decoration:underline; }
    .viewer .headline { font-size:16px;text-align:center;-webkit-line-clamp:3; }
    .viewer .meta { text-align:center; }
    .viewer-actions { display:flex;gap:12px;width:100%;margin-top:auto; }
    .viewer-actions button { padding:18px 10px;font-size:19px; }
    .nav { display:flex;align-items:center;justify-content:space-between;width:100%; }
    .nav button { border:0;background:#eef3f8;color:#0a66c2;border-radius:20px;padding:10px 16px;font-weight:700;font-size:15px; }
    .nav span { color:#666;font-size:14px; }
  `;

  function buildPanel() {
    host = document.createElement('div');
    host.id = 'linkoff-host';
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${STYLE}</style>
      <button class="fab">🧹 LinkOff</button>
      <div class="panel" hidden>
        <header><span class="title">🧹 LinkOff</span><button class="close" title="Minimize">✕</button></header>

        <div class="start">
          <h2>Clean up your connections</h2>
          <ol class="steps">
            <li><span class="n">1</span>Find your connections</li>
            <li><span class="n">2</span>Tap <b>&nbsp;Keep&nbsp;</b> on people you know</li>
            <li><span class="n">3</span>Remove everyone else with one button</li>
          </ol>
          <button class="big primary scan">Find my connections</button>
        </div>

        <div class="toolbar" hidden>
          <input type="search" placeholder="🔍  Search by name or job">
          <div class="row2">
            <span class="count"></span>
            <button class="review">👀 Review one by one</button>
          </div>
        </div>
        <div class="list" hidden></div>

        <div class="status" hidden></div>

        <footer hidden>
          <button class="big danger remove-all">Remove everyone not kept</button>
          <button class="big grey stop" hidden>■ Stop</button>
          <details class="settings">
            <summary>Settings</summary>
            <label>Wait at least (seconds) between removals <input type="number" class="minDelay" min="1"></label>
            <label>Wait at most (seconds) between removals <input type="number" class="maxDelay" min="1"></label>
            <label>Most people to remove at once <input type="number" class="maxPerRun" min="1"></label>
            <label>Practice mode (don't actually remove) <input type="checkbox" class="dryRun"></label>
            <button class="rescan">↻ Find connections again</button>
          </details>
        </footer>

        <div class="viewer" hidden>
          <button class="back">‹ Back to list</button>
          <div class="big-photo"></div>
          <h2><a class="v-name" target="_blank" rel="noopener"></a></h2>
          <div class="headline v-headline"></div>
          <div class="meta v-meta"></div>
          <div class="viewer-actions">
            <button class="keep v-keep">✓ Keep</button>
            <button class="remove v-remove">✕ Remove</button>
          </div>
          <div class="nav">
            <button class="prev">‹ Previous</button>
            <span class="pos"></span>
            <button class="next">Next ›</button>
          </div>
        </div>
      </div>`;
    document.documentElement.appendChild(host);

    const $ = (s) => shadow.querySelector(s);
    ui = {
      fab: $('.fab'), panel: $('.panel'), close: $('.close'), start: $('.start'), scan: $('.scan'),
      toolbar: $('.toolbar'), search: $('input[type=search]'), count: $('.count'), review: $('.review'),
      list: $('.list'), status: $('.status'), footer: $('footer'), removeAll: $('.remove-all'),
      stop: $('.stop'), rescan: $('.rescan'), dryRun: $('.dryRun'),
      minDelay: $('.minDelay'), maxDelay: $('.maxDelay'), maxPerRun: $('.maxPerRun'),
      viewer: $('.viewer'), back: $('.back'), bigPhoto: $('.big-photo'), vName: $('.v-name'),
      vHeadline: $('.v-headline'), vMeta: $('.v-meta'), vKeep: $('.v-keep'), vRemove: $('.v-remove'),
      prev: $('.prev'), next: $('.next'), pos: $('.pos'),
    };

    ui.fab.onclick = () => { ui.fab.hidden = true; ui.panel.hidden = false; };
    ui.close.onclick = () => { ui.panel.hidden = true; ui.fab.hidden = false; };
    ui.scan.onclick = () => (state.busy ? requestStop() : onScan());
    ui.rescan.onclick = onScan;
    ui.stop.onclick = requestStop;
    ui.search.oninput = () => { state.filter = ui.search.value.toLowerCase(); renderList(); };
    ui.removeAll.onclick = onRemoveAll;
    ui.review.onclick = () => {
      const first = filtered().find((c) => !state.keep[c.slug] && c.status !== 'done') || filtered()[0];
      if (first) openViewer(first.slug);
    };

    ui.back.onclick = closeViewer;
    ui.prev.onclick = () => stepViewer(-1);
    ui.next.onclick = () => stepViewer(1);
    ui.vKeep.onclick = () => {
      const c = byslug(state.viewing);
      const wasKept = !!state.keep[c.slug];
      toggleKeep(c);
      if (!wasKept) stepViewer(1, true); // move on to the next person
    };
    ui.vRemove.onclick = () => armRemove(ui.vRemove, byslug(state.viewing), true);

    for (const key of ['minDelay', 'maxDelay', 'maxPerRun']) {
      ui[key].value = state.settings[key];
      ui[key].onchange = () => {
        state.settings[key] = Math.max(1, Number(ui[key].value) || SETTINGS_DEFAULTS[key]);
        ui[key].value = state.settings[key];
        storage.set('settings', state.settings);
      };
    }
  }

  const byslug = (slug) => state.connections.find((c) => c.slug === slug);

  function filtered() {
    if (!state.filter) return state.connections;
    return state.connections.filter((c) =>
      (c.name + ' ' + c.headline).toLowerCase().includes(state.filter));
  }

  function removable() {
    return state.connections.filter((c) => !state.keep[c.slug] && c.status !== 'done');
  }

  function setStatus(msg) {
    ui.status.textContent = msg;
    ui.status.hidden = !msg;
  }

  function requestStop() {
    state.stop = true;
    setStatus('Stopping…');
  }

  function photoEl(c) {
    const initials = () => {
      const span = document.createElement('span');
      span.className = 'initials';
      span.textContent = c.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
      return span;
    };
    if (!c.photo) return initials();
    const img = document.createElement('img');
    img.className = 'photo';
    img.src = c.photo;
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => img.replaceWith(initials());
    return img;
  }

  // A Remove button needs two taps, so a slip of the finger can't remove someone.
  function armRemove(btn, c, fromViewer = false) {
    if (state.busy || !c) return;
    if (btn.dataset.armed) {
      clearTimeout(btn._disarm);
      delete btn.dataset.armed;
      removeOne(c, fromViewer);
      return;
    }
    btn.dataset.armed = '1';
    btn.textContent = 'Tap again to confirm';
    btn._disarm = setTimeout(() => {
      delete btn.dataset.armed;
      btn.textContent = '✕ Remove';
    }, 3000);
  }

  function cardEl(c) {
    const kept = !!state.keep[c.slug];
    const card = document.createElement('div');
    card.className = 'card' + (kept ? ' kept' : '') + (c.status ? ' ' + c.status : '');
    card.dataset.slug = c.slug;

    const photoBtn = document.createElement('button');
    photoBtn.className = 'photo-btn';
    photoBtn.title = 'See bigger photo';
    photoBtn.append(photoEl(c));
    photoBtn.onclick = () => openViewer(c.slug);

    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('a');
    name.className = 'name';
    name.href = c.url; name.target = '_blank'; name.rel = 'noopener';
    name.textContent = c.name;
    const headline = document.createElement('div');
    headline.className = 'headline';
    headline.textContent = c.headline;
    info.append(name, headline);
    const metaText = c.error || c.connected;
    if (metaText) {
      const meta = document.createElement('div');
      meta.className = 'meta' + (c.status === 'fail' ? ' err' : '');
      meta.textContent = metaText;
      info.append(meta);
    }
    card.append(photoBtn, info);

    if (c.status === 'done') {
      const done = document.createElement('div');
      done.className = 'done-label';
      done.textContent = 'Removed';
      card.append(done);
      return card;
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    const keep = document.createElement('button');
    keep.className = 'keep';
    keep.textContent = kept ? '✓ Kept' : '✓ Keep';
    keep.title = 'People you keep are never removed';
    keep.onclick = () => toggleKeep(c);
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = '✕ Remove';
    remove.onclick = () => armRemove(remove, c);
    actions.append(keep, remove);
    card.append(actions);
    return card;
  }

  function renderList() {
    const has = state.connections.length > 0;
    ui.start.hidden = has;
    ui.toolbar.hidden = ui.list.hidden = ui.footer.hidden = !has;
    if (!has) return;

    ui.list.textContent = '';
    const rows = filtered();
    for (const c of rows) ui.list.append(cardEl(c));
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'meta';
      empty.style.textAlign = 'center';
      empty.textContent = 'Nobody matches that search.';
      ui.list.append(empty);
    }
    updateCounts();
  }

  // Re-draws one person's card (and the big view, if open) without rebuilding the whole list.
  function refresh(c) {
    const old = ui.list.querySelector(`.card[data-slug="${CSS.escape(c.slug)}"]`);
    if (old) old.replaceWith(cardEl(c));
    if (state.viewing === c.slug) renderViewer();
    updateCounts();
  }

  function updateCounts() {
    const total = state.connections.length;
    const kept = state.connections.filter((c) => state.keep[c.slug]).length;
    const n = removable().length;
    ui.count.textContent = `${total} connections · ${kept} kept`;
    ui.removeAll.textContent = n ? `Remove everyone not kept (${n})` : 'Nobody left to remove';
    ui.removeAll.disabled = n === 0 || state.busy;
  }

  function toggleKeep(c) {
    if (state.keep[c.slug]) delete state.keep[c.slug];
    else state.keep[c.slug] = c.name;
    storage.set('keep', state.keep);
    refresh(c);
  }

  // ----- big photo view -----

  function openViewer(slug) {
    state.viewing = slug;
    ui.viewer.hidden = false;
    renderViewer();
  }

  function closeViewer() {
    state.viewing = null;
    ui.viewer.hidden = true;
  }

  // Arrows step through everyone; after a choice, skip to the next undecided person.
  function stepViewer(dir, undecidedOnly = false) {
    const rows = filtered();
    const i = rows.findIndex((c) => c.slug === state.viewing);
    let j = i + dir;
    while (undecidedOnly && rows[j] && (state.keep[rows[j].slug] || rows[j].status === 'done')) j += dir;
    const next = rows[j];
    if (next) openViewer(next.slug);
    else if (dir > 0) { closeViewer(); setStatus("That's everyone! Use the red button to remove everyone you didn't keep."); }
  }

  function renderViewer() {
    const c = byslug(state.viewing);
    if (!c) return closeViewer();
    const rows = filtered();
    const i = rows.findIndex((r) => r.slug === c.slug);
    const kept = !!state.keep[c.slug];

    ui.bigPhoto.textContent = '';
    ui.bigPhoto.append(photoEl(c));
    ui.vName.textContent = c.name;
    ui.vName.href = c.url;
    ui.vHeadline.textContent = c.headline;
    ui.vMeta.textContent = c.error || c.connected;
    ui.vMeta.className = 'meta v-meta' + (c.status === 'fail' ? ' err' : '');

    const done = c.status === 'done';
    ui.vKeep.hidden = ui.vRemove.hidden = done;
    ui.vKeep.textContent = kept ? '✓ Kept' : '✓ Keep';
    ui.vKeep.classList.toggle('on', kept);
    clearTimeout(ui.vRemove._disarm);
    delete ui.vRemove.dataset.armed;
    ui.vRemove.textContent = '✕ Remove';
    if (done) ui.vMeta.textContent = 'Removed';

    ui.pos.textContent = i >= 0 ? `${i + 1} of ${rows.length}` : '';
    ui.prev.disabled = i <= 0;
  }

  // ----- doing the work -----

  function setBusy(busy) {
    state.busy = busy;
    state.stop = false;
    ui.panel.classList.toggle('busy', busy);
    ui.rescan.disabled = busy;
    ui.removeAll.hidden = busy;
    ui.stop.hidden = !busy;
    updateCounts();
  }

  async function onScan() {
    setBusy(true);
    ui.stop.hidden = true; // the scan button doubles as Stop while scanning
    ui.scan.textContent = 'Looking… (tap to stop)';
    setStatus('Finding your connections. The page will scroll by itself.');
    try {
      const all = await loadAllConnections(
        (n) => { ui.scan.textContent = `Found ${n}… (tap to stop)`; ui.count.textContent = `${n} found…`; },
        () => state.stop
      );
      state.connections = [...all.values()];
      setStatus(all.size
        ? `Found ${all.size} connections. Tap ✓ Keep on people you know.`
        : "Couldn't find any connections. Make sure you're logged in and on your Connections page.");
    } catch (e) {
      setStatus('Something went wrong: ' + e.message);
    }
    ui.scan.textContent = 'Find my connections';
    setBusy(false);
    renderList();
  }

  async function removeOneQuietly(c, dryRun) {
    try {
      await removeConnection(c.slug, { dryRun });
      c.status = dryRun ? '' : 'done';
      c.error = dryRun ? 'Practice run worked ✓' : '';
      if (!dryRun) await logRemoval(c);
      return true;
    } catch (e) {
      closeMenus();
      c.status = 'fail';
      c.error = "Couldn't remove: " + e.message;
      return false;
    } finally {
      refresh(c);
    }
  }

  async function removeOne(c, fromViewer) {
    const dryRun = ui.dryRun.checked;
    setBusy(true);
    setStatus(`${dryRun ? 'Practicing on' : 'Removing'} ${c.name}…`);
    const ok = await removeOneQuietly(c, dryRun);
    setBusy(false);
    setStatus(ok ? `${dryRun ? 'Practice run worked for' : 'Removed'} ${c.name}.` : `Couldn't remove ${c.name}.`);
    if (ok && fromViewer && state.viewing === c.slug) stepViewer(1, true);
  }

  async function onRemoveAll() {
    const queue = removable();
    const { minDelay, maxDelay, maxPerRun } = state.settings;
    const dryRun = ui.dryRun.checked;
    const batch = queue.slice(0, maxPerRun);
    if (!batch.length) return;

    const msg = dryRun
      ? `Practice run on ${batch.length} people. Nobody will actually be removed. Continue?`
      : `Remove ${batch.length} people you didn't keep?\n\nThis can't be undone.` +
        (queue.length > batch.length ? `\n\n(Removing ${maxPerRun} now. Run it again for the rest. You can change this in Settings.)` : '');
    if (!confirm(msg)) return;

    closeViewer();
    setBusy(true);
    let ok = 0, failed = 0, consecutiveFails = 0;
    for (let i = 0; i < batch.length; i++) {
      if (state.stop) break;
      const c = batch[i];
      setStatus(`${dryRun ? 'Practicing' : 'Removing'} ${i + 1} of ${batch.length}: ${c.name}`);
      if (await removeOneQuietly(c, dryRun)) { ok++; consecutiveFails = 0; }
      else { failed++; consecutiveFails++; }
      if (consecutiveFails >= 3) break;
      if (i < batch.length - 1 && !state.stop) await randDelay(minDelay, Math.max(minDelay, maxDelay));
    }
    const stopped = state.stop;
    setBusy(false);
    if (consecutiveFails >= 3) {
      setStatus('Paused after 3 problems in a row. LinkedIn may have changed its page or be slowing you down. Try again later.');
    } else {
      setStatus(`${dryRun ? 'Practice finished' : 'All done'}: ${ok} ${dryRun ? 'worked' : 'removed'}` +
        (failed ? `, ${failed} couldn't be removed` : '') + '.' + (stopped ? ' (You stopped early.)' : ''));
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
