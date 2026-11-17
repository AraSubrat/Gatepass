/* Gatepass front-end: a small hash-routed single page app, no framework. */
'use strict';

// ---------- Helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Tagged template that escapes every interpolation unless it is raw() or an array of raw().
function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => {
    if (Array.isArray(v)) out += v.map((x) => (x instanceof Raw ? x.s : esc(x))).join('');
    else if (v instanceof Raw) out += v.s;
    else if (v === false || v === null || v === undefined) out += '';
    else out += esc(v);
    out += strings[i + 1];
  });
  return raw(out);
}

async function api(method, url, body) {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.user) { state.user = null; go('/login'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4000);
}

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '');
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const fmtDay = (ymd) => new Date(`${ymd}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return fmtDate(iso);
}
const todayYMD = (offset = 0) => {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('en-CA');
};
const initials = (n) => String(n || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const addMin = (hhmm, m) => { const [h, mm] = hhmm.split(':').map(Number); const t = h * 60 + mm + m; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
const fmtHM = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`; };

const PURPOSE = { guest: 'Guest', delivery: 'Delivery', cab: 'Cab', service: 'Service / help', other: 'Other' };
const VSTATUS = {
  pending: ['Waiting for approval', 'warn'], inside: ['Inside', 'ok'], denied: ['Denied', 'bad'],
  left_at_gate: ['Left at gate', 'brand'], exited: ['Exited', ''],
};
const CSTATUS = { open: ['Open', 'warn'], in_progress: ['In progress', 'brand'], resolved: ['Resolved', 'ok'] };
const badge = ([label, kind]) => html`<span class="badge ${kind}">${label}</span>`;

const ICON = {
  home: '<path d="M3 11 12 4l9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  gate: '<path d="M4 21V8l8-5 8 5v13"/><path d="M9 21v-6h6v6"/>',
  chat: '<path d="M4 5h16v11H8l-4 4z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  wrench: '<path d="M14 6a4 4 0 0 0 5 5l-9 9-3-3 9-9a4 4 0 0 1-2-2z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
};
const icon = (n) => raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`);

// ---------- State & routing ----------
const state = { user: null, config: {}, flats: [], pendingCount: 0, refresh: null };

function go(path) { if (location.hash !== `#${path}`) location.hash = `#${path}`; else render(); }

const routes = [];
const route = (pattern, view, opts = {}) => routes.push({ re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), view, ...opts });

async function render() {
  const path = location.hash.slice(1) || '/';
  const r = routes.find((x) => x.re.test(path)) || routes.find((x) => x.re.test('/'));
  const params = path.match(r.re).groups || {};
  if (!r.public && !state.user) return go('/login');
  if (r.roles && !r.roles.includes(state.user.role)) return go('/');
  state.refresh = null;
  renderChrome(r.tab);
  const view = $('#view');
  try {
    const out = await r.view(params);
    if (out === undefined) return; // view redirected
    view.innerHTML = out.toString();
    view.querySelector('[autofocus]')?.focus();
  } catch (e) {
    view.innerHTML = html`<div class="card"><p class="error">${e.message}</p><button class="btn ghost" data-action="reload">Try again</button></div>`.toString();
  }
  if (!r.keepScroll) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', render);

function renderChrome(activeTab) {
  const u = state.user;
  $('#topbar').hidden = !u;
  $('#tabbar').hidden = !u;
  if (!u) return;
  $('#topbar-title').textContent = state.config.society || 'Gatepass';
  $('#topbar-sub').textContent = u.role === 'guard' ? `Security · ${u.name}` : `${u.name}${u.flat ? ` · ${u.flat}` : ''}${u.role === 'admin' ? ' · Committee' : ''}`;
  const tabs = u.role === 'guard'
    ? [['/guard', 'shield', 'Gate'], ['/guard/log', 'list', 'Log'], ['/community', 'chat', 'Notices'], ['/more', 'more', 'More']]
    : [['/', 'home', 'Home'], ['/gate', 'gate', 'Visitors'], ['/community', 'chat', 'Community'], ['/amenities', 'calendar', 'Amenities'], ['/more', 'more', 'More']];
  $('#tabbar').innerHTML = tabs.map(([href, ic, label]) => html`
    <a href="#${href}" class="${activeTab === href ? 'active' : ''}">${icon(ic)}${label}
      ${href === '/' && state.pendingCount ? html`<span class="dot">${state.pendingCount}</span>` : ''}</a>`).join('');
}

// ---------- Event delegation ----------
const actions = {};
const forms = {};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  e.preventDefault();
  const fn = actions[el.dataset.action];
  if (!fn) return;
  if (el.dataset.confirm && !confirm(el.dataset.confirm)) return;
  el.disabled = true;
  try { await fn(el.dataset, el); } catch (err) { toast(err.message, 'bad'); } finally { el.disabled = false; }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const fn = forms[form.dataset.form];
  const data = Object.fromEntries(new FormData(form));
  form.querySelectorAll('input[type=checkbox]').forEach((c) => { data[c.name] = c.checked; });
  const btn = form.querySelector('[type=submit]');
  const err = form.querySelector('.error');
  if (err) err.textContent = '';
  if (btn) btn.disabled = true;
  try { await fn(data, form); } catch (ex) { if (err) err.textContent = ex.message; else toast(ex.message, 'bad'); } finally { if (btn) btn.disabled = false; }
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el) actions[el.dataset.change]?.({ ...el.dataset, value: el.value }, el);
});

actions.reload = () => render();
actions.back = () => history.back();

// ---------- Live updates ----------
let events;
function connectEvents() {
  events?.close();
  events = new EventSource('/api/events');
  events.addEventListener('visitor', (e) => {
    const v = JSON.parse(e.data);
    if (state.user.role !== 'guard' && v.status === 'pending') {
      toast(`🔔 ${v.name} (${PURPOSE[v.purpose] || 'Visitor'}) is at the gate`);
      navigator.vibrate?.([200, 100, 200]);
    }
    if (state.user.role === 'guard' && v.decided_by_name && v.decided_by_name !== state.user.name && v.status !== 'exited') {
      toast(`${v.flat}: ${v.name} — ${VSTATUS[v.status][0]}`);
    }
    updatePendingCount().then(() => renderChrome(currentTab()));
    state.refresh?.();
  });
  for (const ev of ['post', 'comment', 'complaint', 'admin']) events.addEventListener(ev, () => state.refresh?.());
}
const currentTab = () => $('#tabbar a.active')?.getAttribute('href')?.slice(1);

