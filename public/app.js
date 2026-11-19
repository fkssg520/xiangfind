// 湘寻 · 前端入口
// 当前阶段：单页外壳 + 广场页（mock 数据）
// 契约：docs/API契约.md　样例：docs/fixtures/items.json
// 切换真实接口时只改 API_PREFIX，不改字段映射。

let currentUser = null; // 当前登录用户（null = 未登录）

// 存放点目前没有列表接口，先用与 seed 一致的常量；等 GET /api/storage-points 就绪后替换
const STORAGE_POINTS = [
  { id: 'stp_demo_lib', name: '图书馆一楼服务台', type: 'normal' },
  { id: 'stp_demo_dorm', name: '宿舍服务中心', type: 'normal' },
  { id: 'stp_demo_guard', name: '保卫处失物招领点', type: 'security' },
];
const API_PREFIX = ''; // 例：'' = 同源；'/api' = 后端前缀。mock 阶段留空。
const MOCK = {
  items: 'mock/items.json',
  detail: 'mock/item-detail.json',
  me: 'mock/me.json',
};

/* ---------- 状态码 → 徽章（按 D-001 的 type + status 双维度） ---------- */
const STATUS_MAP = {
  lost: {
    open: ['进行中', 'sand'],
    reunited: ['已找回', 'done'],
    archived: ['已归档', 'muted'],
  },
  found: {
    pending_storage: ['待存放', 'sand'],
    stored: ['已存放', 'olive'],
    claim_pending: ['认领中', 'sand'],
    ready_for_pickup: ['待领取', 'olive'],
    returned: ['已归还', 'done'],
    archived: ['已归档', 'muted'],
  },
};

const TYPE_LABEL = { lost: '失', found: '招' };

/* ---------- 视图路由 ---------- */
const VIEWS = ['plaza', 'publish', 'item', 'me', 'messages', 'admin', 'login'];

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name, ...rest] = raw.split('/');
  return { name: VIEWS.includes(name) ? name : 'plaza', param: rest.join('/') };
}

function renderRoute() {
  const { name, param } = parseHash();

  document.querySelectorAll('.view').forEach((el) => {
    el.classList.toggle('on', el.id === `view-${name}`);
  });

  document.querySelectorAll('[data-nav]').forEach((a) => {
    const active = name === 'item' ? 'plaza' : name;
    a.classList.toggle('on', a.dataset.nav === active);
  });

  if (name === 'item') loadDetail(param);
  if (name === 'me') loadMe(param);
  if (name === 'messages') loadMessages();

  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', renderRoute);

/* ---------- 工具 ---------- */
function fmtTime(iso) {
  if (!iso) return '时间未知';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '时间未知';
  const diff = Date.now() - d.getTime();
  const H = 3600 * 1000;
  if (diff >= 0 && diff < H) return `${Math.max(1, Math.round(diff / 60000))} 分钟前`;
  if (diff >= 0 && diff < 24 * H) return `${Math.round(diff / H)} 小时前`;
  const md = `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
  return `${md} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/* ---------- 广场页 ---------- */
const state = { type: 'all', q: '', category: 'all', items: [], total: 0, page: 1, loading: false, loaded: false, error: '' };

function statusBadge(item) {
  const table = STATUS_MAP[item.type] || {};
  const [label, tone] = table[item.status] || [item.status, 'muted'];
  return el('span', `status ${tone}`, label);
}

function cardOf(item) {
  const card = el('article', 'card');
  card.tabIndex = 0;
  card.addEventListener('click', () => { location.hash = `#/item/${item.id}`; });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') location.hash = `#/item/${item.id}`;
  });

  const top = el('div', 'card-top');
  top.append(el('span', `type-tag ${item.type}`, TYPE_LABEL[item.type] || '?'));
  top.append(statusBadge(item));
  card.append(top);

  card.append(el('div', 'thumb', item.category || '物品'));
  card.append(el('h3', null, item.title || '未命名物品'));

  if (item.summary) card.append(el('p', 'summary', item.summary));

  const meta = el('div', 'meta');
  meta.append(el('span', null, item.location || '地点未知'));
  meta.append(el('span', null, fmtTime(item.eventAt)));
  if (item.storagePoint) meta.append(el('span', 'store', item.storagePoint.name));
  card.append(meta);

  const foot = el('div', 'foot');
  foot.append(el('span', 'who', item.author?.name || '匿名'));
  if (item.author?.isVolunteer) foot.append(el('span', 'vol', '志愿者'));
  foot.append(el('span', 'fav', item.isFavorited ? '★' : '☆'));
  card.append(foot);

  return card;
}

