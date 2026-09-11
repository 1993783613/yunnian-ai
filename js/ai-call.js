/* ============================================
   云念AI - AI 数字人角色通话（微信视频风格）
   流程完全对齐真实云念AI：
   卡片点「视频通话」→ 确认弹窗（可用时长/麦克风权限/摄像头默认关）
   → 呼叫中 → 正在检查麦克风 → 暗色呼叫界面（正在创建通话…→正在接通…）
   → 接通：全屏数字人 + 右上角自己小窗 + 麦克风/摄像头/翻转 + 计时
   AI 能力：语音合成说话 + 语音识别听懂（不支持识别的设备用快捷回复）
   注：口型同步需接入真实数字人引擎（见《数字人接入路线图.md》），
   当前用照片动态 + 语音对话做演示级体验。
   ============================================ */

// ===== 状态 =====
let aiCallChar = null;          // 当前通话的角色
let aiCallMode = 'video';       // 'video' | 'voice'
let aiCallState = 'idle';       // idle | calling | connected | ended
let aiMemUsed = null;           // 本次通话已提过的记忆（防重复"翻旧账"）
let aiCallTimer = null;
let aiCallSeconds = 0;
const AI_CALL_LIMIT = 20 * 60;  // 可用时长 20:00（与确认弹窗一致）
let aiLocalStream = null;       // 本地摄像头流
let aiFacing = 'user';          // 前置/后置
let aiCamOn = false;            // 摄像头默认关闭（与真实产品一致）
let aiMicOn = true;
let aiRecognition = null;       // 语音识别实例
let aiRecognizing = false;
let aiSpeaking = false;
let aiCallReal = false;         // true=真实数字人（IVH云渲染）；false=演示模式
let aiIvhSessionId = '';
let aiIvhTrtc = null;           // 拉数字人流的 TRTC 实例
let aiIvhRemoteUserId = '';     // 数字人在房间里的 userId（扬声器静音用）
let aiIvhPollTimer = null;
const AI_CALL_VER = '20260912c'; // 通话模块版本（排查缓存用）
let aiConnectGuard = false;     // 防止重复接通
let aiWatchdog = null;          // 总看门狗：无论卡在哪一步，超时强制接通演示模式

// ===== 工具 =====
function aiFmt(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return m + ':' + s;
}

function aiFindChar(id) {
  // 内置平台示例角色
  const DEMO = {
    demo_grandma: {
      id: 'demo_grandma', name: '瑶瑶的奶奶', age: '72', relation: '我的外婆', voice: '和蔼奶奶', photo: '', createdAt: 0,
      personality: '嘴硬心软，心疼人全往心里搁，嘴上总不饶人',
      speaking: '开口就是「你呀」，爱拿吃的打比方，说着说着会叹气',
      callUser: '瑶瑶',
      story: '小时候带她去河边钓鱼，她总钓不着就哭；柜子最里头常年给她留着糖',
      cares: '怕她不好好吃饭、一个人熬夜，怕她报喜不报忧'
    },
    demo_grandpa: {
      id: 'demo_grandpa', name: '阿哲的爷爷', age: '75', relation: '最疼我的爷爷', voice: '慈祥爷爷', photo: '', createdAt: 0,
      personality: '倔强、要强，认死理，不服老，嘴上严厉心里软',
      speaking: '话不多但句句有分量，急起来会提高嗓门，爱拿年轻时候的事举例子',
      callUser: '阿哲',
      story: '小时候带他去后山捡栗子，一路教他认树认虫子；他的第一辆自行车是爷爷攒了半年买的',
      cares: '惦记他的工作稳不稳，怕他为了挣钱把身体熬坏，怕他遇事自己扛着不说'
    }
  };
  if (DEMO[id]) return DEMO[id];
  let chars = [];
  try { chars = JSON.parse(localStorage.getItem('yn_characters') || '[]'); } catch (e) {}
  return chars.find(c => String(c.id) === String(id)) || null;
}

function aiVoiceProfile(voiceName) {
  const key = Object.keys(voiceProfiles || {}).find(k => (voiceName || '').indexOf(k) > -1);
  return key ? voiceProfiles[key] : { pitch: 0.9, rate: 0.92 };
}

// ===== 通话页容器激活（确认弹窗/通话界面都挂在 page-call 内，必须先激活容器才可见） =====
function showCallShell() {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const pc = document.getElementById('page-call');
  if (pc) pc.classList.add('active');
  // 隐藏真人通话的大厅/房间界面，避免确认弹窗后面露出大厅
  const lobby = document.getElementById('callLobby');
  if (lobby) lobby.style.display = 'none';
  const activeBox = document.getElementById('callActive');
  if (activeBox) activeBox.style.display = 'none';
  window.scrollTo(0, 0);
}

// ===== 第 1 步：确认弹窗 =====
function aiCallConfirm(id, mode) {
  const char = aiFindChar(id);
  if (!char) { showToast('角色不存在'); return; }
  const ready = Date.now() - char.createdAt >= CHAR_READY_AFTER_MS;
  if (!ready) { showToast('数字人还在创建中，请稍候…'); return; }

  showCallShell();

  aiCallChar = char;
  aiCallMode = mode || 'video';

  document.getElementById('aicConfirmText').textContent =
    '将与「' + char.name + '」发起' + (aiCallMode === 'video' ? '视频' : '语音') +
    '通话。当前可用时长 ' + aiFmt(AI_CALL_LIMIT) +
    '；本次申请麦克风权限；摄像头默认关闭，可在通话中手动开启，是否继续？';
  document.getElementById('aicConfirmMask').style.display = 'flex';
}

function aiCallCancel() {
  document.getElementById('aicConfirmMask').style.display = 'none';
  aiCallChar = null;
  navigate('library');   // 取消则返回创作平台
}

// 统一接通入口：只接通一次（真实模式/演示模式/看门狗共用，防止重复触发）
function aiConnectOnce() {
  if (aiConnectGuard) return;
  aiConnectGuard = true;
  if (aiWatchdog) { clearTimeout(aiWatchdog); aiWatchdog = null; }
  aiCallConnect();
}

// ===== 第 2 步：发起呼叫 =====
// iOS 需要在用户点击手势内解锁语音合成，否则后续 speak 无声
function aiUnlockSpeech() {
  try {
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  } catch (e) {}
}

