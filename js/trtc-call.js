/* ============================================
   云念AI - 腾讯云 TRTC 实时视频通话
   依赖：trtc-sdk-v5（index.html 中 CDN 引入）
   流程：大厅（创建房间/分享链接/加入房间）→ 通话中（真实音视频）
   ============================================ */

// ===== 全局通话状态 =====
let trtcClient = null;          // TRTC 实例
let trtcCurrentRoom = 0;        // 当前房间号
let trtcUserId = '';            // 当前用户 ID
let trtcRemoteUser = null;      // 对方用户 ID
let trtcTimer = null;           // 通话计时器
let trtcSeconds = 0;

// ===== 工具 =====
function trtcRandomId() {
  // 8 位房间号
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

// ===== 页面切换：进入通话页 =====
function trtcEnterCall() {
  // 清理上一次通话（若有）
  trtcCleanup(false);

  const params = new URLSearchParams(location.search);
  const roomParam = params.get('room');

  if (roomParam && /^\d{8}$/.test(roomParam)) {
    // 从分享链接进入 → 直接作为访客加入房间
    showLobbySection('none');
    document.getElementById('callActive').style.display = 'block';
    document.getElementById('inviteRoomNo').textContent = roomParam;
    trtcJoinRoom(Number(roomParam), 'g_' + Math.random().toString(36).slice(2, 8));
  } else {
    // 正常进入 → 显示大厅
    document.getElementById('callActive').style.display = 'none';
    showLobbySection('form');
  }
}

function showLobbySection(which) {
  document.getElementById('callLobby').style.display = which === 'none' ? 'none' : 'block';
  document.querySelector('.lobby-form').style.display = which === 'form' ? 'block' : 'none';
  document.getElementById('joinRoomBox').style.display = 'none';
  document.getElementById('invitePanel').style.display = 'none';
}

// ===== 大厅交互 =====
function showJoinRoom() {
  document.querySelector('.lobby-form').style.display = 'none';
  document.getElementById('joinRoomBox').style.display = 'block';
}

function trtcCreateRoom() {
  const nick = document.getElementById('callNickInput').value.trim();
  const roomId = trtcRandomId();
  trtcUserId = trtcMakeUserId('host');

  // 展示邀请面板
  document.querySelector('.lobby-form').style.display = 'none';
  const panel = document.getElementById('invitePanel');
  panel.style.display = 'block';
  document.getElementById('inviteRoomNo').textContent = roomId;

  const shareUrl = location.origin + location.pathname + '?room=' + roomId;
  document.getElementById('inviteLink').textContent = shareUrl;
  // 存起来，进入房间后仍可复制
  panel.dataset.shareUrl = shareUrl;
  panel.dataset.nick = nick || '我';
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
  trtcJoinRoom(trtcCurrentRoom);
}

// ===== UserSig 获取 =====
async function getUserSig(userId) {
  if (!TRTC_CONFIG.userSigServer) {
    throw new Error('尚未配置签名服务。请先部署 cloud-function 目录中的腾讯云函数，并把函数 URL 填入 js/config.js（见 README「通话签名服务部署」）。');
  }
  const url = TRTC_CONFIG.userSigServer.replace(/\/+$/, '') +
    '?sdkAppId=' + TRTC_CONFIG.sdkAppId + '&userId=' + encodeURIComponent(userId);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('签名服务返回 HTTP ' + resp.status);
  const data = await resp.json();
  const sig = data.userSig || data.sig || data.data;
  if (!sig) throw new Error('签名服务返回数据异常：' + JSON.stringify(data));
  return sig;
}

// ===== 进房 =====
async function trtcJoinRoom(roomId, presetUserId) {
  if (presetUserId) trtcUserId = presetUserId;
  if (!trtcUserId) trtcUserId = trtcMakeUserId('u');

  // 切换到通话中界面
  document.getElementById('callLobby').style.display = 'none';
  document.getElementById('callActive').style.display = 'block';
  document.getElementById('callRoomBadge').textContent = '房间 ' + roomId;
  document.getElementById('callDuration').textContent = '00:00';
  trtcSetStatus('正在进入房间…');
  document.getElementById('callConnecting').style.display = 'flex';
  document.getElementById('callConnectingText').textContent = '正在进入通话房间…';

  try {
    if (typeof TRTC === 'undefined') throw new Error('TRTC SDK 加载失败，请检查网络后刷新重试');

    const userSig = await getUserSig(trtcUserId);
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

    // 开启本地摄像头和麦克风
    try {
      await trtcClient.startLocalVideo({ view: document.getElementById('callLocalContainer'), option: { useFrontCamera: true } });
      await trtcClient.startLocalAudio({ option: { microphoneId: undefined } });
    } catch (mediaErr) {
      console.warn('媒体设备异常：', mediaErr);
      showToast('无法访问摄像头/麦克风，请检查浏览器权限');
    }

    document.getElementById('callConnecting').style.display = 'none';
    trtcSetStatus('等待对方加入…');
    showToast('已进入房间 ' + roomId + '，等待对方加入');
  } catch (err) {
    console.error('进房失败：', err);
    document.getElementById('callConnecting').style.display = 'none';
    trtcSetStatus('进入房间失败');
    showToast(err.message || '进入房间失败，请重试');
    // 回到大厅
    setTimeout(() => {
      document.getElementById('callActive').style.display = 'none';
      document.getElementById('callLobby').style.display = 'block';
      showLobbySection('form');
    }, 1500);
  }
}

// ===== 事件绑定 =====
function trtcBindEvents(client) {
  client.on(TRTC.EVENT.REMOTE_USER_ENTER, (event) => {
    trtcRemoteUser = event.userId;
    trtcSetStatus('对方已加入，通话中');
    document.getElementById('callRemoteAvatar').textContent = '在';
    trtcStartTimer();
    showToast('对方已加入');
  });

  client.on(TRTC.EVENT.REMOTE_USER_EXIT, (event) => {
    trtcRemoteUser = null;
    trtcStopTimer();
    document.getElementById('callRemoteAvatar').textContent = '对';
    document.getElementById('callRemoteContainer').style.display = 'none';
    trtcSetStatus('对方已离开');
    showToast('对方已离开通话');
  });

  client.on(TRTC.EVENT.REMOTE_VIDEO_AVAILABLE, (event) => {
    const box = document.getElementById('callRemoteContainer');
    box.style.display = 'block';
    document.getElementById('callRemoteAvatar').style.display = 'none';
    client.startRemoteVideo({ userId: event.userId, view: box }).catch(console.error);
  });

  client.on(TRTC.EVENT.REMOTE_VIDEO_UNAVAILABLE, () => {
    document.getElementById('callRemoteContainer').style.display = 'none';
    document.getElementById('callRemoteAvatar').style.display = 'flex';
  });

  client.on(TRTC.EVENT.ERROR, (err) => {
    console.error('TRTC 错误：', err);
  });

  client.on(TRTC.EVENT.KICKED_OUT, () => {
    showToast('你在其他设备进入了本房间');
    trtcHangup();
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

// ===== 麦克风 / 摄像头开关 =====
async function trtcToggleMic(el) {
  if (!trtcClient) return;
  const on = !el.classList.contains('active');
  el.classList.toggle('active', on);
  try {
    if (on) { await trtcClient.updateLocalAudio({ mute: TRTC.AUDIO_SOURCE_STATUS.RESUMED }); showToast('麦克风已开启'); }
    else { await trtcClient.updateLocalAudio({ mute: TRTC.AUDIO_SOURCE_STATUS.MUTED }); showToast('麦克风已关闭'); }
  } catch (e) { console.error(e); showToast('操作失败'); }
}

async function trtcToggleCam(el) {
  if (!trtcClient) return;
  const on = !el.classList.contains('active');
  el.classList.toggle('active', on);
  try {
    if (on) { await trtcClient.updateLocalVideo({ mute: TRTC.VIDEO_SOURCE_STATUS.RESUMED }); showToast('摄像头已开启'); }
    else { await trtcClient.updateLocalVideo({ mute: TRTC.VIDEO_SOURCE_STATUS.MUTED }); showToast('摄像头已关闭'); }
  } catch (e) { console.error(e); showToast('操作失败'); }
}

// ===== 挂断 / 清理 =====
function trtcHangup() {
  trtcCleanup(true);
  document.getElementById('callActive').style.display = 'none';
  document.getElementById('callLobby').style.display = 'block';
  showLobbySection('form');
  navigate('library');
  showToast('通话已结束');
}

function trtcCleanup(notify) {
  trtcStopTimer();
  trtcRemoteUser = null;
  if (trtcClient) {
    try {
      trtcClient.stopLocalAudio();
      trtcClient.stopLocalVideo();
      trtcClient.exitRoom();
    } catch (e) { /* 忽略清理异常 */ }
    trtcClient = null;
  }
  // 清掉 URL 中的 room 参数，避免再次进入时误判为访客链接
  if (location.search) {
    history.replaceState(null, '', location.pathname);
  }
}

// 页面关闭时自动退房
window.addEventListener('beforeunload', () => { if (trtcClient) trtcCleanup(false); });