const CATEGORIES = ['证件', '电子产品', '钥匙', '书籍', '衣物', '其他'];
const PAGE_SIZE = 9;

async function fetchItems({ append = false } = {}) {
  const params = new URLSearchParams();
  if (state.type !== 'all') params.set('type', state.type);
  if (state.category !== 'all') params.set('category', state.category);
  const q = state.q.trim();
  if (q) params.set('q', q);
  params.set('page', String(state.page));
  params.set('pageSize', String(PAGE_SIZE));

  const res = await fetch(`/api/items?${params.toString()}`, { headers: { accept: 'application/json' } });
  if (res.status === 401) return { unauth: true };
  if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }

  const data = await res.json();
  const list = Array.isArray(data.items) ? data.items : [];
  state.items = append ? state.items.concat(list) : list;
  state.total = Number(data.total) || 0;
  return { ok: true };
}

function renderPlaza() {
  const grid = document.getElementById('plaza-grid');
  const empty = document.getElementById('plaza-empty');
  const more = document.getElementById('plaza-more');
  if (!grid) return;

  if (!state.loaded) {
    grid.replaceChildren();
    for (let i = 0; i < 3; i += 1) grid.append(el('div', 'skeleton'));
    if (empty) empty.hidden = true;
    if (more) more.hidden = true;
    return;
  }

  grid.replaceChildren();
  state.items.forEach((item) => grid.append(cardOf(item)));

  if (empty) {
    empty.hidden = state.items.length > 0;
    if (state.error && state.items.length === 0) {
      empty.textContent = state.error + ' · 点这里重试';
      empty.onclick = () => { state.error = ''; resetAndLoad(); };
    } else {
      empty.textContent = '没有找到符合条件的物品，换个关键词试试。';
      empty.onclick = null;
    }
  }
  if (more) more.hidden = state.items.length >= state.total || Boolean(state.error);
}

function renderCategories() {
  const box = document.getElementById('cats');
  if (!box) return;
  box.replaceChildren();

  const mk = (label, value) => {
    const b = el('button', state.category === value ? 'on' : '', label);
    b.type = 'button';
    b.addEventListener('click', () => {
      state.category = state.category === value && value !== 'all' ? 'all' : value;
      renderCategories();
      resetAndLoad();
    });
    return b;
  };

  box.append(mk('全部类别', 'all'));
  CATEGORIES.forEach((c) => box.append(mk(c, c)));
}

async function reloadPlaza({ append = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  if (!append) { state.loaded = false; renderPlaza(); }

  try {
    const out = await fetchItems({ append });
    if (out.unauth) {
      state.items = [];
      state.total = 0;
      toast('登录后查看广场');
      location.hash = '#/login';
    }
  } catch (err) {
    console.warn('[湘寻] 列表加载失败：', err.message);
    state.error = err.status === 429 ? '请求太频繁，稍等一下再试' : '加载失败';
    if (!append) { state.items = []; state.total = 0; }
    toast(state.error);
  } finally {
    state.loading = false;
    state.loaded = true;
    renderPlaza();
  }
}

function resetAndLoad() {
  state.page = 1;
  state.items = [];
  state.total = 0;
  reloadPlaza();
}

/* ---------- 未读角标 ---------- */
function setUnread(n) {
  const badge = document.getElementById('unread');
  if (!badge) return;
  badge.textContent = String(n);
  badge.hidden = !(n > 0);
}

/* ---------- 交互绑定 ---------- */
function bindPlaza() {
  const seg = document.getElementById('type-seg');
  seg?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-type]');
    if (!btn) return;
    state.type = btn.dataset.type;
    [...seg.querySelectorAll('button')].forEach((b) => b.classList.toggle('on', b === btn));
    resetAndLoad();
  });

  const q = document.getElementById('q');
  let timer = null;
  q?.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = q.value; resetAndLoad(); }, 180);
  });

  document.getElementById('search-btn')?.addEventListener('click', () => {
    state.q = q?.value || '';
    resetAndLoad();
  });

  document.getElementById('plaza-more')?.addEventListener('click', () => {
    state.page += 1;
    reloadPlaza({ append: true });
  });
}