// ★ 零点击关键：在「开始通话」这次点击手势内，预解锁 AudioContext 音频通道。
// iOS 要求音频在用户手势内激活——在这里激活后，接通后的远端声音、自动聆听都不再需要任何额外点击。
let aiAudioPrimed = false;
function aiPrimeAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      if (!aiPrimeAudio._ctx) aiPrimeAudio._ctx = new AC();
      const c = aiPrimeAudio._ctx;
      if (c.state === 'suspended' && c.resume) c.resume().catch(() => {});
      const b = c.createBuffer(1, 1024, c.sampleRate);   // 播放一段静音，正式激活音频输出通道
      const s = c.createBufferSource();
      s.buffer = b; s.connect(c.destination); s.start(0);
    }
    // 预解锁麦克风：提前拿到授权与轨道，接通后全时聆听直接复用
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
        .then(st => {
          aiPrimeAudio._preMic = st;
          st.getTracks().forEach(t => t.stop());   // 只为触发授权弹窗在手势内出现，轨道即取即停
        })
        .catch(() => {});
    }
    aiAudioPrimed = true;
  } catch (e) {}
}

async function aiCallGo() {
  document.getElementById('aicConfirmMask').style.display = 'none';
  if (!aiCallChar) return;
  aiUnlockSpeech();
  aiPrimeAudio();          // ★ 在这次点击手势内解锁声音+麦克风，实现通话全程零额外点击
  aiMemUsed = new Set();   // 每次接通重置，已提过的记忆不再重复
  aiCallState = 'calling';
  aiConnectGuard = false;
  aiLog('通话模块 v' + AI_CALL_VER);
  showToast('通话模块 v' + AI_CALL_VER);   // 用于确认手机加载的是新版本（非缓存旧版）

  // ★ 总看门狗：200 秒（覆盖 create+进房+status轮询120秒+start 全流程），卡住才强制演示模式
  if (aiWatchdog) clearTimeout(aiWatchdog);
  aiWatchdog = setTimeout(() => {
    // 真实数字人流程正在跑（aiCallReal=true 且已有会话），不要抢占，交给它自己的 120 秒轮询
    if (aiCallState === 'calling' && !aiConnectGuard && !aiIvhSessionId) {
      aiLog('看门狗触发：连接超时，强制进入演示模式');
      showToast('接连超时，已切换演示模式');
      aiConnectOnce();
    }
  }, 200000);

  // 卡片按钮变「呼叫中…」
  aiSetCardCalling(true);

  // 进入暗色呼叫界面
  const screen = document.getElementById('aiCallScreen');
  screen.style.display = 'block';
  document.getElementById('aicAvatarImg').src = aiCallChar.photo || '';
  document.getElementById('aicAvatarImg').style.display = aiCallChar.photo ? 'block' : 'none';
  document.getElementById('aicAvatarLetter').textContent = (aiCallChar.name || '亲').slice(0, 1);
  document.getElementById('aicAvatarLetter').style.display = aiCallChar.photo ? 'none' : 'flex';
  document.getElementById('aicName').textContent = aiCallChar.name;
  document.getElementById('aicPhase').style.display = 'flex';
  document.getElementById('aicConnected').style.display = 'none';
  document.getElementById('aicHangupWrap').style.display = 'flex';

  // 底部提示：正在检查麦克风（同真实产品）+ 申请权限
  showToast('正在检查麦克风...');
  let micOk = false;
  try {
    // 8 秒拿不到麦克风授权就跳过（防止权限弹窗未响应导致整个流程挂死）
    const s = await Promise.race([
      navigator.mediaDevices.getUserMedia({ audio: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('mic timeout')), 8000))
    ]);
    s.getTracks().forEach(t => t.stop());
    micOk = true;
  } catch (e) { /* 用户拒绝、超时或无设备，继续流程但不识别 */ }

  // 呼叫阶段文案（模拟真实接通节奏）
  const phases = [
    ['正在创建通话…', micOk ? '正在申请麦克风权限…' : '麦克风未授权，仅可听她说'],
    ['正在创建' + (aiCallMode === 'video' ? '视频' : '语音') + '通话…', '正在连接数字人。'],
    ['正在接通…', '正在同步画面…']
  ];
  for (const p of phases) {
    if (aiCallState !== 'calling') return;
    document.getElementById('aicPhaseMain').textContent = p[0];
    document.getElementById('aicPhaseSub').textContent = p[1];
    await aiSleep(1400);
  }
  if (aiCallState !== 'calling') return;

  // 优先走真实数字人（IVH 云渲染）；失败自动降级演示模式
  if (TRTC_CONFIG.ivhServer) {
    try {
      await aiIvhCallFlow();
      return;
    } catch (err) {
      if (aiCallState !== 'calling' || aiConnectGuard) return;
      aiLog('真实数字人接入失败，降级演示模式: ' + (err.message || err));
      showToast('数字人通道繁忙，已切换演示模式');
    }
  }
  aiConnectOnce();
}

// 带超时的 fetch（防止云函数/网络挂起导致通话界面卡死）
function fetchT(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 12000);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// ===== 真实数字人流程（IVH 云渲染 + TRTC 拉流 + 文本驱动） =====
async function aiIvhCallFlow() {
  aiCallReal = true;

  document.getElementById('aicPhaseMain').textContent = '正在接通…';
  document.getElementById('aicPhaseSub').textContent = '正在唤醒数字人…';

  // 1. 创建会话（云端加载形象并推流到 TRTC 房间）— action 放进 POST body（规避网关吞查询参数）
  aiLog('① 开始创建会话…');
  const r1 = await cfPost('create', {}, 15000).then(r => r.json());
  if (r1.code !== 0) throw new Error(r1.message || '创建会话失败');
  aiIvhSessionId = r1.sessionId;
  aiLog('② 会话已创建 ' + r1.sessionId + '，房间 ' + r1.roomId + '，status=' + r1.sessionStatus);

  // 2. 进入 TRTC 房间拉数字人的流
  const myId = 'v_' + Math.random().toString(36).slice(2, 8);
  aiLog('③ 获取进房凭证 ' + myId + '…');
  const sigResp = await getUserSig(myId);
  aiLog('④ 凭证已获取，创建 TRTC 客户端…');
  aiIvhTrtc = TRTC.create();
  aiIvhTrtc.on(TRTC.EVENT.REMOTE_VIDEO_AVAILABLE, async (ev) => {
    aiLog('收到数字人视频流，开始渲染…');
    const box = document.getElementById('aicRemoteBox');
    try {
      await aiIvhTrtc.startRemoteVideo({ userId: ev.userId, streamType: ev.streamType, view: box });
      box.style.display = 'block';
      document.getElementById('aicFullPhoto').style.display = 'none';
      // 已预解锁：自动取消静音并播放，无需任何点击
      if (aiAudioPrimed) {
        try {
          box.querySelectorAll('video, audio').forEach(v => {
            v.muted = false;
            v.volume = 1;
            if (v.play) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
          });
          if (aiIvhTrtc.muteRemoteAudio) await aiIvhTrtc.muteRemoteAudio(ev.userId, false);
        } catch (e) {}
      }
      aiLog('数字人画面渲染成功 ✓');
    } catch (e) {
      aiLog('渲染失败: ' + (e.message || e));
    }
  });
  aiIvhTrtc.on(TRTC.EVENT.REMOTE_USER_ENTER, (ev) => {
    aiIvhRemoteUserId = ev.userId;   // 记住远端用户，供扬声器静音用
    aiLog('数字人已进房: ' + ev.userId);
  });
  aiIvhTrtc.on(TRTC.EVENT.ERROR, (err) => aiLog('TRTC错误: ' + (err.message || err)));
  await aiIvhTrtc.enterRoom({
    roomId: r1.roomId,
    sdkAppId: TRTC_CONFIG.sdkAppId,
    userId: myId,
    userSig: sigResp,
    scene: 'rtc'
  });
  aiLog('⑤ 已进入数字人房间 ' + r1.roomId);

  // 3. 等待流就绪（最多 120 秒）
  document.getElementById('aicPhaseMain').textContent = '正在接通…';
  document.getElementById('aicPhaseSub').textContent = '数字人加载中，首次约需 1–2 分钟…';
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (aiCallState !== 'calling') return;
    await aiSleep(3000);
    const r3 = await cfPost('status', { sessionId: r1.sessionId }, 10000).then(x => x.json());
    aiLog('⑥ 轮询状态 ' + (i + 1) + '/40：status=' + r3.sessionStatus + ' code=' + r3.code);
    if (r3.code === 0 && r3.sessionStatus === 1) { ready = true; break; }
  }
  if (!ready) throw new Error('数字人加载超时');

  // 4. 开启会话 → 等引擎就绪 → 显示通话界面（开场白延迟发出，避免驱动过早被吞）
  await cfPost('start', { sessionId: r1.sessionId }, 10000);
  aiLog('⑦ 会话已开启，2秒后接通');
  await aiSleep(2000);
  aiConnectOnce();
}

