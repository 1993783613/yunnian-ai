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
let aiIvhPollTimer = null;

// ===== 工具 =====
function aiFmt(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return m + ':' + s;
}

function aiFindChar(id) {
  // 内置平台示例角色
  const DEMO = {
    demo_grandma: { id: 'demo_grandma', name: '瑶瑶的奶奶', age: '72', relation: '我的外婆', voice: '和蔼奶奶', photo: '', createdAt: 0 },
    demo_grandpa: { id: 'demo_grandpa', name: '阿哲的爷爷', age: '75', relation: '最疼我的爷爷', voice: '慈祥爷爷', photo: '', createdAt: 0 }
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

// ===== 第 1 步：确认弹窗 =====
function aiCallConfirm(id, mode) {
  const char = aiFindChar(id);
  if (!char) { showToast('角色不存在'); return; }
  const ready = Date.now() - char.createdAt >= CHAR_READY_AFTER_MS;
  if (!ready) { showToast('数字人还在创建中，请稍候…'); return; }

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

async function aiCallGo() {
  document.getElementById('aicConfirmMask').style.display = 'none';
  if (!aiCallChar) return;
  aiUnlockSpeech();
  aiCallState = 'calling';

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
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach(t => t.stop());
    micOk = true;
  } catch (e) { /* 用户拒绝或无设备，继续流程但不识别 */ }

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
      if (aiCallState !== 'calling') return;
      aiLog('真实数字人接入失败，降级演示模式: ' + (err.message || err));
      showToast('数字人通道繁忙，已切换演示模式');
    }
  }
  aiCallConnect();
}

// ===== 真实数字人流程（IVH 云渲染 + TRTC 拉流 + 文本驱动） =====
async function aiIvhCallFlow() {
  aiCallReal = true;
  const base = TRTC_CONFIG.ivhServer.replace(/\/+$/, '');

  document.getElementById('aicPhaseMain').textContent = '正在接通…';
  document.getElementById('aicPhaseSub').textContent = '正在唤醒数字人…';

  // 1. 创建会话（云端加载形象并推流到 TRTC 房间）
  const r1 = await fetch(base + '?action=create').then(r => r.json());
  if (r1.code !== 0) throw new Error(r1.message || '创建会话失败');
  aiIvhSessionId = r1.sessionId;
  aiLog('会话已创建 ' + r1.sessionId + '，房间 ' + r1.roomId);

  // 2. 进入 TRTC 房间拉数字人的流
  const myId = 'v_' + Math.random().toString(36).slice(2, 8);
  const sigResp = await getUserSig(myId);
  aiIvhTrtc = TRTC.create();
  aiIvhTrtc.on(TRTC.EVENT.REMOTE_VIDEO_AVAILABLE, async (ev) => {
    aiLog('收到数字人视频流，开始渲染…');
    const box = document.getElementById('aicRemoteBox');
    try {
      await aiIvhTrtc.startRemoteVideo({ userId: ev.userId, streamType: ev.streamType, view: box });
      box.style.display = 'block';
      document.getElementById('aicFullPhoto').style.display = 'none';
      aiLog('数字人画面渲染成功 ✓');
    } catch (e) {
      aiLog('渲染失败: ' + (e.message || e));
    }
  });
  aiIvhTrtc.on(TRTC.EVENT.ERROR, (err) => aiLog('TRTC错误: ' + (err.message || err)));
  await aiIvhTrtc.enterRoom({
    roomId: r1.roomId,
    sdkAppId: TRTC_CONFIG.sdkAppId,
    userId: myId,
    userSig: sigResp,
    scene: 'rtc'
  });
  aiLog('已进入数字人房间');

  // 3. 等待流就绪（最多 120 秒）
  document.getElementById('aicPhaseMain').textContent = '正在接通…';
  document.getElementById('aicPhaseSub').textContent = '数字人加载中，首次约需 1–2 分钟…';
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (aiCallState !== 'calling') return;
    await aiSleep(3000);
    const r3 = await fetch(base + '?action=status&sessionId=' + r1.sessionId).then(x => x.json());
    if (r3.code === 0 && r3.sessionStatus === 1) { ready = true; break; }
  }
  if (!ready) throw new Error('数字人加载超时');

  // 4. 开启会话 → 显示通话界面（开场白由 aiCallConnect 内部驱动）
  await fetch(base + '?action=start&sessionId=' + r1.sessionId);
  aiCallConnect();
}