/* ---------- 启动 ---------- */
renderRoute();
bindPlaza();
bindAuth();
bindPublish();
refreshMe();
loadUnread(); // mock 未读数；等 /api/messages 就绪后换真实接口
renderCategories();
resetAndLoad();

/* ---------- 详情页 ---------- */
const CLAIMABLE = new Set(['stored', 'pending_storage', 'open']);

async function loadDetail(id) {
  const root = document.getElementById('detail-root');
  if (!root) return;
  root.replaceChildren(el('div', 'skeleton'));

  let data = null;
  try {
    const res = await fetch(`${API_PREFIX}${MOCK.detail}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.warn('[湘寻] 详情 mock 加载失败：', err.message);
    root.replaceChildren(el('div', 'empty', '详情加载失败，稍后再试。'));
    return;
  }

  root.replaceChildren(buildDetail(data, id));
}

function buildDetail(item, id) {
  const wrap = el('article', 'detail');

  /* 左：主信息 */
  const main = el('div', 'detail-main');
  main.append(el('div', 'detail-media', item.category || '物品'));

  const head = el('div', 'detail-head');
  head.append(el('span', `type-tag ${item.type}`, TYPE_LABEL[item.type] || '?'));
  head.append(el('h1', null, item.title || '未命名物品'));
  head.append(statusBadge(item));
  main.append(head);

  const kv = el('div', 'kv-list');
  const row = (k, v) => {
    const r = el('div', 'kv-row');
    r.append(el('span', 'k', k), el('span', 'v', v));
    kv.append(r);
  };
  row('类别', item.category || '未分类');
  row('地点', item.location || '未知');
  row('时间', fmtTime(item.eventAt));
  row('存放点', item.storagePoint?.name || '未入库');
  row('发布者', `${item.author?.name || '匿名'}${item.author?.isVolunteer ? '（志愿者）' : ''}`);
  row('编号', id || item.id);
  main.append(kv);

  if (item.description) main.append(el('div', 'detail-desc', item.description));
  wrap.append(main);

  /* 右：认领 + 匹配 */
  const side = el('div', 'detail-side');

  const claim = el('div', 'side-card claim-box');
  claim.append(el('h2', null, '认领这件物品'));

  const best = (item.matches || []).reduce((m, x) => (x.score > m ? x.score : m), 0);
  if (best > 0) {
    const sr = el('div', 'score-row');
    sr.append(el('b', null, String(best)));
    sr.append(el('span', null, '/ 100 最高匹配分'));
    claim.append(sr);
    const meter = el('div', 'meter');
    const fill = el('i');
    fill.style.width = `${Math.min(100, best)}%`;
    meter.append(fill);
    claim.append(meter);
  }

  const tips = el('p', null, item.isOwner
    ? '这是你发布的信息，可在「我的」里编辑或关闭。'
    : '认领时请说明 2 项以上未公开的特征（划痕、贴纸、内容物），通过审核后才会向双方开放联系方式。');
  claim.append(tips);

  const cbtn = el('button', 'btn', item.isOwner ? '管理这条信息' : '申请认领');
  cbtn.type = 'button';
  if (!item.isOwner && !CLAIMABLE.has(item.status)) {
    cbtn.disabled = true;
    cbtn.textContent = '当前状态不可认领';
  }
  cbtn.addEventListener('click', () => {
    if (cbtn.disabled) return;
    toast('认领接口就绪后生效（M3）');
  });
  claim.append(cbtn);
  side.append(claim);

  const matches = item.matches || [];
  if (matches.length) {
    const mcard = el('div', 'side-card');
    mcard.append(el('h2', null, '可能相关'));
    matches.forEach((m) => {
      const box = el('div', 'match');
      const top = el('div', 'match-top');
      top.append(el('b', null, m.title || m.itemId));
      top.append(el('span', 'num', String(m.score)));
      box.append(top);
      if (m.reasons?.length) {
        const rs = el('div', 'reasons');
        m.reasons.forEach((r) => rs.append(el('span', 'reason', r)));
        box.append(rs);
      }
      box.addEventListener('click', () => { location.hash = `#/item/${m.itemId}`; });
      box.style.cursor = 'pointer';
      mcard.append(box);
    });
    side.append(mcard);
  }

  wrap.append(side);
  return wrap;
}

