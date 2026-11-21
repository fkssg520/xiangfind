// 湘寻 · 前端入口
// 当前阶段：全部页面已接真实 /api/*，mock 仅作字段参考
// 契约：docs/API契约.md　样例：docs/fixtures/items.json
// 数据全部来自 /api/*；mock 只保留在 public/mock 作为字段参考。

let currentUser = null; // 当前登录用户（null = 未登录）


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
const VIEWS = ['plaza', 'publish', 'item', 'me', 'messages', 'admin', 'login', 'forgot'];

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
  if (name === 'admin') loadAdmin(param);

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
const state = { type: 'all', q: '', category: 'all', status: 'all', valueLevel: 'all', storagePointId: 'all',
  items: [], total: 0, page: 1, loading: false, loaded: false, error: '' };

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

  const cardImg = (item.images || [])[0];
  if (cardImg) {
    const th = el('div', 'thumb has-img');
    const im = document.createElement('img');
    im.src = cardImg.url || ('/uploads/' + cardImg.fileName);
    im.alt = item.title || '';
    im.loading = 'lazy';
    th.append(im);
    card.append(th);
  } else {
    card.append(el('div', 'thumb', item.category || '物品'));
  }
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
  const fav = el('span', 'fav', item.isFavorited ? '★' : '☆');
  fav.title = item.isFavorited ? '取消收藏' : '收藏';
  fav.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!currentUser) { toast('登录后才能收藏'); location.hash = '#/login'; return; }
    const r = await api('/items/' + encodeURIComponent(item.id) + '/favorite', { method: 'POST' });
    if (!r.ok) { toast(errText(r, '操作失败')); return; }
    const now = typeof r.data?.isFavorited === 'boolean' ? r.data.isFavorited : !item.isFavorited;
    item.isFavorited = now;
    fav.textContent = now ? '★' : '☆';
    fav.title = now ? '取消收藏' : '收藏';
    toast(now ? '已收藏' : '已取消收藏');
  });
  foot.append(fav);
  card.append(foot);

  return card;
}

const CATEGORIES = ['证件', '电子产品', '钥匙', '书籍', '衣物', '其他'];
const PAGE_SIZE = 9;

async function fetchItems({ append = false } = {}) {
  const params = new URLSearchParams();
  if (state.type !== 'all') params.set('type', state.type);
  if (state.category !== 'all') params.set('category', state.category);
  if (state.status !== 'all') params.set('status', state.status);
  if (state.valueLevel !== 'all') params.set('valueLevel', state.valueLevel);
  if (state.storagePointId !== 'all') params.set('storagePointId', state.storagePointId);
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

  // ---------- 状态 / 贵重等级 / 存放点筛选 ----------
  const fStatus = document.getElementById('f-status');
  const fValue = document.getElementById('f-value');
  const fPoint = document.getElementById('f-point');
  const fReset = document.getElementById('f-reset');

  const paintFilters = () => {
    if (fStatus) fStatus.value = state.status;
    if (fValue) fValue.value = state.valueLevel;
    if (fPoint) fPoint.value = state.storagePointId;
  };

  fStatus?.addEventListener('change', () => { state.status = fStatus.value; resetAndLoad(); });
  fValue?.addEventListener('change', () => { state.valueLevel = fValue.value; resetAndLoad(); });
  fPoint?.addEventListener('change', () => { state.storagePointId = fPoint.value; resetAndLoad(); });

  fReset?.addEventListener('click', () => {
    state.type = 'all';
    state.category = 'all';
    state.status = 'all';
    state.valueLevel = 'all';
    state.storagePointId = 'all';
    state.q = '';
    const q = document.getElementById('q');
    if (q) q.value = '';
    [...document.querySelectorAll('#type-seg button')].forEach((b) => b.classList.toggle('on', b.dataset.type === 'all'));
    renderCategories();
    paintFilters();
    resetAndLoad();
  });

  // 存放点下拉：公开接口，游客也能拿到
  (async () => {
    if (!fPoint) return;
    const r = await api('/storage-points');
    if (!r.ok) return;
    (r.data.storagePoints || []).forEach((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name + (p.type === 'security' ? '（保卫处）' : '');
      fPoint.append(o);
    });
    paintFilters();
  })();
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
bindForgot();
refreshMe();
loadUnread(); // mock 未读数；等 /api/messages 就绪后换真实接口
renderCategories();
resetAndLoad();

/* ---------- 详情页 ---------- */
// 与后端 submitClaim 保持一致：只有「已存放」「认领中」的招领可以申请；失物不参与认领
const CLAIMABLE = new Set(['stored', 'claim_pending']);
const canClaimItem = (item) => Boolean(item) && item.type === 'found' && CLAIMABLE.has(item.status);

async function loadDetail(id) {
  const root = document.getElementById('detail-root');
  if (!root) return;
  root.replaceChildren(el('div', 'skeleton'));

  const r = await api('/items/' + encodeURIComponent(id));
  if (r.status === 404) { root.replaceChildren(el('div', 'empty', '这条信息不存在或已删除。')); return; }
  if (!r.ok) { root.replaceChildren(el('div', 'empty', '详情加载失败，稍后再试。')); return; }

  root.replaceChildren(buildDetail(r.data.item, id));
}

function buildDetail(item, id) {
  const wrap = el('article', 'detail');

  /* 左：主信息 */
  const main = el('div', 'detail-main');
  const imgList = (item.images || []).filter((x) => x && (x.url || x.fileName));
  if (imgList.length) {
    const media = el('div', 'detail-media has-img');
    imgList.forEach((im) => {
      const src = im.url || ('/uploads/' + im.fileName);
      const img = document.createElement('img');
      img.src = src;
      img.alt = item.title || '物品图片';
      img.loading = 'lazy';
      media.append(img);
    });
    main.append(media);
  } else {
    main.append(el('div', 'detail-media', item.category || '物品'));
  }

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
    // 发布者点的是「管理」：去「我的发布」列表，不要弹认领框
    if (item.isOwner) { location.hash = '#/me/posts'; return; }
    openClaimDialog(item, () => loadDetail(item.id));
  });
  // 只在「自己发布的」或「当前可认领的」情况下显示按钮，避免出现禁用的死按钮
  if (item.isOwner || canClaimItem(item)) claim.append(cbtn);

  // 待入库：志愿者/管理员/保卫处可以确认入库（他们没有后台权限，只能在这里点）
  // /api/me 现在会返回志愿者绑定的存放点，能提前判断；拿不到时退回按角色显示 + 403 自愈
  const STORAGE_ROLES = ['volunteer', 'admin', 'security'];
  let canStore = false;
  if (item.status === 'pending_storage' && currentUser && STORAGE_ROLES.includes(currentUser.role)) {
    const pts = currentUser.storagePoints;
    if (currentUser.role === 'admin') canStore = true;
    else if (currentUser.role === 'security') canStore = item.storagePoint?.type === 'security';
    else if (Array.isArray(pts)) canStore = pts.some((p) => p.id === item.storagePoint?.id);
    else canStore = true; // 还不知道绑定关系，先给按钮，点错由 403 兜底
  }
  if (canStore) {
    const store = el('button', 'btn btn-ghost', '确认已入库');
    store.type = 'button';
    store.style.marginTop = '10px';
    store.addEventListener('click', async () => {
      store.disabled = true;
      const r = await api('/items/' + encodeURIComponent(item.id), { method: 'PATCH', body: { status: 'stored' } });
      store.disabled = false;
      if (!r.ok) {
        toast(errText(r, '操作失败'));
        if (r.status === 403) store.remove();
        return;
      }
      toast('已确认入库');
      loadDetail(item.id);
    });
    claim.append(store);
  }

  // 待领取：只有所属存放点的志愿者或管理员能确认归还
  if (item.status === 'ready_for_pickup' && item.claim?.canReview) {
    const done = el('button', 'btn btn-ghost', '确认已归还');
    done.type = 'button';
    done.style.marginTop = '10px';
    done.addEventListener('click', async () => {
      if (!confirm('确认这件物品已经交还给失主？确认后状态变为「已归还」。')) return;
      done.disabled = true;
      const r = await api('/items/' + encodeURIComponent(item.id) + '/return', { method: 'POST' });
      done.disabled = false;
      if (!r.ok) { toast(errText(r, '操作失败')); return; }
      toast('已标记归还');
      loadDetail(item.id);
    });
    claim.append(done);
  }
  side.append(claim);

  if (item.isOwner || item.claim?.canReview) {
    const box = el('div', 'side-card');
    box.append(el('h2', null, '认领申请'));
    const listBox = el('div');
    box.append(listBox);
    side.append(box);
    loadClaimList(item.id, listBox);
  }

  // 联系方式：认领通过后（ready_for_pickup / returned）接口才会给，只对双方可见
  if (item.contact) {
    const cbox = el('div', 'side-card');
    cbox.append(el('h2', null, '联系方式'));
    cbox.append(el('p', 'modal-hint', '认领已通过，以下信息只对双方可见，请勿外传。'));
    const ckv = el('div', 'kv-list');
    const crow = (k, v) => {
      const r = el('div', 'kv-row');
      r.append(el('span', 'k', k), el('span', 'v', v || '未填写'));
      ckv.append(r);
    };
    crow('姓名', item.contact.name);
    crow('邮箱', item.contact.email);
    crow('电话', item.contact.phone);
    cbox.append(ckv);
    side.append(cbox);
  }

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