async function updatePendingCount() {
  if (!state.user || state.user.role === 'guard' || !state.user.flat_id) { state.pendingCount = 0; return; }
  const list = await api('GET', '/visitors?scope=active&mine=1').catch(() => []);
  state.pendingCount = list.filter((v) => v.status === 'pending').length;
}

// Re-render just one region of the page (keeps forms the user is typing in intact).
async function refreshRegion(id, fn) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = (await fn()).toString();
}

// ---------- Auth ----------
route('/login', async () => html`
  <div class="auth">
    <img class="logo" src="/icons/icon.svg" alt="">
    <h1>${state.config.society || 'Gatepass'}</h1>
    <p class="center muted">Sign in to your society app</p>
    <form class="card" data-form="login">
      <label for="phone">Mobile number</label>
      <input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required autofocus>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <div class="error"></div>
      <button class="btn block lg" type="submit">Sign in</button>
    </form>
    <p class="center">New resident? <a href="#/register">Create an account</a></p>
    <p class="center small muted">Forgot your password? Ask the committee to reset it.</p>
  </div>`, { public: true });

forms.login = async (d) => {
  await api('POST', '/auth/login', d);
  await boot();
};

route('/register', async () => {
  const flats = await api('GET', '/flats');
  return html`
  <div class="auth">
    <h1>Create account</h1>
    <p class="center muted">The committee approves new accounts, usually within a day.</p>
    <form class="card" data-form="register">
      <label for="name">Your name</label>
      <input id="name" name="name" autocomplete="name" required maxlength="80">
      <label for="phone">Mobile number</label>
      <input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required>
      <label for="flat">Flat</label>
      <select id="flat" name="flat_id" required>
        <option value="">Select your flat…</option>
        ${flats.map((f) => html`<option value="${f.id}">${f.label}</option>`)}
      </select>
      <label for="password">Choose a password</label>
      <input id="password" name="password" type="password" autocomplete="new-password" minlength="6" required>
      <div class="error"></div>
      <button class="btn block lg" type="submit">Register</button>
    </form>
    <p class="center"><a href="#/login">Back to sign in</a></p>
  </div>`;
}, { public: true });

forms.register = async (d, form) => {
  const r = await api('POST', '/auth/register', d);
  form.outerHTML = html`<div class="card"><h3>Thanks!</h3><p>${r.message}</p><a class="btn block" href="#/login">Back to sign in</a></div>`.toString();
};

actions.logout = async () => {
  await disablePush().catch(() => {});
  await api('POST', '/auth/logout', {});
  state.user = null;
  events?.close();
  go('/login');
};

// ---------- Resident: Home ----------
function visitorCard(v, { resident = false, guard = false } = {}) {
  const isPending = v.status === 'pending';
  return html`
  <div class="card ${isPending && resident ? 'alert' : ''}">
    <div class="row top">
      <div class="avatar">${initials(v.name)}</div>
      <div class="grow">
        <div class="row between wrap">
          <span class="visitor-name">${v.name}</span>
          ${guard ? html`<span class="flat-tag">${v.flat}</span>` : badge(VSTATUS[v.status])}
        </div>
        <div class="meta">${PURPOSE[v.purpose] || v.purpose}${v.vehicle ? ` · ${v.vehicle}` : ''}${v.phone ? ` · ${v.phone}` : ''}${v.pass_id ? ' · Gate pass' : ''}</div>
        <div class="meta">${v.status === 'pending' ? `Arrived ${ago(v.created_at)}` : ''}
          ${v.in_at ? `In ${fmtTime(v.in_at)}` : ''}${v.out_at ? ` · Out ${fmtTime(v.out_at)}` : ''}
          ${v.decided_by_name && v.status !== 'pending' ? ` · by ${v.decided_by_name}` : ''}</div>
        ${guard ? html`<div class="meta">${badge(VSTATUS[v.status])}</div>` : ''}
      </div>
    </div>
    ${resident && isPending ? html`
      <div class="btns">
        <button class="btn ok" data-action="decide" data-id="${v.id}" data-decision="approve">Allow in</button>
        <button class="btn bad" data-action="decide" data-id="${v.id}" data-decision="deny">Deny</button>
        ${v.purpose === 'delivery' ? html`<button class="btn soft" data-action="decide" data-id="${v.id}" data-decision="leave_at_gate">Leave at gate</button>` : ''}
      </div>` : ''}
    ${guard ? guardButtons(v) : ''}
  </div>`;
}

actions.decide = async ({ id, decision }) => {
  await api('POST', `/visitors/${id}/decision`, { decision });
  toast(decision === 'approve' ? 'Allowed in' : decision === 'deny' ? 'Denied' : 'Security will keep it at the gate');
  await updatePendingCount();
  render();
};

async function homeActive() {
  const active = await api('GET', '/visitors?scope=active&mine=1');
  state.pendingCount = active.filter((v) => v.status === 'pending').length;
  if (!active.length) return html`<div class="card empty">No visitors right now.</div>`;
  return raw(active.map((v) => visitorCard(v, { resident: true })).join(''));
}

route('/', async () => {
  if (state.user.role === 'guard') return go('/guard');
  if (!state.user.flat_id) return go('/admin');
  const [active, posts, bookings] = await Promise.all([
    homeActive(), api('GET', '/posts?kind=notice'), api('GET', '/bookings'),
  ]);
  state.refresh = () => refreshRegion('home-active', homeActive).then(() => renderChrome('/'));
  return html`
    <div class="quick">
      <a href="#/gate/invite">${icon('key')}Invite guest</a>
      <a href="#/amenities">${icon('calendar')}Book amenity</a>
      <a href="#/helpdesk">${icon('wrench')}Raise issue</a>
    </div>
    <h2>At the gate</h2>
    <div id="home-active">${active}</div>
    ${bookings.length ? html`<h2>Your bookings</h2><div class="card"><ul class="list">
      ${bookings.slice(0, 3).map((b) => html`<li class="row between"><span><span class="title">${b.amenity}</span><br><span class="meta">${fmtDay(b.date)} · ${fmtHM(b.start_time)}–${fmtHM(addMin(b.start_time, b.slot_minutes))}</span></span></li>`)}
    </ul></div>` : ''}
    <h2>Notices</h2>
    ${posts.length ? posts.slice(0, 3).map(postCard) : html`<div class="card empty">No notices yet.</div>`}
    ${posts.length > 3 ? html`<p class="center"><a href="#/community">All notices</a></p>` : ''}`;
}, { tab: '/', keepScroll: false });