/* ---------- 轻提示 ---------- */
function toast(msg) {
  const t = el('div', 'toast', msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

/* ---------- 接口封装（CSRF 双提交） ---------- */
function csrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)xf_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  const token = csrfToken();
  if (token) headers['x-csrf-token'] = token;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });

  let data = null;
  try { data = await res.json(); } catch { /* 204 */ }
  return { ok: res.ok, status: res.status, data };
}

function errText(r, fallback) {
  return r?.data?.error?.message || fallback;
}

/* ---------- 登录态 ---------- */

function renderUser() {
  const btn = document.getElementById('login-btn');
  if (!btn) return;
  if (currentUser) {
    btn.textContent = currentUser.name || currentUser.studentId;
    btn.href = '#/me';
  } else {
    btn.textContent = '登录';
    btn.href = '#/login';
  }
}

async function refreshMe() {
  const r = await api('/me');
  currentUser = r.ok ? r.data.user : null;
  renderUser();
  return currentUser;
}

/* ---------- 登录 / 注册 ---------- */
function showAuthForm(which) {
  ['login', 'register', 'verify'].forEach((k) => {
    const form = document.getElementById(`form-${k}`);
    if (form) form.hidden = k !== which;
  });
  document.querySelectorAll('[data-auth-tab]').forEach((b) => {
    b.classList.toggle('on', b.dataset.authTab === which || (which === 'verify' && b.dataset.authTab === 'register'));
  });
}

function setMsg(id, text, ok = false) {
  const box = document.getElementById(id);
  if (!box) return;
  box.hidden = !text;
  box.textContent = text || '';
  box.classList.toggle('ok', !!ok);
}

function busy(btn, on, label) {
  if (!btn) return;
  btn.disabled = on;
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || '处理中…'; }
  else if (btn.dataset.label) { btn.textContent = btn.dataset.label; }
}