/* ---------- 忘记密码 ---------- */
function bindForgot() {
  const send = document.getElementById('forgot-send');
  if (!send) return;
  const email = document.getElementById('forgot-email');
  const code = document.getElementById('forgot-code');
  const pass = document.getElementById('forgot-pass');
  const pass2 = document.getElementById('forgot-pass2');
  const msg1 = document.getElementById('forgot-msg1');
  const msg2 = document.getElementById('forgot-msg2');
  const step1 = document.getElementById('forgot-step1');
  const step2 = document.getElementById('forgot-step2');
  const submit = document.getElementById('forgot-submit');

  send.addEventListener('click', async () => {
    const value = (email.value || '').trim();
    msg1.hidden = true;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      msg1.hidden = false;
      msg1.textContent = '请输入正确的邮箱';
      return;
    }
    send.disabled = true;
    send.textContent = '发送中…';
    const r = await api('/auth/forgot-password', { method: 'POST', body: { email: value } });
    send.disabled = false;
    send.textContent = '发送验证码';
    if (!r.ok) {
      msg1.hidden = false;
      msg1.textContent = errText(r, '发送失败');
      return;
    }
    step1.hidden = true;
    step2.hidden = false;
    toast(r.data?.delivery === 'log' ? '验证码已生成（开发环境见服务端日志）' : '验证码已发送，请查收邮件');
  });

  submit.addEventListener('click', async () => {
    msg2.hidden = true;
    const body = {
      email: (email.value || '').trim(),
      code: (code.value || '').trim(),
      password: pass.value,
      confirmPassword: pass2.value,
    };
    if (!/^\d{6}$/.test(body.code)) { msg2.hidden = false; msg2.textContent = '验证码为 6 位数字'; return; }
    if (body.password.length < 8 || !/[A-Za-z]/.test(body.password) || !/\d/.test(body.password)) {
      msg2.hidden = false; msg2.textContent = '密码需 8-64 位，且同时包含字母和数字'; return;
    }
    if (body.password !== body.confirmPassword) { msg2.hidden = false; msg2.textContent = '两次输入的密码不一致'; return; }

    submit.disabled = true;
    submit.textContent = '提交中…';
    const r = await api('/auth/reset-password', { method: 'POST', body });
    submit.disabled = false;
    submit.textContent = '重置密码';
    if (!r.ok) {
      msg2.hidden = false;
      msg2.textContent = errText(r, '重置失败');
      return;
    }
    toast('密码已重置，请用新密码登录');
    step1.hidden = false;
    step2.hidden = true;
    if (code) code.value = '';
    if (pass) pass.value = '';
    if (pass2) pass2.value = '';
    location.hash = '#/login';
  });
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

  let pointsCache = null;
  async function refreshPoints() {
    if (!pointsCache) {
      const r = await api('/storage-points');
      pointsCache = r.ok ? (r.data.storagePoints || []) : [];
    }
    const valuable = valueSel.value === 'valuable';
    const list = pointsCache.filter((p) => !valuable || p.type === 'security');
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

  // ---- 图片上传（最多 3 张、单张 5MB、JPEG/PNG/WebP）----
  const imgInput = document.getElementById('pub-images');
  const previewBox = document.getElementById('pub-previews');
  const MAX_IMAGES = 3;
  const MAX_SIZE = 5 * 1024 * 1024;
  const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  let uploaded = [];

  function paintPreviews() {
    previewBox.replaceChildren();
    uploaded.forEach((f, i) => {
      const cell = el('div', 'pub-preview');
      const im = document.createElement('img');
      im.src = f.url;
      im.alt = '';
      cell.append(im);
      const del = el('button', 'pub-preview-del', '×');
      del.type = 'button';
      del.title = '移除这张';
      del.addEventListener('click', () => {
        uploaded.splice(i, 1);
        paintPreviews();
      });
      cell.append(del);
      previewBox.append(cell);
    });
  }

  imgInput?.addEventListener('change', async () => {
    const picked = [...imgInput.files];
    imgInput.value = '';
    if (!picked.length) return;

    if (uploaded.length + picked.length > MAX_IMAGES) {
      toast(`最多 ${MAX_IMAGES} 张图片`);
      return;
    }
    const badType = picked.find((f) => !OK_TYPES.includes(f.type));
    if (badType) { toast('只支持 JPEG / PNG / WebP'); return; }
    const tooBig = picked.find((f) => f.size > MAX_SIZE);
    if (tooBig) { toast('单张不能超过 5MB'); return; }

    const fd = new FormData();
    picked.forEach((f) => fd.append('files', f));
    previewBox.append(el('span', 'pub-hint', '上传中…'));

    const res = await fetch('/api/uploads', {
      method: 'POST',
      headers: { 'x-csrf-token': csrfToken() },
      body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      paintPreviews();
      toast(data?.error?.message || '上传失败');
      return;
    }
    uploaded = uploaded.concat(data.files || []);
    paintPreviews();
    toast(`已上传 ${data.files?.length || 0} 张`);
  });
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
      images: uploaded.map((f) => f.fileName),
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
  info.append(el('span', 'me-meta', user.email ? ('邮箱：' + user.email + (user.emailVerified ? '（已验证）' : '（未验证）')) : '邮箱：未绑定'));
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
        // 编辑内容只允许在「待存放 / 进行中」阶段（后端 patchItem 的 locked 规则：入库后关键信息不能改）
        if (it.status === 'pending_storage' || it.status === 'open') {
          const edit = el('span', 'admin-act', '编辑');
          edit.addEventListener('click', (e) => {
            e.stopPropagation();
            openEditItemDialog(it.id, pane);
          });
          row.append(edit);
        }

        // 标记找回：只针对「进行中的失物」
        if (it.type === 'lost' && it.status === 'open') {
          const done = el('span', 'admin-act', '标记找回');
          done.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm('标记为「已找回」？之后不再出现在广场的进行中列表。')) return;
            const r = await api('/items/' + encodeURIComponent(it.id), { method: 'PATCH', body: { status: 'reunited' } });
            if (!r.ok) { toast(errText(r, '操作失败')); return; }
            toast('已标记找回');
            renderPane('posts', pane);
          });
          row.append(done);
        }

        if (it.status !== 'archived' && it.status !== 'returned') {
          const down = el('span', 'admin-act muted', '下架');
          down.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm('关闭这条信息？关闭后不再出现在广场。')) return;
            const r = await api('/items/' + encodeURIComponent(it.id), { method: 'PATCH', body: { status: 'archived' } });
            if (!r.ok) { toast(errText(r, '操作失败')); return; }
            toast('已下架');
            renderPane('posts', pane);
          });
          row.append(down);
        }
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

    const r = await api('/items?fav=1&pageSize=50');
    if (!r.ok || r.data?.requiresLogin) return pane.replaceChildren(emptyBox('请先登录后查看我的收藏'));
    const favs = r.data.items || [];
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

