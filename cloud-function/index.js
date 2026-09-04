/**
 * 云念AI - UserSig 签发服务（腾讯云 SCF 云函数）
 *
 * 作用：用 SecretKey（配置在环境变量中）为前端生成进房凭证 UserSig。
 * 前端通过函数 URL 调用：GET ?sdkAppId=xxx&userId=xxx
 * 返回：{ "code": 0, "userSig": "..." }
 *
 * 部署要求：
 * 1. 运行环境：Node.js 16.13 或更高
 * 2. 环境变量：SDKAPPID（如 1600160855）、SECRETKEY（应用详情页的密钥）
 * 3. 依赖：tls-sig-api-v2（已包含在 node_modules 中，整个目录打包上传即可）
 */

const tls = require('tls-sig-api-v2');

// CORS 头：允许 GitHub Pages 域名跨域调用
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8'
};

// UserSig 有效期：7 天（秒）
const SIG_EXPIRE_SECONDS = 7 * 24 * 3600;

exports.main_handler = async (event) => {
  // 兼容多种触发方式的事件结构（函数URL / API网关 / 直接调用）
  const query = event.queryString || event.queryStringParameters || event || {};
  const userId = query.userId;
  const sdkAppId = Number(query.sdkAppId) || Number(process.env.SDKAPPID);
  const secretKey = process.env.SECRETKEY;

  // 预检请求直接放行
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (!sdkAppId || !secretKey) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ code: 1, message: '云函数未配置 SDKAPPID / SECRETKEY 环境变量' })
    };
  }
  if (!userId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ code: 1, message: '缺少 userId 参数' })
    };
  }

  try {
    const api = new tls.Api(sdkAppId, secretKey);
    const userSig = api.genSig(String(userId), SIG_EXPIRE_SECONDS);
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ code: 0, userId: String(userId), userSig: userSig })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ code: 2, message: '生成 UserSig 失败：' + err.message })
    };
  }
};