function bindAuth() {
  const tabs = document.getElementById('auth-tabs');
  tabs?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-auth-tab]');
    if (!b) return;
    setMsg('login-msg', '');
    setMsg('reg-msg', '');
    showAuthForm(b.dataset.authTab);
  });

  /* 登录 */
  document.getElementById('form-login')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    setMsg('login-msg', '');
    busy(btn, true, '登录中…');
    const r = await api('/auth/login', {
      method: 'POST',
      body: {
        studentId: e.target.studentId.value.trim(),
        password: e.target.password.value,
      },
    });
    busy(btn, false);
    if (!r.ok) return setMsg('login-msg', errText(r, '登录失败，请检查学号与密码'));
    await refreshMe();
    location.hash = '#/plaza';
    toast(`欢迎回来，${currentUser?.name || ''}`);
  });

  /* 注册 → 发验证码 */
  const PENDING_KEY = 'xf_pending_email';
  let pendingEmail = sessionStorage.getItem(PENDING_KEY) || '';
  document.getElementById('form-register')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    setMsg('reg-msg', '');
    busy(btn, true, '发送中…');
    const body = {
      studentId: e.target.studentId.value.trim(),
      name: e.target.elements.name.value.trim(),
      email: e.target.email.value.trim(),
      password: e.target.password.value,
      confirmPassword: e.target.confirmPassword.value,
    };
    const r = await api('/auth/register', { method: 'POST', body });
    busy(btn, false);
    if (!r.ok) return setMsg('reg-msg', errText(r, '注册失败'));
    pendingEmail = body.email;
    sessionStorage.setItem(PENDING_KEY, pendingEmail);
    document.getElementById('verify-email').textContent = pendingEmail;
    showAuthForm('verify');
  });

  /* 验证码 → 自动登录 */
  document.getElementById('form-verify')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    setMsg('verify-msg', '');
    busy(btn, true, '验证中…');
    const r = await api('/auth/verify-email', {
      method: 'POST',
      body: { email: pendingEmail || sessionStorage.getItem(PENDING_KEY) || document.getElementById('verify-email').textContent, code: e.target.code.value.trim() },
    });
    busy(btn, false);
    if (!r.ok) return setMsg('verify-msg', errText(r, '验证失败'));
    await refreshMe();
    location.hash = '#/plaza';
    toast('注册成功，已登录');
  });

  document.getElementById('verify-back')?.addEventListener('click', () => {
    setMsg('verify-msg', '');
    showAuthForm('register');
  });

  /* restore verify step after refresh */
  if (pendingEmail && parseHash().name === 'login') {
    const box = document.getElementById('verify-email');
    if (box) box.textContent = pendingEmail;
    showAuthForm('verify');
  }
}

/* ---------- 发布页 ---------- */

function bindPublish() {
  const form = document.getElementById('form-publish');
  if (!form) return;

  let type = 'lost';
  const storageWrap = document.getElementById('pub-storage-wrap');
  const storageSel = form.elements.storagePointId;
  const valueSel = form.elements.valueLevel;
  const msg = document.getElementById('pub-msg');

  function refreshPoints() {
    const valuable = valueSel.value === 'valuable';
    const list = STORAGE_POINTS.filter((p) => !valuable || p.type === 'security');
    storageSel.replaceChildren();
    list.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      storageSel.append(opt);
    });
  }

  function refreshType() {
    document.querySelectorAll('#pub-type button').forEach((b) => {
      b.classList.toggle('on', b.dataset.type === type);
    });
    storageWrap.hidden = type !== 'found';
  }

  document.getElementById('pub-type')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-type]');
    if (!btn) return;
    type = btn.dataset.type;
    refreshType();
  });

  valueSel.addEventListener('change', refreshPoints);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.hidden = true;

    const btn = form.querySelector('button[type=submit]');
    busy(btn, true, '提交中…');

    const body = {
      type,
      title: form.elements.title.value.trim(),
      category: form.elements.category.value,
      description: form.elements.description.value.trim(),
      location: form.elements.location.value.trim(),
      eventAt: form.elements.eventAt.value ? new Date(form.elements.eventAt.value).toISOString() : null,
      valueLevel: form.elements.valueLevel.value,
      storagePointId: type === 'found' ? form.elements.storagePointId.value : null,
    };

    const r = await api('/items', { method: 'POST', body });
    busy(btn, false);

    if (r.status === 401) {
      toast('请先登录');
      location.hash = '#/login';
      return;
    }
    if (!r.ok) {
      msg.hidden = false;
      msg.textContent = errText(r, '提交失败，检查一下必填项');
      return;
    }

    toast('已提交，等待审核');
    const id = r.data?.item?.id;
    form.reset();
    type = 'lost';
    refreshType();
    refreshPoints();
    location.hash = id ? `#/item/${id}` : '#/plaza';
  });

  refreshType();
  refreshPoints();
}

/* ---------- 我的中心 ---------- */
const ROLE_TEXT = { student: '学生', volunteer: '志愿者', admin: '管理员', security: '保卫处' };
const CLAIM_TEXT = {
  pending: ['待审核', 'sand'],
  approved: ['已通过', 'olive'],
  rejected: ['已驳回', 'muted'],
};

function emptyBox(text) {
  return el('div', 'empty', text);
}

