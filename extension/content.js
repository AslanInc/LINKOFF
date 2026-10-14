// LinkOff content script.
// Runs on linkedin.com, shows a panel on the Connections page, and removes the
// people you select: by clicking "More actions -> Remove connection" for you, or,
// if that menu won't open, by sending LinkedIn the removal request directly.
//
// LinkedIn changes its markup often, so elements are found by visible text and
// aria-labels instead of CSS class names.

(() => {
  if (window.__linkoffLoaded) return;
  window.__linkoffLoaded = true;

  const VERSION = '1.2.0';
  const CONNECTIONS_PATH = '/mynetwork/invite-connect/connections';
  const SETTINGS_KEY = 'settingsV2'; // new key so old, slower saved delays don't carry over
  const SETTINGS_DEFAULTS = { minDelay: 1, maxDelay: 2 };

  const MORE_ACTIONS_RE = /more actions|more options|show more actions/i;
  const REMOVE_ITEM_RE = /^remove( this)? connection$/i;
  const CONFIRM_RE = /^remove$/i;
  const LOAD_MORE_RE = /^(show more results|show more|load more|see more)$/i;

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

  function rawSlugFromHref(href) {
    const m = /\/in\/([^/?#]+)/.exec(href || '');
    return m ? decodeURIComponent(m[1]) : null;
  }

  function slugFromHref(href) {
    return rawSlugFromHref(href)?.toLowerCase() ?? null;
  }

  function fire(el, type, Ctor, extra) {
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window, ...extra }));
  }

  // Replays the full event sequence a real mouse click makes, at the element's center.
  function realClick(el) {
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const pos = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    const ptr = { ...pos, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    fire(el, 'pointerover', PointerEvent, ptr);
    fire(el, 'mouseover', MouseEvent, pos);
    fire(el, 'pointerdown', PointerEvent, { ...ptr, buttons: 1 });
    fire(el, 'mousedown', MouseEvent, { ...pos, buttons: 1 });
    el.focus?.({ preventScroll: true });
    fire(el, 'pointerup', PointerEvent, ptr);
    fire(el, 'mouseup', MouseEvent, pos);
    fire(el, 'click', MouseEvent, { ...pos, detail: 1 });
  }

  function pressKey(el, key) {
    el.focus?.({ preventScroll: true });
    const init = { key, code: key === ' ' ? 'Space' : key, keyCode: key === ' ' ? 32 : 13, which: key === ' ' ? 32 : 13 };
    fire(el, 'keydown', KeyboardEvent, init);
    fire(el, 'keyup', KeyboardEvent, init);
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

  // Short description of an element, for the "Copy problem details" report.
  function describe(el, withHtml = false) {
    if (!el) return '(none)';
    if (withHtml) return el.outerHTML.replace(/\s+/g, ' ').slice(0, 500);
    const attrs = ['role', 'aria-label', 'data-testid'].map((a) => el.getAttribute(a) && `${a}="${el.getAttribute(a)}"`)
      .filter(Boolean).join(' ');
    return `<${el.tagName.toLowerCase()}${attrs ? ' ' + attrs : ''}> "${textOf(el).slice(0, 60)}"`;
  }

  // Records elements LinkedIn adds to the page while we try to open a menu.
  function watchAdded() {
    const seen = [];
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.nodeType === 1 && n !== host && seen.length < 15) seen.push(describe(n));
        }
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    return { stop: () => { obs.disconnect(); return [...new Set(seen)]; } };
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
      const btns = [...el.querySelectorAll('button, [role="button"]')].filter(isMoreActionsButton);
      if (btns.length) {
        const slugs = new Set(
          [...el.querySelectorAll('a[href*="/in/"]')].map((a) => slugFromHref(a.href))
        );
        if (slugs.size === 1 && slugs.has(slug)) return { card: el, moreBtn: btns.find(isVisible) || btns[0] };
        return null;
      }
      el = el.parentElement;
    }
    return null;
  }

  // LinkedIn's internal member ID ("ACoAA…"), if the card carries it somewhere.
  function memberIdFrom(card, rawSlug) {
    if (/^ACo[A-Za-z0-9_-]{10,}$/.test(rawSlug)) return rawSlug;
    const m = /urn:li:fsd_profile:(ACo[A-Za-z0-9_-]+)/.exec(card.outerHTML) ||
      /\b(ACoA[A-Za-z0-9_-]{20,})\b/.exec(card.outerHTML);
    return m ? m[1] : '';
  }

  function scanVisibleConnections() {
    const found = new Map();
    for (const a of profileAnchors()) {
      const slug = slugFromHref(a.href);
      if (!slug || found.has(slug)) continue;
      const hit = cardFor(a, slug);
      if (!hit) continue;
      const rawSlug = rawSlugFromHref(a.href);
      const lines = hit.card.innerText.split('\n').map((s) => s.trim()).filter(Boolean)
        .filter((s) => !/^(message|more actions|show more actions)$/i.test(s));
      const name = ((a.innerText || '').split('\n').map((s) => s.trim()).find(Boolean) || lines[0] || slug)
        .replace(/\s+(undefined|null)$/i, '');
      const rest = lines.filter((s) => s !== name);
      const connected = rest.find((s) => /^connected/i.test(s)) || '';
      const headline = rest.find((s) => s !== connected) || '';
      found.set(slug, {
        slug, rawSlug, name, headline, connected,
        photo: photoFrom(hit.card),
        memberId: memberIdFrom(hit.card, rawSlug),
        url: `https://www.linkedin.com/in/${rawSlug}/`,
      });
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

  // LinkedIn sometimes links one person under two addresses (a vanity name and an
  // ID), so also treat the same name + headline (or name + photo) as the same person.
  function personKey(c) {
    const name = c.name.toLowerCase();
    if (c.headline && c.headline !== '--') return name + '|' + c.headline.toLowerCase();
    return c.photo ? name + '|' + c.photo.split('?')[0] : null;
  }

  // Elements between el and the page that scroll on their own. LinkedIn's newer
  // layout scrolls the list inside a box, so scrolling the window loads nothing.
  function scrollContainers(el) {
    const out = [];
    for (let p = el?.parentElement; p; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if (/(auto|scroll|overlay)/.test(oy) && p.scrollHeight > p.clientHeight + 10) out.push(p);
    }
    return out;
  }

  function scrollToEnd() {
    const anchors = profileAnchors();
    const last = anchors[anchors.length - 1];
    if (last) {
      last.scrollIntoView({ block: 'end' });
      for (const box of scrollContainers(last)) box.scrollTop = box.scrollHeight;
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
  }

  // Scrolls / clicks "Show more results" until the list stops growing.
  async function loadAllConnections(onProgress, shouldStop) {
    const all = new Map();
    const seenPeople = new Set();
    let stableRounds = 0;
    while (stableRounds < 6 && !shouldStop()) {
      const before = all.size;
      for (const [k, v] of scanVisibleConnections()) {
        if (all.has(k)) {
          const old = all.get(k);
          all.set(k, { ...v, photo: v.photo || old.photo, memberId: v.memberId || old.memberId });
          continue;
        }
        const key = personKey(v);
        if (key && seenPeople.has(key)) continue; // same person under another address
        if (key) seenPeople.add(key);
        all.set(k, v);
      }
      onProgress(all.size);

      const more = findClickableByText(LOAD_MORE_RE, document.querySelector('main') || document);
      if (more) realClick(more);
      scrollToEnd();
      await sleep(more ? 2000 : 1500);

      stableRounds = all.size === before ? stableRounds + 1 : 0;
    }
    window.scrollTo(0, 0);
    return all;
  }

  // ---------- removing one connection ----------

  // Which way worked last time ('ui' = clicking the menu, 'api' = direct request).
  // Trying that one first makes long runs much faster.
  let preferredMethod = 'ui';

  async function removeConnection(c, { dryRun, debug }) {
    const order = preferredMethod === 'api' ? ['api', 'ui'] : ['ui', 'api'];
    const errors = [];
    for (const method of order) {
      try {
        const note = method === 'ui'
          ? await removeViaUi(c, dryRun, debug)
          : await removeViaApi(c, dryRun, debug);
        preferredMethod = method;
        return note;
      } catch (e) {
        debug.push(`${method} failed: ${e.message}`);
        errors.push(`${method === 'ui' ? 'Menu' : 'Backup'}: ${e.message}`);
      }
    }
    throw new Error(errors.join(' · '));
  }

  async function scrollToFind(slug) {
    const box = scrollContainers(profileAnchors()[0])[0] || document.scrollingElement;
    for (let y = 0; y < box.scrollHeight; y += box.clientHeight * 0.8) {
      box.scrollTop = y;
      await sleep(250);
      const hit = findCard(slug);
      if (hit) return hit;
    }
    return null;
  }

  async function removeViaUi(c, dryRun, debug) {
    const hit = findCard(c.slug) || await scrollToFind(c.slug);
    if (!hit) throw new Error('person not found on the page');
    debug.push('More button: ' + describe(hit.moreBtn, true));

    const watcher = watchAdded();
    const tries = [
      ['mouse click', () => realClick(hit.moreBtn)],
      ['Enter key', () => pressKey(hit.moreBtn, 'Enter')],
      ['plain click', () => hit.moreBtn.click()],
    ];
    let item = null;
    for (const [label, run] of tries) {
      run();
      item = await waitFor(() => findClickableByText(REMOVE_ITEM_RE), 2000).catch(() => null);
      debug.push(`${label}: ${item ? 'found Remove connection' : 'no Remove option'}` +
        ` (aria-expanded=${hit.moreBtn.getAttribute('aria-expanded')})`);
      if (item) break;
    }
    const added = watcher.stop();
    if (!item) {
      const seen = visibleMenuTexts();
      debug.push('Menu items on screen: ' + (seen.join(' | ') || 'none'));
      debug.push('Added to page after clicking: ' + (added.join(' | ') || 'nothing'));
      closeMenus();
      throw new Error(menuError(seen));
    }

    if (dryRun) {
      closeMenus();
      await sleep(300);
      return 'Practice run worked ✓';
    }

    realClick(item);
    // Usually LinkedIn asks "Remove connection?"; sometimes it removes straight away.
    const dialog = await waitFor(() =>
      deepQueryAll('[role="dialog"], [role="alertdialog"], dialog').find(isVisible), 3000).catch(() => null);
    if (!dialog) {
      if (!findCard(c.slug)) return '';
      throw new Error('confirmation box did not appear');
    }
    const confirm = await waitFor(() =>
      deepQueryAll('button', dialog).find((b) => isVisible(b) &&
        (CONFIRM_RE.test(textOf(b)) || CONFIRM_RE.test(labelOf(b)))), 3000)
      .catch(() => { throw new Error('"Remove" button in the confirmation box not found'); });
    realClick(confirm);
    await waitFor(() => !isVisible(dialog), 6000).catch(() => {});
    return '';
  }

  // Short texts of whatever menu items are on screen, for error messages.
  function visibleMenuTexts() {
    const items = deepQueryAll('[role="menuitem"], [role="menu"] li, [role="menu"] button, .artdeco-dropdown__item')
      .filter(isVisible).map(textOf).filter((t) => t && t.length < 40);
    return [...new Set(items)].slice(0, 6);
  }

  function menuError(seen) {
    return seen.length
      ? `menu showed ${seen.map((t) => `"${t}"`).join(', ')} but no "Remove connection"`
      : 'the "…" menu did not open';
  }

  function closeMenus() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.body.click();
  }

  // ----- direct requests to LinkedIn (the same ones its own site makes) -----

  function csrfToken() {
    return /(?:^|;\s*)JSESSIONID="?([^";]+)"?/.exec(document.cookie)?.[1];
  }

  function voyager(path, { method = 'GET', body } = {}) {
    const token = csrfToken();
    if (!token) throw new Error('not logged in');
    return fetch(path, {
      method,
      credentials: 'include',
      headers: {
        'csrf-token': token,
        'x-restli-protocol-version': '2.0.0',
        accept: 'application/vnd.linkedin.normalized+json+2.1',
        ...(body ? { 'content-type': 'application/json; charset=UTF-8' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async function lookupMemberId(c, debug) {
    if (c.memberId) return c.memberId;
    const res = await voyager(
      `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(c.rawSlug)}`);
    debug.push(`profile lookup -> ${res.status}`);
    if (!res.ok) throw new Error(`profile lookup failed (${res.status})`);
    const id = /urn:li:fsd_profile:(ACo[A-Za-z0-9_-]+)/.exec(await res.text())?.[1];
    if (!id) throw new Error('profile ID not found');
    return (c.memberId = id);
  }

  async function removeViaApi(c, dryRun, debug) {
    const id = await lookupMemberId(c, debug);
    if (dryRun) return 'Practice: the menu way failed, but the backup way found this person ✓';
    const urn = `urn:li:fsd_connection:${id}`;
    const attempts = [
      ['POST', '/voyager/api/relationships/dash/memberRelationships?action=removeFromMyConnections', { connectionUrn: urn }],
      ['DELETE', `/voyager/api/relationships/dash/connections/${encodeURIComponent(urn)}`],
    ];
    const statuses = [];
    for (const [method, path, body] of attempts) {
      const res = await voyager(path, { method, body });
      debug.push(`${method} ${path.split('?')[0]} -> ${res.status}`);
      statuses.push(res.status);
      if (res.ok) return '';
      if (res.status === 429) throw new Error('LinkedIn says slow down (429). Wait a while, then try again');
    }
    throw new Error(`LinkedIn refused (${statuses.join(', ')})`);
  }

  // ---------- panel UI ----------

  const state = {
    connections: [], // [{slug, rawSlug, name, headline, connected, url, photo, memberId, status, error}]
    keep: {}, // slug -> name
    selected: new Set(), // slugs ticked for removal
    settings: { ...SETTINGS_DEFAULTS },
    filter: '',
    tab: 'todo', // which list is showing: todo | kept | removed
    queue: [], // slugs the big view steps through, fixed when it opens
    busy: false,
    stop: false,
    viewing: null, // slug shown in the big photo view
    report: '', // details of the last failure, for "Copy problem details"
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
    .tabs { display:flex;gap:6px;background:#eef3f8;border-radius:22px;padding:4px; }
    .tabs button { flex:1;border:0;background:none;border-radius:18px;padding:9px 4px;font-size:14px;font-weight:600;color:#555; }
    .tabs button b { display:inline-block;min-width:22px;margin-left:2px;padding:1px 6px;border-radius:10px;background:#dfe6ee;font-size:12px; }
    .tabs button.on { background:#fff;color:#0a66c2;box-shadow:0 1px 3px rgba(0,0,0,.15); }
    .tabs button.on b { background:#0a66c2;color:#fff; }
    .row { display:flex;gap:8px; }
    .row button { flex:1;border:2px solid #0a66c2;background:#fff;color:#0a66c2;border-radius:22px;padding:10px 8px;font-weight:700;font-size:15px; }
    .row button.sel-all { background:#0a66c2;color:#fff; }
    .empty { text-align:center;color:#666;padding:30px 10px;font-size:16px; }

    .list { flex:1;overflow:auto;padding:12px 16px;display:flex;flex-direction:column;gap:12px;background:#f4f2ee; }
    .card { position:relative;background:#fff;border:2px solid #e0dfdc;border-radius:14px;padding:14px;display:grid;grid-template-columns:96px 1fr;gap:12px 14px;align-items:center;cursor:pointer; }
    .card.kept { border-color:#057642;background:#f3faf5;cursor:default; }
    .card.picked { border:3px solid #0a66c2;background:#eaf3fc;padding:13px; }
    .card.done { opacity:.5;cursor:default; }
    .card.fail { border-color:#cc1016; }
    .pick { position:absolute;top:10px;right:10px;width:34px;height:34px;border-radius:50%;border:2px solid #9aa5b1;background:#fff;color:transparent;font-size:20px;font-weight:900;line-height:28px;padding:0; }
    .picked .pick { background:#0a66c2;border-color:#0a66c2;color:#fff; }
    .photo-btn { padding:0;border:0;background:none;border-radius:50%;width:96px;height:96px;position:relative; }
    .photo-btn::after { content:"🔍";position:absolute;right:0;bottom:0;background:#fff;border-radius:50%;width:28px;height:28px;font-size:14px;line-height:28px;box-shadow:0 1px 4px rgba(0,0,0,.3); }
    .photo, .initials { width:100%;height:100%;border-radius:50%;object-fit:cover;display:flex;align-items:center;justify-content:center;background:#c9d7e6;color:#0a3a6b;font-weight:800;font-size:32px; }
    .info { min-width:0;padding-right:36px; }
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
    .done-label { grid-column:1 / -1;text-align:center;font-weight:700;color:#555;padding:10px; }
    .busy .actions button, .busy .viewer-actions button, .busy .pick, .busy .row button { pointer-events:none;opacity:.5; }

    .status { padding:12px 16px;background:#fff8e6;border-top:1px solid #f0e2b6;font-size:15px;display:flex;flex-direction:column;gap:8px; }
    .status .copy { align-self:flex-start;border:1px solid #b58900;background:#fff;color:#7a5c00;border-radius:16px;padding:6px 12px;font-weight:600;font-size:13px; }
    .status textarea { width:100%;height:90px;font:12px monospace; }
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
            <li><span class="n">2</span>Tap the people you don't know</li>
            <li><span class="n">3</span>Remove them all with one button</li>
          </ol>
          <button class="big primary scan">Find my connections</button>
        </div>

        <div class="toolbar" hidden>
          <input type="search" placeholder="🔍  Search by name or job">
          <div class="tabs">
            <button data-tab="todo">To review <b></b></button>
            <button data-tab="kept">Kept <b></b></button>
            <button data-tab="removed">Removed <b></b></button>
          </div>
          <div class="row select-row">
            <button class="sel-all">☑ Select all</button>
            <button class="sel-none">Clear</button>
            <button class="review">👀 One by one</button>
          </div>
        </div>
        <div class="list" hidden></div>

        <div class="status" hidden>
          <span class="msg"></span>
          <button class="copy" hidden>📋 Copy problem details</button>
        </div>

        <footer hidden>
          <button class="big danger remove-sel">Remove selected</button>
          <button class="big grey stop" hidden>■ Stop</button>
          <details class="settings">
            <summary>Settings</summary>
            <label>Wait at least (seconds) between removals <input type="number" class="minDelay" min="0" step="0.5"></label>
            <label>Wait at most (seconds) between removals <input type="number" class="maxDelay" min="0" step="0.5"></label>
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
      toolbar: $('.toolbar'), search: $('input[type=search]'), tabs: [...shadow.querySelectorAll('.tabs button')],
      selectRow: $('.select-row'), selAll: $('.sel-all'), selNone: $('.sel-none'), review: $('.review'),
      list: $('.list'), status: $('.status'), msg: $('.status .msg'), copy: $('.status .copy'),
      footer: $('footer'), removeSel: $('.remove-sel'), stop: $('.stop'), rescan: $('.rescan'), dryRun: $('.dryRun'),
      minDelay: $('.minDelay'), maxDelay: $('.maxDelay'),
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
    ui.removeSel.onclick = onRemoveSelected;
    ui.copy.onclick = copyReport;
    for (const t of ui.tabs) t.onclick = () => { state.tab = t.dataset.tab; renderList(); };
    ui.selAll.onclick = () => {
      for (const c of filtered()) if (!decided(c)) state.selected.add(c.slug);
      renderList();
    };
    ui.selNone.onclick = () => { state.selected.clear(); renderList(); };
    ui.review.onclick = () => {
      const rows = filtered();
      const first = rows.find((c) => !decided(c)) || rows[0];
      if (first) openViewer(first.slug, rows.map((c) => c.slug));
      else setStatus('Nobody here to review.');
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
    ui.vRemove.onclick = () => removeOne(byslug(state.viewing), true);

    for (const key of ['minDelay', 'maxDelay']) {
      ui[key].value = state.settings[key];
      ui[key].onchange = () => {
        const v = Number(ui[key].value);
        state.settings[key] = Number.isFinite(v) && v >= 0 ? v : SETTINGS_DEFAULTS[key];
        ui[key].value = state.settings[key];
        storage.set(SETTINGS_KEY, state.settings);
      };
    }
  }

  const byslug = (slug) => state.connections.find((c) => c.slug === slug);
  const decided = (c) => !!state.keep[c.slug] || c.status === 'done';

  function inTab(c, tab = state.tab) {
    if (tab === 'kept') return !!state.keep[c.slug];
    if (tab === 'removed') return c.status === 'done';
    return !decided(c);
  }

  function filtered() {
    return state.connections.filter((c) => inTab(c) &&
      (!state.filter || (c.name + ' ' + c.headline).toLowerCase().includes(state.filter)));
  }

  function setStatus(msg, { problem = false } = {}) {
    ui.msg.textContent = msg;
    ui.status.hidden = !msg;
    ui.copy.hidden = !(problem && state.report);
    ui.status.querySelector('textarea')?.remove();
  }

  function requestStop() {
    state.stop = true;
    setStatus('Stopping…');
  }

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(state.report);
      ui.copy.textContent = '✓ Copied! Paste it to whoever is helping you';
    } catch {
      // Clipboard blocked: show the text so it can be copied by hand.
      if (!ui.status.querySelector('textarea')) {
        const ta = document.createElement('textarea');
        ta.value = state.report;
        ui.status.append(ta);
        ta.select();
      }
    }
  }

  function buildReport(c, debug, error) {
    return [
      `LinkOff ${VERSION} problem report`,
      `Page: ${location.pathname}`,
      `Browser: ${navigator.userAgent}`,
      `Person: ${c.name} (${c.rawSlug}) memberId=${c.memberId || '?'}`,
      `Error: ${error}`,
      ...debug,
    ].join('\n');
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

  function toggleSelect(c) {
    if (state.busy || decided(c)) return;
    if (state.selected.has(c.slug)) state.selected.delete(c.slug);
    else state.selected.add(c.slug);
    refresh(c);
  }

  function cardEl(c) {
    const kept = !!state.keep[c.slug];
    const picked = state.selected.has(c.slug);
    const card = document.createElement('div');
    card.className = 'card' + (kept ? ' kept' : '') + (picked ? ' picked' : '') + (c.status ? ' ' + c.status : '');
    card.dataset.slug = c.slug;
    // Tapping anywhere on the card (except its buttons and links) selects it.
    card.onclick = (e) => { if (!e.target.closest('button, a')) toggleSelect(c); };

    const photoBtn = document.createElement('button');
    photoBtn.className = 'photo-btn';
    photoBtn.title = 'See bigger photo';
    photoBtn.append(photoEl(c));
    photoBtn.onclick = () => openViewer(c.slug, filtered().map((r) => r.slug));

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

    if (!kept) {
      const pick = document.createElement('button');
      pick.className = 'pick';
      pick.title = 'Select to remove';
      pick.textContent = '✓';
      pick.onclick = () => toggleSelect(c);
      card.append(pick);
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
    remove.onclick = () => removeOne(c);
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
      empty.className = 'empty';
      empty.textContent = state.filter ? 'Nobody matches that search.'
        : { todo: "🎉 You've gone through everyone!", kept: "You haven't kept anyone yet.", removed: 'Nobody removed yet.' }[state.tab];
      ui.list.append(empty);
    }
    for (const t of ui.tabs) t.classList.toggle('on', t.dataset.tab === state.tab);
    ui.selAll.hidden = ui.selNone.hidden = state.tab !== 'todo';
    updateCounts();
  }

  // A person who no longer belongs in the open tab (e.g. just kept) leaves the list.
  function refresh(c) {
    const old = ui.list.querySelector(`.card[data-slug="${CSS.escape(c.slug)}"]`);
    if (old) {
      if (inTab(c)) old.replaceWith(cardEl(c));
      else old.remove();
    }
    if (!ui.list.querySelector('.card')) renderList();
    if (state.viewing === c.slug) renderViewer();
    updateCounts();
  }

  function updateCounts() {
    for (const t of ui.tabs) {
      t.querySelector('b').textContent = state.connections.filter((c) => inTab(c, t.dataset.tab)).length;
    }
    const n = state.selected.size;
    ui.removeSel.textContent = n ? `Remove ${n} selected` : 'Tap people to select them';
    ui.removeSel.disabled = n === 0 || state.busy;
  }

  function toggleKeep(c) {
    if (state.keep[c.slug]) delete state.keep[c.slug];
    else { state.keep[c.slug] = c.name; state.selected.delete(c.slug); }
    storage.set('keep', state.keep);
    refresh(c);
  }

  // ----- big photo view -----

  function openViewer(slug, queue) {
    if (queue) state.queue = queue;
    state.viewing = slug;
    ui.viewer.hidden = false;
    renderViewer();
  }

  function closeViewer() {
    state.viewing = null;
    ui.viewer.hidden = true;
  }

  // Steps through the list as it was when the big view opened, so nobody shows up
  // twice. After a choice, skip anyone already kept or removed.
  function stepViewer(dir, undecidedOnly = false) {
    const q = state.queue;
    let j = q.indexOf(state.viewing) + dir;
    while (q[j] && (!byslug(q[j]) || (undecidedOnly && decided(byslug(q[j]))))) j += dir;
    if (q[j]) openViewer(q[j]);
    else if (dir > 0) { closeViewer(); setStatus("That's everyone!"); }
  }

  function renderViewer() {
    const c = byslug(state.viewing);
    if (!c) return closeViewer();
    const i = state.queue.indexOf(c.slug);
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
    if (done) ui.vMeta.textContent = 'Removed';

    ui.pos.textContent = i >= 0 ? `${i + 1} of ${state.queue.length}` : '';
    ui.prev.disabled = i <= 0;
  }

  // ----- doing the work -----

  function setBusy(busy) {
    state.busy = busy;
    state.stop = false;
    ui.panel.classList.toggle('busy', busy);
    ui.rescan.disabled = busy;
    ui.removeSel.hidden = busy;
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
        (n) => { ui.scan.textContent = `Found ${n}… (tap to stop)`; },
        () => state.stop
      );
      state.connections = [...all.values()];
      state.selected = new Set([...state.selected].filter((s) => all.has(s)));
      setStatus(all.size
        ? `Found ${all.size} connections. Tap the people you don't know, then press Remove.`
        : "Couldn't find any connections. Make sure you're logged in and on your Connections page.");
    } catch (e) {
      setStatus('Something went wrong: ' + e.message);
    }
    ui.scan.textContent = 'Find my connections';
    setBusy(false);
    renderList();
  }

  // Removes one person and updates their card. Returns true on success.
  async function removeAndMark(c, dryRun) {
    const debug = [];
    try {
      const note = await removeConnection(c, { dryRun, debug });
      c.status = dryRun ? '' : 'done';
      c.error = note;
      if (!dryRun) {
        state.selected.delete(c.slug);
        await logRemoval(c);
      }
      return true;
    } catch (e) {
      closeMenus();
      c.status = 'fail';
      c.error = "Couldn't remove: " + e.message;
      state.report = buildReport(c, debug, e.message);
      return false;
    } finally {
      refresh(c);
    }
  }

  async function removeOne(c, fromViewer = false) {
    if (state.busy || !c) return;
    const dryRun = ui.dryRun.checked;
    setBusy(true);
    setStatus(`${dryRun ? 'Practicing on' : 'Removing'} ${c.name}…`);
    const ok = await removeAndMark(c, dryRun);
    setBusy(false);
    setStatus(ok ? `${dryRun ? 'Practice run worked for' : 'Removed'} ${c.name}.` : `Couldn't remove ${c.name}.`,
      { problem: !ok });
    if (ok && fromViewer && state.viewing === c.slug) stepViewer(1, true);
  }

  async function onRemoveSelected() {
    const batch = state.connections.filter((c) => state.selected.has(c.slug) && !decided(c));
    if (!batch.length) return;
    const { minDelay, maxDelay } = state.settings;
    const dryRun = ui.dryRun.checked;

    closeViewer();
    setBusy(true);
    let ok = 0, failed = 0, consecutiveFails = 0;
    for (let i = 0; i < batch.length; i++) {
      if (state.stop) break;
      const c = batch[i];
      setStatus(`${dryRun ? 'Practicing' : 'Removing'} ${i + 1} of ${batch.length}: ${c.name}`);
      if (await removeAndMark(c, dryRun)) { ok++; consecutiveFails = 0; }
      else { failed++; consecutiveFails++; }
      if (consecutiveFails >= 3) break;
      if (i < batch.length - 1 && !state.stop) await randDelay(minDelay, Math.max(minDelay, maxDelay));
    }
    const stopped = state.stop;
    setBusy(false);
    if (consecutiveFails >= 3) {
      setStatus('Paused after 3 problems in a row. LinkedIn may have changed its page or be slowing you down.',
        { problem: true });
    } else {
      setStatus(`${dryRun ? 'Practice finished' : 'All done'}: ${ok} ${dryRun ? 'worked' : 'removed'}` +
        (failed ? `, ${failed} couldn't be removed` : '') + '.' + (stopped ? ' (You stopped early.)' : ''),
        { problem: failed > 0 });
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
    state.settings = { ...SETTINGS_DEFAULTS, ...(await storage.get(SETTINGS_KEY, {})) };
    buildPanel();
    const sync = () => {
      host.style.display = location.pathname.startsWith(CONNECTIONS_PATH) ? '' : 'none';
    };
    sync();
    setInterval(sync, 1000);
  }

  init();
})();
