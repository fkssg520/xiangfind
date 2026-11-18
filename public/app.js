// 湘寻 · 前端入口
// 当前阶段：单页外壳 + 广场页（mock 数据）
// 契约：docs/API契约.md　样例：docs/fixtures/items.json
// 切换真实接口时只改 API_PREFIX，不改字段映射。

const API_PREFIX = ''; // 例：'' = 同源；'/api' = 后端前缀。mock 阶段留空。
const MOCK = {
  items: 'mock/items.json',
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
  const { name } = parseHash();

  document.querySelectorAll('.view').forEach((el) => {
    el.classList.toggle('on', el.id === `view-${name}`);
  });

  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.classList.toggle('on', a.dataset.nav === name);
  });

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