// 已读语义（刻意如此，不是 bug）：进页面**不**自动标已读；
// 点开单条 → 本地即时标记 + POST /api/messages/:id/read；「全部标为已读」逐条 POST。
/* 编辑自己发布的信息：只改标题/地点/描述，状态变更走专门的按钮 */
async function openEditItemDialog(itemId, pane) {
  const r = await api('/items/' + encodeURIComponent(itemId));
  if (!r.ok) { toast(errText(r, '读取失败')); return; }
  const item = r.data.item;

  const mask = el('div', 'modal-mask');
  const box = el('div', 'modal');
  box.append(el('h3', null, '编辑信息'));
  box.append(el('p', 'modal-hint', '只改文字，不会改变状态；认领、入库等流程不受影响。'));

  const fields = [
    ['title', '标题', 'input', item.title || ''],
    ['location', '地点', 'input', item.location || ''],
  ];
  const inputs = {};
  fields.forEach(([key, label, kind, value]) => {
    const wrap = el('label', 'field');
    wrap.append(el('span', null, label));
    const inp = document.createElement('input');
    inp.className = 'input';
    inp.value = value;
    wrap.append(inp);
    box.append(wrap);
    inputs[key] = inp;
  });

  const descWrap = el('label', 'field');
  descWrap.append(el('span', null, '描述'));
  const ta = document.createElement('textarea');
  ta.className = 'input area';
  ta.value = item.description || '';
  descWrap.append(ta);
  box.append(descWrap);

  const msg = el('p', 'auth-msg');
  msg.hidden = true;
  box.append(msg);

  const acts = el('div', 'modal-actions');
  const cancel = el('button', 'btn btn-ghost', '取消');
  cancel.type = 'button';
  const submit = el('button', 'btn', '保存');
  submit.type = 'button';
  acts.append(cancel, submit);
  box.append(acts);
  mask.append(box);
  document.body.append(mask);

  const close = () => mask.remove();
  cancel.addEventListener('click', close);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });

  submit.addEventListener('click', async () => {
    const body = {
      title: inputs.title.value.trim(),
      location: inputs.location.value.trim(),
      description: ta.value.trim(),
    };
    if (!body.title || !body.location || !body.description) {
      msg.hidden = false;
      msg.textContent = '标题、地点、描述都不能为空';
      return;
    }
    submit.disabled = true;
    const res = await api('/items/' + encodeURIComponent(itemId), { method: 'PATCH', body });
    submit.disabled = false;
    if (!res.ok) {
      msg.hidden = false;
      msg.textContent = errText(res, '保存失败');
      return;
    }
    close();
    toast('已保存');
    if (pane) renderPane('posts', pane);
    else loadDetail(itemId);
  });
}
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
    const list = data.messages.filter((m) => {
      if (filter === 'unread') return !m.readAt;
      if (filter === 'system') return m.type === 'system';
      if (filter === 'claim') return m.type === 'claim' || m.type === 'match';
      return true;
    });
    const EMPTY_TEXT = { unread: '没有未读消息', system: '没有系统消息', claim: '没有认领或匹配消息' };
    pane.replaceChildren();
    if (!list.length) {
      pane.append(emptyBox(EMPTY_TEXT[filter] || '还没有消息'));
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

  [['all', '全部'], ['unread', '未读'], ['system', '系统'], ['claim', '认领']].forEach(([k, label], i) => {
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

/* ---------- 管理后台 ---------- */
let adminUserQuery = ''; // 用户搜索关键词（跨重渲染保留）
const ADMIN_KPIS = [
  ['users', '注册用户'],
  ['volunteers', '志愿者'],
  ['items', '信息总数'],
  ['inProgress', '进行中'],
  ['pendingStorage', '待入库'],
  ['pendingClaims', '待审认领'],
  ['returned', '已归还'],
  ['unreadMessages', '未读消息'],
];

async function loadAdmin(tab) {
  const root = document.getElementById('admin-root');
  if (!root) return;
  root.replaceChildren(el('div', 'skeleton'));

  const meRes = await api('/me');
  if (!meRes.ok) {
    root.replaceChildren(emptyBox('请先登录后再进入后台'));
    location.hash = '#/login';
    return;
  }
  if (meRes.data.user.role !== 'admin') {
    root.replaceChildren(emptyBox('这个页面需要管理员权限'));
    return;
  }

  const page = el('div', 'admin-page');
  const tabs = el('div', 'admin-tabs');
  const pane = el('div', 'admin-pane');

  const TABS = [['overview', '概览'], ['claims', '审核'], ['items', '信息'], ['users', '用户'], ['points', '存放点'], ['data', '数据']];
  const show = (key) => {
    [...tabs.children].forEach((b) => b.classList.toggle('on', b.dataset.tab === key));
    pane.replaceChildren(el('div', 'skeleton'));
    renderAdminPane(key, pane);
  };
  TABS.forEach(([key, label], i) => {
    const b = el('button', i === 0 ? 'on' : '', label);
    b.type = 'button'; b.dataset.tab = key;
    b.addEventListener('click', () => show(key));
    tabs.append(b);
  });

  page.append(tabs, pane);
  root.replaceChildren(page);
  show(TABS.some(([k]) => k === tab) ? tab : 'overview');
}

function adminTable(headers, rows, renderRow) {
  const wrap = el('div', 'admin-table-wrap');
  const table = el('table', 'admin-table');
  const head = document.createElement('tr');
  headers.forEach((t) => head.append(el('th', null, t)));
  table.append(head);
  rows.forEach((r) => table.append(renderRow(r)));
  wrap.append(table);
  return wrap;
}

function adminAct(label, handler, muted) {
  const s = el('span', `admin-act${muted ? ' muted' : ''}`, label);
  s.addEventListener('click', handler);
  return s;
}

async function renderAdminPane(key, pane) {
  try {
    if (key === 'overview') {
      const r = await api('/admin/overview');
      if (!r.ok) return pane.replaceChildren(emptyBox('概览加载失败'));
      const grid = el('div', 'admin-kpis');
      ADMIN_KPIS.forEach(([k, label]) => {
        const box = el('div', 'admin-kpi');
        box.append(el('span', null, label));
        box.append(el('b', null, String(r.data[k] ?? 0)));
        grid.append(box);
      });
      const bar = el('div', 'admin-bar');
      bar.append(adminAct('+ 群发系统消息', () => openBroadcastDialog(pane)));
      const box = el('div', 'admin-page');
      box.append(grid, bar);
      pane.replaceChildren(box);
      return;
    }

    if (key === 'claims') {
      const r = await api('/admin/claims?status=pending');
      if (!r.ok) return pane.replaceChildren(emptyBox('审核列表加载失败'));
      const rows = r.data.claims || [];
      if (!rows.length) return pane.replaceChildren(emptyBox('没有待审核的认领申请'));

      pane.replaceChildren(adminTable(['物品', '申请人', '申请说明', '提交时间', '操作'], rows, (c) => {
        const tr = document.createElement('tr');
        const t1 = document.createElement('td');
        t1.append(el('div', 't', c.itemTitle || ''));
        t1.append(el('div', 'sub', c.itemId || ''));
        tr.append(t1);
        tr.append(el('td', 'sub', c.applicantName || ''));
        const t3 = document.createElement('td');
        t3.append(el('div', 'sub', c.note || ''));
        if (c.publisherVerdict) t3.append(el('div', 'sub', '发布者表态：' + (c.publisherVerdict === 'agree' ? '同意' : '拒绝')));
        tr.append(t3);
        tr.append(el('td', 'sub', fmtTime(c.createdAt)));
        const t5 = document.createElement('td');
        t5.append(adminAct('确认发放', () => adminDecideClaim(c.id, 'approve', pane)));
        t5.append(adminAct('不予认领', () => adminDecideClaim(c.id, 'reject', pane), true));
        tr.append(t5);
        return tr;
      }));
      return;
    }

    if (key === 'items') {
      const r = await api('/admin/items?status=all');
      if (!r.ok) return pane.replaceChildren(emptyBox('信息列表加载失败'));
      const rows = r.data.items || [];
      if (!rows.length) return pane.replaceChildren(emptyBox('还没有信息'));

      pane.replaceChildren(adminTable(['信息', '类型', '状态', '地点', '发布者', '操作'], rows, (it) => {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.append(el('div', 't', it.title || '未命名'));
        td.append(el('div', 'sub', it.category || ''));
        tr.append(td);
        tr.append(el('td', null, it.type === 'lost' ? '失物' : '招领'));
        const tdStatus = document.createElement('td');
        const map = STATUS_MAP[it.type] || {};
        const [label, tone] = map[it.status] || [it.status, 'muted'];
        tdStatus.append(el('span', `status ${tone}`, label));
        tr.append(tdStatus);
        tr.append(el('td', 'sub', it.location || ''));
        tr.append(el('td', 'sub', it.author?.name || ''));
        const acts = document.createElement('td');
        if (it.status === 'pending_storage') {
          acts.append(adminAct('确认入库', () => adminPatchItem(it.id, 'stored', pane)));
        }
        acts.append(adminAct('下架', () => adminPatchItem(it.id, 'archived', pane), true));
        tr.append(acts);
        return tr;
      }));
      return;
    }

    if (key === 'users') {
      const bar = el('div', 'admin-bar');
      const qInput = document.createElement('input');
      qInput.className = 'input admin-search';
      qInput.placeholder = '搜学号 / 邮箱 / 姓名';
      qInput.value = adminUserQuery;
      let timer = null;
      qInput.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          adminUserQuery = qInput.value.trim();
          renderAdminPane('users', pane);
        }, 260);
      });
      bar.append(qInput);
      if (adminUserQuery) {
        bar.append(adminAct('清空', () => { adminUserQuery = ''; renderAdminPane('users', pane); }, true));
      }

      const r = await api('/admin/users' + (adminUserQuery ? '?q=' + encodeURIComponent(adminUserQuery) : ''));
      if (!r.ok) return pane.replaceChildren(emptyBox('用户列表加载失败'));
      const rows = r.data.users || [];
      const me = currentUser;

      const table = rows.length
        ? adminTable(['姓名', '学号', '角色', '状态', '发布数', '操作'], rows, (u) => {
          const tr = document.createElement('tr');
          tr.append(el('td', 't', u.name || ''));
          tr.append(el('td', 'sub', u.studentId || ''));
          tr.append(el('td', 'sub', ROLE_TEXT[u.role] || u.role));
          tr.append(el('td', 'sub', u.status === 'disabled' ? '已停用' : '正常'));
          tr.append(el('td', 'sub', String(u.itemCount ?? '')));

          const acts = document.createElement('td');
          const isAdminRow = u.role === 'admin';
          if (!isAdminRow) {
            if (u.role === 'volunteer') {
              acts.append(adminAct('取消志愿者', () => adminSetVolunteer(u, false, pane)));
            } else {
              acts.append(adminAct('设为志愿者', () => openVolunteerDialog(u, pane)));
            }
            acts.append(adminAct('重置密码', () => adminResetPassword(u, pane)));
            if (u.id === me?.id) {
              acts.append(adminAct('停用', () => {}, true));
            } else if (u.status === 'disabled') {
              acts.append(adminAct('启用', () => adminSetStatus(u.id, 'active', pane)));
            } else {
              acts.append(adminAct('停用', () => adminSetStatus(u.id, 'disabled', pane), true));
            }
          }
          tr.append(acts);
          return tr;
        })
        : emptyBox(adminUserQuery ? '没有匹配的用户' : '还没有用户');

      const wrap = el('div', 'admin-page');
      wrap.append(bar, table);
      pane.replaceChildren(wrap);
      return;
    }
    if (key === 'data') {
      renderDataPane(pane);
      return;
    }

    // 存放点
    const r = await api('/admin/storage-points');
    if (!r.ok) return pane.replaceChildren(emptyBox('存放点加载失败'));
    const rows = r.data.storagePoints || [];

    const headBar = el('div', 'admin-bar');
    headBar.append(adminAct('+ 新增存放点', () => openPointDialog(pane)));
    const table = adminTable(['序', '名称', '类型', '地址', '时间', '在库', '状态', '操作'], rows, (p) => {
      const tr = document.createElement('tr');
      tr.append(el('td', 'sub', String(p.sortOrder ?? 0)));
      tr.append(el('td', 't', p.name || ''));
      tr.append(el('td', 'sub', p.type === 'security' ? '保卫处' : '普通'));
      tr.append(el('td', 'sub', p.address || ''));
      tr.append(el('td', 'sub', p.hours || ''));
      tr.append(el('td', 'sub', String(p.itemCount ?? 0)));
      tr.append(el('td', 'sub', p.enabled === false ? '已停用' : '启用中'));
      const acts = document.createElement('td');
      const pos = rows.indexOf(p);
      acts.append(adminAct('↑', () => adminMovePoint(rows, pos, -1, pane), pos === 0));
      acts.append(adminAct('↓', () => adminMovePoint(rows, pos, 1, pane), pos === rows.length - 1));
      acts.append(adminAct(p.enabled === false ? '启用' : '停用',
        () => adminTogglePoint(p.id, p.enabled === false, pane), p.enabled !== false));
      tr.append(acts);
      return tr;
    });

    const box = el('div', 'admin-page');
    box.append(headBar, table);
    pane.replaceChildren(box);
  } catch (err) {
    console.warn('[湘寻] 后台加载失败：', err.message);
    pane.replaceChildren(emptyBox('加载失败，稍后再试'));
  }
}

