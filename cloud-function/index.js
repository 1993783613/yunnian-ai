/**
 * 云念AI - UserSig 签发 + IVH 数字人会话服务（腾讯云 SCF 云函数）v2
 *
 * 功能：
 * 1. usersig  — 为 TRTC 生成进房凭证（原有功能）
 * 2. create   — 创建数字人会话（形象资产建流，TRTC 协议，用本应用 TRTC 房间）
 * 3. status   — 查询会话状态（1=进行中/已就绪）
 * 4. start    — 开启会话（流就绪后必须调用才能驱动）
 * 5. drive    — 文本驱动（数字人 TTS + 口型同步说话）
 * 6. speak    — 音频驱动说话（Edge-TTS 合成 → ffmpeg 转 PCM → wss SEND_AUDIO 推流）
 * 7. close    — 关闭会话（停止推流，释放并发）
 *
 * 环境变量：
 * - SDKAPPID / SECRETKEY          ：TRTC 应用（已有）
 * - IVH_APPKEY / IVH_ACCESSTOKEN  ：数智人平台「资源管理中心」获取
 * - IVH_IMAGE_ID                  ：形象资产 ID（用 createsessionbyasset 时需要）
 * - IVH_PROJECT_ID                ：会话互动项目 ID（用 createsession 时需要，绑定了并发配额）
 *
 * 部署：Node.js 16.13+，依赖 tls-sig-api-v2 / msedge-tts / ffmpeg-static（node_modules 已含）
 */

const tls = require('tls-sig-api-v2');
const https = require('https');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const { MPEGDecoder } = require('mpg123-decoder');

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

// ===== IVH 长连接签名：appkey + requestid + timestamp 三参数按字典序排序后签名 =====
// 关键：音频驱动的 wss 长连接必须携带 requestid=SessionId，且 requestid 也要参与签名
function ivhWssUrl(path, sessionId) {
  const appkey = process.env.IVH_APPKEY || '';
  const token = process.env.IVH_ACCESSTOKEN || '';
  if (!appkey || !token) return null;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const content = 'appkey=' + appkey + '&requestid=' + sessionId + '&timestamp=' + timestamp;
  const hmac = require('crypto').createHmac('sha256', token).update(content).digest('base64');
  const sign = encodeURIComponent(hmac);
  return 'wss://' + GW_HOST + path + '?appkey=' + appkey + '&requestid=' + sessionId + '&timestamp=' + timestamp + '&signature=' + sign;
}

// ===== Edge-TTS 合成音频，返回 MP3 Buffer =====
// 音色：zh-CN-YunxiNeural（云希，年轻男声，适合「二大爷」的亲切邻家感）
async function edgeTts(text) {
  const tts = new MsEdgeTTS();
  const voice = process.env.TTS_VOICE || 'zh-CN-YunxiNeural';
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(text);
  const chunks = [];
  audioStream.on('data', (c) => chunks.push(c));
  await new Promise((res, rej) => { audioStream.on('end', res); audioStream.on('error', rej); });
  return Buffer.concat(chunks);
}

// ===== 纯 JS 转码：MP3 -> PCM 16kHz 16bit 单声道（mpg123-decoder 解码 + 线性重采样） =====
async function mp3ToPcm(mp3Buf) {
  const decoder = new MPEGDecoder();
  await decoder.ready;
  const decoded = decoder.decode(mp3Buf);
  const src = decoded.channelData[0]; // 左声道（单声道化）
  const srcRate = decoded.sampleRate; // Edge-TTS 输出 24000
  const dstRate = 16000;
  const ratio = srcRate / dstRate;
  const dstLen = Math.floor(src.length / ratio);
  const pcm16 = new Int16Array(dstLen);
  for (let i = 0; i < dstLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const i1 = Math.min(i0 + 1, src.length - 1);
    const v = src[i0] * (1 - frac) + src[i1] * frac;
    pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32768)));
  }
  decoder.free();
  return Buffer.from(pcm16.buffer);
}

