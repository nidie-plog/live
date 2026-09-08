// server.js —— 零依赖 DeepSeek 代理（阿里云函数计算 HTTP 函数 / 本地调试通用）
// 只依赖 Node 内置模块（http/https），无需 npm install，可直接粘贴到 FC 控制台在线编辑器
//
// 环境变量：
//   DEEPSEEK_API_KEY  必填，DeepSeek API Key
//   PORT              可选，本地调试端口，默认 3000
//
// 本地调试：  $env:DEEPSEEK_API_KEY='sk-xxx'; node server.js
// 函数计算：  创建「Web 函数 / HTTP 函数」，运行时 Node.js 20，handler 填 index.handler，
//             配置环境变量 DEEPSEEK_API_KEY，HTTP 触发器认证方式选「无需认证」
const http = require('http');
const https = require('https');

/* ---------- 简易内存限流：每 IP 每分钟最多 20 次（防刷，低成本保护） ---------- */
const hits = {};
function rateOk(ip) {
  const now = Date.now();
  const win = Math.floor(now / 60000);
  const k = ip + '_' + win;
  hits[k] = (hits[k] || 0) + 1;
  // 清理旧窗口，避免内存膨胀
  if (now % 60000 < 1000) {
    const cur = Math.floor(now / 60000);
    Object.keys(hits).forEach(key => { if (parseInt(key.split('_')[1], 10) < cur - 1) delete hits[key]; });
  }
  return hits[k] <= 20;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Content-Type': 'application/json; charset=utf-8'
  };
}

function sendJson(res, status, obj) {
  res.writeHead(status, corsHeaders());
  res.end(JSON.stringify(obj));
}

/* ---------- 收集请求体（限 64KB） ---------- */
function readBody(req, cb) {
  const chunks = [];
  let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > 64 * 1024) { cb(new Error('body too large')); return; }
    chunks.push(c);
  });
  req.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
}

/* ---------- 转发 DeepSeek 官方接口（Key 留在服务端） ---------- */
function proxyDeepSeek(messages, cb) {
  const key = process.env.DEEPSEEK_API_KEY || '';
  const body = JSON.stringify({
    model: 'deepseek-chat',
    messages: messages,
    temperature: 1.0,
    max_tokens: 2000,
    response_format: { type: 'json_object' }
  });
  const req = https.request({
    hostname: 'api.deepseek.com',
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key,
      'Content-Length': Buffer.byteLength(body)
    },
    timeout: 45000
  }, (r) => {
    const chunks = [];
    r.on('data', c => chunks.push(c));
    r.on('end', () => {
      let data = null;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {}
      cb(null, r.statusCode, data || { error: 'DeepSeek 返回异常' });
    });
  });
  req.on('timeout', () => { req.destroy(new Error('timeout')); });
  req.on('error', (e) => cb(e));
  req.write(body);
  req.end();
}

/* ---------- 主处理函数（FC HTTP 函数签名 / 本地 http.createServer 通用） ---------- */
function handler(req, res) {
  try {
    // CORS 预检
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      return res.end();
    }

    // 健康检查
    if (req.method === 'GET' && (req.url === '/' || req.url === '/favicon.ico')) {
      return sendJson(res, 200, { ok: true, service: 'tarot-deepseek-proxy' });
    }

    // DeepSeek 解析代理
    if (req.method === 'POST' && req.url === '/api/deepseek') {
      const ip = clientIp(req);
      if (!rateOk(ip)) {
        return sendJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
      }
      const key = process.env.DEEPSEEK_API_KEY || '';
      if (!key) {
        return sendJson(res, 500, { ok: false, error: '服务端未配置 DEEPSEEK_API_KEY 环境变量' });
      }
      return readBody(req, (err, text) => {
        if (err) return sendJson(res, 413, { ok: false, error: '请求体过大' });
        let body = {};
        try { body = JSON.parse(text || '{}'); } catch (e) { return sendJson(res, 400, { ok: false, error: 'JSON 格式错误' }); }
        const messages = body.messages;
        if (!Array.isArray(messages) || !messages.length) {
          return sendJson(res, 400, { ok: false, error: '缺少 messages 参数' });
        }
        // 参数清洗，防注入过长内容
        const safe = messages.map(m => ({
          role: m.role === 'system' ? 'system' : m.role === 'assistant' ? 'assistant' : 'user',
          content: String(m.content || '').slice(0, 4000)
        }));
        proxyDeepSeek(safe, (err2, status, data) => {
          if (err2) {
            console.error('DeepSeek 代理失败:', err2.message);
            return sendJson(res, 502, { ok: false, error: 'DeepSeek 调用失败' });
          }
          res.writeHead(status, corsHeaders());
          res.end(JSON.stringify(data));
        });
      });
    }

    // 404
    return sendJson(res, 404, { ok: false, error: 'Not Found' });
  } catch (e) {
    console.error('处理异常:', e.message);
    return sendJson(res, 500, { ok: false, error: '服务内部错误' });
  }
}

/* ---------- 导出：兼容函数计算 HTTP 触发器 + 本地调试 ---------- */
module.exports.handler = (req, res, context) => handler(req, res);

if (require.main === module) {
  const port = process.env.PORT || 3000;
  http.createServer(handler).listen(port, () => console.log(`tarot-deepseek-proxy 已启动: http://localhost:${port}`));
}
