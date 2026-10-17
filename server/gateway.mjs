// Folia Web 本地网关：静态托管 dist/ + 同源反向代理。
// @deploy 复刻 deploy/docker/gateway/nginx.conf.template 的路由结构：
//   /netease/*        -> 网易云 API（netease-api 容器）
//   /api/lyric-proxy  -> 歌词/封面代理（host allowlist，与 vite.config.ts 的 dev 插件一致）
//   /*                -> dist/ 静态文件，SPA 回退到 index.html
// 同源是刚需：手机浏览器下跨域 + 混合内容会让播放和封面直接失败。
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 云端部署（Render）与本地部署共用同一份网关逻辑，只是产物目录和 API 目录不同。
// 本地：dist 在仓库根，api 在 folia-major/api；云端：public 在仓库根，api 在 server/api。
const DIST = path.resolve(process.env.FOLIA_DIST || path.join(__dirname, '..', 'public'));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const NETEASE_TARGET = process.env.FOLIA_NETEASE_TARGET || 'http://127.0.0.1:3300';
// 汽水音乐 RPC 服务器（移植自 2706521883-lgtm/folia-qishui 的 electron/qishui-server.cjs）。
// 它只绑回环、不校验 Host，令牌走 Authorization 头（音频走 ?t=）。
// 前端构建时把 VITE_QISHUI_API_BASE 设为 /qishui，因此这里反代成同源，手机也能播。
const QISHUI_TARGET = process.env.FOLIA_QISHUI_TARGET || 'http://127.0.0.1:8787';

// HTTPS：Folia Web 的本地音乐库导入依赖 showDirectoryPicker，而它是 [SecureContext] 门控 API——
// 在非 https/localhost 的源上这个 API 根本不存在，Folia 会直接判定 insecure-http、按钮置灰。
// 证书由 start-folia.ps1 用 openssl 自签（SAN 含局域网 IP），手机首次访问需手动信任一次。
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const CERT_FILE = process.env.FOLIA_TLS_CERT || path.join(__dirname, 'certs', 'cert.pem');
const KEY_FILE = process.env.FOLIA_TLS_KEY || path.join(__dirname, 'certs', 'key.pem');

// ---------- 访问密码 ----------
// 公网暴露后必须挡一道，否则拿到链接的人都能用，连 /netease 代理也一并可用。
// 只在浏览器端弹框毫无意义（直接请求接口就绕过了），所以校验放在服务端：
// 未通过密码前，静态资源、/netease、/api/* 全部取不到。
// 通过后写一个 HMAC 签名的长效 cookie，实现「只问第一次」。
const AUTH_PASSWORD = process.env.FOLIA_PASSWORD || 'qjzQJZ2012';
const AUTH_COOKIE = 'folia_auth';
const AUTH_TTL_SECONDS = Number(process.env.FOLIA_AUTH_TTL_SECONDS || 180 * 24 * 3600);
const AUTH_SECRET_FILE = path.join(__dirname, 'auth-secret.txt');

// 签名密钥：云端优先用环境变量（Render 的文件系统是临时的，每次部署都会清空，
// 只靠落盘的话每次重新部署都会把所有人踢下线）。本地则落盘复用。
function loadAuthSecret() {
  const fromEnv = String(process.env.FOLIA_AUTH_SECRET || '').trim();
  if (fromEnv.length >= 32) return fromEnv;
  try {
    const existing = fs.readFileSync(AUTH_SECRET_FILE, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch { /* 首次运行，往下生成 */ }
  const created = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(AUTH_SECRET_FILE, created, 'utf8'); } catch { /* 只读目录就退化为内存密钥 */ }
  return created;
}
const AUTH_SECRET = loadAuthSecret();

const authSignature = (expiresAt) =>
  crypto.createHmac('sha256', AUTH_SECRET).update(`folia-auth:${expiresAt}`).digest('hex');

const buildAuthCookie = () => {
  const expiresAt = Date.now() + AUTH_TTL_SECONDS * 1000;
  const value = `${expiresAt}.${authSignature(expiresAt)}`;
  return `${AUTH_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${AUTH_TTL_SECONDS}`;
};

const parseCookies = (header) => {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
};

// 常量时间比较，避免靠响应时间逐字节试探密码
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(bb, bb);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
};

