// 湘寻 · 前端入口
// 当前阶段：单页外壳 + 广场页（mock 数据）
// 契约：docs/API契约.md　样例：docs/fixtures/items.json
// 切换真实接口时只改 API_PREFIX，不改字段映射。

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
const state = { type: 'all', q: '', category: 'all', items: [], loaded: false };

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

function filtered() {
  const q = state.q.trim().toLowerCase();
  return state.items.filter((it) => {
    if (state.type !== 'all' && it.type !== state.type) return false;
    if (state.category !== 'all' && it.category !== state.category) return false;
    if (!q) return true;
    const hay = [it.title, it.summary, it.location, it.category].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function renderPlaza() {
  const grid = document.getElementById('plaza-grid');
  const empty = document.getElementById('plaza-empty');
  if (!grid) return;

  grid.replaceChildren();

  if (!state.loaded) {
    for (let i = 0; i < 3; i += 1) grid.append(el('div', 'skeleton'));
    empty.hidden = true;
    return;
  }

  const list = filtered();
  list.forEach((item) => grid.append(cardOf(item)));
  empty.hidden = list.length > 0;
}

function renderCategories() {
  const box = document.getElementById('cats');
  if (!box) return;

  const cats = [...new Set(state.items.map((i) => i.category).filter(Boolean))];
  box.replaceChildren();

  const all = el('button', state.category === 'all' ? 'on' : '', '全部类别');
  all.type = 'button';
  all.addEventListener('click', () => { state.category = 'all'; renderCategories(); renderPlaza(); });
  box.append(all);

  cats.forEach((c) => {
    const b = el('button', state.category === c ? 'on' : '', c);
    b.type = 'button';
    b.addEventListener('click', () => {
      state.category = state.category === c ? 'all' : c;
      renderCategories();
      renderPlaza();
    });
    box.append(b);
  });
}

async function loadItems() {
  try {
    const res = await fetch(`${API_PREFIX}${MOCK.items}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.items = Array.isArray(data.items) ? data.items : [];
  } catch (err) {
    console.warn('[湘寻] mock 加载失败，使用空列表：', err.message);
    state.items = [];
  }
  state.loaded = true;
  renderCategories();
  renderPlaza();
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
    renderPlaza();
  });

  const q = document.getElementById('q');
  let timer = null;
  q?.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = q.value; renderPlaza(); }, 180);
  });

  document.getElementById('search-btn')?.addEventListener('click', () => {
    state.q = q?.value || '';
    renderPlaza();
  });
}

/* ---------- 启动 ---------- */
renderRoute();
bindPlaza();
setUnread(3); // mock：等 /api/messages 就绪后改为真实 unreadCount
loadItems();

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