// ---------- Resident: Visitors / gate passes ----------
route('/gate', async () => {
  const [passes, log] = await Promise.all([api('GET', '/passes'), api('GET', `/visitors?days=7&mine=1`)]);
  return html`
    <div class="row between"><h1>Visitors</h1><a class="btn sm" href="#/gate/invite">${icon('plus')} Invite guest</a></div>
    ${passes.length ? html`<h2>Gate passes</h2>${passes.map(passCard)}` : ''}
    <h2>Last 7 days</h2>
    ${log.length ? html`<div class="card"><ul class="list">${log.map((v) => html`
      <li class="row">
        <div class="grow"><div class="title">${v.name}</div>
          <div class="meta">${PURPOSE[v.purpose]} · ${fmtDate(v.created_at)} ${fmtTime(v.in_at || v.created_at)}${v.out_at ? `–${fmtTime(v.out_at)}` : ''}</div></div>
        ${badge(VSTATUS[v.status])}
      </li>`)}</ul></div>` : html`<div class="card empty">No visitors in the last week.</div>`}`;
}, { tab: '/gate' });

function passCard(p) {
  return html`
  <div class="card">
    <div class="row between top">
      <div><div class="title">${p.guest_name}</div><div class="meta">${p.valid_date === todayYMD() ? 'Today' : fmtDay(p.valid_date)}</div></div>
      ${p.used_at ? badge(['Used', 'ok']) : html`<span class="passcode">${p.code}</span>`}
    </div>
    ${p.used_at ? '' : html`<div class="btns">
      <button class="btn sm" data-action="sharePass" data-code="${p.code}" data-name="${p.guest_name}" data-date="${p.valid_date}">Share</button>
      <button class="btn sm ghost" data-action="cancelPass" data-id="${p.id}" data-confirm="Cancel this gate pass?">Cancel</button>
    </div>`}
  </div>`;
}

route('/gate/invite', async () => html`
  <h1>Invite a guest</h1>
  <p class="muted">Your guest shows this 6-digit code at the gate and walks straight in. No call needed.</p>
  <form class="card" data-form="invite">
    <label for="g">Guest name</label>
    <input id="g" name="guest_name" required maxlength="80" autofocus>
    <label for="d">Date of visit</label>
    <input id="d" name="valid_date" type="date" value="${todayYMD()}" min="${todayYMD()}" max="${todayYMD(30)}" required>
    <div class="hint">Code works once, on this date only.</div>
    <div class="error"></div>
    <button class="btn block lg" type="submit">Create gate pass</button>
  </form>
  <div id="new-pass"></div>`, { tab: '/gate' });

forms.invite = async (d, form) => {
  const p = await api('POST', '/passes', d);
  form.reset();
  $('#d', form).value = todayYMD();
  $('#new-pass').innerHTML = html`<h2>Pass created</h2>${passCard(p)}`.toString();
};

actions.sharePass = async ({ code, name, date }) => {
  const when = date === todayYMD() ? 'today' : `on ${fmtDay(date)}`;
  const text = `Hi ${name}, your gate pass for ${state.config.society || 'our society'} (${state.user.flat}) ${when} is ${code}. Show this code to security at the gate.`;
  if (navigator.share) {
    await navigator.share({ text }).catch(() => {});
  } else {
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  }
};

actions.cancelPass = async ({ id }) => { await api('DELETE', `/passes/${id}`); toast('Pass cancelled'); render(); };

// ---------- Community ----------
function postCard(p) {
  return html`
  <a class="card card-link" href="#/post/${p.id}">
    <div class="row between wrap">
      <span class="title">${p.pinned ? '📌 ' : ''}${p.title}</span>
      ${p.kind === 'notice' ? badge(['Notice', 'brand']) : ''}
    </div>
    <p class="muted small pre">${p.excerpt}${p.excerpt?.length >= 280 ? '…' : ''}</p>
    <div class="meta">${p.author}${p.flat ? ` · ${p.flat}` : ''} · ${ago(p.created_at)}${p.kind === 'discussion' ? ` · ${p.comments} ${p.comments === 1 ? 'reply' : 'replies'}` : ''}</div>
  </a>`;
}

route('/community', async () => go('/community/notice'), { tab: '/community' });
route('/community/:kind', async ({ kind }) => {
  const posts = await api('GET', `/posts?kind=${kind === 'discussion' ? 'discussion' : 'notice'}`);
  const canPost = state.user.role !== 'guard' && (kind === 'discussion' || state.user.role === 'admin');
  state.refresh = () => render();
  return html`
    <h1>Community</h1>
    <div class="seg">
      <a href="#/community/notice" class="${kind === 'notice' ? 'active' : ''}">Notices</a>
      ${state.user.role === 'guard' ? '' : html`<a href="#/community/discussion" class="${kind === 'discussion' ? 'active' : ''}">Discussions</a>`}
    </div>
    ${posts.length ? posts.map(postCard) : html`<div class="card empty">${kind === 'notice' ? 'No notices yet.' : 'No discussions yet. Start one!'}</div>`}
    ${canPost ? html`<a class="btn fab" href="#/new-post/${kind}">${icon('plus')} New ${kind === 'notice' ? 'notice' : 'post'}</a>` : ''}`;
}, { tab: '/community' });

route('/new-post/:kind', async ({ kind }) => html`
  <h1>${kind === 'notice' ? 'New notice' : 'Start a discussion'}</h1>
  <form class="card" data-form="post">
    <input type="hidden" name="kind" value="${kind}">
    <label for="t">Title</label>
    <input id="t" name="title" required maxlength="150" autofocus>
    <label for="b">Message</label>
    <textarea id="b" name="body" required maxlength="5000" rows="6"></textarea>
    ${state.user.role === 'admin' ? html`<label class="check"><input type="checkbox" name="pinned"> Pin to top</label>` : ''}
    ${kind === 'notice' ? html`<p class="hint">Everyone gets a notification for notices.</p>` : ''}
    <div class="error"></div>
    <button class="btn block lg" type="submit">Post</button>
  </form>`, { tab: '/community', roles: ['resident', 'admin'] });

forms.post = async (d) => { const r = await api('POST', '/posts', d); go(`/post/${r.id}`); };