/* ---------- 管理后台操作 ---------- */
async function adminPatchItem(id, status, pane) {
  const r = await api('/items/' + encodeURIComponent(id), { method: 'PATCH', body: { status } });
  if (!r.ok) return toast(errText(r, '操作失败'));
  toast(status === 'stored' ? '已确认入库' : '已下架');
  renderAdminPane('items', pane);
}

async function adminDecideClaim(id, decision, pane) {
  const r = await api('/claims/' + encodeURIComponent(id) + '/decision', { method: 'POST', body: { decision } });
  if (!r.ok) return toast(errText(r, '操作失败'));
  toast(decision === 'approve' ? '已确认发放' : '已驳回');
  renderAdminPane('claims', pane);
}

async function adminSetVolunteer(user, enabled, pane, storagePointIds) {
  const body = enabled ? { enabled: true, storagePointIds: storagePointIds || [] } : { enabled: false };
  const r = await api('/admin/users/' + encodeURIComponent(user.id) + '/volunteer', { method: 'POST', body });
  if (!r.ok) return toast(errText(r, '操作失败'));
  toast(enabled ? '已设为志愿者' : '已取消志愿者');
  renderAdminPane('users', pane);
}

async function adminSetStatus(userId, status, pane) {
  if (status === 'disabled' && !confirm('停用后该用户会被强制退出所有会话，确定吗？')) return;
  const r = await api('/admin/users/' + encodeURIComponent(userId) + '/status', { method: 'POST', body: { status } });
  if (!r.ok) return toast(errText(r, '操作失败'));
  toast(status === 'disabled' ? '已停用' : '已启用');
  renderAdminPane('users', pane);
}