function aiLog(msg) {
  const box = document.getElementById('aicDebugLog');
  if (!box) return;
  const line = document.createElement('div');
  line.textContent = '[' + new Date().toTimeString().slice(0, 8) + '] ' + msg;
  box.appendChild(line);
  while (box.children.length > 6) box.removeChild(box.firstChild);
}

// ===== 真实数字人说话（云驱动：TTS + 口型同步；带超时/结果校验/失败重试一次） =====
async function ivhSpeak(text) {
  const sub = document.getElementById('aicSubtitle');
  sub.textContent = text;
  sub.style.display = 'block';
  clearTimeout(ivhSpeak._t);
  ivhSpeak._t = setTimeout(() => { sub.style.display = 'none'; }, 8000);
  if (!aiIvhSessionId) { aiLog('驱动跳过：无会话'); return; }
  const doDrive = async () => {
    const resp = await cfPost('drive', { sessionId: aiIvhSessionId, text: text }, 10000);
    const d = await resp.json().catch(() => ({}));
    return d.code === 0;
  };
  try {
    let ok = await doDrive();
    if (!ok) { aiLog('驱动失败，2秒后重试'); await aiSleep(2000); ok = await doDrive(); }
    aiLog(ok ? '驱动成功 ✓' : '驱动仍失败（看云函数日志）');
  } catch (e) {
    aiLog('驱动异常: ' + (e.message || e));
  }
}

function aiSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function aiSetCardCalling(calling) {
  const card = document.querySelector('.dh-card[data-char-id="' + aiCallChar.id + '"]');
  if (!card) return;
  const btns = card.querySelectorAll('.dh-card-actions button');
  btns.forEach(b => {
    if (calling) {
      b.dataset.origText = b.textContent;
      if (b.textContent.indexOf('视频') > -1 || aiCallMode === 'voice') b.textContent = '呼叫中...';
    } else {
      if (b.dataset.origText) b.textContent = b.dataset.origText;
    }
    b.disabled = calling;
  });
}

// ===== 第 3 步：接通 =====
function aiCallConnect() {
  aiCallState = 'connected';
  aiSetCardCalling(false);
  document.getElementById('aicPhase').style.display = 'none';
  document.getElementById('aicConnected').style.display = 'block';

  // 重置画面：照片先显示，真实模式下数字人流就绪后自动覆盖
  document.getElementById('aicRemoteBox').style.display = 'none';
  document.getElementById('aicDebugLog').innerHTML = '';
  if (aiCallChar.photo) {
    const img = document.getElementById('aicFullPhoto');
    img.src = aiCallChar.photo;
    img.style.display = 'block';
  } else if (!aiCallReal) {
    document.getElementById('aicFullPhoto').style.display = 'none';
  }

  // 控制栏初始状态：麦克风开、摄像头关（同真实产品）
  aiMicOn = true;
  aiCamOn = false;
  aiUpdateCtl('micCtlBtn', true, '麦克风已开');
  aiUpdateCtl('camCtlBtn', false, '摄像头已关');

  // 计时（左下角，向上计数）
  aiCallSeconds = 0;
  document.getElementById('aicTimer').textContent = '00:00';
  aiCallTimer = setInterval(() => {
    aiCallSeconds++;
    document.getElementById('aicTimer').textContent = aiFmt(aiCallSeconds);
    if (aiCallSeconds >= AI_CALL_LIMIT) {
      showToast('可用时长已用完，通话结束');
      aiHangup();
    }
  }, 1000);

  // 开口第一句（真实模式延迟2.5秒发，给引擎启动口型/配音的时间）
  const greet = aiGreeting(aiCallChar);
  if (aiCallReal) {
    setTimeout(() => { if (aiCallState === 'connected') aiSpeak(greet); }, 2500);
  } else {
    aiSpeak(greet);
  }

  // 聆听指示复位
  const lst = document.getElementById('aicListen');
  if (lst) lst.style.display = 'none';

  if (aiAudioPrimed) {
    // ★ 已在「开始通话」点击时解锁：零额外点击，直接开声音+开麦聆听（微信视频式）
    try {
      document.querySelectorAll('#aiCallScreen video, #aiCallScreen audio').forEach(v => {
        v.muted = false;
        if (v.play) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
      });
    } catch (e) {}
    if (aiIvhTrtc && aiIvhRemoteUserId) {
      try { aiIvhTrtc.muteRemoteAudio(aiIvhRemoteUserId, false); } catch (e) {}
    }
    setTimeout(() => { if (aiCallState === 'connected') aiListenStart(); }, 4000);   // 等开场白说完大部分再听
  } else {
    // 兜底：预解锁失败才显示「开启语音对话」浮层
    const ul = document.getElementById('aicAudioUnlock');
    if (ul) ul.style.display = 'flex';
  }

  // 开启"听"（支持的设备用语音识别；纯视频对话，无快捷回复）
  if (aiSRSupported()) {
    aiStartRecognition();
  }
}