async function loadMe(tab) {
  const root = document.getElementById('me-root');
  if (!root) return;
  root.replaceChildren(el('div', 'skeleton'));

  const meRes = await api('/me');
  if (!meRes.ok) {
    root.replaceChildren(emptyBox('请先登录后再查看「我的」'));
    toast('请先登录');
    location.hash = '#/login';
    return;
  }
  const user = meRes.data.user;

  const page = el('div', 'me-page');

  const head = el('div', 'card me-head');
  head.append(el('div', 'me-avatar', (user.name || '?').slice(-1)));
  const info = el('div', 'me-info');
  info.append(el('b', null, user.name || user.studentId));
  info.append(el('span', 'me-meta',
    `${user.studentId} · ${ROLE_TEXT[user.role] || user.role}${user.isVolunteer ? ' · 志愿者' : ''}`));
  head.append(info);

  const logout = el('button', 'btn btn-ghost btn-sm', '退出登录');
  logout.type = 'button';
  logout.addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' });
    currentUser = null;
    renderUser();
    toast('已退出');
    location.hash = '#/plaza';
  });
  head.append(logout);
  page.append(head);

  const tabs = el('div', 'seg me-tabs');
  const pane = el('div', 'me-pane');
  const TAB_DEFS = [
    ['posts', '我的发布'],
    ['claims', '我的认领'],
    ['favs', '我的收藏'],
  ];

  const show = (key) => {
    [...tabs.children].forEach((b) => b.classList.toggle('on', b.dataset.tab === key));
    pane.replaceChildren(el('div', 'skeleton'));
    renderPane(key, pane);
  };

  TAB_DEFS.forEach(([key, label], i) => {
    const b = el('button', i === 0 ? 'on' : '', label);
    b.type = 'button';
    b.dataset.tab = key;
    b.addEventListener('click', () => show(key));
    tabs.append(b);
  });

  page.append(tabs, pane);
  root.replaceChildren(page);
  const first = ['posts', 'claims', 'favs'].includes(tab) ? tab : 'posts';
  show(first);
}

async function renderPane(key, pane) {
  try {
    if (key === 'posts') {
      const r = await api('/items?mine=1&pageSize=50');
      if (!r.ok) return pane.replaceChildren(emptyBox('请先登录后查看我的发布'));
      const data = r.data;
      if (!data.items.length) return pane.replaceChildren(emptyBox('还没有发布过信息'));
      const list = el('div', 'me-list');
      data.items.forEach((it) => {
        const row = el('div', 'me-row');
        row.append(el('span', `type-tag ${it.type}`, it.type === 'lost' ? '失' : '招'));
        const main = el('div', 'me-row-main');
        main.append(el('b', null, it.title));
        main.append(el('span', 'me-meta', `${it.location} · ${fmtTime(it.createdAt)}`));
        row.append(main);
        const table = STATUS_MAP[it.type] || {};
        const [label, tone] = table[it.status] || [it.status, 'muted'];
        row.append(el('span', `status ${tone}`, label));
        row.addEventListener('click', () => { location.hash = `#/item/${it.id}`; });
        list.append(row);
      });
      pane.replaceChildren(list);
      return;
    }

    if (key === 'claims') {
      const r = await api('/claims/mine');
      if (!r.ok) return pane.replaceChildren(emptyBox('请先登录后查看我的认领'));
      const data = r.data;
      if (!data.claims.length) return pane.replaceChildren(emptyBox('还没有提交过认领'));
      const list = el('div', 'me-list');
      data.claims.forEach((c) => {
        const row = el('div', 'me-row');
        const main = el('div', 'me-row-main');
        main.append(el('b', null, c.itemTitle));
        main.append(el('span', 'me-meta', c.note));
        if (c.reviewNote) main.append(el('span', 'me-meta warn', c.reviewNote));
        row.append(main);
        const [label, tone] = CLAIM_TEXT[c.status] || [c.status, 'muted'];
        row.append(el('span', `status ${tone}`, label));
        list.append(row);
      });
      pane.replaceChildren(list);
      return;
    }

    const res = await fetch('/mock/items.json');
    const data = await res.json();
    const favs = (data.items || []).filter((i) => i.isFavorited);
    if (!favs.length) return pane.replaceChildren(emptyBox('还没有收藏任何信息'));
    const grid = el('div', 'grid');
    favs.forEach((it) => grid.append(cardOf(it)));
    pane.replaceChildren(grid);
  } catch (err) {
    pane.replaceChildren(emptyBox('加载失败，稍后再试'));
    console.warn('[湘寻] 我的中心加载失败：', err.message);
  }
}