async function adminTogglePoint(id, enabled, pane) {
  const r = await api('/admin/storage-points/' + encodeURIComponent(id), { method: 'PATCH', body: { enabled } });
  if (!r.ok) return toast(errText(r, '操作失败'));
  toast(enabled ? '已启用' : '已停用');
  renderAdminPane('points', pane);
}

/* ---------- 后台弹窗 ---------- */
function adminModal(title, hint, fields, onSubmit) {
  const mask = el('div', 'modal-mask');
  const box = el('div', 'modal');
  box.append(el('h3', null, title));
  if (hint) box.append(el('p', 'modal-hint', hint));

  const inputs = {};
  fields.forEach((f) => {
    const wrap = el('label', 'field');
    wrap.append(el('span', null, f.label));
    if (f.type === 'select') {
      const s = document.createElement('select');
      s.className = 'input';
      f.options.forEach(([v, t]) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = t; s.append(o);
      });
      wrap.append(s);
      inputs[f.key] = s;
    } else {
      const i = document.createElement('input');
      i.className = 'input';
      i.type = f.type || 'text';
      i.placeholder = f.placeholder || '';
      wrap.append(i);
      inputs[f.key] = i;
    }
    box.append(wrap);
  });

  const msg = el('p', 'auth-msg');
  msg.hidden = true;
  box.append(msg);

  const acts = el('div', 'modal-actions');
  const cancel = el('button', 'btn btn-ghost', '取消');
  cancel.type = 'button';
  const submit = el('button', 'btn', '确定');
  submit.type = 'button';
  acts.append(cancel, submit);
  box.append(acts);
  mask.append(box);
  document.body.append(mask);

  const close = () => mask.remove();
  cancel.addEventListener('click', close);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });

  submit.addEventListener('click', async () => {
    const data = {};
    Object.keys(inputs).forEach((k) => { data[k] = inputs[k].value.trim(); });
    submit.disabled = true;
    const res = await onSubmit(data);
    submit.disabled = false;
    if (res && res.ok === false) {
      msg.hidden = false;
      msg.textContent = res.message || '操作失败';
      return;
    }
    close();
  });
}

