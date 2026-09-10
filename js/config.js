/* ============================================
   云念AI - TRTC 通话配置
   ============================================ */

// 腾讯云 TRTC 配置
// SDKAppID 可以公开（仅用于标识应用）
// SecretKey 绝不能出现在前端代码中，只配置在云函数的环境变量里
const TRTC_CONFIG = {
  sdkAppId: 1600160855,

  // UserSig 签发服务地址（腾讯云函数）
  // 已部署并验证通过
  userSigServer: 'https://1422484427-kxu5p373mj.ap-guangzhou.tencentscf.com/',

  // IVH 数字人服务（同一个云函数 v2，含 create/status/start/drive/close）
  // 云函数更新到 v3 版并配置 IVH_APPKEY / IVH_ACCESSTOKEN / IVH_IMAGE_ID 后即可用
  // 为空时通话走演示模式（照片+本地语音合成），配置后自动切换真实数字人
  ivhServer: 'https://1422484427-kxu5p373mj.ap-guangzhou.tencentscf.com/'
};

// 云函数统一调用：action 放进 POST body
// （腾讯云 HTTP 触发器网关有时会吞掉 URL 查询参数，放进 body 最稳，云函数 parseQuery 已支持）
function cfPost(action, payload, ms) {
  const base = (TRTC_CONFIG.ivhServer || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, ms || 15000);
  return fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ action: action }, payload || {})),
    signal: ctrl.signal
  }).finally(function () { clearTimeout(t); });
}
