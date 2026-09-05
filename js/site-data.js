/* ============================================
   超级念 - 全站共享数据层
   管理员后台(admin.html)与前台(index.html)共用
   存储位置：浏览器 localStorage（同域名下前后台实时同步）
   说明：纯静态站点的演示级方案。跨设备发布时，
   在后台「数据管理 → 导出配置」下载 JSON，替换仓库同名文件即可。
   ============================================ */

const SITE_DATA_KEY = 'yn_site_data';
const SITE_USERS_KEY = 'yn_users';
const SITE_ORDERS_KEY = 'yn_orders';

// ===== 默认数据（首次自动写入） =====
const DEFAULT_SITE_DATA = {
  products: [
    { id: 'p1', name: 'AI 团圆时刻', price: '9.9', sold: 328, emoji: '👨‍👩‍👧‍👦', img: '', brief: '让一家人在视频里重新团圆',
      detail: '上传家人照片，AI 生成一段温暖的"团圆视频"：全家人围坐一桌，说说笑笑。\n\n· 高清 1080P 成片\n· 3-5 分钟自动生成\n· 支持导出保存/分享到朋友圈' },
    { id: 'p2', name: '时光信使', price: '9.9', sold: 328, emoji: '💌', img: '', brief: '把没来得及说的话，寄给思念的人',
      detail: '写下你想说的话，AI 让 TA 用熟悉的声音读给你听。\n\n· 支持手写/语音输入\n· 声音复刻还原度高\n· 生成后可反复收听' },
    { id: 'p3', name: '回忆重现', price: '9.9', sold: 328, emoji: '🖼️', img: '', brief: '让老照片动起来',
      detail: '上传一张老照片，AI 让照片里的人微笑、眨眼、转头，重现记忆中的样子。\n\n· 支持 10 秒动态照片\n· 自定义动作模板\n· 生成后可发起实时通话' },
    { id: 'p4', name: '思念相册', price: '9.9', sold: 328, emoji: '💐', img: '', brief: '把思念做成一本会动的相册',
      detail: '多张照片自动剪辑成纪念相册视频，配乐、转场、字幕一键生成。\n\n· 最多 30 张照片\n· 多款纪念模板\n· 适合生日/纪念日发布' }
  ],
  serviceQr: '',   // 客服二维码（base64，后台上传）
  serviceText: '工作时间 9:00 - 21:00，添加客服微信一对一解答',
  coopImg: '',     // 合作联系图片（base64，后台上传）
  coopText: '商务合作请扫码添加微信，或发送邮件至 biz@chaojinian.com',
  agents: []       // 代理：{id, name, account, rate, createdAt}
};

// ===== 读写站点配置 =====
function loadSiteData() {
  try {
    const saved = JSON.parse(localStorage.getItem(SITE_DATA_KEY) || '{}');
    const d = Object.assign(JSON.parse(JSON.stringify(DEFAULT_SITE_DATA)), saved);
    if (!Array.isArray(d.products)) d.products = JSON.parse(JSON.stringify(DEFAULT_SITE_DATA.products));
    if (!Array.isArray(d.agents)) d.agents = [];
    return d;
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_SITE_DATA));
  }
}
function saveSiteData(d) {
  try { localStorage.setItem(SITE_DATA_KEY, JSON.stringify(d)); return true; } catch (e) { return false; }
}
let siteData = loadSiteData();
function persistSiteData() { siteData && saveSiteData(siteData); }

// ===== 会员 =====
function getUsers() {
  try { return JSON.parse(localStorage.getItem(SITE_USERS_KEY) || '[]'); } catch (e) { return []; }
}
function saveUsers(u) {
  try { localStorage.setItem(SITE_USERS_KEY, JSON.stringify(u)); return true; } catch (e) { return false; }
}

// ===== 订单 =====
function getOrders() {
  try { return JSON.parse(localStorage.getItem(SITE_ORDERS_KEY) || '[]'); } catch (e) { return []; }
}
function saveOrders(o) {
  try { localStorage.setItem(SITE_ORDERS_KEY, JSON.stringify(o)); return true; } catch (e) { return false; }
}
function genOrderNo() {
  const d = new Date();
  const p = (n, l) => String(n).padStart(l, '0');
  return 'SN' + d.getFullYear() + p(d.getMonth() + 1, 2) + p(d.getDate(), 2) + p(d.getHours(), 2) + p(d.getMinutes(), 2) + p(d.getSeconds(), 2) + p(Math.floor(Math.random() * 9000) + 1000, 4);
}
function addOrder(o) {
  const list = getOrders();
  const order = Object.assign({
    id: 'o' + Date.now() + Math.floor(Math.random() * 1000),
    no: genOrderNo(),
    account: '（未登录）',
    type: '充值',
    title: '',
    amount: '0',
    credits: 0,
    channel: '微信支付',
    status: 'paid',
    createdAt: Date.now()
  }, o);
  list.unshift(order);
  saveOrders(list.slice(0, 500));
  return order;
}