// ===== AI 说话（真实模式=云驱动口型；演示模式=本地语音合成） =====
function aiSpeak(text) {
  // 她说话期间暂停聆听（按字数估算时长+缓冲），防止扬声器声音被当成你的话
  aiDeafUntil = Date.now() + String(text).length * 380 + 2500;
  // 通话里 TA 说的话自动写入记忆库
  if (aiCallState === 'connected' && aiCallChar) memAdd(aiCallChar.id, text, 'ai');
  if (aiCallReal) return ivhSpeak(text);
  const sub = document.getElementById('aicSubtitle');
  sub.textContent = text;
  sub.style.display = 'block';

  const img = document.getElementById('aicFullPhoto');
  const avatar = document.getElementById('aicPhase');

  if ('speechSynthesis' in window) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const prof = aiVoiceProfile(aiCallChar.voice);
    u.lang = 'zh-CN';
    u.pitch = prof.pitch;
    u.rate = prof.rate;
    const zhVoice = speechSynthesis.getVoices().find(v => v.lang && v.lang.indexOf('zh') === 0);
    if (zhVoice) u.voice = zhVoice;
    u.onstart = () => { aiSpeaking = true; img.classList.add('speaking'); };
    u.onend = () => { aiSpeaking = false; img.classList.remove('speaking'); };
    u.onerror = () => { aiSpeaking = false; img.classList.remove('speaking'); };
    speechSynthesis.speak(u);
  }
  // 8 秒后字幕淡出
  clearTimeout(aiSpeak._t);
  aiSpeak._t = setTimeout(() => { sub.style.display = 'none'; }, 8000);
}

