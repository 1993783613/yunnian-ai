/* ============================================
   云念AI - 腾讯云 TRTC 实时视频通话 v2
   依赖：trtc-sdk-v5（index.html 中 CDN 引入）
   v2 修复：
   - 访客改为"点击加入"（满足 iOS 用户手势要求，解决无声问题）
   - 麦克风/摄像头开关改用布尔 mute 参数
   - 新增通话诊断日志（面板内可见，便于远程排查）
   ============================================ */

// ===== 全局通话状态 =====
let trtcClient = null;          // TRTC 实例
let trtcCurrentRoom = 0;        // 当前房间号
let trtcUserId = '';            // 当前用户 ID
let trtcTimer = null;           // 通话计时器
let trtcSeconds = 0;
let trtcMicOn = true;           // 麦克风状态
let trtcCamOn = true;           // 摄像头状态

// ===== 工具 =====
function trtcRandomId() {
  return Math.floor(10000000 + Math.random() * 90000000);
}

function trtcMakeUserId(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 8);
}

function trtcFormatDuration(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return m + ':' + s;
}

// ===== 诊断日志（屏幕上可见，方便手机端排查） =====
function trtcLog(msg) {
  const box = document.getElementById('callDebugLog');
  if (!box) return;
  const time = new Date().toTimeString().slice(0, 8);
  const line = document.createElement('div');
  line.textContent = '[' + time + '] ' + msg;
  box.appendChild(line);
  while (box.children.length > 8) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
  try { console.log('[TRTC]', msg); } catch (e) {}
}

// ===== 页面切换：进入通话页 =====
function trtcEnterCall() {
  trtcCleanup(false);

  const params = new URLSearchParams(location.search);
  const roomParam = params.get('room');

  document.getElementById('callActive').style.display = 'none';

  if (roomParam && /^\d{8}$/.test(roomParam)) {
    // 从分享链接进入 → 显示"加入通话"按钮（需要一次点击，满足 iOS 手势要求）
    trtcCurrentRoom = Number(roomParam);
    document.getElementById('callLobby').style.display = 'block';
    document.querySelector('.lobby-form').style.display = 'none';
    document.getElementById('joinRoomBox').style.display = 'none';
    document.getElementById('invitePanel').style.display = 'none';
    const guestBox = document.getElementById('guestJoinBox');
    guestBox.style.display = 'block';
    document.getElementById('guestRoomNo').textContent = roomParam;
  } else {
    // 正常进入 → 显示发起大厅
    document.getElementById('callLobby').style.display = 'block';
    showLobbySection('form');
  }
}

function showLobbySection(which) {
  document.getElementById('guestJoinBox').style.display = 'none';
  document.getElementById('callLobby').style.display = 'block';
  document.querySelector('.lobby-form').style.display = which === 'form' ? 'block' : 'none';
  document.getElementById('joinRoomBox').style.display = 'none';
  document.getElementById('invitePanel').style.display = 'none';
}

// ===== 大厅交互 =====
function showJoinRoom() {
  document.querySelector('.lobby-form').style.display = 'none';
  document.getElementById('guestJoinBox').style.display = 'none';
  document.getElementById('joinRoomBox').style.display = 'block';
}

function trtcCreateRoom() {
  const roomId = trtcRandomId();
  trtcUserId = trtcMakeUserId('host');

  document.querySelector('.lobby-form').style.display = 'none';
  const panel = document.getElementById('invitePanel');
  panel.style.display = 'block';
  document.getElementById('inviteRoomNo').textContent = roomId;

  const shareUrl = location.origin + location.pathname + '?room=' + roomId;
  document.getElementById('inviteLink').textContent = shareUrl;
  panel.dataset.shareUrl = shareUrl;
  trtcCurrentRoom = roomId;
}

function copyInviteLink() {
  const panel = document.getElementById('invitePanel');
  const url = panel.dataset.shareUrl || '';
  if (navigator.clipboard && url) {
    navigator.clipboard.writeText(url).then(
      () => showToast('邀请链接已复制，发给对方吧'),
      () => fallbackCopy(url)
    );
  } else {
    fallbackCopy(url);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); showToast('邀请链接已复制'); }
  catch (e) { showToast('复制失败，请长按链接手动复制'); }
  document.body.removeChild(ta);
}

function trtcJoinByRoomId() {
  const input = document.getElementById('joinRoomInput').value.trim();
  if (!/^\d{8}$/.test(input)) { showToast('请输入 8 位数字房间号'); return; }
  trtcUserId = trtcMakeUserId('g');
  trtcJoinRoom(Number(input));
}

