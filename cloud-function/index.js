/**
 * 云念AI - UserSig 签发 + IVH 数字人会话服务（腾讯云 SCF 云函数）v2
 *
 * 功能：
 * 1. usersig  — 为 TRTC 生成进房凭证（原有功能）
 * 2. create   — 创建数字人会话（形象资产建流，TRTC 协议，用本应用 TRTC 房间）
 * 3. status   — 查询会话状态（1=进行中/已就绪）
 * 4. start    — 开启会话（流就绪后必须调用才能驱动）
 * 5. drive    — 文本驱动（数字人 TTS + 口型同步说话）
 * 6. close    — 关闭会话（停止推流，释放并发）
 *
 * 环境变量：
 * - SDKAPPID / SECRETKEY          ：TRTC 应用（已有）
 * - IVH_APPKEY / IVH_ACCESSTOKEN  ：数智人平台「资源管理中心」获取
 * - IVH_IMAGE_ID                  ：形象资产 ID（如 95054）
 *
 * 部署：Node.js 16.13+，依赖 tls-sig-api-v2（node_modules 已含）
 */

const tls = require('tls-sig-api-v2');
const https = require('https');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8'
};

const SIG_EXPIRE_SECONDS = 7 * 24 * 3600;
const GW_HOST = 'gw.tvs.qq.com';

function json(status, obj) {
  return { statusCode: status, headers: CORS_HEADERS, body: JSON.stringify(obj) };
}

function uuid32() {
  return require('crypto').randomBytes(16).toString('hex');
}

// ===== IVH 签名：sorted(query) -> HmacSHA256(accesstoken) -> base64 -> urlencode =====
function ivhSignUrl(path) {
  const appkey = process.env.IVH_APPKEY || '';
  const token = process.env.IVH_ACCESSTOKEN || '';
  if (!appkey || !token) return null;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const content = 'appkey=' + appkey + '&timestamp=' + timestamp;
  const hmac = require('crypto').createHmac('sha256', token).update(content).digest('base64');
  const sign = encodeURIComponent(hmac);
  return 'https://' + GW_HOST + path + '?' + content + '&signature=' + sign;
}

// Node 16 无 fetch，用 https 模块 POST JSON
function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=utf-8', 'Content-Length': Buffer.byteLength(data) },
      timeout: 15000
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('响应解析失败: ' + buf.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.write(data);
    req.end();
  });
}

async function ivhPost(path, payload) {
  const url = ivhSignUrl(path);
  if (!url) throw new Error('云函数未配置 IVH_APPKEY / IVH_ACCESSTOKEN 环境变量');
  const resp = await postJSON(url, { Header: {}, Payload: payload });
  if (resp.Header && resp.Header.Code !== 0 && resp.Header.Code !== undefined) {
    throw new Error('IVH 接口错误 Code=' + resp.Header.Code + ' ' + (resp.Header.Message || ''));
  }
  return resp;
}