function openVolunteerDialog(user, pane) {
  const mask = el('div', 'modal-mask');
  const box = el('div', 'modal');
  box.append(el('h3', null, '设为志愿者：' + (user.name || user.studentId)));
  box.append(el('p', 'modal-hint', '选择他能确认入库的存放点（可多选）。'));

  const listBox = el('div', 'vol-list');
  box.append(listBox);

  const acts = el('div', 'modal-actions');
  const cancel = el('button', 'btn btn-ghost', '取消');
  cancel.type = 'button';
  const submit = el('button', 'btn', '保存');
  submit.type = 'button';
  acts.append(cancel, submit);
  box.append(acts);
  mask.append(box);
  document.body.append(mask);

  const close = () => mask.remove();
  cancel.addEventListener('click', close);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });

  api('/admin/storage-points').then((r) => {
    const points = r.ok ? (r.data.storagePoints || []) : [];
    if (!points.length) return listBox.append(el('p', 'modal-hint', '还没有存放点，先去「存放点」页签新增'));
    points.forEach((p) => {
      const row = el('label', 'vol-item');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = p.id;
      row.append(cb, el('span', null, p.name + (p.type === 'security' ? '（保卫处）' : '')));
      listBox.append(row);
    });
  });

  submit.addEventListener('click', async () => {
    const ids = [...listBox.querySelectorAll('input:checked')].map((c) => c.value);
    if (!ids.length) { toast('至少选一个存放点'); return; }
    submit.disabled = true;
    await adminSetVolunteer(user, true, pane, ids);
    submit.disabled = false;
    close();
  });
}