route('/post/:id', async ({ id }) => {
  const p = await api('GET', `/posts/${id}`);
  const mine = (uid) => uid === state.user.id || state.user.role === 'admin';
  state.refresh = async () => { if (document.activeElement?.name !== 'body') render(); };
  return html`
    <p><a href="#/community/${p.kind}">← ${p.kind === 'notice' ? 'Notices' : 'Discussions'}</a></p>
    <div class="card">
      <div class="row between wrap"><h1>${p.title}</h1>${p.kind === 'notice' ? badge(['Notice', 'brand']) : ''}</div>
      <div class="meta">${p.author}${p.flat ? ` · ${p.flat}` : ''}${p.author_role === 'admin' ? ' · Committee' : ''} · ${fmtDate(p.created_at)} ${fmtTime(p.created_at)}</div>
      <p class="pre">${p.body}</p>
      <div class="btns">
        ${state.user.role === 'admin' ? html`<button class="btn sm soft" data-action="pin" data-id="${p.id}" data-pinned="${p.pinned ? '' : '1'}">${p.pinned ? 'Unpin' : 'Pin to top'}</button>` : ''}
        ${mine(p.user_id) ? html`<button class="btn sm ghost" data-action="deletePost" data-id="${p.id}" data-kind="${p.kind}" data-confirm="Delete this post?">Delete</button>` : ''}
      </div>
    </div>
    ${p.kind === 'discussion' || p.comments.length ? html`
      <h2>${p.comments.length} ${p.comments.length === 1 ? 'reply' : 'replies'}</h2>
      ${p.comments.map((c) => html`
        <div class="card">
          <div class="row between"><span class="title">${c.author}${c.flat ? html` <span class="meta">· ${c.flat}</span>` : ''}</span><span class="meta">${ago(c.created_at)}</span></div>
          <p class="pre">${c.body}</p>
          ${mine(c.user_id) ? html`<button class="linkbtn small" data-action="deleteComment" data-id="${c.id}" data-confirm="Delete this reply?">Delete</button>` : ''}
        </div>`)}` : ''}
    ${state.user.role !== 'guard' ? html`
      <form class="card" data-form="comment">
        <input type="hidden" name="post_id" value="${p.id}">
        <label for="c">Reply</label>
        <textarea id="c" name="body" required maxlength="2000" rows="3"></textarea>
        <div class="error"></div>
        <button class="btn block" type="submit">Send reply</button>
      </form>` : ''}`;
}, { tab: '/community' });

forms.comment = async (d) => { await api('POST', `/posts/${d.post_id}/comments`, { body: d.body }); render(); };
actions.deletePost = async ({ id, kind }) => { await api('DELETE', `/posts/${id}`); toast('Deleted'); go(`/community/${kind}`); };
actions.deleteComment = async ({ id }) => { await api('DELETE', `/comments/${id}`); render(); };
actions.pin = async ({ id, pinned }) => { await api('PATCH', `/posts/${id}`, { pinned: Boolean(pinned) }); render(); };