exports.main_handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const query = event.queryString || event.queryStringParameters || event || {};
  const action = query.action || 'usersig';

  // ===== 1. UserSig（原有） =====
  if (action === 'usersig') {
    const userId = query.userId;
    const sdkAppId = Number(query.sdkAppId) || Number(process.env.SDKAPPID);
    const secretKey = process.env.SECRETKEY;
    if (!sdkAppId || !secretKey) return json(500, { code: 1, message: '云函数未配置 SDKAPPID / SECRETKEY' });
    if (!userId) return json(400, { code: 1, message: '缺少 userId 参数' });
    try {
      const api = new tls.Api(sdkAppId, secretKey);
      return json(200, { code: 0, userId: String(userId), userSig: api.genSig(String(userId), SIG_EXPIRE_SECONDS) });
    } catch (err) {
      return json(500, { code: 2, message: '生成 UserSig 失败：' + err.message });
    }
  }

  // ===== 2. ping：检查 IVH 配置 =====
  if (action === 'ping') {
    return json(200, {
      code: 0,
      ivhAppkey: !!(process.env.IVH_APPKEY),
      ivhToken: !!(process.env.IVH_ACCESSTOKEN),
      imageId: process.env.IVH_IMAGE_ID || '未配置',
      trtcAppId: process.env.SDKAPPID || '未配置'
    });
  }

  // ===== 3. 创建数字人会话 =====
  if (action === 'create') {
    try {
      const sdkAppId = Number(process.env.SDKAPPID);
      const secretKey = process.env.SECRETKEY;
      if (!sdkAppId || !secretKey) return json(500, { code: 1, message: '未配置 SDKAPPID / SECRETKEY' });

      const roomId = Math.floor(10000000 + Math.random() * 90000000);
      const vUserId = 'ivh_anchor_' + Math.random().toString(36).slice(2, 8);
      const api = new tls.Api(sdkAppId, secretKey);
      const vUserSig = api.genSig(vUserId, SIG_EXPIRE_SECONDS);

      const resp = await ivhPost('/v2/ivh/sessionmanager/sessionmanagerservice/createsessionbyasset', {
        ReqId: uuid32(),
        AssetVirtualmanKey: process.env.IVH_IMAGE_ID || '95054',
        UserId: vUserId,
        Protocol: 'trtc',
        DriverType: 1,
        ProtocolOption: {
          TrtcUseExternalApp: true,
          TrtcAppId: String(sdkAppId),
          TrtcRoomId: roomId,
          TrtcUserSig: vUserSig,
          TrtcPrivateMapKey: 'dummy'
        }
      });

      const p = resp.Payload || {};
      if (!p.SessionId) {
        return json(500, { code: 3, message: '创建会话失败: ' + JSON.stringify(resp).slice(0, 300) });
      }
      return json(200, {
        code: 0,
        sessionId: p.SessionId,
        roomId: roomId,
        vUserId: vUserId,
        sessionStatus: p.SessionStatus
      });
    } catch (err) {
      return json(500, { code: 4, message: err.message });
    }
  }

  // ===== 4. 查询会话状态 =====
  if (action === 'status') {
    try {
      const resp = await ivhPost('/v2/ivh/sessionmanager/sessionmanagerservice/statsession', {
        ReqId: uuid32(),
        SessionId: query.sessionId
      });
      return json(200, { code: 0, sessionStatus: resp.Payload ? resp.Payload.SessionStatus : null });
    } catch (err) {
      return json(500, { code: 4, message: err.message });
    }
  }

  // ===== 5. 开启会话 =====
  if (action === 'start') {
    try {
      await ivhPost('/v2/ivh/sessionmanager/sessionmanagerservice/startsession', {
        ReqId: uuid32(),
        SessionId: query.sessionId
      });
      return json(200, { code: 0 });
    } catch (err) {
      return json(500, { code: 4, message: err.message });
    }
  }

  // ===== 6. 文本驱动（数字人开口说话 + 口型同步） =====
  if (action === 'drive') {
    try {
      const text = (query.text || '').slice(0, 4000);
      if (!text) return json(400, { code: 1, message: '缺少 text' });
      await ivhPost('/v2/ivh/interactdriver/interactdriverservice/command', {
        ReqId: uuid32(),
        SessionId: query.sessionId,
        Command: 'SEND_TEXT',
        Data: { Text: text, ChatCommand: 'NotUseChat' }
      });
      return json(200, { code: 0 });
    } catch (err) {
      return json(500, { code: 4, message: err.message });
    }
  }

  // ===== 7. 关闭会话（释放并发） =====
  if (action === 'close') {
    try {
      await ivhPost('/v2/ivh/sessionmanager/sessionmanagerservice/closesession', {
        ReqId: uuid32(),
        SessionId: query.sessionId
      });
      return json(200, { code: 0 });
    } catch (err) {
      return json(500, { code: 4, message: err.message });
    }
  }

  return json(400, { code: 1, message: '未知 action: ' + action });
};
