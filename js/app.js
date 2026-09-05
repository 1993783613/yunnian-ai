/* ============================================
   云念AI - 应用交互逻辑
   ============================================ */

// ===== 页面导航 =====
const pageHistory = ['landing'];

function navigate(pageId) {
  const pages = document.querySelectorAll('.page');
  pages.forEach(p => p.classList.remove('active'));
  const target = document.getElementById('page-' + pageId);
  if (target) {
    target.classList.add('active');
    if (pageHistory[pageHistory.length - 1] !== pageId) {
      pageHistory.push(pageId);
    }
    // 滚动到顶部
    const content = target.querySelector('.page-content');
    if (content) content.scrollTop = 0;
    window.scrollTo(0, 0);

    // 页面特定逻辑
    if (pageId === 'call') trtcEnterCall();
    if (pageId === 'landing') generateStars();
    if (pageId === 'library') renderMyCharacters();
  }
}

function goBack() {
  if (pageHistory.length > 1) {
    pageHistory.pop();
    const prev = pageHistory[pageHistory.length - 1];
    navigate(prev);
    pageHistory.pop(); // navigate 会再 push，所以弹出去
  }
}

// ===== 星空背景 =====
function generateStars() {
  const container = document.getElementById('starsBg');
  if (!container || container.children.length > 0) return;
  for (let i = 0; i < 40; i++) {
    const star = document.createElement('div');
    star.className = 'landing-star';
    star.style.left = Math.random() * 100 + '%';
    star.style.top = Math.random() * 100 + '%';
    star.style.animationDelay = Math.random() * 3 + 's';
    star.style.animationDuration = (2 + Math.random() * 2) + 's';
    star.style.opacity = 0.2 + Math.random() * 0.5;
    const size = 1 + Math.random() * 2;
    star.style.width = size + 'px';
    star.style.height = size + 'px';
    container.appendChild(star);
  }
}

// ===== 登录/注册切换 =====
let isLoginMode = false;

function toggleAuthMode() {
  isLoginMode = !isLoginMode;
  const title = document.getElementById('authTitle');
  const subtitle = document.getElementById('authSubtitle');
  const confirmField = document.getElementById('confirmField');
  const submitText = document.getElementById('authSubmitText');
  const switchText = document.getElementById('authSwitchText');
  const switchLink = document.getElementById('authSwitchLink');

  if (isLoginMode) {
    title.textContent = '欢迎回来';
    subtitle.textContent = '使用账号和密码登录，继续管理你的数字人与实时会话。';
    confirmField.classList.add('hidden');
    submitText.textContent = '登录';
    switchText.textContent = '还没有账号？';
    switchLink.textContent = '注册账号';
  } else {
    title.textContent = '创建账号';
    subtitle.textContent = '创建账号后即可管理你的数字人与实时会话。';
    confirmField.classList.remove('hidden');
    submitText.textContent = '注册并登录';
    switchText.textContent = '已有账号？';
    switchLink.textContent = '返回登录';
  }
}

function handleAuth() {
  const account = document.getElementById('authAccount').value.trim();
  const password = document.getElementById('authPassword').value;
  const confirm = document.getElementById('authConfirm').value;
  const agreed = document.getElementById('authAgree').checked;
  const errorEl = document.getElementById('authError');
  const btn = document.getElementById('authSubmit');

  errorEl.classList.add('hidden');

  // 验证
  if (!account) { showAuthError('请输入账号'); return; }
  if (!password) { showAuthError('请输入密码'); return; }
  if (password.length < 8) { showAuthError('密码需至少 8 个字符且不超过 72 字节。'); return; }
  if (!isLoginMode) {
    if (password !== confirm) { showAuthError('两次输入的密码不一致。'); return; }
  }
  if (!agreed) { showAuthError('请先阅读并同意用户协议和隐私政策。'); return; }

  // 模拟登录
  btn.disabled = true;
  const text = document.getElementById('authSubmitText');
  text.textContent = isLoginMode ? '正在登录…' : '正在注册…';

  setTimeout(() => {
    btn.disabled = false;
    text.textContent = isLoginMode ? '登录' : '注册并登录';
    showToast(isLoginMode ? '登录成功' : '创建成功，数字人需要三到五分钟进行加载创建。');
    // 记住账号密码（仅保存在本机浏览器）
    try {
      const remember = document.getElementById('authRemember').checked;
      if (remember) {
        localStorage.setItem('yn_auth_remember', JSON.stringify({ account: account, password: password }));
      } else {
        localStorage.removeItem('yn_auth_remember');
      }
    } catch (e) { /* 忽略存储异常 */ }
    setTimeout(() => navigate('library'), 800);
  }, 1200);
}