// ---------- Amenities ----------
route('/amenities', async () => {
  const [list, mine] = await Promise.all([api('GET', '/amenities'), api('GET', '/bookings')]);
  return html`
    <h1>Amenities</h1>
    ${list.length ? list.map((a) => html`
      <a class="card card-link" href="#/amenity/${a.id}">
        <div class="row between"><span class="title">${a.name}</span><span class="meta">›</span></div>
        ${a.description ? html`<p class="muted small">${a.description}</p>` : ''}
        <div class="meta">${fmtHM(a.open_time)}–${fmtHM(a.close_time)} · ${a.slot_minutes} min slots</div>
      </a>`) : html`<div class="card empty">The committee hasn't added any amenities yet.</div>`}
    <h2>Your upcoming bookings</h2>
    ${mine.length ? html`<div class="card"><ul class="list">${mine.map((b) => html`
      <li class="row">
        <div class="grow"><div class="title">${b.amenity}</div>
          <div class="meta">${fmtDay(b.date)} · ${fmtHM(b.start_time)}–${fmtHM(addMin(b.start_time, b.slot_minutes))} · by ${b.user_name}</div></div>
        <button class="btn sm ghost" data-action="cancelBooking" data-id="${b.id}" data-confirm="Cancel this booking?">Cancel</button>
      </li>`)}</ul></div>` : html`<div class="card empty">No upcoming bookings.</div>`}`;
}, { tab: '/amenities' });

route('/amenity/:id', async ({ id }) => {
  const date = sessionStorage.getItem(`amenity-date-${id}`) || todayYMD();
  const data = await api('GET', `/amenities/${id}/slots?date=${date}`);
  const a = data.amenity;
  const days = Array.from({ length: a.max_days_ahead + 1 }, (_, i) => todayYMD(i));
  state.refresh = () => render();
  return html`
    <p><a href="#/amenities">← Amenities</a></p>
    <h1>${a.name}</h1>
    ${a.description ? html`<p class="muted">${a.description}</p>` : ''}
    <div class="chips">${days.map((d) => {
      const dt = new Date(`${d}T00:00:00`);
      return html`<button class="chip ${d === date ? 'active' : ''}" data-action="pickDate" data-id="${a.id}" data-date="${d}">
        ${d === todayYMD() ? 'Today' : dt.toLocaleDateString('en-IN', { weekday: 'short' })}<b>${dt.getDate()}</b></button>`;
    })}</div>
    <div class="slots">${data.slots.map((s) => {
      const cls = s.mine ? 'mine' : s.booked ? 'taken' : s.past ? 'past' : 'free';
      const label = s.mine ? 'Your booking · tap to cancel' : s.booked ? `Booked${s.flat && state.user.role === 'admin' ? ` · ${s.flat}` : ''}` : s.past ? 'Past' : 'Available';
      const act = s.mine || (s.booked && state.user.role === 'admin' && s.booking_id) ? 'cancelBooking' : !s.booked && !s.past ? 'book' : '';
      return html`<button class="slot ${cls}" ${raw(act ? `data-action="${act}"` : 'disabled')}
        data-id="${s.booking_id || ''}" data-amenity="${a.id}" data-date="${date}" data-start="${s.start}"
        ${raw(act === 'cancelBooking' ? 'data-confirm="Cancel this booking?"' : '')}>
        <strong>${fmtHM(s.start)} – ${fmtHM(s.end)}</strong><small>${label}</small></button>`;
    })}</div>
    <p class="hint">One slot per flat per day. Bookings open ${a.max_days_ahead} days ahead.</p>`;
}, { tab: '/amenities', keepScroll: true });

actions.pickDate = ({ id, date }) => { sessionStorage.setItem(`amenity-date-${id}`, date); render(); };
actions.book = async ({ amenity, date, start }) => {
  if (!confirm(`Book ${fmtDay(date)} at ${fmtHM(start)}?`)) return;
  await api('POST', '/bookings', { amenity_id: Number(amenity), date, start_time: start });
  toast('Booked!');
  render();
};
actions.cancelBooking = async ({ id }) => { await api('DELETE', `/bookings/${id}`); toast('Booking cancelled'); render(); };

// ---------- Helpdesk ----------
route('/helpdesk', async () => {
  const [cats, list] = await Promise.all([api('GET', '/complaints/categories'), api('GET', '/complaints')]);
  return html`
    <h1>Helpdesk</h1>
    <form class="card" data-form="complaint">
      <label for="cat">What's the problem?</label>
      <select id="cat" name="category">${cats.map((c) => html`<option>${c}</option>`)}</select>
      <label for="desc">Details</label>
      <textarea id="desc" name="description" required maxlength="2000" rows="3" placeholder="e.g. Kitchen tap leaking since morning"></textarea>
      <div class="error"></div>
      <button class="btn block" type="submit">Send to committee</button>
    </form>
    <h2>Your flat's requests</h2>
    ${list.length ? list.map(complaintCard) : html`<div class="card empty">Nothing raised yet.</div>`}`;
}, { tab: '/more', roles: ['resident', 'admin'] });

function complaintCard(c, admin = false) {
  return html`
  <div class="card">
    <div class="row between wrap"><span class="title">${c.category}${admin && c.flat ? ` · ${c.flat}` : ''}</span>${badge(CSTATUS[c.status])}</div>
    <p class="pre">${c.description}</p>
    ${c.admin_note ? html`<p class="small"><b>Committee:</b> ${c.admin_note}</p>` : ''}
    <div class="meta">${c.user_name} · ${fmtDate(c.created_at)}</div>
    ${admin ? html`
      <form data-form="updateComplaint" class="stack">
        <input type="hidden" name="id" value="${c.id}">
        <div class="grid2">
          <select name="status" aria-label="Status">${Object.entries(CSTATUS).map(([k, [l]]) => html`<option value="${k}" ${raw(k === c.status ? 'selected' : '')}>${l}</option>`)}</select>
          <button class="btn sm" type="submit">Update</button>
        </div>
        <input name="admin_note" placeholder="Note to resident (optional)" value="${c.admin_note || ''}" maxlength="1000">
      </form>` : ''}
  </div>`;
}

forms.complaint = async (d, form) => { await api('POST', '/complaints', d); form.reset(); toast('Sent to the committee'); render(); };

// ---------- More / account ----------
route('/more', async () => {
  const pushOk = 'serviceWorker' in navigator && 'PushManager' in window && state.config.pushKey;
  const sub = pushOk ? await navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).catch(() => null) : null;
  const isIOS = /iphone|ipad/i.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return html`
    <h1>More</h1>
    <div class="card"><ul class="list">
      ${state.user.role !== 'guard' ? html`<li><a class="row card-link" href="#/helpdesk">${icon('wrench')}<span class="grow title">Helpdesk</span>›</a></li>` : ''}
      ${state.user.role === 'admin' ? html`<li><a class="row card-link" href="#/admin">${icon('shield')}<span class="grow title">Committee admin</span>›</a></li>` : ''}
    </ul></div>
    <h2>Notifications</h2>
    <div class="card">
      ${!state.config.pushKey ? html`<p class="muted small">Phone notifications aren't set up on this server yet. You'll still see alerts while the app is open.</p>`
        : isIOS && !standalone ? html`<p class="small">On iPhone, first tap <b>Share → Add to Home Screen</b>, then open Gatepass from your home screen to turn on notifications.</p>`
        : !pushOk ? html`<p class="muted small">This browser doesn't support notifications.</p>`
        : sub ? html`<p class="small">✅ Notifications are on for this device.</p><button class="btn sm ghost" data-action="pushOff">Turn off</button>`
        : html`<p class="small">Get alerted when a visitor is at the gate, even when the app is closed.</p><button class="btn" data-action="pushOn">Turn on notifications</button>`}
    </div>
    <h2>Account</h2>
    <div class="card">
      <div class="title">${state.user.name}</div>
      <div class="meta">${state.user.phone}${state.user.flat ? ` · ${state.user.flat}` : ''} · ${state.user.role === 'admin' ? 'Committee' : state.user.role === 'guard' ? 'Security' : 'Resident'}</div>
      <form data-form="password">
        <label for="cur">Current password</label>
        <input id="cur" name="current" type="password" autocomplete="current-password" required>
        <label for="np">New password</label>
        <input id="np" name="password" type="password" autocomplete="new-password" minlength="6" required>
        <div class="error"></div>
        <button class="btn soft block" type="submit">Change password</button>
      </form>
    </div>
    <button class="btn ghost block" data-action="logout">Sign out</button>
    ${!standalone ? html`<p class="hint center">Tip: add Gatepass to your home screen for one-tap access.</p>` : ''}`;
}, { tab: '/more' });

forms.password = async (d, form) => { await api('POST', '/me/password', d); form.reset(); toast('Password changed'); };

function urlB64ToUint8(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
actions.pushOn = async () => {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications were blocked. Allow them in your browser settings.');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(state.config.pushKey) });
  await api('POST', '/push/subscribe', sub.toJSON());
  toast('Notifications on');
  render();
};
async function disablePush() {
  const reg = await navigator.serviceWorker?.ready;
  const sub = await reg?.pushManager?.getSubscription();
  if (sub) { await api('POST', '/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
}
actions.pushOff = async () => { await disablePush(); toast('Notifications off'); render(); };

// ---------- Guard console ----------
function guardButtons(v) {
  if (v.status === 'pending') {
    return html`<div class="btns">
      <button class="btn soft" data-action="callFlat" data-flat="${v.flat_id}">📞 Call resident</button>
      <button class="btn ok" data-action="guardStatus" data-id="${v.id}" data-act="allow" data-confirm="Resident approved on phone? Allow ${v.name} in.">Allow</button>
      <button class="btn bad" data-action="guardStatus" data-id="${v.id}" data-act="deny" data-confirm="Send ${v.name} away?">Deny</button>
    </div>`;
  }
  if (v.status === 'inside') return html`<div class="btns"><button class="btn lg" data-action="guardStatus" data-id="${v.id}" data-act="exit">Mark exit</button></div>`;
  if (v.status === 'left_at_gate') return html`<div class="btns"><button class="btn" data-action="guardStatus" data-id="${v.id}" data-act="exit">Collected by resident</button></div>`;
  return '';
}

async function guardLists() {
  const active = await api('GET', '/visitors?scope=active');
  const group = (s) => active.filter((v) => v.status === s);
  const section = (title, list, empty) => html`<h2>${title} ${list.length ? html`<span class="badge">${list.length}</span>` : ''}</h2>
    ${list.length ? list.map((v) => visitorCard(v, { guard: true })) : html`<div class="card empty">${empty}</div>`}`;
  return html`
    ${section('Waiting for approval', group('pending'), 'Nobody waiting.')}
    ${section('Parcels at gate', group('left_at_gate'), 'No parcels.')}
    ${section('Inside now', group('inside'), 'No visitors inside.')}`;
}

route('/guard', async () => {
  if (!state.flats.length) state.flats = await api('GET', '/flats');
  const lists = await guardLists();
  state.refresh = () => refreshRegion('guard-lists', guardLists);
  const mode = sessionStorage.getItem('guard-mode') || 'new';
  return html`
  <div class="guard">
    <div class="seg">
      <button class="${mode === 'new' ? 'active' : ''}" data-action="guardMode" data-mode="new">New visitor</button>
      <button class="${mode === 'code' ? 'active' : ''}" data-action="guardMode" data-mode="code">Gate pass code</button>
    </div>
    ${mode === 'new' ? html`
    <form class="card" data-form="newVisitor" autocomplete="off">
      <label for="flat">Flat</label>
      <input id="flat" name="flat" list="flatlist" required placeholder="e.g. A-101" autocapitalize="characters">
      <datalist id="flatlist">${state.flats.map((f) => html`<option value="${f.label}">`)}</datalist>
      <label for="vname">Visitor name</label>
      <input id="vname" name="name" required maxlength="80">
      <label>Purpose</label>
      <div class="chips wrap" role="radiogroup">
        ${Object.entries(PURPOSE).map(([k, l], i) => html`<label class="check chip"><input type="radio" name="purpose" value="${k}" ${raw(i === 0 ? 'checked' : '')}> ${l}</label>`)}
      </div>
      <div class="grid2">
        <div><label for="vphone">Phone (optional)</label><input id="vphone" name="phone" type="tel" inputmode="tel"></div>
        <div><label for="veh">Vehicle no. (optional)</label><input id="veh" name="vehicle" autocapitalize="characters"></div>
      </div>
      <div class="error"></div>
      <button class="btn block lg" type="submit">Send for approval</button>
    </form>` : html`
    <form class="card" data-form="verifyPass" autocomplete="off">
      <label for="code">6-digit code from the guest</label>
      <input id="code" name="code" class="code-input" inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus>
      <label for="veh2">Vehicle no. (optional)</label>
      <input id="veh2" name="vehicle" autocapitalize="characters">
      <div class="error"></div>
      <button class="btn block lg" type="submit">Verify & let in</button>
    </form>`}
    <div id="guard-lists">${lists}</div>
  </div>`;
}, { tab: '/guard', roles: ['guard', 'admin'] });

actions.guardMode = ({ mode }) => { sessionStorage.setItem('guard-mode', mode); render(); };

forms.newVisitor = async (d, form) => {
  const flat = state.flats.find((f) => f.label.toLowerCase() === d.flat.trim().toLowerCase());
  if (!flat) throw new Error(`No flat called "${d.flat}". Pick one from the list.`);
  const v = await api('POST', '/visitors', { ...d, flat_id: flat.id });
  form.reset();
  if (v.residents_on_app === 0) {
    toast(`${flat.label} has nobody on the app — please call them.`, 'bad');
    actions.callFlat({ flat: flat.id });
  } else {
    toast(`Sent to ${flat.label}. Waiting for approval…`);
  }
  refreshRegion('guard-lists', guardLists);
};

forms.verifyPass = async (d, form) => {
  const v = await api('POST', '/passes/verify', d);
  form.reset();
  toast(`✅ Valid: ${v.name} for ${v.flat}. Let them in.`);
  refreshRegion('guard-lists', guardLists);
};

actions.guardStatus = async ({ id, act }) => {
  await api('POST', `/visitors/${id}/status`, { action: act });
  refreshRegion('guard-lists', guardLists);
};

actions.callFlat = async ({ flat }) => {
  const contacts = await api('GET', `/flats/${flat}/contacts`);
  if (!contacts.length) return toast('No phone numbers registered for this flat.', 'bad');
  if (contacts.length === 1) { location.href = `tel:${contacts[0].phone}`; return; }
  const dlg = document.createElement('div');
  dlg.className = 'toast';
  dlg.innerHTML = html`<div class="stack">${contacts.map((c) => html`<a class="btn block" href="tel:${c.phone}">📞 ${c.name}</a>`)}
    <button class="btn ghost block" data-action="closeToast">Close</button></div>`.toString();
  $('#toasts').append(dlg);
};
actions.closeToast = (_, el) => el.closest('.toast').remove();

route('/guard/log', async () => {
  const date = sessionStorage.getItem('log-date') || todayYMD();
  const q = sessionStorage.getItem('log-q') || '';
  const list = await api('GET', `/visitors?date=${date}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  return html`
    <h1>Visitor log</h1>
    <div class="grid2">
      <input type="date" value="${date}" max="${todayYMD()}" data-change="logDate" aria-label="Date">
      <input type="search" value="${q}" placeholder="Search name, flat, vehicle" data-change="logQ" aria-label="Search">
    </div>
    <p class="meta">${list.length} entries</p>
    ${list.length ? html`<div class="card"><ul class="list">${list.map((v) => html`
      <li class="row top">
        <div class="grow">
          <div class="title">${v.name} <span class="flat-tag">· ${v.flat}</span></div>
          <div class="meta">${PURPOSE[v.purpose]}${v.vehicle ? ` · ${v.vehicle}` : ''}${v.phone ? ` · ${v.phone}` : ''}</div>
          <div class="meta">Logged ${fmtTime(v.created_at)}${v.in_at ? ` · In ${fmtTime(v.in_at)}` : ''}${v.out_at ? ` · Out ${fmtTime(v.out_at)}` : ''}${v.logged_by_name ? ` · ${v.logged_by_name}` : ''}</div>
        </div>
        ${badge(VSTATUS[v.status])}
      </li>`)}</ul></div>` : html`<div class="card empty">No entries.</div>`}`;
}, { tab: '/guard/log', roles: ['guard', 'admin'] });