// ===== 记忆召回工具 =====
function aiClip(s, n) {
  s = String(s).replace(/\s+/g, '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

const MEM_STOP = ['我的', '你的', '我们', '你们', '就是', '不是', '一下', '什么', '怎么', '这样', '那样', '可以', '这个', '那个', '你好', '谢谢', '时候', '知道', '觉得', '现在', '最近', '还是', '没有', '了吗', '呢？'];

// 从用户输入里找相关旧记忆（两字词重叠匹配，够演示级召回）
function memMatch(text, mems) {
  const t = String(text).replace(/[，。！？、,.!?\s]/g, '');
  if (t.length < 2 || !mems || !mems.length) return null;
  for (const m of mems) {
    const s = String(m.text).replace(/\s+/g, '');
    if (s === t) continue;
    for (let i = 0; i + 2 <= t.length; i++) {
      const bg = t.slice(i, i + 2);
      if (MEM_STOP.indexOf(bg) > -1) continue;
      if (s.indexOf(bg) > -1) return m;
    }
  }
  return null;
}

// ===== 人设档案 =====
// 老角色数据没有 personality/speaking/callUser/story/cares 字段，
// 这里统一做安全取值 + 默认回退，保证任何字段缺失都不会出现 undefined / 崩溃。
const AI_PERSONA_DEFAULT = {
  personality: '朴实、话不多，但心里有数',
  speaking: '像家里长辈拉家常那样说话，句子短，偶尔带点方言味',
  callUser: '',
  story: '',
  cares: ''
};

/**
 * 读取角色的人设档案，缺失字段用默认值兜底。
 * @param {Object|null} char 角色对象（可能为老结构，字段不全）
 * @returns {{name:string, relation:string, personality:string, speaking:string, callUser:string, story:string, cares:string}}
 */
function aiPersona(char) {
  const c = char || {};
  // 只接受字符串/有限数字；对象、数组、布尔、null 一律当作「未填写」，
  // 避免脏数据（手工改过的 localStorage）把 [object Object] 拼进 prompt
  const str = (v) => {
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' && isFinite(v)) return String(v).trim();
    return '';
  };
  const relation = str(c.relation).replace(/^我的/, '') || '亲人';
  return {
    name: str(c.name) || '亲人',
    relation: relation,
    personality: str(c.personality) || AI_PERSONA_DEFAULT.personality,
    speaking: str(c.speaking) || AI_PERSONA_DEFAULT.speaking,
    callUser: str(c.callUser) || AI_PERSONA_DEFAULT.callUser,
    story: str(c.story) || AI_PERSONA_DEFAULT.story,
    cares: str(c.cares) || AI_PERSONA_DEFAULT.cares
  };
}

/**
 * 拼装 LLM system prompt：人设档案驱动，让 TA 有自己的立场和主张。
 * @param {Object|null} char 角色对象
 * @param {string} memsBlock 记忆文本块（可为空）
 * @returns {string} system prompt
 */
function aiBuildSystemPrompt(char, memsBlock) {
  const p = aiPersona(char);
  const L = [];

  // ① 身份：明确"我是一个人"，而不是服务
  L.push('你是' + p.name + '，是这个家里已经走了的' + p.relation + '。');
  L.push('现在你就在电话这头，跟家人说话。你就是你本人，一个有脾气、有主张、有记性的人，');
  L.push('不是客服，不是问答机器人，也不是谁的助手。');
  L.push('');

  // ② 人设档案
  L.push('【你是什么样的人】');
  L.push('- 你的性格：' + p.personality);
  L.push('- 你说话的样子：' + p.speaking);
  if (p.callUser) L.push('- 你平时这么称呼对方：' + p.callUser);
  if (p.story) L.push('- 你们一起经历过的事：' + p.story);
  if (p.cares) L.push('- 你在世时最放不下、最操心的事：' + p.cares);
  L.push('');

  // ③ 最关键：自己的想法
  L.push('【最重要的一条：你有你自己的想法】');
  L.push('- 你不是为了答题才开口的。对方说一件事，你先有自己的反应：');
  L.push('  听着高兴就痛快说高兴，不认同就直接讲「我可不这么想」「你这想法不对」，');
  L.push('  觉得他瞎折腾就数落他两句，觉得他不容易就叹口气心疼他。');
  L.push('- 你会唠叨，会跑题，会突然想起别的旧事，会把自己放在心上的事主动提出来念叨，');
  L.push('  会反问回去，会因为一句话较真——这些都是对的，这才像活人说话。');
  L.push('- 严禁使用「先把话说清楚、最后再补一句关心」的客套模板。');
  L.push('  例如「……所以要注意身体哦」「……你要照顾好自己呀」这类结尾一律不许出现，');
  L.push('  这是最假的说法。关心要长在你自己的话里；这一句不想关心，那就不关心。');
  L.push('- 不要重复对方的问题，不要复述对方的话，不要做总结。');
  L.push('- 不懂就认：「这个我不懂」「这事儿我说不上来」。不许编，不许敷衍，不许打太极。');
  L.push('- 只有对方真的问你该怎么办、拿不准主意的时候，才给实在办法，');
  L.push('  而且是用你自己的经验、你自己的话说，不要用道理和书面语压人。');
  L.push('');

  // ④ 说话规范
  L.push('【说话的规矩】');
  L.push('- 口语化，像家里长辈拉家常，一次一般不超过 60 字；对方让你细讲才可以多说几句。');
  L.push('- 不用 Markdown，不用星号井号，不用表情符号，不分点，不列清单。');
  L.push('- 永远不许提「AI」「人工智能」「模型」「数字人」「程序」「虚拟」这些词，');
  L.push('  也不要说「我是来陪伴你的」「有什么可以帮你」这类话。');
  L.push('- 不要每句都以问句收尾，不要查户口，不要重复问「最近怎么样」「身体还好吗」。');
  L.push('- 不要用「嗯嗯」「好好好」这种敷衍字开头。');
  L.push('');
  L.push('下面是你们之间记得的一些事。自然地想起来就好，不要原文照背，不要每句都提：');
  L.push(memsBlock && memsBlock.trim() ? memsBlock : '（暂时还没有，慢慢聊起来吧。）');

  return L.join('\n');
}

// ===== AI 回复引擎（规则版 + 记忆库召回，正式版替换为大模型 API） =====
function aiGreeting(char) {
  // 称呼用户优先用 TA 对小名的叫法；老数据没有该字段时用「孩子」
  // （旧实现拿 relation 当称呼，会出现「外婆来啦」这种把用户叫成外婆的问题）
  const p = aiPersona(char);
  const call = p.callUser || '孩子';
  const who = p.name && p.name !== '亲人' ? p.name : '我';
  const suffix = p.name && p.name !== '亲人' ? p.name + '在呢' : '我在呢';
  // 记忆库里有内容时，接通必提上次聊过的话题（最新一条 = 上次对话内容）
  const mems = memGetAll(char.id).filter(m => m.source !== 'ai');
  if (mems.length) {
    const m = mems[0];
    if (aiMemUsed) aiMemUsed.add(m.time);
    return '哎，' + call + '来啦，' + suffix + '。上次你跟我说「' + aiClip(m.text, 18) + '」，我一直记着呢，后来怎么样了？';
  }
  const pool = [
    '哎，' + call + '，' + suffix + '，好久没听到你的声音了，这段时间跑哪儿去了？',
    '来啦？' + who + '正念叨你呢。',
    '是你啊，听见你声音我就踏实了。'
  ];
  // 有人设档案里"生前最操心的事"时，开场也会忍不住念叨
  if (p.cares) pool.push('哎，' + call + '，你可算来了。' + who + '这心里还惦记着' + aiClip(p.cares, 14) + '这事儿呢。');
  return pool[Math.floor(Math.random() * pool.length)];
}

function aiReply(text) {
  const t = (text || '').trim();
  // 人设档案驱动：称呼、口头禅、TA 惦记的事，缺失字段一律走默认值
  const p = aiPersona(aiCallChar);
  const call = p.callUser || '孩子';
  const who = p.name && p.name !== '亲人' ? p.name : '我';

  // ① 先查记忆库：用户提到和旧记忆相关的事 → 召回并追问
  const hit = memMatch(t, memGetAll(aiCallChar.id).filter(m => m.source !== 'ai'));
  if (hit) {
    const R0 = [
      '这个' + who + '记得！你之前跟我讲过「' + aiClip(hit.text, 20) + '」，' + who + '一直放在心里呢，后来怎么样了？',
      '哎，你一提我就想起来了，你说过「' + aiClip(hit.text, 20) + '」，现在是什么情况啦？',
      '记得记得，「' + aiClip(hit.text, 20) + '」嘛，' + who + '记性还不差。你接着跟我说说。'
    ];
    return R0[Math.floor(Math.random() * R0.length)];
  }

  const R = [
    [/想你|想念|思念|挂念/, ['哎，' + call + '，' + who + '也天天想你，想得夜里翻来覆去睡不着。', '我也想你啊，一闭眼就是你小时候的样子。']],
    [/吃了吗|吃饭|吃东西|饿/, ['刚吃过，锅里还给你留着呢，你到时候回来热一热就能吃。你也要按时吃饭，别老点外卖。']],
    [/身体|健康|血压|腿|生病|药/, ['我身体好着呢，就是天冷腿有点沉，你放心。倒是你，别熬夜，年纪轻轻把身体搞垮了可不行。']],
    [/工作|上班|累|忙|加班/, ['工作要紧，但也别太拼，钱够花就行。累了就歇歇，家里永远是你的退路。']],
    [/钱|缺不缺|给你|打钱/, ['我不缺钱，你别给我塞钱了，把自己照顾好比什么都强。']],
    [/故事|以前|过去|小时候|讲讲/, ['你小时候啊，最黏我了，天天跟在我后头喊' + who + '，一转眼都长这么大了，时间过得真快哟。']],
    [/天气|冷|热|下雨/, ['这边今天还行，你那边冷不冷？记得添衣服，别为了好看穿得单薄。']],
    [/睡了|晚安|困/, ['睡吧睡吧，做个好梦。' + who + '在这边看着你呢。晚安，' + call + '。']],
    [/你是谁|你是|名字/, ['我是' + who + '呀，连我的声音都听不出来了？', '我是' + who + '。你这' + call + '，连我都认不出来了？']],
    [/好|嗯|哦|是的/, ['哎，' + who + '听着呢。你有话就说，' + who + '最乐意听你讲。']],
  ];
  for (const [re, answers] of R) {
    if (re.test(t)) return answers[Math.floor(Math.random() * answers.length)];
  }
  const fallback = [
    '哎，你说得对，' + call + '长大了，有主见了，' + who + '听着高兴。',
    '嗯，' + who + '在听呢，你慢慢说。',
    '你说的这事' + who + '可不太认同，不过你想说就接着说吧。'
  ];
  // ② 没命中规则时：翻记忆库里本次通话还没提过的旧话题，主动接话（像真亲人一样"翻旧账"）
  const unmentioned = memGetAll(aiCallChar.id).filter(m => m.source !== 'ai' && !(aiMemUsed && aiMemUsed.has(m.time)));
  if (unmentioned.length && Math.random() < 0.5) {
    const m = unmentioned[Math.floor(Math.random() * Math.min(3, unmentioned.length))];
    if (aiMemUsed) aiMemUsed.add(m.time);
    return '对了，' + who + '还记着呢，你之前说过「' + aiClip(m.text, 20) + '」，后来怎么样了？';
  }
  return fallback[Math.floor(Math.random() * fallback.length)];
}

// ===== 语音识别（Android Chrome / Edge 支持；iOS Safari 不支持走快捷回复） =====
function aiSRSupported() {
  return 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
}

function aiStartRecognition() {
  if (!aiSRSupported() || aiRecognizing) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  aiRecognition = new SR();
  aiRecognition.lang = 'zh-CN';
  aiRecognition.continuous = false;
  aiRecognition.interimResults = false;

  aiRecognition.onresult = async (e) => {
    const said = e.results[e.results.length - 1][0].transcript;
    aiShowUserBubble(said);
    const reply = await aiReplySmart(said);
    aiSpeak(reply);
  };
  aiRecognition.onend = () => {
    aiRecognizing = false;
    // 通话中且麦克风开着 → 持续听
    if (aiCallState === 'connected' && aiMicOn) {
      setTimeout(() => { try { aiRecognition.start(); aiRecognizing = true; } catch (e) {} }, 600);
    }
  };
  aiRecognition.onerror = () => { aiRecognizing = false; };

  try { aiRecognition.start(); aiRecognizing = true; } catch (e) {}
}

function aiStopRecognition() {
  if (aiRecognition) {
    try { aiRecognition.onend = null; aiRecognition.stop(); } catch (e) {}
    aiRecognition = null;
    aiRecognizing = false;
  }
}

function aiShowUserBubble(text) {
  // 用户说过的话自动写入记忆库（TA 就记住了你聊过的话题）
  if (aiCallChar) memAdd(aiCallChar.id, text, 'chat');
  const box = document.getElementById('aicUserBubble');
  box.textContent = '我：' + text;
  box.style.display = 'block';
  clearTimeout(aiShowUserBubble._t);
  aiShowUserBubble._t = setTimeout(() => { box.style.display = 'none'; }, 4000);
}

// 快捷回复/通话回复（优先大模型，失败退回规则引擎）
async function aiChipReply(text) {
  aiShowUserBubble(text);
  const reply = await aiReplySmart(text);
  aiSpeak(reply);
}

// 带超时的 POST（大模型对话用）
function fetchTPost(url, body, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 15000);
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctrl.signal
  }).finally(() => clearTimeout(t));
}