function openPointDialog(pane) {
  adminModal('新增存放点', '「保卫处」类型的存放点可以存贵重物品，普通存放点不行。', [
    { key: 'name', label: '名称', placeholder: '如：图书馆一楼服务台' },
    { key: 'type', label: '类型', type: 'select', options: [['normal', '普通'], ['security', '保卫处（可存贵重物品）']] },
    { key: 'address', label: '地址', placeholder: '如：图书馆一层东侧' },
    { key: 'hours', label: '营业时间', placeholder: '如：08:00-22:00' },
    { key: 'contactName', label: '联系人', placeholder: '如：张老师' },
    { key: 'contactPhone', label: '联系电话', placeholder: '可选' },
  ], async (data) => {
    if (!data.name) return { ok: false, message: '名称不能为空' };
    const r = await api('/admin/storage-points', { method: 'POST', body: data });
    if (!r.ok) return { ok: false, message: errText(r, '新增失败') };
    toast('已新增存放点');
    renderAdminPane('points', pane);
    return { ok: true };
  });
}
/* ---------- 认领：申请与审核 ---------- */
function openClaimDialog(item, onDone) {
  const mask = el('div', 'modal-mask');
  const box = el('div', 'modal');
  box.append(el('h3', null, '申请认领'));
  box.append(el('p', 'modal-hint', '写下 2 项以上只有失主才知道的特征（划痕、贴纸、内容物）。发布者核对通过后，才会向双方开放联系方式。'));

  const ta = document.createElement('textarea');
  ta.className = 'input area';
  ta.placeholder = '至少 10 个字，例如：盒盖内侧贴了一张动漫贴纸，右耳塞有轻微磨损';
  box.append(ta);

  const msg = el('p', 'auth-msg');
  msg.hidden = true;
  box.append(msg);

  const actions = el('div', 'modal-actions');
  const cancel = el('button', 'btn btn-ghost', '取消');
  cancel.type = 'button';
  const submit = el('button', 'btn', '提交申请');
  submit.type = 'button';
  actions.append(cancel, submit);
  box.append(actions);
  mask.append(box);
  document.body.append(mask);
  ta.focus();

  const close = () => mask.remove();
  cancel.addEventListener('click', close);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });

  submit.addEventListener('click', async () => {
    const note = ta.value.trim();
    if (note.length < 10) {
      msg.hidden = false;
      msg.textContent = '至少写 10 个字，写清特征更容易通过';
      return;
    }
    submit.disabled = true;
    submit.textContent = '提交中…';
    const r = await api('/items/' + encodeURIComponent(item.id) + '/claims', { method: 'POST', body: { note } });
    submit.disabled = false;
    submit.textContent = '提交申请';
    if (!r.ok) {
      msg.hidden = false;
      msg.textContent = errText(r, '提交失败');
      return;
    }
    close();
    toast('已提交认领申请，等待核对');
    if (onDone) onDone();
  });
}

async function loadClaimList(itemId, box) {
  const r = await api('/items/' + encodeURIComponent(itemId) + '/claims');
  if (!r.ok) { box.replaceChildren(el('p', 'modal-hint', '申请列表加载失败')); return; }

  const data = r.data;
  const list = data.claims || [];
  if (!list.length) {
    box.replaceChildren(el('p', 'modal-hint', '还没有人申请认领'));
    return;
  }

  const isReviewer = Boolean(data.canReview);
  box.replaceChildren();

  list.forEach((c) => {
    const row = el('div', 'claim-row');
    const head = el('div', 'claim-head');
    head.append(el('b', null, c.isMine ? '我的申请' : (c.applicantName || '申请人')));
    const tone = c.status === 'pending' ? 'sand' : c.status === 'approved' ? 'olive' : 'muted';
    const text = c.status === 'pending' ? '待处理' : c.status === 'approved' ? '已通过' : '已驳回';
    head.append(el('span', `status ${tone}`, text));
    row.append(head);
    row.append(el('p', 'claim-note', c.note || ''));
    if (c.reviewNote) row.append(el('p', 'claim-note warn', '处理意见：' + c.reviewNote));

    if (c.status === 'pending' && !c.isMine) {
      const acts = el('div', 'claim-acts');
      const agree = el('span', 'admin-act', isReviewer ? '最终通过' : '同意');
      const reject = el('span', 'admin-act muted', '拒绝');
      agree.addEventListener('click', () => decideClaim(c.id, isReviewer ? 'approve' : 'agree', itemId));
      reject.addEventListener('click', () => decideClaim(c.id, 'reject', itemId));
      acts.append(agree, reject);
      row.append(acts);
    } else if (c.publisherVerdict) {
      row.append(el('p', 'claim-note', '发布者表态：' + (c.publisherVerdict === 'agree' ? '同意' : '拒绝')));
    }

    box.append(row);
  });
}

async function decideClaim(claimId, decision, itemId) {
  const r = await api('/claims/' + encodeURIComponent(claimId) + '/decision', {
    method: 'POST',
    body: { decision },
  });
  if (!r.ok) {
    toast(errText(r, '操作失败'));
    return;
  }
  toast(decision === 'reject' ? '已拒绝' : '已确认');
  if (itemId) loadDetail(itemId);
}

/* ---------- P2：重置密码 + 群发消息 ---------- */
async function adminResetPassword(user, pane) {
  if (!confirm(`给「${user.name || user.studentId}」发送重置密码邮件？\n验证码 15 分钟内有效。`)) return;
  const r = await api('/admin/users/' + encodeURIComponent(user.id) + '/reset-password', { method: 'POST' });
  if (!r.ok) {
    toast(errText(r, '发送失败'));
    return;
  }
  const d = r.data || {};
  if (d.delivery === 'log') {
    toast('已生成验证码（开发环境：见服务端日志）');
  } else if (d.cooldown) {
    toast(`刚发过，请 ${d.cooldown} 秒后再试`);
  } else {
    toast('重置邮件已发送');
  }
  renderAdminPane('users', pane);
}

async function adminCountRecipients(role) {
  const r = await api('/admin/users');
  if (!r.ok) return null;
  const list = (r.data.users || []).filter((u) => u.status !== 'disabled');
  if (role === 'all') return list.length;
  return list.filter((u) => u.role === role).length;
}