function aiLog(msg) {
  const box = document.getElementById('aicDebugLog');
  if (!box) return;
  const line = document.createElement('div');
  line.textContent = '[' + new Date().toTimeString().slice(0, 8) + '] ' + msg;
  box.appendChild(line);
  while (box.children.length > 6) box.removeChild(box.firstChild);
}

// ===== 真实数字人说话（云驱动：TTS + 口型同步） =====
async function ivhSpeak(text) {
  const sub = document.getElementById('aicSubtitle');
  sub.textContent = text;
  sub.style.display = 'block';
  clearTimeout(ivhSpeak._t);
  ivhSpeak._t = setTimeout(() => { sub.style.display = 'none'; }, 8000);
  try {
    const base = TRTC_CONFIG.ivhServer.replace(/\/+$/, '');
    await fetch(base + '?action=drive&sessionId=' + aiIvhSessionId + '&text=' + encodeURIComponent(text));
  } catch (e) {
    aiLog('驱动失败: ' + (e.message || e));
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

  // 开口第一句（数字人主动说话）
  const greet = aiGreeting(aiCallChar);
  aiSpeak(greet);

  // 开启"听"（支持的设备用语音识别，否则显示快捷回复）
  if (aiSRSupported()) {
    aiStartRecognition();
  } else {
    document.getElementById('aicChips').style.display = 'flex';
  }
}

// ===== AI 说话（真实模式=云驱动口型；演示模式=本地语音合成） =====
function aiSpeak(text) {
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

// ===== AI 回复引擎（规则版 + 记忆库召回，正式版替换为大模型 API） =====
function aiGreeting(char) {
  const rel = char.relation ? char.relation.replace(/^我的/, '') : '好孩子';
  // 记忆库里有内容时，主动提起上次聊过的话题
  const mems = memGetAll(char.id).filter(m => m.source !== 'ai');
  if (mems.length && Math.random() < 0.6) {
    const m = mems[Math.floor(Math.random() * Math.min(3, mems.length))];
    return '哎，' + rel + '来啦，' + (char.name || '') + '在呢。上次你跟我说「' + aiClip(m.text, 18) + '」，我一直记着呢，后来怎么样了？';
  }
  const pool = [
    '哎，' + rel + '，' + (char.name || '') + '在呢，好久没听到你的声音了，最近过得好不好？',
    '来啦，我正念叨你呢，吃饭了没有啊？',
    '是你啊，我可太想你了，最近忙什么呢？'
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}

function aiReply(text) {
  const t = (text || '').trim();
  const rel = aiCallChar.relation ? aiCallChar.relation.replace(/^我的/, '') : '孩子';
  const who = aiCallChar.name || '';

  // ① 先查记忆库：用户提到和旧记忆相关的事 → 召回并追问
  const hit = memMatch(t, memGetAll(aiCallChar.id).filter(m => m.source !== 'ai'));
  if (hit) {
    const R0 = [
      '这个我记得！你之前跟我讲过「' + aiClip(hit.text, 20) + '」，' + who + '一直放在心里呢，后来怎么样了？',
      '哎，你一提我就想起来了，你说过「' + aiClip(hit.text, 20) + '」，现在是什么情况啦？',
      '我记得记得，「' + aiClip(hit.text, 20) + '」嘛，' + who + '记性可好了。你接着跟我说说。'
    ];
    return R0[Math.floor(Math.random() * R0.length)];
  }

  const R = [
    [/想你|想念|思念|挂念/, ['哎，' + rel + '，我也天天想你，你好好上班，别惦记我，我身体硬朗着呢。', '我也想你啊，夜里翻来覆去都是你小时候的样子。']],
    [/吃了吗|吃饭|吃东西|饿/, ['刚吃过，锅里还给你留着呢，你到时候回来热一热就能吃。你也要按时吃饭，别老点外卖。']],
    [/身体|健康|血压|腿|生病|药/, ['我身体好着呢，就是天冷腿有点沉，你放心。倒是你，别熬夜，年纪轻轻把身体搞垮了可不行。']],
    [/工作|上班|累|忙|加班/, ['工作要紧，但也别太拼，钱够花就行。累了就歇歇，家里永远是你的退路。']],
    [/钱|缺不缺|给你|打钱/, ['我不缺钱，你别给我塞钱了，把自己照顾好比什么都强。']],
    [/故事|以前|过去|小时候|讲讲/, ['你小时候啊，最黏我了，天天跟在我后头喊' + who + '，一转眼都长这么大了，时间过得真快哟。']],
    [/天气|冷|热|下雨/, ['这边今天还行，你那边冷不冷？记得添衣服，别为了好看穿得单薄。']],
    [/睡了|晚安|困/, ['睡吧睡吧，做个好梦，我在这边看着你呢。晚安，' + rel + '。']],
    [/你是谁|你是|名字/, ['我是' + who + '呀，连' + (aiCallChar.voice || '') + '的声音都没听出来？']],
    [/好|嗯|哦|是的/, ['哎，好孩子。有空常来跟我说说话，我随时都在。']],
  ];
  for (const [re, answers] of R) {
    if (re.test(t)) return answers[Math.floor(Math.random() * answers.length)];
  }
  const fallback = [
    '哎，你说得对，' + rel + '长大了，有主见了，' + who + '听着高兴。',
    '嗯嗯，我在听呢，你慢慢说，我最爱听你讲话了。',
    '好，都听你的。你那边一切都好吗？'
  ];
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

  aiRecognition.onresult = (e) => {
    const said = e.results[e.results.length - 1][0].transcript;
    aiShowUserBubble(said);
    setTimeout(() => aiSpeak(aiReply(said)), 400);
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

// 快捷回复（不支持语音识别的设备）
function aiChipReply(text) {
  aiShowUserBubble(text);
  setTimeout(() => aiSpeak(aiReply(text)), 300);
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

// ===== 挂断 / 清理 =====
function aiHangup() {
  aiCallState = 'ended';
  aiStopRecognition();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (aiLocalStream) { aiLocalStream.getTracks().forEach(t => t.stop()); aiLocalStream = null; }
  if (aiCallTimer) { clearInterval(aiCallTimer); aiCallTimer = null; }
  if (aiIvhPollTimer) { clearInterval(aiIvhPollTimer); aiIvhPollTimer = null; }
  // 真实模式：关闭云端会话（释放并发）+ 退出房间
  if (aiCallReal && aiIvhSessionId && TRTC_CONFIG.ivhServer) {
    const base = TRTC_CONFIG.ivhServer.replace(/\/+$/, '');
    fetch(base + '?action=close&sessionId=' + aiIvhSessionId).catch(() => {});
    if (aiIvhTrtc) {
      try { aiIvhTrtc.exitRoom(); } catch (e) {}
      aiIvhTrtc = null;
    }
    aiIvhSessionId = '';
    aiCallReal = false;
  }
  aiSetCardCalling(false);
  document.getElementById('aiCallScreen').style.display = 'none';
  document.getElementById('aicChips').style.display = 'none';
  document.getElementById('aicSubtitle').style.display = 'none';
  document.getElementById('aicUserBubble').style.display = 'none';
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