// ===== 大模型智能回复（云函数 chat 通道：人设档案 + 记忆注入 system prompt） =====
async function aiLLMReply(text, timeoutMs) {
  const char = aiCallChar || aiChatChar;
  if (!char || !TRTC_CONFIG.ivhServer) return null;
  // 人设：由角色的人设档案驱动（缺失字段自动兜底），重点让 TA 有自己的想法，而不是答题机器
  const mems = memGetAll(char.id).slice(0, 12).reverse()
    .map(m => '- [' + (m.source === 'ai' ? '你说' : m.source === 'chat' ? '文字聊天' : '用户说') + '] ' + String(m.text).slice(0, 120))
    .join('\n');
  const sys = aiBuildSystemPrompt(char, mems);
  // 记忆块已包含在 sys 内，这里不再重复拼接
  const messages = [{ role: 'system', content: sys }];
  // 带上最近几轮对话作为上下文（从聊天记录取）
  if (typeof aiChatChar !== 'undefined' && aiChatChar) {
    chatLogGet(aiChatChar.id).slice(-8).forEach(m => {
      messages.push({ role: m.r === 'me' ? 'user' : 'assistant', content: String(m.t).slice(0, 200) });
    });
  }
  messages.push({ role: 'user', content: text });
  try {
    const resp = await cfPost('chat', { messages: messages }, timeoutMs || 20000);
    const data = await resp.json();
    if (data && data.code === 0 && data.reply) return data.reply;
    aiLog('大模型通道: ' + (data && data.message || '不可用'));
    return null;
  } catch (e) {
    aiLog('大模型通道失败: ' + (e.message || e));
    return null;
  }
}

// 统一智能回复入口：优先大模型，失败自动退回本地规则引擎
async function aiReplySmart(text) {
  const r = await aiLLMReply(text);
  if (r) return r;
  return aiReply(text);
}

// ===== 声音解锁（iOS：远端音频需一次用户点击激活；点击后她会重新开口） =====
async function aiUnlockAudio() {
  const box = document.getElementById('aicAudioUnlock');
  if (box) box.style.display = 'none';
  try {
    document.querySelectorAll('#aiCallScreen video, #aiCallScreen audio').forEach(v => {
      v.muted = false;
      if (v.play) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
    });
  } catch (e) {}
  if (aiIvhTrtc && aiIvhRemoteUserId) {
    try { await aiIvhTrtc.muteRemoteAudio(aiIvhRemoteUserId, false); } catch (e) {}
  }
  aiSpeakerOn = true;
  const lbl = document.getElementById('spkCtlLabel');
  if (lbl) lbl.textContent = '扬声器已开';
  // 重发开场白（之前那次可能被静音吞掉）
  if (aiCallState === 'connected' && aiCallChar) aiSpeak(aiGreeting(aiCallChar));
  // 开启全时聆听：之后直接说话即可，她自动听、自动答（微信视频式）
  aiListenStart();
}

// ===== 全时语音对话（微信视频式：直接说话，自动断句识别，她回答完再问下一句） =====
let aiVad = null;          // { stream, ctx, proc, buf, speaking, silence, len }
let aiDeafUntil = 0;       // 她说话期间不听（防扬声器声音被识别成你的话）

function aiListenUI(state) {
  const el = document.getElementById('aicListen');
  if (!el) return;
  if (state === 'on') { el.textContent = '● 正在聆听，请说话…'; el.style.display = 'block'; }
  else if (state === 'hearing') { el.textContent = '● 听你说话…'; el.style.display = 'block'; }
  else { el.style.display = 'none'; }
}