function openBroadcastDialog(pane) {
  const mask = el('div', 'modal-mask');
  const box = el('div', 'modal');
  box.append(el('h3', null, '群发系统消息'));
  box.append(el('p', 'modal-hint', '会以「系统消息」的形式进入每个收件人的消息中心，已停用的账号不会收到。'));

  const roleWrap = el('label', 'field');
  roleWrap.append(el('span', null, '收件人'));
  const roleSel = document.createElement('select');
  roleSel.className = 'input';
  [['all', '全部用户'], ['student', '仅学生'], ['volunteer', '仅志愿者'], ['admin', '仅管理员']].forEach(([v, t]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = t; roleSel.append(o);
  });
  roleWrap.append(roleSel);
  box.append(roleWrap);

  const titleWrap = el('label', 'field');
  titleWrap.append(el('span', null, '标题'));
  const titleInput = document.createElement('input');
  titleInput.className = 'input';
  titleInput.placeholder = '1-60 字';
  titleWrap.append(titleInput);
  box.append(titleWrap);

  const bodyWrap = el('label', 'field');
  bodyWrap.append(el('span', null, '正文'));
  const bodyInput = document.createElement('textarea');
  bodyInput.className = 'input area';
  bodyInput.placeholder = '1-1000 字';
  bodyWrap.append(bodyInput);
  box.append(bodyWrap);

  const count = el('p', 'modal-hint');
  count.textContent = '正在统计收件人…';
  box.append(count);

  const msg = el('p', 'auth-msg');
  msg.hidden = true;
  box.append(msg);

  const acts = el('div', 'modal-actions');
  const cancel = el('button', 'btn btn-ghost', '取消');
  cancel.type = 'button';
  const submit = el('button', 'btn', '发送');
  submit.type = 'button';
  acts.append(cancel, submit);
  box.append(acts);
  mask.append(box);
  document.body.append(mask);

  const close = () => mask.remove();
  cancel.addEventListener('click', close);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });

  const refreshCount = async () => {
    const n = await adminCountRecipients(roleSel.value);
    count.textContent = n === null ? '收件人统计失败，仍可发送' : `将发送给 ${n} 人`;
  };
  roleSel.addEventListener('change', refreshCount);
  refreshCount();

  submit.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    const text = bodyInput.value.trim();
    if (title.length < 1 || title.length > 60) { msg.hidden = false; msg.textContent = '标题需 1-60 字'; return; }
    if (text.length < 1 || text.length > 1000) { msg.hidden = false; msg.textContent = '正文需 1-1000 字'; return; }
    if (!confirm(`确定发送「${title}」给 ${count.textContent.replace('将发送给 ', '')} 吗？`)) return;

    submit.disabled = true;
    submit.textContent = '发送中…';
    const r = await api('/admin/messages', { method: 'POST', body: { role: roleSel.value, title, body: text } });
    submit.disabled = false;
    submit.textContent = '发送';
    if (!r.ok) { msg.hidden = false; msg.textContent = errText(r, '发送失败'); return; }
    close();
    toast(`已发送给 ${r.data.recipients} 人`);
    renderAdminPane('overview', pane);
  });
}

/* ---------- 数据页签：恢复演示 / 导出统计 / 重算匹配 ---------- */
async function renderDataPane(pane) {
  const box = el('div', 'admin-page');
  const bar = el('div', 'admin-bar');
  bar.append(
    adminAct('重新计算匹配', () => adminRecomputeMatches(pane)),
    adminAct('导出统计', () => adminShowStats(pane)),
    adminAct('恢复演示数据', () => adminResetDemo(pane), true),
  );
  box.append(bar);
  box.append(el('p', 'modal-hint', '「重新计算匹配」只重跑规则打分，不改物品状态；「恢复演示数据」会清空业务表并重新播种，操作前会二次确认。'));

  const r = await api('/admin/stats');
  if (!r.ok) {
    box.append(emptyBox('统计加载失败'));
    pane.replaceChildren(box);
    return;
  }
  const s = r.data;
  const grid = el('div', 'admin-kpis');
  const push = (label, value) => {
    const cell = el('div', 'admin-kpi');
    cell.append(el('span', null, label));
    cell.append(el('b', null, String(value)));
    grid.append(cell);
  };
  push('信息总数', (s.items?.byStatus || []).reduce((a, x) => a + x.c, 0));
  push('认领总数', (s.claims || []).reduce((a, x) => a + x.c, 0));
  push('用户总数', (s.users || []).reduce((a, x) => a + x.c, 0));
  box.append(grid);

  const sections = [
    ['按状态', s.items?.byStatus],
    ['按分类', s.items?.byCategory],
    ['按类型', s.items?.byType],
    ['认领状态', s.claims],
    ['近 7 日新增', s.daily],
    ['用户角色', s.users],
  ];
  sections.forEach(([title, list]) => {
    if (!Array.isArray(list) || !list.length) return;
    box.append(el('h3', 'admin-sub', title));
    const rows = list.map((x) => {
      const key = x.status || x.category || x.type || x.day || x.role || '';
      return `${key}：${x.c}`;
    });
    box.append(el('p', 'modal-hint', rows.join('　|　')));
  });

  const dl = el('button', 'btn btn-ghost btn-sm', '下载 JSON');
  dl.type = 'button';
  dl.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'xiangfind-stats-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast('已导出 JSON');
  });
  box.append(dl);
  pane.replaceChildren(box);
}

async function adminShowStats(pane) {
  renderDataPane(pane);
}

async function adminRecomputeMatches(pane) {
  if (!confirm('重新计算全部匹配？只重跑打分与通知，不改物品状态。')) return;
  const r = await api('/admin/recompute-matches', { method: 'POST' });
  if (!r.ok) { toast(errText(r, '重算失败')); return; }
  const d = r.data || {};
  toast(`已重算：扫描 ${d.scanned ?? 0}，更新 ${d.recomputed ?? 0}，跳过 ${d.skipped ?? 0}`);
  if (Array.isArray(d.failures) && d.failures.length) {
    console.warn('[湘寻] 重算失败项：', d.failures);
  }
}

async function adminResetDemo(pane) {
  if (!confirm('恢复演示数据会清空当前所有业务数据（物品、认领、消息、收藏），只保留账号。确定吗？')) return;
  if (!confirm('再确认一次：这是不可撤销的操作，演示前才用。继续？')) return;
  const r = await api('/admin/reset-demo', { method: 'POST' });
  if (!r.ok) { toast(errText(r, '恢复失败')); return; }
  toast('演示数据已恢复');
  renderDataPane(pane);
}

/* 上移/下移：和相邻项交换 sortOrder */
async function adminMovePoint(rows, pos, delta, pane) {
  const target = pos + delta;
  if (target < 0 || target >= rows.length) return;
  const a = rows[pos];
  const b = rows[target];
  const aOrder = Number(a.sortOrder) || 0;
  const bOrder = Number(b.sortOrder) || 0;
  const r1 = await api('/admin/storage-points/' + encodeURIComponent(a.id), { method: 'PATCH', body: { sortOrder: bOrder } });
  if (!r1.ok) { toast(errText(r1, '排序失败')); return; }
  const r2 = await api('/admin/storage-points/' + encodeURIComponent(b.id), { method: 'PATCH', body: { sortOrder: aOrder } });
  if (!r2.ok) { toast(errText(r2, '排序失败')); return; }
  toast('已调整顺序');
  renderAdminPane('points', pane);
}