actions.logDate = ({ value }) => { sessionStorage.setItem('log-date', value); render(); };
actions.logQ = ({ value }) => { sessionStorage.setItem('log-q', value); render(); };

// ---------- Admin ----------
const ADMIN_TABS = [['', 'Overview'], ['users', 'People'], ['flats', 'Flats'], ['amenities', 'Amenities'], ['complaints', 'Helpdesk'], ['bookings', 'Bookings']];
const adminNav = (cur) => html`<div class="seg">${ADMIN_TABS.map(([k, l]) => html`<a href="#/admin${k ? `/${k}` : ''}" class="${cur === k ? 'active' : ''}">${l}</a>`)}</div>`;

route('/admin', async () => {
  const [s, pending] = await Promise.all([api('GET', '/admin/summary'), api('GET', '/admin/users?status=pending')]);
  state.refresh = () => render();
  return html`
    <h1>Committee admin</h1>
    ${adminNav('')}
    <div class="stats">
      <a class="stat" href="#/admin/flats"><b>${s.flats_on_app}/${s.flats}</b><span>Flats on the app</span></a>
      <a class="stat" href="#/admin/users"><b>${s.residents}</b><span>Active members</span></a>
      <a class="stat" href="#/guard"><b>${s.visitors_inside}</b><span>Visitors inside</span></a>
      <a class="stat" href="#/admin/complaints"><b>${s.open_complaints}</b><span>Open issues</span></a>
      <a class="stat" href="#/admin/bookings"><b>${s.bookings_today}</b><span>Bookings today</span></a>
    </div>
    <h2>Waiting for approval ${pending.length ? html`<span class="badge warn">${pending.length}</span>` : ''}</h2>
    ${pending.length ? pending.map((u) => html`
      <div class="card">
        <div class="row between"><div><div class="title">${u.name} · ${u.flat}</div><div class="meta">${u.phone} · signed up ${ago(u.created_at)}</div></div></div>
        <div class="btns">
          <button class="btn ok" data-action="userSet" data-id="${u.id}" data-status="active">Approve</button>
          <button class="btn ghost" data-action="rejectUser" data-id="${u.id}" data-confirm="Reject ${u.name}'s sign-up?">Reject</button>
        </div>
      </div>`) : html`<div class="card empty">No pending sign-ups.</div>`}
    ${s.flats === 0 ? html`<div class="card alert"><b>Start here:</b> add your society's flats under <a href="#/admin/flats">Flats</a>, then add guards under <a href="#/admin/users">People</a>.</div>` : ''}
    <h2>Quick links</h2>
    <div class="btns">
      <a class="btn soft" href="#/new-post/notice">Post a notice</a>
      <a class="btn soft" href="#/guard">Gate console</a>
      <a class="btn soft" href="#/guard/log">Visitor log</a>
    </div>`;
}, { tab: '/more', roles: ['admin'] });

actions.userSet = async ({ id, ...rest }) => {
  const body = {};
  for (const k of ['status', 'role']) if (rest[k]) body[k] = rest[k];
  await api('PATCH', `/admin/users/${id}`, body);
  toast('Saved');
  render();
};
actions.rejectUser = async ({ id }) => { await api('DELETE', `/admin/users/${id}`); toast('Rejected'); render(); };
actions.resetPw = async ({ id, name }) => {
  const r = await api('POST', `/admin/users/${id}/reset-password`, {});
  alert(`New temporary password for ${name}:\n\n${r.password}\n\nShare it with them privately. They can change it under More → Account.`);
};

route('/admin/users', async () => {
  const [users, flats] = await Promise.all([api('GET', '/admin/users'), api('GET', '/flats')]);
  const q = (sessionStorage.getItem('user-q') || '').toLowerCase();
  const shown = users.filter((u) => !q || `${u.name} ${u.phone} ${u.flat || ''} ${u.role}`.toLowerCase().includes(q));
  const roleLabel = { resident: 'Resident', guard: 'Security', admin: 'Committee' };
  return html`
    <h1>People</h1>
    ${adminNav('users')}
    <details class="card">
      <summary class="title">＋ Add resident, guard or committee member</summary>
      <form data-form="addUser">
        <label for="un">Name</label><input id="un" name="name" required maxlength="80">
        <label for="up">Mobile number</label><input id="up" name="phone" type="tel" required>
        <div class="grid2">
          <div><label for="ur">Role</label><select id="ur" name="role"><option value="resident">Resident</option><option value="guard">Security guard</option><option value="admin">Committee</option></select></div>
          <div><label for="uf">Flat</label><select id="uf" name="flat_id"><option value="">— none —</option>${flats.map((f) => html`<option value="${f.id}">${f.label}</option>`)}</select></div>
        </div>
        <p class="hint">A temporary password is generated for you to share.</p>
        <div class="error"></div>
        <button class="btn block" type="submit">Add</button>
      </form>
    </details>
    <input type="search" placeholder="Search name, phone, flat…" value="${q}" data-change="userQ" aria-label="Search people">
    <p class="meta">${shown.length} people</p>
    <div class="card"><ul class="list">${shown.map((u) => html`
      <li>
        <div class="row between wrap">
          <div><span class="title">${u.name}</span> <span class="meta">${u.flat || ''}</span><div class="meta">${u.phone} · ${roleLabel[u.role]}</div></div>
          ${u.status === 'active' ? '' : badge([u.status === 'pending' ? 'Pending' : 'Disabled', u.status === 'pending' ? 'warn' : 'bad'])}
        </div>
        <div class="btns">
          ${u.status === 'pending' ? html`<button class="btn sm ok" data-action="userSet" data-id="${u.id}" data-status="active">Approve</button>`
            : u.status === 'active' ? html`<button class="btn sm ghost" data-action="userSet" data-id="${u.id}" data-status="disabled" data-confirm="Disable ${u.name}? They will be signed out.">Disable</button>`
            : html`<button class="btn sm soft" data-action="userSet" data-id="${u.id}" data-status="active">Re-enable</button>`}
          ${u.status !== 'pending' ? html`<button class="btn sm ghost" data-action="resetPw" data-id="${u.id}" data-name="${u.name}" data-confirm="Reset ${u.name}'s password?">Reset password</button>` : ''}
          ${u.role === 'resident' && u.status === 'active' ? html`<button class="btn sm ghost" data-action="userSet" data-id="${u.id}" data-role="admin" data-confirm="Make ${u.name} a committee admin?">Make admin</button>` : ''}
          ${u.role === 'admin' && u.id !== state.user.id && u.flat_id ? html`<button class="btn sm ghost" data-action="userSet" data-id="${u.id}" data-role="resident" data-confirm="Remove admin rights from ${u.name}?">Remove admin</button>` : ''}
        </div>
      </li>`)}</ul></div>`;
}, { tab: '/more', roles: ['admin'] });

actions.userQ = ({ value }) => { sessionStorage.setItem('user-q', value); render(); };
forms.addUser = async (d) => {
  const r = await api('POST', '/admin/users', d);
  alert(`${d.name} added.\n\nTemporary password: ${r.password}\n\nShare it with them privately along with the app link.`);
  render();
};

route('/admin/flats', async () => {
  const flats = await api('GET', '/admin/flats');
  return html`
    <h1>Flats</h1>
    ${adminNav('flats')}
    <form class="card" data-form="addFlats">
      <label for="labels">Add flats</label>
      <textarea id="labels" name="labels" rows="4" required placeholder="One per line or comma-separated. Ranges work too:&#10;A-101..A-110&#10;B-201..B-210"></textarea>
      <p class="hint">Use the same format residents will recognise, e.g. A-101. Duplicates are skipped.</p>
      <div class="error"></div>
      <button class="btn block" type="submit">Add flats</button>
    </form>
    <p class="meta">${flats.length} flats · ${flats.filter((f) => f.members).length} with members on the app</p>
    <div class="card"><ul class="list">${flats.map((f) => html`
      <li class="row between"><span><span class="title">${f.label}</span> <span class="meta">${f.members ? `${f.members} member${f.members > 1 ? 's' : ''}` : 'Not on app'}</span></span>
        ${f.members ? '' : html`<button class="linkbtn small" data-action="deleteFlat" data-id="${f.id}" data-confirm="Delete flat ${f.label}?">Delete</button>`}</li>`)}</ul></div>`;
}, { tab: '/more', roles: ['admin'] });

forms.addFlats = async (d) => { const r = await api('POST', '/admin/flats', d); toast(`Added ${r.added}${r.skipped ? `, skipped ${r.skipped} duplicates` : ''}`); render(); };
actions.deleteFlat = async ({ id }) => { await api('DELETE', `/admin/flats/${id}`); render(); };

route('/admin/amenities', async () => {
  const list = await api('GET', '/amenities?all=1');
  const form = (a = {}) => html`
    <form data-form="saveAmenity">
      <input type="hidden" name="id" value="${a.id || ''}">
      <label>Name</label><input name="name" required maxlength="60" value="${a.name || ''}" placeholder="e.g. Clubhouse, Badminton court">
      <label>Description / rules</label><input name="description" maxlength="500" value="${a.description || ''}">
      <div class="grid2">
        <div><label>Opens</label><input type="time" name="open_time" required value="${a.open_time || '06:00'}"></div>
        <div><label>Closes</label><input type="time" name="close_time" required value="${a.close_time || '22:00'}"></div>
        <div><label>Slot length (min)</label><input type="number" name="slot_minutes" min="15" max="720" step="15" required value="${a.slot_minutes || 60}"></div>
        <div><label>Book up to (days ahead)</label><input type="number" name="max_days_ahead" min="0" max="90" required value="${a.max_days_ahead ?? 7}"></div>
      </div>
      <label class="check"><input type="checkbox" name="active" ${raw(a.active === 0 ? '' : 'checked')}> Available for booking</label>
      <div class="error"></div>
      <button class="btn block" type="submit">${a.id ? 'Save changes' : 'Add amenity'}</button>
    </form>`;
  return html`
    <h1>Amenities</h1>
    ${adminNav('amenities')}
    <details class="card" ${raw(list.length ? '' : 'open')}><summary class="title">＋ Add amenity</summary>${form()}</details>
    ${list.map((a) => html`<details class="card"><summary class="title">${a.name} ${a.active ? '' : badge(['Hidden', ''])}</summary>${form(a)}</details>`)}`;
}, { tab: '/more', roles: ['admin'] });

forms.saveAmenity = async (d) => {
  const body = { ...d, slot_minutes: Number(d.slot_minutes), max_days_ahead: Number(d.max_days_ahead) };
  if (d.id) await api('PUT', `/amenities/${d.id}`, body); else await api('POST', '/amenities', body);
  toast('Saved');
  render();
};

route('/admin/complaints', async () => {
  const list = await api('GET', '/complaints?all=1');
  state.refresh = () => { if (!document.activeElement?.closest('form')) render(); };
  return html`<h1>Helpdesk</h1>${adminNav('complaints')}
    ${list.length ? list.map((c) => complaintCard(c, true)) : html`<div class="card empty">No issues raised.</div>`}`;
}, { tab: '/more', roles: ['admin'] });

forms.updateComplaint = async (d) => { await api('PATCH', `/complaints/${d.id}`, { status: d.status, admin_note: d.admin_note }); toast('Updated'); render(); };

route('/admin/bookings', async () => {
  const list = await api('GET', '/bookings?all=1');
  return html`<h1>Upcoming bookings</h1>${adminNav('bookings')}
    ${list.length ? html`<div class="card"><ul class="list">${list.map((b) => html`
      <li class="row"><div class="grow"><div class="title">${b.amenity} · ${b.flat}</div>
        <div class="meta">${fmtDay(b.date)} · ${fmtHM(b.start_time)}–${fmtHM(addMin(b.start_time, b.slot_minutes))} · ${b.user_name}</div></div>
        <button class="btn sm ghost" data-action="cancelBooking" data-id="${b.id}" data-confirm="Cancel ${b.flat}'s booking?">Cancel</button></li>`)}</ul></div>`
      : html`<div class="card empty">No upcoming bookings.</div>`}`;
}, { tab: '/more', roles: ['admin'] });

// ---------- Boot ----------
async function boot() {
  state.config = await api('GET', '/config').catch(() => ({}));
  document.title = state.config.society || 'Gatepass';
  try { state.user = await api('GET', '/me'); } catch { state.user = null; }
  if (state.user) {
    connectEvents();
    await updatePendingCount();
    if (['/login', '/register', ''].includes(location.hash.slice(1))) {
      location.hash = state.user.role === 'guard' ? '#/guard' : '#/';
    }
  }
  render();
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
// When the app comes back to the foreground, refresh what's on screen.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.user) {
    updatePendingCount().then(() => renderChrome(currentTab()));
    state.refresh?.();
  }
});
boot();