// ===== 通过 wss 长连接把 PCM 音频分片推给数字人（SEND_AUDIO） =====
// 片包 160ms = 5120 字节（16k * 2字节 * 0.16s）；前6片最快发，之后每120ms一片；最后发 IsFinal=true 空包
function sendAudioViaWss(sessionId, pcmBuf) {
  return new Promise((resolve, reject) => {
    const wsUrl = ivhWssUrl('/v2/ws/ivh/streammanager/streamservice/commandchannel', sessionId);
    if (!wsUrl) return reject(new Error('未配置 IVH_APPKEY / IVH_ACCESSTOKEN'));
    const WebSocket = globalThis.WebSocket;
    const ws = new WebSocket(wsUrl);
    const reqId = uuid32();
    const CHUNK = 5120; // 160ms
    let seq = 0;
    let done = false;

    const finish = (err) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch (e) {}
      err ? reject(err) : resolve();
    };

    const timer = setTimeout(() => finish(new Error('推音频超时')), 30000);

    ws.addEventListener('open', () => {
      const total = pcmBuf.length;
      let offset = 0;
      let sent = 0;

      const sendNext = () => {
        if (offset >= total) {
          // 发 final 包
          ws.send(JSON.stringify({ Header: {}, Payload: { ReqId: reqId, SessionId: sessionId, Command: 'SEND_AUDIO', Data: { Audio: '', Seq: ++seq, IsFinal: true } } }));
          clearTimeout(timer);
          finish();
          return;
        }
        const end = Math.min(offset + CHUNK, total);
        const chunk = pcmBuf.subarray(offset, end);
        offset = end;
        seq++;
        ws.send(JSON.stringify({ Header: {}, Payload: { ReqId: reqId, SessionId: sessionId, Command: 'SEND_AUDIO', Data: { Audio: chunk.toString('base64'), Seq: seq, IsFinal: false } } }));
        sent++;
        // 前6片立即发，之后每120ms一片（保持实时率[0.75,1]）
        const delay = sent <= 6 ? 0 : 120;
        setTimeout(sendNext, delay);
      };
      sendNext();
    });

    ws.addEventListener('message', (e) => {
      // 监听下行，若返回错误码则记录（不中断，正常播报也会返回 speak_start/speak_over）
      try {
        const msg = JSON.parse(e.data);
        if (msg.Header && msg.Header.Code !== 0) {
          // 记录错误，但继续推完
          console.log('IVH 下行异常:', msg.Header.Code, msg.Header.Message);
        }
      } catch (err) {}
    });

    ws.addEventListener('error', (e) => finish(new Error('wss 连接失败: ' + (e.message || 'unknown'))));
    ws.addEventListener('close', () => { if (!done) finish(new Error('wss 提前关闭')); });
  });
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
      trtcAppId: process.env.SDKAPPID || '未配置'
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

  // ===== 3. 创建数字人会话（形象ID建流，createsessionbyasset） =====
  // 实测结论：项目ID建流报100007（项目ID无效），形象ID建流能成功，故固定走形象建流
  if (action === 'create') {
    try {
      const sdkAppId = Number(process.env.SDKAPPID);
      const secretKey = process.env.SECRETKEY;
      if (!sdkAppId || !secretKey) return json(500, { code: 1, message: '未配置 SDKAPPID / SECRETKEY' });

      const roomId = Math.floor(10000000 + Math.random() * 90000000);
      const vUserId = 'ivh_anchor_' + Math.random().toString(36).slice(2, 8);
      const api = new tls.Api(sdkAppId, secretKey);
      const vUserSig = api.genSig(vUserId, SIG_EXPIRE_SECONDS);

      // 形象ID建流（用本应用自己的 TRTC AppId）
      // ★ DriverType=3（音频驱动）：照片形象文本驱动不做 TTS（TtsSupport:false，只动口型没声音），
      //   必须走音频驱动——由 speak action 用 Edge-TTS 合成音频，再 SEND_AUDIO 推给数字人发声
      const resp = await ivhPost('/v2/ivh/sessionmanager/sessionmanagerservice/createsessionbyasset', {
        ReqId: uuid32(),
        AssetVirtualmanKey: process.env.IVH_IMAGE_ID || '95054',
        UserId: vUserId,
        Protocol: 'trtc',
        DriverType: 3,
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
        playStreamAddr: p.PlayStreamAddr,
        roomId: roomId,
        vUserId: vUserId,
        sessionStatus: p.SessionStatus,
        usedAsset: true
      });
    } catch (err) {
      const raw = err.rawResponse ? err.rawResponse.slice(0, 600) : '(no raw)';
      return json(500, { code: 4, message: err.message, ivhRaw: raw });
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
  // mode='audio'：照片形象唯一出声方式——Edge-TTS 合成 + wss SEND_AUDIO 推流
  if (action === 'drive') {
    try {
      const text = (query.text || '').slice(0, 4000);
      const sessionId = query.sessionId;
      if (!text) return json(400, { code: 1, message: '缺少 text' });
      if (!sessionId) return json(400, { code: 1, message: '缺少 sessionId' });

      // 音频驱动模式：Edge-TTS 合成 → 纯 JS 解码转 PCM → wss SEND_AUDIO 推流
      if (query.mode === 'audio') {
        const mp3 = await edgeTts(text);
        if (!mp3 || mp3.length < 100) return json(500, { code: 2, message: 'TTS 合成失败' });
        const pcm = await mp3ToPcm(mp3);
        if (!pcm || pcm.length < 100) return json(500, { code: 3, message: 'PCM 转码失败' });
        await sendAudioViaWss(sessionId, pcm);
        return json(200, { code: 0, mode: 'audio', pcmBytes: pcm.length });
      }

      // 默认：原文本驱动（向后兼容 v7 行为）
      let Data;
      if (query.variant === '1') Data = { Text: text };
      else if (query.variant === '3') Data = { Type: 0, Text: text };
      else Data = { Text: text, ChatCommand: 'NotUseChat' };
      const resp = await ivhPost('/v2/ivh/interactdriver/interactdriverservice/command', {
        ReqId: uuid32(),
        SessionId: sessionId,
        Command: 'SEND_TEXT',
        Data: Data
      });
      return json(200, { code: 0, mode: 'text', resp: JSON.stringify(resp).slice(0, 400) });
    } catch (err) {
      return json(500, { code: 4, message: err.message });
    }
  }

  // ===== 6.5. speak：兼容旧前端（已合并到 drive mode=audio，这里保留只是不报 400） =====
  if (action === 'speak') {
    return json(400, { code: 1, message: 'speak 已废弃，请改用 drive + mode=audio（v8 起）' });
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