const isAuthenticated = (req) => {
  const raw = parseCookies(req.headers.cookie)[AUTH_COOKIE];
  if (!raw) return false;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return false;
  const expiresAt = Number(raw.slice(0, dot));
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  return safeEqual(raw.slice(dot + 1), authSignature(expiresAt));
};

const readRequestBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const renderLoginPage = (errorMessage = '') => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>Folia · 需要密码</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: #09090b; color: #fafafa;
    display: flex; align-items: center; justify-content: center;
    font-family: Inter, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    padding: 24px; -webkit-tap-highlight-color: transparent;
  }
  .card { width: 100%; max-width: 360px; }
  .title { font-size: 34px; font-weight: 600; letter-spacing: .06em; margin: 0 0 6px; }
  .sub { color: #71717a; font-size: 13px; margin: 0 0 28px; }
  label { display: block; font-size: 13px; color: #a1a1aa; margin-bottom: 8px; }
  input {
    width: 100%; height: 48px; border-radius: 12px; border: 1px solid #27272a;
    background: #18181b; color: #fafafa; font-size: 16px; padding: 0 14px; outline: none;
  }
  input:focus { border-color: #52525b; }
  button {
    width: 100%; height: 48px; margin-top: 14px; border-radius: 12px; border: 0;
    cursor: pointer; background: #fafafa; color: #09090b; font-size: 15px; font-weight: 600;
  }
  button:active { opacity: .85; }
  .err {
    margin-top: 14px; font-size: 13px; color: #fca5a5;
    background: rgba(127,29,29,.25); border: 1px solid rgba(153,27,27,.5);
    border-radius: 10px; padding: 10px 12px;
  }
</style>
</head>
<body>
  <form class="card" method="POST" action="/__auth">
    <h1 class="title">Folia</h1>
    <p class="sub">此站点受密码保护，输入一次后即可长期访问</p>
    <label for="password">访问密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">进入</button>
    ${errorMessage ? `<div class="err">${errorMessage}</div>` : ''}
  </form>
</body>
</html>`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.onnx': 'application/octet-stream',
};

const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt', '.map']);

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

// 网易云的音乐 CDN（*.music.126.net 等）全部支持 HTTPS，但这个版本的
// @neteasecloudmusicapienhanced/api 即使收到 https=true 也仍会返回 http:// 地址。
// HTTPS 页面下这种地址会被浏览器当混合内容处理：fetch() 直接抛 TypeError，<audio> 只是警告
// （Chrome 会自动升级，Safari 未必）。所以统一在网关层把 126.net 系 CDN 升到 https://。
const NETEASE_HTTP_CDN = /http:\/\/([a-z0-9.-]*126\.net)/gi;
const upgradeNeteaseCdnUrls = (text) => text.replace(NETEASE_HTTP_CDN, 'https://$1');

// 服务端代理转发：把浏览器请求原样交给上游，再把上游响应原样交回。
async function proxy(req, res, targetBase, { stripPrefix = '', allowlist = null, extraReqHeaders = {}, cors = false, upgradeNeteaseCdn = false } = {}) {
  const incoming = new URL(req.url, 'http://localhost');
  let targetPath = incoming.pathname;
  if (stripPrefix && targetPath.startsWith(stripPrefix)) {
    targetPath = targetPath.slice(stripPrefix.length) || '/';
  }

  const targetUrl = new URL(targetPath + incoming.search, targetBase);

  if (allowlist && !allowlist(targetUrl.hostname)) {
    send(res, 403, JSON.stringify({ error: 'Forbidden: Domain not allowed' }), { 'content-type': 'application/json' });
    return;
  }

  const headers = new Headers();
  // HTTP/2 会把伪头放进入站 headers（:method/:path/:scheme/:authority），
  // 它们不是合法 header 名，直接塞给 fetch 会抛 "invalid header name"。
  // 逐跳头也必须剔除：上游要自己决定连接语义。
  const HOP_BY_HOP = new Set([
    'host', 'connection', 'content-length', 'accept-encoding',
    'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-connection',
  ]);
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.startsWith(':')) continue;
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  for (const [k, v] of Object.entries(extraReqHeaders)) headers.set(k, v);

  const hasBody = !['GET', 'HEAD'].includes(req.method ?? '');
  let requestBody;
  if (hasBody) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requestBody = Buffer.concat(chunks);
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: requestBody,
      redirect: 'manual',
    });

    const outHeaders = {};
    const upstreamEncoding = upstream.headers.get('content-encoding');
    // 逐跳头一律不能回给客户端：HTTP/1.1 上游会带 Connection/Keep-Alive，
    // 而这两个在 HTTP/2 里是非法的，Node 会直接抛错、响应永远写不完。
    const UPSTREAM_HOP_BY_HOP = new Set([
      'connection', 'keep-alive', 'proxy-connection', 'te', 'trailer',
      'transfer-encoding', 'upgrade', 'set-cookie',
    ]);
    for (const [key, value] of upstream.headers) {
      const lower = key.toLowerCase();
      // content-encoding 必须丢掉：Node 的 fetch 会自动解压 gzip，原 header 不再成立。
      // 带压缩时 content-length 同样失效，只在未压缩时保留——
      // 音频（尤其 206 分片）需要它，否则 <audio> 的 Range 拖动会坏。
      if (lower === 'content-encoding') continue;
      if (UPSTREAM_HOP_BY_HOP.has(lower)) continue;
      if (lower === 'content-length' && upstreamEncoding) continue;
      outHeaders[key] = value;
    }
    if (cors) {
      outHeaders['Access-Control-Allow-Origin'] = '*';
      outHeaders['Access-Control-Allow-Methods'] = 'GET,OPTIONS,PATCH,DELETE,POST,PUT';
      outHeaders['Access-Control-Allow-Headers'] = 'Content-Type, X-Requested-With, X-CSRF-Token, X-Api-Version, mid, x-router';
    }

    // 需要改写 URL 时整段缓冲（只发生在网易云的 JSON 上，体积小）；
    // 其余响应（尤其 /qishui/a 的音频）直接流式转发，并保留 content-length / content-range，
    // 否则 <audio> 的 Range 拖动会坏。
    if (upgradeNeteaseCdn && /json/i.test(upstream.headers.get('content-type') || '')) {
      const rewritten = upgradeNeteaseCdnUrls(Buffer.from(await upstream.arrayBuffer()).toString('utf8'));
      const outBuffer = Buffer.from(rewritten, 'utf8');
      // 关键：http->https 每次替换多一个字节，改写后的长度和上游 Content-Length 对不上。
      // 沿用旧值会让客户端少读末尾（JSON 被截断、cookie 读不出来），必须按新长度重算。
      for (const key of Object.keys(outHeaders)) {
        if (key.toLowerCase() === 'content-length') delete outHeaders[key];
      }
      outHeaders['content-length'] = String(outBuffer.length);
      res.writeHead(upstream.status, outHeaders);
      res.end(outBuffer);
      return;
    }

    res.writeHead(upstream.status, outHeaders);
    if (req.method === 'HEAD' || !upstream.body) {
      res.end();
      return;
    }
    // 同样是客户端断开的场景：代理流的 error 必须接住，否则进程会被带走。
    // 注意别叫 body —— 上面请求体曾用这个名字，同块内 const 会形成 TDZ，反而把 fetch 弄炸。
    const upstreamStream = Readable.fromWeb(upstream.body);
    const cleanup = () => {
      try { upstreamStream.destroy(); } catch { /* 已关闭 */ }
      try { res.destroy(); } catch { /* 已关闭 */ }
    };
    upstreamStream.on('error', cleanup);
    res.on('error', cleanup);
    upstreamStream.pipe(res);
  } catch (error) {
    send(res, 502, JSON.stringify({ error: 'Upstream request failed', details: String(error) }), {
      'content-type': 'application/json',
    });
  }
}

const LYRIC_PROXY_ALLOWLIST = (hostname) =>
  hostname === 'qq.com' || hostname.endsWith('.qq.com') ||
  hostname === 'y.gtimg.cn' ||
  hostname === 'kugou.com' || hostname.endsWith('.kugou.com') ||
  hostname === 'kgimg.com' || hostname.endsWith('.kgimg.com');

// ---------- AI 主题生成 ----------
// 仓库里的 api/generate-theme*.js 是 Vercel 风格的 ESM handler：读 req.body、用 res.status().json()。
// 原生 Node 没有这两样，这里补一层适配器，直接复用官方实现（连 prompt 和 schema 都不必自己维护）。
// 密钥由服务端环境变量提供，绝不下发到浏览器。
const API_DIR = path.resolve(process.env.FOLIA_API_DIR || path.join(__dirname, 'api'));
const themeHandlerCache = new Map();

// 这两个 handler 的调用约定不一样，必须都支持：
//   api/generate-theme.js         → (req, res) 传统 Vercel 风格，读 req.body、用 res.status().json()
//   api/generate-theme_openai.js  → (Request) => Response，Web Fetch API 风格，读 await req.json()
// 用 handler.length 区分：1 个参数是 Web 风格，2 个是传统风格。
async function runVercelApiHandler(req, res, handlerName) {
  let handler = themeHandlerCache.get(handlerName);
  if (!handler) {
    const mod = await import(pathToFileURL(path.join(API_DIR, `${handlerName}.js`)).href);
    handler = mod.default;
    themeHandlerCache.set(handlerName, handler);
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);

  if (handler.length >= 2) {
    try {
      req.body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
    } catch {
      req.body = {};
    }
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (obj) => {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(obj));
      return res;
    };
    await handler(req, res);
    return;
  }

  // Web 风格：构造标准 Request，再把返回的 Response 写回 Node 响应
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    // content-length 与实际 body 长度由 Request 自己校验，这里剔掉避免冲突
    if (['content-length', 'host', 'connection'].includes(key.toLowerCase())) continue;
    if (typeof value === 'string') headers[key] = value;
  }
  const request = new Request(new URL(req.url ?? '/', 'http://localhost'), {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method ?? '') ? undefined : rawBody,
  });

  const response = await handler(request);
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (['content-encoding', 'transfer-encoding', 'connection', 'content-length'].includes(key.toLowerCase())) return;
    res.setHeader(key, value);
  });
  const outBuffer = Buffer.from(await response.arrayBuffer());
  res.setHeader('content-length', String(outBuffer.length));
  res.end(outBuffer);
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';

  const filePath = path.join(DIST, rel);

  // 目录穿越防护：解析后必须仍在 DIST 内。
  if (!path.resolve(filePath).startsWith(path.resolve(DIST))) {
    send(res, 403, 'Forbidden');
    return;
  }

  let stat = await fs.promises.stat(filePath).catch(() => null);
  let finalPath = filePath;

  // SPA 回退：无扩展名的路径交给 index.html，带扩展名的按 404 处理。
  if (!stat || stat.isDirectory()) {
    if (path.extname(rel)) {
      send(res, 404, 'Not Found');
      return;
    }
    finalPath = path.join(DIST, 'index.html');
    stat = await fs.promises.stat(finalPath).catch(() => null);
    if (!stat) {
      send(res, 404, 'Not Found');
      return;
    }
  }

  const ext = path.extname(finalPath).toLowerCase();
  const headers = { 'content-type': MIME[ext] || 'application/octet-stream' };

  // Service Worker / 入口 HTML 必须每次都回源校验，否则 PWA 会卡在旧版本。
  const base = path.basename(finalPath);
  if (base === 'sw.js' || base === 'index.html' || base === 'registerSW.js' || base.endsWith('.webmanifest')) {
    headers['Cache-Control'] = 'no-cache';
  } else if (finalPath.includes(`${path.sep}assets${path.sep}`)) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  } else {
    headers['Cache-Control'] = 'public, max-age=3600';
  }
  if (base === 'sw.js') headers['Service-Worker-Allowed'] = '/';

  const stream = fs.createReadStream(finalPath);
  const acceptEncoding = String(req.headers['accept-encoding'] || '');

  // 客户端中途断开（切页、刷新、限速卡顿、h2 RST_STREAM）时，读流 / 压缩流 / 响应都会发 error；
  // 任何一处没有监听器，Node 会直接把进程带走 —— 这正是之前网关整死的原因。
  const abort = () => {
    try { stream.destroy(); } catch { /* 已关闭 */ }
    try { res.destroy(); } catch { /* 已关闭 */ }
  };
  stream.on('error', abort);
  res.on('error', abort);

  // 优先 Brotli：同样这批 JS 包，br 比 gzip 大约再小 15-20%，移动端加载能明显受益。
  // 质量用 5（默认 11 太慢，会卡住事件循环）；低于 4 收益就不明显了。
  if (COMPRESSIBLE.has(ext) && /\bbr\b/.test(acceptEncoding)) {
    const brotli = zlib.createBrotliCompress({
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: stat.size,
      },
    });
    brotli.on('error', abort);
    headers['content-encoding'] = 'br';
    headers['vary'] = 'Accept-Encoding';
    res.writeHead(200, headers);
    stream.pipe(brotli).pipe(res);
  } else if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(acceptEncoding)) {
    const gzip = zlib.createGzip({ level: 6 });
    gzip.on('error', abort);
    headers['content-encoding'] = 'gzip';
    headers['vary'] = 'Accept-Encoding';
    res.writeHead(200, headers);
    stream.pipe(gzip).pipe(res);
  } else {
    headers['content-length'] = String(stat.size);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    stream.pipe(res);
  }
}

const handleRequest = async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/healthz') {
    send(res, 200, JSON.stringify({ ok: true, service: 'folia-web-gateway' }), { 'content-type': 'application/json' });
    return;
  }

  // ---- 访问密码：/__auth 是登录入口，其余一切都要先过这一关 ----
  // /healthz 上面已经放行，供隧道存活校验与监控使用（只回一个 ok，不泄露内容）。
  if (pathname === '/__auth') {
    if (req.method === 'POST') {
      const body = await readRequestBody(req);
      const password = new URLSearchParams(body.toString('utf8')).get('password') || '';
      if (safeEqual(password, AUTH_PASSWORD)) {
        res.writeHead(303, {
          'Set-Cookie': buildAuthCookie(),
          Location: '/',
          'Cache-Control': 'no-store',
        });
        res.end();
      } else {
        send(res, 401, renderLoginPage('密码不正确，请重试。'), {
          'content-type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
      }
      return;
    }
    send(res, 200, renderLoginPage(), {
      'content-type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    return;
  }

  if (!isAuthenticated(req)) {
    // 页面导航给登录页；资源与接口一律 401，避免静态内容和 API 在未授权时被取走。
    // 接口路径即使带了 Accept: text/html 也不给登录页，保持语义清晰。
    const isApiPath =
      pathname === '/netease' || pathname.startsWith('/netease/') || pathname.startsWith('/api/');
    const wantsHtml =
      !isApiPath &&
      ((req.headers.accept || '').includes('text/html') ||
        req.headers['sec-fetch-mode'] === 'navigate');
    if (wantsHtml) {
      send(res, 200, renderLoginPage(), {
        'content-type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
    } else {
      send(res, 401, JSON.stringify({ error: 'Unauthorized' }), {
        'content-type': 'application/json',
        'Cache-Control': 'no-store',
      });
    }
    return;
  }

  // index.html 里有一句 <script src="/runtime-config.js">，官方 Docker 网关动态生成它。
  // 不提供会得到一个 404 的 script（无害但会报错），且 AI provider 只能靠构建期变量。
  // 注意不要写 deployment:"docker"：那会打开 Navidrome 预置凭据分支，而这里没有 Navidrome。
  if (pathname === '/runtime-config.js') {
    const payload = `window.__FOLIA_RUNTIME_CONFIG__={aiProvider:${JSON.stringify(process.env.FOLIA_AI_PROVIDER || 'google')}};`;
    send(res, 200, payload, {
      'content-type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    return;
  }

  // 网易云 API：/netease/xxx -> http://127.0.0.1:3300/xxx
  if (pathname === '/netease' || pathname.startsWith('/netease/')) {
    await proxy(req, res, NETEASE_TARGET, { stripPrefix: '/netease', upgradeNeteaseCdn: true });
    return;
  }

  // 汽水音乐 RPC：/qishui/rpc/* 与 /qishui/a（音频）-> 127.0.0.1:8787
  if (pathname === '/qishui' || pathname.startsWith('/qishui/')) {
    await proxy(req, res, QISHUI_TARGET, { stripPrefix: '/qishui' });
    return;
  }

  // AI 主题生成：直接委托给仓库里的 Vercel handler（密钥走服务端环境变量）
  if (pathname === '/api/generate-theme' || pathname === '/api/generate-theme_openai') {
    const handlerName = pathname === '/api/generate-theme' ? 'generate-theme' : 'generate-theme_openai';
    try {
      await runVercelApiHandler(req, res, handlerName);
    } catch (error) {
      send(res, 500, JSON.stringify({ error: 'AI handler failed', details: String(error) }), {
        'content-type': 'application/json',
      });
    }
    return;
  }

  if (pathname === '/api/lyric-proxy') {
    if (req.method === 'OPTIONS') {
      send(res, 200, '', {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,OPTIONS,PATCH,DELETE,POST,PUT',
        'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
      });
      return;
    }
    const target = url.searchParams.get('url');
    if (!target) {
      send(res, 400, JSON.stringify({ error: 'Missing url parameter' }), { 'content-type': 'application/json' });
      return;
    }
    await proxy(req, res, target, { allowlist: LYRIC_PROXY_ALLOWLIST, cors: true });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed');
    return;
  }

  await serveStatic(req, res, pathname);
};

const httpServer = http.createServer(handleRequest);
// HTTP/1.1 的解析错误（畸形请求、客户端半途断开）不能默认把 socket 留着或抛出去。
httpServer.on('clientError', (error, socket) => {
  try { socket.destroy(); } catch { /* 已关闭 */ }
});
httpServer.listen(PORT, HOST, () => {
  console.log(`[folia-gateway] http  listening on http://${HOST}:${PORT}`);
});

if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
  // 用 HTTP/2 而不是 https.createServer：这个应用一次加载要拉 80+ 个 chunk，
  // HTTP/1.1 下 6 条连接排队是主要延迟来源（实测一个 562KB 的包耗时 3988ms，远超字节量该有的时间）。
  // allowHTTP1 让老客户端仍然可用；http2 的兼容层把 req/res 伪装成 http1 的接口，handleRequest 不用改。
  const httpsServer = http2.createSecureServer(
    {
      cert: fs.readFileSync(CERT_FILE),
      key: fs.readFileSync(KEY_FILE),
      allowHTTP1: true,
      settings: { maxConcurrentStreams: 256 },
    },
    handleRequest,
  );
  httpsServer.listen(HTTPS_PORT, HOST, () => {
    console.log(`[folia-gateway] https listening on https://${HOST}:${HTTPS_PORT}  (HTTP/2, allowHTTP1)`);
  });
  // h2 每个连接是一个 session，session 上的 error（RST_STREAM、GOAWAY、半途断开）必须接住。
  httpsServer.on('session', (session) => {
    session.on('error', () => { /* 客户端断开属正常，忽略 */ });
  });
  httpsServer.on('sessionError', () => { /* 同上 */ });
  httpsServer.on('tlsClientError', () => { /* 证书/握手失败属正常 */ });
  httpsServer.on('error', (error) => {
    console.error('[folia-gateway] https server error:', error && error.message);
  });
} else {
  console.warn(`[folia-gateway] no TLS cert at ${CERT_FILE}; https disabled, local library import stays unavailable`);
}

console.log(`[folia-gateway] serving ${DIST}`);
console.log(`[folia-gateway] /netease/* -> ${NETEASE_TARGET}`);

// 兜底：这是个常驻服务，任何漏网的异步异常都不该让整站下线。
// 记一行日志继续跑，比崩掉强得多（之前崩溃就是因为流上的 error 没人接）。
process.on('uncaughtException', (error) => {
  console.error('[folia-gateway] uncaughtException:', error && (error.stack || error.message));
});
process.on('unhandledRejection', (reason) => {
  console.error('[folia-gateway] unhandledRejection:', reason && (reason.stack || reason.message || reason));
});
