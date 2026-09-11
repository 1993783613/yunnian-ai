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
 * - IVH_IMAGE_ID                  ：形象资产 ID（用 createsessionbyasset 时需要）
 * - IVH_PROJECT_ID                ：会话互动项目 ID（用 createsession 时需要，绑定了并发配额）
 *
 * 部署：Node.js 16.13+，依赖 tls-sig-api-v2（node_modules 已含）
 */

const tls = require('tls-sig-api-v2');
const https = require('https');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
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

// Node 16 无 fetch，用 https 模块 POST JSON（headers 可选，用于大模型鉴权）
function postJSON(url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json;charset=utf-8', 'Content-Length': Buffer.byteLength(data) }, extraHeaders || {}),
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
    const err = new Error('IVH 接口错误 Code=' + resp.Header.Code + ' ' + (resp.Header.Message || ''));
    err.rawResponse = JSON.stringify(resp).slice(0, 800);
    throw err;
  }
  return resp;
}

// ===== 腾讯云 TC3-HMAC-SHA256 签名 POST（用于 ASR 一句话识别） =====
const crypto = require('crypto');
function tc3Post(host, service, version, action, payload) {
  const secretId = process.env.ASR_SECRET_ID || '';
  const secretKey = process.env.ASR_SECRET_KEY || '';
  if (!secretId || !secretKey) return Promise.reject(new Error('云函数未配置 ASR_SECRET_ID / ASR_SECRET_KEY 环境变量'));
  const ts = Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const body = JSON.stringify(payload);
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const canonical = 'POST\n/\n\n' + 'content-type:application/json\nhost:' + host + '\n\n' + 'content-type;host\n' + sha(body);
  const toSign = 'TC3-HMAC-SHA256\n' + ts + '\n' + date + '/' + service + '/tc3_request\n' + sha(canonical);
  const kDate = crypto.createHmac('sha256', 'TC3' + secretKey).update(date).digest();
  const kService = crypto.createHmac('sha256', kDate).update(service).digest();
  const kSign = crypto.createHmac('sha256', kService).update('tc3_request').digest();
  const signature = crypto.createHmac('sha256', kSign).update(toSign).digest('hex');
  const auth = 'TC3-HMAC-SHA256 Credential=' + secretId + '/' + date + '/' + service + '/tc3_request, SignedHeaders=content-type;host, Signature=' + signature;
  // 注意：postJSON 内部会 JSON.stringify，必须传对象（body 变量仅用于签名，保证签名的串和发送的串一致）
  return postJSON('https://' + host + '/', payload, {
    'Content-Type': 'application/json',
    'Authorization': auth,
    'X-TC-Action': action,
    'X-TC-Version': version,
    'X-TC-Timestamp': String(ts),
    'X-TC-Region': process.env.ASR_REGION || 'ap-guangzhou'
  });
}

// ===== 万能事件解析：兼容 SCF 各种事件形态（对象/字符串/空查询/Web函数） =====
function parseQuery(event) {
  let ev = event;
  if (typeof ev === 'string') {
    try { ev = JSON.parse(ev); } catch (e) { return { __raw: ev }; }
  }
  if (!ev || typeof ev !== 'object') return {};
  let q = ev.queryString || ev.queryStringParameters || null;
  if (typeof q === 'string' && q) {
    const o = {};
    new URLSearchParams(q).forEach((v, k) => { o[k] = v; });
    q = o;
  }
  if (!q) {
    // Web 函数形态：从原始 URL 里抠查询串
    const urlLike = ev.rawUrl || ev.url || ev.path || '';
    const qi = String(urlLike).indexOf('?');
    if (qi >= 0) {
      const o = {};
      new URLSearchParams(String(urlLike).slice(qi + 1)).forEach((v, k) => { o[k] = v; });
      q = o;
    }
  }
  if ((!q || !Object.keys(q).length) && ev.body) {
    // 兜底：POST JSON body 里可能带 action 等字段
    try {
      const b = typeof ev.body === 'string' ? JSON.parse(ev.body) : ev.body;
      if (b && typeof b === 'object') q = Object.assign({}, b, q || {});
    } catch (e) {}
  }
  if (!q) q = ev;
  return q || {};
}