function showAuthError(msg) {
  const errorEl = document.getElementById('authError');
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}

// ===== 创建角色 =====
function switchVoiceTab(el, type) {
  const tabs = el.parentElement.querySelectorAll('.voice-tab');
  tabs.forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('voicePlatform').classList.toggle('hidden', type !== 'platform');
  document.getElementById('voiceCustom').classList.toggle('hidden', type !== 'custom');
}

function selectVoice(el) {
  const options = el.parentElement.querySelectorAll('.voice-option');
  options.forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
}

// 音色分类筛选
function filterVoiceCategory(tabEl, category) {
  // 切换分类标签高亮
  const tabs = tabEl.parentElement.querySelectorAll('.voice-cat-tab');
  tabs.forEach(t => t.classList.remove('active'));
  tabEl.classList.add('active');

  const platform = document.getElementById('voicePlatform');
  const options = platform.querySelectorAll('.voice-option');
  const labels = platform.querySelectorAll('.voice-group-label');
  const emptyHint = document.getElementById('voiceEmptyHint');

  let visibleCount = 0;
  options.forEach(opt => {
    const match = category === 'all' || opt.dataset.category === category;
    opt.style.display = match ? '' : 'none';
    if (match) visibleCount++;
  });
  labels.forEach(label => {
    const show = category === 'all' || label.dataset.group === category;
    label.classList.toggle('hidden', !show);
  });
  emptyHint.classList.toggle('hidden', visibleCount > 0);

  // 若当前选中的音色被隐藏，自动选中第一个可见项
  const selected = platform.querySelector('.voice-option.selected');
  if (selected && selected.style.display === 'none') {
    const firstVisible = platform.querySelector('.voice-option:not([style*="none"])');
    if (firstVisible) {
      options.forEach(o => o.classList.remove('selected'));
      firstVisible.classList.add('selected');
    }
  }
}

// ===== 音色真实试听（浏览器语音合成，按角色调整音高/语速） =====
const voiceProfiles = {
  '慈祥爷爷': { pitch: 0.6, rate: 0.8,  line: '孩子啊，爷爷想你了，最近过得好不好？' },
  '和蔼奶奶': { pitch: 0.85, rate: 0.85, line: '乖孙啊，奶奶给你留了好吃的，有空回来吃啊。' },
  '温柔妈妈': { pitch: 1.1, rate: 0.95, line: '宝贝，妈妈在呢，别担心，好好照顾自己。' },
  '沉稳爸爸': { pitch: 0.7, rate: 0.9,  line: '孩子，爸相信你，遇到什么事跟爸说。' },
  '活泼少女': { pitch: 1.4, rate: 1.1,  line: '嗨～今天有没有想我呀？我可想你啦！' },
  '阳光少年': { pitch: 1.0, rate: 1.05, line: '兄弟，走啊，打球去，就等你了！' },
  '稚嫩童声': { pitch: 1.8, rate: 1.15, line: '妈妈妈妈，你快看，我画的画好不好看呀？' }
};

let voicePreviewUtterance = null;

function playVoicePreview(btnEl, voiceName) {
  if (!('speechSynthesis' in window)) {
    showToast('当前浏览器不支持语音试听');
    return;
  }
  // 停止上一个试听
  window.speechSynthesis.cancel();
  document.querySelectorAll('.voice-option-play.playing').forEach(b => b.classList.remove('playing'));

  const profile = voiceProfiles[voiceName] || { pitch: 1, rate: 1, line: '你好，我想你了。' };
  const u = new SpeechSynthesisUtterance(profile.line);
  u.lang = 'zh-CN';
  u.pitch = profile.pitch;   // 0~2，越低越沧桑，越高越稚嫩
  u.rate = profile.rate;     // 0.5~2，语速
  u.volume = 1;
  voicePreviewUtterance = u;

  u.onstart = () => {
    btnEl.classList.add('playing');
    showToast(`正在试听「${voiceName}」…`);
  };
  u.onend = u.onerror = () => {
    btnEl.classList.remove('playing');
    voicePreviewUtterance = null;
  };
  window.speechSynthesis.speak(u);
}