function trtcEnterRoomAsHost() {
  if (!trtcCurrentRoom) return;
  trtcUserId = trtcMakeUserId('host');
  trtcJoinRoom(trtcCurrentRoom);
}

// 访客从分享链接点击加入（用户手势内发起，iOS 音频正常）
function trtcJoinAsGuest() {
  if (!trtcCurrentRoom) return;
  trtcUserId = trtcMakeUserId('g');
  trtcJoinRoom(trtcCurrentRoom);
}

// ===== UserSig 获取 =====
async function getUserSig(userId) {
  if (!TRTC_CONFIG.userSigServer) {
    throw new Error('尚未配置签名服务');
  }
  const url = TRTC_CONFIG.userSigServer.replace(/\/+$/, '') +
    '?sdkAppId=' + TRTC_CONFIG.sdkAppId + '&userId=' + encodeURIComponent(userId);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('签名服务返回 HTTP ' + resp.status);
  const data = await resp.json();
  const sig = data.userSig || data.sig || data.data;
  if (!sig) throw new Error('签名服务返回数据异常');
  return sig;
}

// ===== 进房 =====
async function trtcJoinRoom(roomId) {
  if (!trtcUserId) trtcUserId = trtcMakeUserId('u');

  // 重置通话界面
  document.getElementById('callLobby').style.display = 'none';
  document.getElementById('callActive').style.display = 'block';
  document.getElementById('callRoomBadge').textContent = '房间 ' + roomId;
  document.getElementById('callDuration').textContent = '00:00';
  document.getElementById('callRemoteAvatar').textContent = '对';
  document.getElementById('callRemoteAvatar').style.display = 'flex';
  document.getElementById('callRemoteContainer').style.display = 'none';
  document.getElementById('callDebugLog').innerHTML = '';
  trtcSetStatus('正在进入房间…');
  document.getElementById('callConnecting').style.display = 'flex';
  document.getElementById('callConnectingText').textContent = '正在进入通话房间…';
  trtcMicOn = true;
  trtcCamOn = true;
  document.getElementById('micBtn').classList.add('active');
  document.getElementById('camBtn').classList.add('active');
  trtcLog('准备进房 ' + roomId + '，身份 ' + trtcUserId);

  try {
    if (typeof TRTC === 'undefined') throw new Error('TRTC SDK 未加载，请刷新重试');

    trtcLog('获取进房凭证…');
    const userSig = await getUserSig(trtcUserId);
    trtcLog('凭证已获取 ✓');

    trtcCurrentRoom = roomId;
    trtcClient = TRTC.create();
    trtcBindEvents(trtcClient);

    await trtcClient.enterRoom({
      roomId: roomId,
      sdkAppId: TRTC_CONFIG.sdkAppId,
      userId: trtcUserId,
      userSig: userSig,
      scene: 'rtc'
    });
    trtcLog('已进房 ✓');

    // 开启本地麦克风（音频优先，失败不阻塞视频）
    try {
      await trtcClient.startLocalAudio();
      trtcLog('麦克风已开启 ✓');
    } catch (audioErr) {
      trtcLog('麦克风开启失败: ' + (audioErr.name || '') + ' ' + (audioErr.message || ''));
      showToast('无法访问麦克风，请检查权限');
    }

    // 开启本地摄像头
    try {
      await trtcClient.startLocalVideo({
        view: document.getElementById('callLocalContainer'),
        option: { useFrontCamera: true }
      });
      trtcLog('摄像头已开启 ✓');
    } catch (videoErr) {
      trtcLog('摄像头开启失败: ' + (videoErr.name || '') + ' ' + (videoErr.message || ''));
      showToast('无法访问摄像头，请检查权限');
    }

    document.getElementById('callConnecting').style.display = 'none';
    trtcSetStatus('等待对方加入…');
    trtcLog('等待对方加入…');
  } catch (err) {
    trtcLog('进房失败: ' + (err.message || err));
    document.getElementById('callConnecting').style.display = 'none';
    trtcSetStatus('进入房间失败');
    showToast(err.message || '进入房间失败，请重试');
    setTimeout(() => {
      document.getElementById('callActive').style.display = 'none';
      trtcEnterCall();
    }, 1500);
  }
}