exports.main_handler = async (event) => {
  if (event && typeof event === 'object' && event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const query = parseQuery(event);
  const action = query.action || 'usersig';

  // ===== 0. debug：返回云函数实际收到的事件结构（排查触发器问题用） =====
  if (action === 'debug') {
    const ev = typeof event === 'object' ? event : { __type: typeof event, __raw: String(event).slice(0, 500) };
    return json(200, {
      code: 0,
      eventType: typeof event,
      topKeys: ev && typeof ev === 'object' ? Object.keys(ev) : [],
      queryString: ev && ev.queryString,
      queryStringParameters: ev && ev.queryStringParameters,
      rawUrl: ev && (ev.rawUrl || ev.url || ev.path || ''),
      parsedAction: action,
      parsedQuery: query,
      preview: JSON.stringify(ev).slice(0, 600)
    });
  }

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
      projectId: process.env.IVH_PROJECT_ID || '未配置',
      trtcAppId: process.env.SDKAPPID || '未配置',
      // 调试：暴露当前环境变量的前 8 位（用于核对是否配置错值）
      appkeyPrefix: (process.env.IVH_APPKEY || '').slice(0, 8),
      tokenPrefix: (process.env.IVH_ACCESSTOKEN || '').slice(0, 8)
    });
  }

  // ===== 2.5 list：列出账号下可用的数字人形象（找真正的 VirtualmanKey） =====
  if (action === 'list') {
    try {
      const resp = await ivhPost('/v2/ivh/crmserver/customerassetservice/describesmallsampleimage', {
        PageIndex: 1, pageIndex: 1, PageSize: 100
      });
      const mans = (resp.Payload && resp.Payload.Virtualmans) || [];
      return json(200, {
        code: 0,
        total: mans.length,
        currentImageId: process.env.IVH_IMAGE_ID || '未配置',
        currentProjectId: process.env.IVH_PROJECT_ID || '未配置',
        avatars: mans.map(m => ({
          key: m.VirtualmanKey,
          name: m.AnchorName,
          clothes: m.ClothesName,
          pose: m.PoseName,
          resolution: m.Resolution,
          expire: m.ExpireDate,
          driver: m.SupportDriverTypes
        }))
      });
    } catch (err) {
      return json(500, { code: 4, message: '查询形象列表失败: ' + err.message });
    }
  }

  // ===== 3. 创建数字人会话 =====
  // 优先用项目 ID 建流（项目已绑定形象 + 并发配额），降级用形象 ID 建流
  if (action === 'create') {
    try {
      const sdkAppId = Number(process.env.SDKAPPID);
      const secretKey = process.env.SECRETKEY;
      if (!sdkAppId || !secretKey) return json(500, { code: 1, message: '未配置 SDKAPPID / SECRETKEY' });

      const roomId = Math.floor(10000000 + Math.random() * 90000000);
      const vUserId = 'ivh_anchor_' + Math.random().toString(36).slice(2, 8);
      const api = new tls.Api(sdkAppId, secretKey);
      const vUserSig = api.genSig(vUserId, SIG_EXPIRE_SECONDS);

      const projectId = process.env.IVH_PROJECT_ID;
      let resp;
      if (projectId) {
        // 路径 A：项目 ID 建流（推荐，已绑并发）
        resp = await ivhPost('/v2/ivh/sessionmanager/sessionmanagerservice/createsession', {
          ReqId: uuid32(),
          VirtualmanProjectId: projectId,
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
      } else {
        // 路径 B：形象 ID 建流（回退方案，要求并发配额已绑到形象上）
        resp = await ivhPost('/v2/ivh/sessionmanager/sessionmanagerservice/createsessionbyasset', {
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
      }

      const p = resp.Payload || {};
      if (!p.SessionId) {
        return json(500, { code: 3, message: '创建会话失败: ' + JSON.stringify(resp).slice(0, 300) });
      }
      return json(200, {
        code: 0,
        sessionId: p.SessionId,
        roomId: roomId,
        vUserId: vUserId,
        sessionStatus: p.SessionStatus,
        usedProjectId: !!projectId
      });
    } catch (err) {
      // 调试：把 IVH 原始响应也带出来
      const raw = err.rawResponse ? err.rawResponse.slice(0, 600) : '(no raw)';
      return json(500, { code: 4, message: err.message, ivhRaw: raw });
    }
  }

  // ===== 3.5 调试专用：直接打 IVH 看错误原始形态 + 项目 ID 是否存在 =====
  if (action === 'create_diag') {
    const projectId = process.env.IVH_PROJECT_ID;
    const imageId = process.env.IVH_IMAGE_ID;
    try {
      // 试验 A：直接 createsession 当前 projectId
      const a = await ivhPost('/v2/ivh/sessionmanager/sessionmanagerservice/createsession', {
        ReqId: uuid32(),
        VirtualmanProjectId: projectId,
        UserId: 'diag_' + Math.random().toString(36).slice(2, 8),
        Protocol: 'trtc',
        DriverType: 1
      });
      return json(200, { diag: 'A createsession ok', resp: JSON.stringify(a).slice(0, 600) });
    } catch (errA) {
      try {
        // 试验 B：createsessionbyasset 当前 imageId（备用诊断）
        const b = await ivhPost('/v2/ivh/sessionmanager/sessionmanagerservice/createsessionbyasset', {
          ReqId: uuid32(),
          AssetVirtualmanKey: imageId,
          UserId: 'diag_' + Math.random().toString(36).slice(2, 8),
          Protocol: 'trtc',
          DriverType: 1
        });
        return json(200, { diag: 'A 失败但 B 成功', aErr: errA.message, bResp: JSON.stringify(b).slice(0, 600) });
      } catch (errB) {
        return json(500, { diag: 'A 和 B 都失败', aErr: errA.message, bErr: errB.message, projectId, imageId });
      }
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
  // variant: 1={Text} 2={Text,ChatCommand:'NotUseChat'}(默认) 3={Type:0,Text} —— 便于远程排查驱动报错
  if (action === 'drive') {
    try {
      const text = (query.text || '').slice(0, 4000);
      if (!text) return json(400, { code: 1, message: '缺少 text' });
      let Data;
      if (query.variant === '1') Data = { Text: text };
      else if (query.variant === '3') Data = { Type: 0, Text: text };
      else Data = { Text: text, ChatCommand: 'NotUseChat' };
      const resp = await ivhPost('/v2/ivh/interactdriver/interactdriverservice/command', {
        ReqId: uuid32(),
        SessionId: query.sessionId,
        Command: 'SEND_TEXT',
        Data: Data
      });
      return json(200, { code: 0, resp: JSON.stringify(resp).slice(0, 400) });
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

  // ===== 8. chat：大模型对话（OpenAI 兼容接口；默认智谱 GLM-4-Flash 免费） =====
  // POST body: { messages: [{role:'system'|'user'|'assistant', content:'...'}, ...] }
  // 环境变量：LLM_APIKEY（必填）、LLM_BASE_URL（默认智谱）、LLM_MODEL（默认 glm-4-flash）
  if (action === 'chat') {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) {}
    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (!messages || !messages.length) return json(400, { code: 1, message: '缺少 messages 参数' });
    const apiKey = process.env.LLM_APIKEY;
    if (!apiKey) return json(200, { code: 3, message: '云函数未配置 LLM_APIKEY 环境变量' });
    const llmUrl = process.env.LLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
    const model = process.env.LLM_MODEL || 'glm-4-flash';
    try {
      const resp = await postJSON(llmUrl, {
        model: model,
        messages: messages,
        // 稳定人设场景：温度调低，避免回答飘、重复、前后不连贯
        temperature: 0.65,
        max_tokens: 400
      }, { Authorization: 'Bearer ' + apiKey });
      const reply = resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
      if (!reply) return json(200, { code: 4, message: '大模型返回异常: ' + JSON.stringify(resp).slice(0, 300) });
      return json(200, { code: 0, reply: String(reply).trim() });
    } catch (err) {
      return json(200, { code: 5, message: '大模型请求失败: ' + err.message });
    }
  }

  // ===== 9. asr：一句话语音识别（腾讯云 ASR，TC3 签名） =====
  // POST body: { format: 'wav'|'m4a'|'mp3', audio: '<base64>' }
  // 环境变量：ASR_SECRET_ID / ASR_SECRET_KEY（必填，CAM 密钥）
  if (action === 'asr') {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) {}
    const audio = body.audio;
    const format = body.format || 'wav';
    if (!audio) return json(400, { code: 1, message: '缺少 audio(base64) 参数' });
    try {
      const resp = await tc3Post('asr.tencentcloudapi.com', 'asr', '2019-06-14', 'SentenceRecognition', {
        ProjectId: 0,
        SubServiceType: 2,
        EngSerViceType: '16k_zh',
        SourceType: 1,
        VoiceFormat: format,
        Data: audio,
        DataLen: Buffer.from(audio, 'base64').length
      });
      const r = resp.Response || resp;
      if (r.Error) return json(200, { code: 2, message: 'ASR错误: ' + r.Error.Code + ' ' + r.Error.Message });
      if (!r.Result) return json(200, { code: 3, message: 'ASR未识别到内容: ' + JSON.stringify(resp).slice(0, 200) });
      return json(200, { code: 0, text: r.Result });
    } catch (err) {
      return json(200, { code: 4, message: '语音识别失败: ' + err.message });
    }
  }

  return json(400, { code: 1, message: '未知 action: ' + action });
};