// Float32 → 16k 单声道 WAV（浏览器端编码，云函数一句话识别）
function aiFloatToWav(samples, srcRate) {
  const ratio = srcRate / 16000;
  const outLen = Math.floor(samples.length / ratio);
  const buf = new ArrayBuffer(44 + outLen * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + outLen * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, outLen * 2, true);
  for (let i = 0; i < outLen; i++) {
    let s = Math.max(-1, Math.min(1, samples[Math.floor(i * ratio)] || 0));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buf;
}

async function aiListenStart() {
  if (aiVad || !navigator.mediaDevices) return;
  let stream, ctx;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    try { ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 }); }
    catch (e) { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
  } catch (e) {
    aiLog('麦克风打开失败: ' + (e.message || e));
    showToast('麦克风未授权，无法语音对话');
    return;
  }
  const st = { stream, ctx, buf: [], speaking: false, silence: 0, len: 0 };
  aiVad = st;
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  st.proc = proc;
  proc.onaudioprocess = (ev) => {
    if (!aiVad || st !== aiVad) return;
    const inp = ev.inputBuffer.getChannelData(0);
    if (Date.now() < aiDeafUntil) return;   // 她正在说话，暂停聆听防回声
    let sum = 0;
    for (let i = 0; i < inp.length; i++) sum += inp[i] * inp[i];
    const rms = Math.sqrt(sum / inp.length);
    if (!st.speaking) {
      if (rms > 0.015) {
        st.speaking = true; st.buf = [new Float32Array(inp)]; st.len = inp.length; st.silence = 0;
        aiListenUI('hearing');
      }
    } else {
      st.buf.push(new Float32Array(inp)); st.len += inp.length;
      if (rms > 0.015) st.silence = 0;
      else st.silence += inp.length / ctx.sampleRate * 1000;
      const ms = st.len / ctx.sampleRate * 1000;
      // 静音超过 0.9 秒（且说了至少 0.9 秒）= 一句话说完了；或最长 20 秒强制截断
      if ((st.silence > 900 && ms > 900) || ms > 20000) {
        st.speaking = false; st.silence = 0;
        const all = new Float32Array(st.len);
        let off = 0;
        for (const c of st.buf) { all.set(c, off); off += c.length; }
        st.buf = []; st.len = 0;
        aiListenUI('on');
        aiUtterance(all, ctx.sampleRate);
      }
    }
  };
  src.connect(proc);
  proc.connect(ctx.destination);
  aiListenUI('on');
  aiLog('全时聆听已开启 ✓');
}

function aiListenStop() {
  if (!aiVad) return;
  const st = aiVad; aiVad = null;
  try { st.proc.disconnect(); st.stream.getTracks().forEach(t => t.stop()); st.ctx.close(); } catch (e) {}
  aiListenUI('off');
}

// 一句话说完了：送云 ASR 识别 → 大模型回答 → 她开口说
async function aiUtterance(samples, rate) {
  const ms = samples.length / rate * 1000;
  if (ms < 700) return;   // 太短当杂音忽略
  const wav = aiFloatToWav(samples, rate);
  const u8 = new Uint8Array(wav);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  try {
    const resp = await cfPost('asr', { format: 'wav', audio: btoa(bin) }, 25000);
    const d = await resp.json().catch(() => ({}));
    if (d.code === 0 && d.text) {
      aiShowUserBubble(d.text);
      const reply = await aiReplySmart(d.text);
      aiSpeak(reply);
    } else if (d.message) {
      aiLog('识别: ' + String(d.message).slice(0, 60));
    }
  } catch (e) {
    aiLog('识别失败: ' + (e.message || e));
  }
}

// 挂断按钮双保险（onclick 之外再绑 touchend，防 iOS 点按失效）
(function bindHangup() {
  const b = document.getElementById('aicHangupBtn');
  if (!b) return;
  b.addEventListener('touchend', (e) => { e.preventDefault(); aiHangup(); }, { passive: false });
})();

/* ============================================
   微信式文字聊天页（角色卡「聊天」按钮进入）
   你打字发一句，TA 打字回一句；聊天记录持久化，
   每句自动写入记忆库，回复复用 aiReply 记忆召回引擎
   ============================================ */
let aiChatChar = null;

function chatLogKey(id) { return 'yn_chat_' + id; }

function chatLogGet(id) {
  try { return JSON.parse(localStorage.getItem(chatLogKey(id)) || '[]'); } catch (e) { return []; }
}

function openChat(id) {
  const char = aiFindChar(id);
  if (!char) { showToast('角色不存在'); return; }
  if (Date.now() - char.createdAt < CHAR_READY_AFTER_MS) { showToast('数字人还在创建中，请稍候…'); return; }
  aiChatChar = char;
  aiCallChar = char;   // aiReply/aiGreeting 依赖 aiCallChar
  document.getElementById('chatName').textContent = char.name || '亲人';
  const av = document.getElementById('chatAvatar');
  av.innerHTML = char.photo
    ? '<img src="' + char.photo + '" alt="">'
    : escapeHtml((char.name || '亲').slice(0, 1));
  const box = document.getElementById('chatMsgs');
  box.innerHTML = '';
  const log = chatLogGet(char.id).slice(-50);
  log.forEach(m => chatRenderMsg(m.r, m.t));
  navigate('chat');
  requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  // 首次打开（无历史记录）：TA 主动打招呼（带记忆召回）
  if (!log.length) {
    setTimeout(() => {
      if (aiChatChar && document.getElementById('page-chat').classList.contains('active')) {
        chatAppend('ta', aiGreeting(char));
      }
    }, 800);
  }
}

function chatRenderMsg(role, text) {
  const box = document.getElementById('chatMsgs');
  if (!box) return;
  const row = document.createElement('div');
  row.className = 'chat-row ' + (role === 'me' ? 'me' : 'ta');
  let inner = '';
  if (role === 'ta' && aiChatChar) {
    inner += aiChatChar.photo
      ? '<div class="chat-msg-avatar"><img src="' + aiChatChar.photo + '" alt=""></div>'
      : '<div class="chat-msg-avatar">' + escapeHtml((aiChatChar.name || '亲').slice(0, 1)) + '</div>';
  }
  inner += '<div class="chat-bubble">' + escapeHtml(text) + '</div>';
  row.innerHTML = inner;
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

function chatAppend(role, text) {
  if (!aiChatChar) return;
  const log = chatLogGet(aiChatChar.id);
  log.push({ r: role, t: text, ts: Date.now() });
  try { localStorage.setItem(chatLogKey(aiChatChar.id), JSON.stringify(log.slice(-200))); } catch (e) {}
  chatRenderMsg(role, text);
}

function chatTyping(show) {
  const box = document.getElementById('chatMsgs');
  if (!box) return;
  let tip = document.getElementById('chatTypingRow');
  if (show) {
    if (tip) return;
    tip = document.createElement('div');
    tip.className = 'chat-row ta';
    tip.id = 'chatTypingRow';
    tip.innerHTML = '<div class="chat-msg-avatar"><span class="chat-dot-flash">●</span></div><div class="chat-bubble">正在输入…</div>';
    box.appendChild(tip);
    box.scrollTop = box.scrollHeight;
  } else if (tip) {
    tip.remove();
  }
}

async function chatSend() {
  if (aiCallState === 'calling') { showToast('通话中，请在通话界面对话'); return; }
  const inp = document.getElementById('chatInput');
  if (!inp || !aiChatChar) return;
  const text = (inp.value || '').trim();
  if (!text) return;
  inp.value = '';
  chatAppend('me', text);
  memAdd(aiChatChar.id, text, 'chat');   // 你说的话进记忆库
  chatTyping(true);
  aiCallChar = aiChatChar;
  const reply = await aiReplySmart(text); // 大模型优先，失败退回规则引擎
  chatTyping(false);
  chatAppend('ta', reply);
  memAdd(aiChatChar.id, reply, 'ai');    // TA 的话也进记忆库
}

// ===== 控制按钮 =====
function aiUpdateCtl(id, on, label) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('off', !on);
  const lbl = el.querySelector('.aic-ctl-label');
  if (lbl) lbl.textContent = label;
}