// ===== 事件绑定 =====
function trtcBindEvents(client) {
  client.on(TRTC.EVENT.REMOTE_USER_ENTER, (event) => {
    trtcLog('对方已进房: ' + event.userId);
    trtcSetStatus('对方已加入，通话中');
    document.getElementById('callRemoteAvatar').textContent = '在';
    trtcStartTimer();
    showToast('对方已加入');
  });

  client.on(TRTC.EVENT.REMOTE_USER_EXIT, (event) => {
    trtcLog('对方已离开: ' + event.userId);
    trtcStopTimer();
    document.getElementById('callRemoteAvatar').textContent = '对';
    document.getElementById('callRemoteContainer').style.display = 'none';
    document.getElementById('callRemoteAvatar').style.display = 'flex';
    trtcSetStatus('对方已离开');
    showToast('对方已离开通话');
  });

  client.on(TRTC.EVENT.REMOTE_VIDEO_AVAILABLE, (event) => {
    trtcLog('收到对方视频流，开始渲染…');
    const box = document.getElementById('callRemoteContainer');
    box.style.display = 'block';
    document.getElementById('callRemoteAvatar').style.display = 'none';
    client.startRemoteVideo({ userId: event.userId, streamType: event.streamType, view: box })
      .then(() => trtcLog('对方视频渲染成功 ✓'))
      .catch((e) => trtcLog('视频渲染失败: ' + (e.message || e)));
  });

  client.on(TRTC.EVENT.REMOTE_VIDEO_UNAVAILABLE, (event) => {
    trtcLog('对方视频已关闭');
    document.getElementById('callRemoteContainer').style.display = 'none';
    document.getElementById('callRemoteAvatar').style.display = 'flex';
  });

  client.on(TRTC.EVENT.ERROR, (err) => {
    trtcLog('SDK 错误: ' + (err.code || '') + ' ' + (err.message || err));
  });

  client.on(TRTC.EVENT.KICKED_OUT, () => {
    showToast('你在其他设备进入了本房间');
    trtcHangup();
  });

  client.on(TRTC.EVENT.CONNECTION_STATE_CHANGED, (event) => {
    trtcLog('连接状态: ' + event.state);
  });
}

// ===== 计时 / 状态 =====
function trtcSetStatus(text) {
  const el = document.getElementById('callStatusText');
  if (el) el.innerHTML = '<span class="dot"></span>' + text;
}

function trtcStartTimer() {
  trtcStopTimer();
  trtcSeconds = 0;
  document.getElementById('callDuration').textContent = '00:00';
  trtcTimer = setInterval(() => {
    trtcSeconds++;
    document.getElementById('callDuration').textContent = trtcFormatDuration(trtcSeconds);
  }, 1000);
}

function trtcStopTimer() {
  if (trtcTimer) { clearInterval(trtcTimer); trtcTimer = null; }
}

// ===== 麦克风 / 摄像头开关（v5 API：mute 为布尔值） =====
async function trtcToggleMic(el) {
  if (!trtcClient) return;
  trtcMicOn = !trtcMicOn;
  el.classList.toggle('active', trtcMicOn);
  try {
    await trtcClient.updateLocalAudio({ mute: !trtcMicOn });
    trtcLog('麦克风: ' + (trtcMicOn ? '开' : '关'));
    showToast(trtcMicOn ? '麦克风已开启' : '麦克风已关闭');
  } catch (e) {
    trtcLog('麦克风切换失败: ' + (e.message || e));
    showToast('操作失败');
  }
}

async function trtcToggleCam(el) {
  if (!trtcClient) return;
  trtcCamOn = !trtcCamOn;
  el.classList.toggle('active', trtcCamOn);
  try {
    await trtcClient.updateLocalVideo({ mute: !trtcCamOn });
    trtcLog('摄像头: ' + (trtcCamOn ? '开' : '关'));
    showToast(trtcCamOn ? '摄像头已开启' : '摄像头已关闭');
  } catch (e) {
    trtcLog('摄像头切换失败: ' + (e.message || e));
    showToast('操作失败');
  }
}

// ===== 挂断 / 清理 =====
function trtcHangup() {
  trtcCleanup(true);
  document.getElementById('callActive').style.display = 'none';
  trtcEnterCall();
  navigate('library');
  showToast('通话已结束');
}

function trtcCleanup(notify) {
  trtcStopTimer();
  if (trtcClient) {
    try {
      trtcClient.stopLocalAudio();
      trtcClient.stopLocalVideo();
      trtcClient.exitRoom();
    } catch (e) { /* 忽略清理异常 */ }
    trtcClient = null;
  }
  if (location.search) {
    history.replaceState(null, '', location.pathname);
  }
}

// 页面关闭时自动退房
window.addEventListener('beforeunload', () => { if (trtcClient) trtcCleanup(false); });