// ===== 照片真实选择与预览 =====
let pendingPhotoThumb = null;   // 缩略图（用于本机保存角色）

function handlePhotoSelect(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    showToast('仅支持 PNG / JPG / WebP 图片');
    input.value = '';
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showToast('照片超过 10MB，请压缩后重试');
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = document.getElementById('photoPreview');
    img.src = e.target.result;
    img.classList.remove('hidden');
    document.getElementById('photoUploadIcon').style.display = 'none';
    document.getElementById('photoUploadHint').innerHTML =
      '已选择：' + file.name + '<br>点击可重新选择';
    document.getElementById('photoUploadArea').classList.add('has-photo');
    showToast('照片已就绪 ✓');
    // 生成小尺寸缩略图用于本地保存（localStorage 容量有限，不能存原图）
    const thumb = new Image();
    thumb.onload = () => {
      const max = 320;
      const scale = Math.min(1, max / Math.max(thumb.width, thumb.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(thumb.width * scale);
      canvas.height = Math.round(thumb.height * scale);
      canvas.getContext('2d').drawImage(thumb, 0, 0, canvas.width, canvas.height);
      pendingPhotoThumb = canvas.toDataURL('image/jpeg', 0.72);
    };
    thumb.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// ===== 音频真实选择与试听 =====
function handleAudioSelect(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  // 宽松校验：audio/* MIME 或常见音频扩展名都放行（手机文件管理器的 MIME 标注不统一）
  const okType = (file.type && file.type.indexOf('audio') === 0) ||
                 /\.(mp3|m4a|wav|aac|ogg|amr|flac|wma|caf)$/i.test(file.name);
  if (!okType) {
    showToast('请选择音频文件（MP3 / M4A / WAV 等）');
    input.value = '';
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    showToast('音频超过 20MB，请压缩后重试');
    input.value = '';
    return;
  }
  const player = document.getElementById('audioPreviewPlayer');
  if (player.src) URL.revokeObjectURL(player.src);
  player.src = URL.createObjectURL(file);
  document.getElementById('audioFileName').textContent = '已选择：' + file.name;
  document.getElementById('audioPreviewBox').classList.remove('hidden');
  document.getElementById('audioUploadIcon').style.display = 'none';
  document.getElementById('audioUploadHint').style.display = 'none';
  showToast('音频已就绪，点击播放按钮试听 ✓');
}

// ===== 创建角色（保存到本机 localStorage） =====
const CHAR_READY_AFTER_MS = 3 * 60 * 1000;  // 创建后 3 分钟变为"可通话"

function submitCreate() {
  const consent = document.getElementById('consentPhoto').checked;
  if (!consent) {
    showToast('请先确认素材授权同意');
    return;
  }
  const name = (document.getElementById('createName').value || '').trim();
  if (!name) {
    showToast('请先在第 2 步填写角色姓名');
    return;
  }

  const age = (document.getElementById('createAge').value || '').trim();
  const relation = (document.getElementById('createRelation').value || '').trim();
  // 当前选中的音色
  let voice = '未选择';
  const activeTab = document.querySelector('.voice-tab.active');
  if (activeTab && activeTab.textContent.indexOf('克隆') > -1) {
    voice = '克隆音色（' + ((document.getElementById('audioFileName').textContent || '已上传音频').replace('已选择：', '')).slice(0, 20) + '）';
  } else {
    const sel = document.querySelector('#voicePlatform .voice-option.selected .voice-option-name');
    if (sel) voice = sel.textContent;
  }

  let characters = [];
  try { characters = JSON.parse(localStorage.getItem('yn_characters') || '[]'); } catch (e) {}
  characters.unshift({
    id: Date.now(),
    name: name,
    age: age,
    relation: relation,
    voice: voice,
    photo: pendingPhotoThumb || '',
    createdAt: Date.now()
  });
  try {
    localStorage.setItem('yn_characters', JSON.stringify(characters));
  } catch (e) {
    showToast('本机存储空间不足，角色未保存（照片过大）');
    return;
  }

  showToast('创建成功，数字人需要三到五分钟进行加载创建。');
  setTimeout(() => navigate('library'), 1000);
}

// ===== 创作库：渲染"我的角色" =====
function renderMyCharacters() {
  const section = document.getElementById('myCharactersSection');
  const grid = document.getElementById('myCharactersGrid');
  if (!section || !grid) return;

  let characters = [];
  try { characters = JSON.parse(localStorage.getItem('yn_characters') || '[]'); } catch (e) {}

  if (!characters.length) {
    section.classList.add('hidden');
    grid.innerHTML = '';
    return;
  }

  section.classList.remove('hidden');
  grid.innerHTML = characters.map(c => {
    const ready = Date.now() - c.createdAt >= CHAR_READY_AFTER_MS;
    const badge = ready ? '可语音/视频' : '创建中…';
    const avatar = c.photo
      ? '<img src="' + c.photo + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">'
      : '<div class="dh-avatar">' + (c.name || '角').slice(0, 1) + '</div>';
    return '<div class="dh-card" onclick="navigate(\'call\')">' +
      '<div class="dh-card-photo"><div class="dh-card-badge">' + badge + '</div>' + avatar + '</div>' +
      '<div class="dh-card-info"><div class="dh-card-name">' + escapeHtml(c.name) + '</div>' +
      '<div class="dh-card-relation">' + escapeHtml(c.relation || (c.age ? c.age + '岁' : '我的亲人')) + ' · ' + escapeHtml(c.voice) + '</div></div>' +
      '<div class="dh-card-actions">' +
      '<button onclick="event.stopPropagation();navigate(\'call\')">语音</button>' +
      '<button onclick="event.stopPropagation();navigate(\'call\')">视频</button>' +
      '</div></div>';
  }).join('');

  // 创建中的角色到时间后自动刷新状态
  const earliestPending = characters
    .filter(c => Date.now() - c.createdAt < CHAR_READY_AFTER_MS)
    .sort((a, b) => (a.createdAt + CHAR_READY_AFTER_MS) - (b.createdAt + CHAR_READY_AFTER_MS))[0];
  if (earliestPending) {
    setTimeout(renderMyCharacters, earliestPending.createdAt + CHAR_READY_AFTER_MS - Date.now() + 1000);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// ===== 通话功能 =====
// 通话逻辑已迁移至 js/trtc-call.js（腾讯云 TRTC 真实音视频）

// ===== 充值套餐 =====
function selectPackage(el) {
  const cards = document.querySelectorAll('.package-card');
  cards.forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');

  const price = el.querySelector('.price').textContent;
  const name = el.querySelector('.package-name').textContent;
  const btn = document.querySelector('#page-recharge .submit-bar .btn-primary');
  if (btn) btn.textContent = `确认微信支付 · ¥${price}`;
}

// ===== Toast =====
let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('active');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('active'), 2500);
}

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', () => {
  generateStars();

  // 监听浏览器返回
  window.addEventListener('popstate', (e) => {
    if (pageHistory.length > 1) {
      goBack();
    }
  });

  // 阻止双击缩放
  let lastTouch = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTouch < 300) e.preventDefault();
    lastTouch = now;
  }, { passive: false });
});

// ===== 从分享链接进入：自动跳转到通话页 =====
(function () {
  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  if (room && /^\d{8}$/.test(room)) {
    setTimeout(() => navigate('call'), 300);
  }
})();

// ===== 启动时：填充记住的账号密码并切到登录模式 =====
(function initRememberedAuth() {
  try {
    const saved = JSON.parse(localStorage.getItem('yn_auth_remember') || 'null');
    if (saved && saved.account && saved.password) {
      toggleAuthMode();  // 初始为注册模式，切一次变为登录模式
      document.getElementById('authAccount').value = saved.account;
      document.getElementById('authPassword').value = saved.password;
      document.getElementById('authRemember').checked = true;
    }
  } catch (e) { /* 忽略 */ }
})();