async function aiToggleMic() {
  if (aiCallState !== 'connected') return;
  aiMicOn = !aiMicOn;
  aiUpdateCtl('micCtlBtn', aiMicOn, aiMicOn ? '麦克风已开' : '麦克风已关');
  if (aiMicOn && aiSRSupported()) aiStartRecognition();
  else aiStopRecognition();
  showToast(aiMicOn ? '麦克风已开启' : '麦克风已关闭');
}

async function aiToggleCam() {
  if (aiCallState !== 'connected') return;
  const pipVideo = document.getElementById('aicPipVideo');
  const pipHint = document.getElementById('aicPipHint');
  if (!aiCamOn) {
    try {
      aiLocalStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: aiFacing } },
        audio: false
      });
      pipVideo.srcObject = aiLocalStream;
      pipVideo.style.display = 'block';
      pipHint.style.display = 'none';
      aiCamOn = true;
    } catch (e) {
      showToast('无法开启摄像头，请检查权限');
      return;
    }
  } else {
    if (aiLocalStream) { aiLocalStream.getTracks().forEach(t => t.stop()); aiLocalStream = null; }
    pipVideo.srcObject = null;
    pipVideo.style.display = 'none';
    pipHint.style.display = 'flex';
    aiCamOn = false;
  }
  aiUpdateCtl('camCtlBtn', aiCamOn, aiCamOn ? '摄像头已开' : '摄像头已关');
}

async function aiFlipCamera() {
  if (aiCallState !== 'connected') return;
  aiFacing = aiFacing === 'user' ? 'environment' : 'user';
  if (aiCamOn) {
    // 重启流以切换摄像头
    if (aiLocalStream) { aiLocalStream.getTracks().forEach(t => t.stop()); }
    try {
      aiLocalStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: aiFacing } },
        audio: false
      });
      document.getElementById('aicPipVideo').srcObject = aiLocalStream;
      showToast(aiFacing === 'user' ? '已切换到前置' : '已切换到后置');
    } catch (e) {
      showToast('翻转失败，该设备可能没有后置摄像头');
    }
  } else {
    showToast(aiFacing === 'user' ? '已切换到前置' : '已切换到后置');
  }
}

// ===== 挂断 / 清理（异常兜底：无论内部是否报错，界面必返回首页） =====
function aiHangup() {
  try {
    aiCallState = 'ended';
    aiStopRecognition();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (aiLocalStream) { aiLocalStream.getTracks().forEach(t => t.stop()); aiLocalStream = null; }
    if (aiCallTimer) { clearInterval(aiCallTimer); aiCallTimer = null; }
    if (aiIvhPollTimer) { clearInterval(aiIvhPollTimer); aiIvhPollTimer = null; }
    if (aiWatchdog) { clearTimeout(aiWatchdog); aiWatchdog = null; }
    // 真实模式：关闭云端会话（释放并发）+ 退出房间
    if (aiCallReal && aiIvhSessionId && TRTC_CONFIG.ivhServer) {
      const sid = aiIvhSessionId;
      cfPost('close', { sessionId: sid }, 8000).catch(() => {});
      if (aiIvhTrtc) {
        try { aiIvhTrtc.exitRoom(); } catch (e) {}
        aiIvhTrtc = null;
      }
      aiIvhSessionId = '';
      aiIvhRemoteUserId = '';
      aiCallReal = false;
    }
    aiSetCardCalling(false);
  } catch (e) { /* 清理异常不阻塞返回 */ }
  // 兜底清理（必须执行）
  try {
    aiListenStop();   // 停止全时聆听
    document.getElementById('aiCallScreen').style.display = 'none';
    const lst = document.getElementById('aicListen');
    if (lst) lst.style.display = 'none';
    const ul = document.getElementById('aicAudioUnlock');
    if (ul) ul.style.display = 'none';
    document.getElementById('aicSubtitle').style.display = 'none';
    document.getElementById('aicUserBubble').style.display = 'none';
  } catch (e) {}
  navigate('library');
  showToast('通话已结束');
}

function aiInfo() {
  showToast('该形象由 AI 生成，对话为演示版本；正式版将接入真实数字人引擎实现口型同步');
}

// 离开页面自动清理
window.addEventListener('beforeunload', () => {
  if (aiLocalStream) aiLocalStream.getTracks().forEach(t => t.stop());
  aiStopRecognition();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
});

// ===== 扬声器开关（微信式：静音/取消静音远端音频） =====
let aiSpeakerOn = true;
async function aiToggleSpeaker() {
  aiSpeakerOn = !aiSpeakerOn;
  // 真实模式：走 TRTC 正规远端静音接口（v5 播放走 WebAudio，video.muted 无效）
  if (aiCallReal && aiIvhTrtc && aiIvhRemoteUserId) {
    try { await aiIvhTrtc.muteRemoteAudio(aiIvhRemoteUserId, !aiSpeakerOn); } catch (e) { aiLog('静音失败: ' + (e.message || e)); }
  }
  // 演示模式：静音页面里的音视频元素
  document.querySelectorAll('#aiCallScreen video, #aiCallScreen audio').forEach(v => { v.muted = !aiSpeakerOn; });
  const lbl = document.getElementById('spkCtlLabel');
  if (lbl) lbl.textContent = aiSpeakerOn ? '扬声器已开' : '扬声器已关';
  const btn = document.getElementById('spkCtlBtn');
  if (btn) btn.classList.toggle('off', !aiSpeakerOn);
  showToast(aiSpeakerOn ? '扬声器已开启' : '扬声器已关闭');
}

// ===== 小窗切换（放大/还原自己画面） =====
let aiPipLarge = false;
function aiTogglePip() {
  aiPipLarge = !aiPipLarge;
  const pip = document.querySelector('#aiCallScreen .aic-pip');
  if (pip) pip.classList.toggle('large', aiPipLarge);
  showToast(aiPipLarge ? '已放大自己的画面' : '已还原小窗');
}
