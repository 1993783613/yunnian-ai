/**
 * WorkBuddy Sites HTTP server 入口
 * 把 HTTP 请求适配成 SCF main_handler(event) 格式，调用 cloud-function/index.js
 */
const http = require('http');
const path = require('path');

// 加载 SCF 处理器（cloud-function/index.js）
const cfPath = path.join(__dirname, 'index.js');
const cf = require(cfPath);
const handler = cf.main_handler;

const PORT = process.env.PORT || 3000;

http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  // 收集 body
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const rawBody = Buffer.concat(chunks).toString('utf8');
  let bodyJson = {};
  if (rawBody) { try { bodyJson = JSON.parse(rawBody); } catch (e) { bodyJson = { __raw: rawBody.slice(0, 500) }; } }

  // 解析 query（合并 URL query + body）
  const url = new URL(req.url, `http://${req.headers.host}`);
  const query = {};
  for (const [k, v] of url.searchParams) query[k] = v;
  for (const k of Object.keys(bodyJson)) query[k] = bodyJson[k];

  // 构造 SCF 事件对象
  const event = {
    httpMethod: req.method,
    queryString: query,
    queryStringParameters: query,
    body: rawBody || undefined,
    headers: req.headers,
    path: req.url
  };

  try {
    const t0 = Date.now();
    const result = await handler(event, {});
    const ms = Date.now() - t0;
    res.statusCode = result.statusCode || 200;
    // 透传 CORS 等头
    if (result.headers) {
      for (const k of Object.keys(result.headers)) {
        if (k.toLowerCase() === 'content-type') continue;
        res.setHeader(k, result.headers[k]);
      }
    }
    res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body || ''));
    if (process.env.LOG) console.log(`[${req.method} ${req.url}] ${res.statusCode} (${ms}ms)`);
  } catch (err) {
    console.error('handler error:', err);
    res.statusCode = 500;
    res.end(JSON.stringify({ code: 500, message: 'server error: ' + err.message }));
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP server listening on 0.0.0.0:${PORT}`);
});