// ===== 首次初始化演示数据 =====
(function seedDemo() {
  if (!localStorage.getItem(SITE_USERS_KEY)) {
    const now = Date.now();
    const DAY = 86400000;
    const names = ['瑶瑶', '阿哲', '小雨', '思远', '朵朵', '志强', '婷婷', '浩然'];
    const users = names.map((n, i) => ({
      id: 'u' + (1001 + i),
      account: (i % 2 === 0 ? '1' : '15') + String(13800000000 + i * 73521).slice(1),
      nickname: n,
      balance: [120, 50, 860, 320, 50, 1980, 70, 540][i],
      status: 'active',
      agentId: i < 3 ? 'a1' : (i < 6 ? 'a2' : ''),
      createdAt: now - (i + 1) * DAY * 3
    }));
    saveUsers(users);
  }
  if (!localStorage.getItem(SITE_ORDERS_KEY)) {
    const now = Date.now();
    const HOUR = 3600000;
    const demos = [];
    const titles = ['念想值充值', '念想值充值', '商城-时光信使', '念想值充值', '商城-思念相册', '念想值充值'];
    const amounts = ['9.9', '30', '9.9', '98', '9.9', '598'];
    const credits = [50, 200, 0, 800, 0, 5000];
    for (let i = 0; i < 12; i++) {
      const k = i % titles.length;
      demos.push({
        id: 'o_seed_' + i,
        no: genOrderNo(),
        account: i % 2 === 0 ? '11380000001' : '15138000735',
        type: titles[k].indexOf('商城') === 0 ? '商城' : '充值',
        title: titles[k],
        amount: amounts[k],
        credits: credits[k],
        channel: '微信支付',
        status: i === 4 ? 'refund' : 'paid',
        createdAt: now - (i + 1) * HOUR * 7
      });
    }
    saveOrders(demos);
  }
  if (!localStorage.getItem(SITE_DATA_KEY)) {
    saveSiteData({
      products: DEFAULT_SITE_DATA.products,
      serviceQr: '', serviceText: DEFAULT_SITE_DATA.serviceText,
      coopImg: '', coopText: DEFAULT_SITE_DATA.coopText,
      agents: [
        { id: 'a1', name: '张经理', account: '13800001111', pass: '123456', rate: 20, createdAt: Date.now() - 30 * 86400000 },
        { id: 'a2', name: '李代理', account: '15100002222', pass: '123456', rate: 15, createdAt: Date.now() - 15 * 86400000 }
      ]
    });
    siteData = loadSiteData();
  }
})();

// ===== 超级代理 =====
// 邀请来源：消费者通过 ?agent=代理账号 的链接进入时记录，注册/下单时自动绑定到该代理
function getAgentRef() {
  try { return localStorage.getItem('yn_agent_ref') || ''; } catch (e) { return ''; }
}
function setAgentRef(account) {
  try { localStorage.setItem('yn_agent_ref', account); } catch (e) {}
}
function getAgentByAccount(acc) {
  if (!acc) return null;
  return (loadSiteData().agents || []).find(a => a.account === acc) || null;
}
// 确保账号在会员表中有记录（注册/下单时调用），并自动完成邀请归因绑定
function upsertUser(account, nickname) {
  if (!account || account === '（未登录）') return null;
  const users = getUsers();
  let u = users.find(x => x.account === account);
  if (!u) {
    u = { id: 'u' + Date.now() + Math.floor(Math.random() * 1000), account: account, nickname: nickname || '', balance: 0, status: 'active', agentId: '', createdAt: Date.now() };
    users.unshift(u);
  }
  if (!u.agentId) {
    const refAcc = getAgentRef();
    if (refAcc && refAcc !== account) {
      const ag = getAgentByAccount(refAcc);
      if (ag) u.agentId = ag.id;
    }
  }
  saveUsers(users);
  return u;
}
// 代理数据统计：旗下会员 / 已支付订单 / 会员消费 / 佣金（= 消费 × 后台设置的比例）
function getAgentStats(agentId) {
  const site = loadSiteData();
  const agent = (site.agents || []).find(a => a.id === agentId);
  const rate = agent ? (Number(agent.rate) || 0) : 0;
  const members = getUsers().filter(u => u.agentId === agentId);
  const accounts = members.map(u => u.account);
  const orders = getOrders().filter(o => o.status === 'paid' && accounts.indexOf(o.account) > -1)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const consume = orders.reduce((s, o) => s + (parseFloat(o.amount) || 0), 0);
  return { agent: agent, rate: rate, members: members, orders: orders, consume: consume, commission: consume * rate / 100 };
}
