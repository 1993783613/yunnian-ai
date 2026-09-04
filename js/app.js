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
    if (pageId === 'call') startCall();
    if (pageId === 'landing') generateStars();
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

// 试听音色预览
let voicePreviewTimer = null;
function playVoicePreview(btnEl, voiceName) {
  // 停止上一个试听
  if (voicePreviewTimer) {
    clearTimeout(voicePreviewTimer);
    document.querySelectorAll('.voice-option-play.playing').forEach(b => b.classList.remove('playing'));
  }
  btnEl.classList.add('playing');
  showToast(`正在试听「${voiceName}」…`);
  // 模拟播放 3 秒
  voicePreviewTimer = setTimeout(() => {
    btnEl.classList.remove('playing');
    voicePreviewTimer = null;
  }, 3000);
}

function handleUpload(el) {
  // 模拟上传
  showToast('选择文件中…');
  setTimeout(() => {
    el.classList.add('has-photo');
    const hint = el.querySelector('.upload-hint');
    const svg = el.querySelector('svg');
    if (hint) hint.innerHTML = '已选择照片<br>点击重新选择';
    if (svg) svg.style.display = 'none';
    showToast('文件已选择');
  }, 800);
}

function submitCreate() {
  const consent = document.getElementById('consentPhoto').checked;
  if (!consent) {
    showToast('请先确认素材授权同意');
    return;
  }
  showToast('正在创建数字人，请稍候…');
  setTimeout(() => {
    showToast('创建成功，数字人需要三到五分钟进行加载创建。');
    setTimeout(() => navigate('library'), 1000);
  }, 1500);
}

// ===== 通话功能 =====
let callTimer = null;
let callSeconds = 0;
let callConnectingTimeout = null;

function startCall() {
  const overlay = document.getElementById('callConnecting');
  const statusText = document.getElementById('callStatusText');
  const duration = document.getElementById('callDuration');

  // 重置状态
  overlay.style.display = 'flex';
  statusText.innerHTML = '<span class="dot"></span>正在连接数字人…';
  duration.textContent = '00:00';
  callSeconds = 0;
  if (callTimer) clearInterval(callTimer);
  if (callConnectingTimeout) clearTimeout(callConnectingTimeout);

  // 模拟连接过程（2秒后接通）
  callConnectingTimeout = setTimeout(() => {
    overlay.style.display = 'none';
    statusText.innerHTML = '<span class="dot"></span>通话中';
    startCallTimer();
  }, 2000);
}

function startCallTimer() {
  callTimer = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const s = String(callSeconds % 60).padStart(2, '0');
    document.getElementById('callDuration').textContent = `${m}:${s}`;
  }, 1000);
}

function endCall() {
  if (callTimer) { clearInterval(callTimer); callTimer = null; }
  if (callConnectingTimeout) { clearTimeout(callConnectingTimeout); callConnectingTimeout = null; }
  showToast('通话已结束');
  setTimeout(() => navigate('library'), 500);
}

function toggleCallBtn(el, name) {
  el.classList.toggle('active');
  const isActive = el.classList.contains('active');
  showToast(`${name}已${isActive ? '开启' : '关闭'}`);
}

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