/* ---------- 消息中心 ---------- */
const MSG_TEXT = { match: '匹配', claim: '认领', system: '系统' };

async function loadMessages() {
  const root = document.getElementById('messages-root');
  if (!root) return;
  root.replaceChildren(el('div', 'skeleton'));

  const meRes = await api('/me');
  if (!meRes.ok) {
    root.replaceChildren(emptyBox('请先登录后再查看消息'));
    location.hash = '#/login';
    return;
  }

  let data;
  try {
    const r = await api('/messages');
    if (!r.ok) {
      root.replaceChildren(emptyBox('请先登录后再查看消息'));
      return;
    }
    data = r.data;
  } catch {
    root.replaceChildren(emptyBox('消息加载失败'));
    return;
  }

  const page = el('div', 'msg-page');
  let filter = 'all';

  const bar = el('div', 'msg-bar');
  const seg = el('div', 'seg');
  const pane = el('div', 'msg-list');

  const paint = () => {
    const list = filter === 'unread' ? data.messages.filter((m) => !m.readAt) : data.messages;
    pane.replaceChildren();
    if (!list.length) {
      pane.append(emptyBox(filter === 'unread' ? '没有未读消息' : '还没有消息'));
      return;
    }
    list.forEach((m) => {
      const row = el('div', `msg-row${m.readAt ? '' : ' unread'}`);
      row.append(el('span', `msg-dot ${MSG_TEXT[m.type] ? m.type : 'system'}`, MSG_TEXT[m.type] || '消息'));
      const main = el('div', 'msg-main');
      main.append(el('b', null, m.title));
      main.append(el('span', 'msg-body', m.body));
      main.append(el('span', 'me-meta', fmtTime(m.createdAt)));
      row.append(main);
      if (!m.readAt) row.append(el('span', 'msg-badge', '未读'));
      row.addEventListener('click', () => {
        const wasUnread = !m.readAt;
        m.readAt = m.readAt || new Date().toISOString();
        if (wasUnread && m.id) api('/messages/' + m.id + '/read', { method: 'POST' }).catch(() => {});
        setUnread(data.messages.filter((x) => !x.readAt).length);
        if (m.relatedId) location.hash = `#/item/${m.relatedId}`;
        else paint();
      });
      pane.append(row);
    });
    setUnread(data.messages.filter((x) => !x.readAt).length);
  };

  [['all', '全部'], ['unread', '未读']].forEach(([k, label], i) => {
    const b = el('button', i === 0 ? 'on' : '', label);
    b.type = 'button';
    b.addEventListener('click', () => {
      filter = k;
      [...seg.children].forEach((x) => x.classList.toggle('on', x === b));
      paint();
    });
    seg.append(b);
  });

  const markAll = el('button', 'btn btn-ghost btn-sm', '全部标为已读');
  markAll.type = 'button';
  markAll.addEventListener('click', () => {
    const now = new Date().toISOString();
    data.messages.forEach((m) => {
      if (!m.readAt && m.id) api('/messages/' + m.id + '/read', { method: 'POST' }).catch(() => {});
      m.readAt = m.readAt || now;
    });
    paint();
    toast('已全部标为已读');
  });

  bar.append(seg, markAll);
  page.append(bar, pane);
  root.replaceChildren(page);
  paint();
}

async function loadUnread() {
  try {
    const r = await api('/messages');
    setUnread(r.ok ? (Number(r.data.unreadCount) || 0) : 0);
  } catch {
    setUnread(0);
  }
}
