# Folia Web 云端部署包

一份**开箱可部署**的 Folia Web：静态前端 + 访问密码门 + 网易云反代 + AI 主题代理。
部署后**不需要你自己的电脑开机**，也不会再出现 Cloudflare 1033。

> 为什么是 Render：`vercel.app` 在国内被 DNS 投毒到 Facebook 网段、`pages.dev` 被 TLS 阻断，
> 实测 `onrender.com` 与 `netlify.app` 可达。选 Render 是因为它同时给「Node 服务 + 免费额度 +
> Blueprint 一键部署」。

---

## 包里有什么

```
folia-cloud/
├── package.json          # 唯一依赖 @google/genai（Gemini handler 用）
├── render.yaml           # Blueprint：一次创建两个服务
├── public/               # 构建好的前端（1868 个文件）
└── server/
    ├── gateway.mjs       # 网关：静态托管 + 密码门 + /netease 反代 + /api/generate-theme*
    ├── api/
    │   ├── generate-theme.js          # Gemini 版（传统 Vercel 风格）
    │   └── generate-theme_openai.js   # OpenAI 兼容版（Web Fetch 风格）
    └── shared/
        ├── themeSanitizer.mjs
        └── openAICompatibleRequest.mjs
```

**两个服务的分工**

| 服务 | 作用 |
| --- | --- |
| `folia-web` | 跑 `server/gateway.mjs`：发静态文件、校验密码、反代 `/netease/*`、调 DeepSeek 生成主题 |
| `folia-netease-api` | 直接部署官方公开仓库 `NeteaseCloudMusicApiEnhanced/api-enhanced`，免登录可搜可播 |

---

## 部署步骤

### 1. 建仓库并推送

在 GitHub 新建一个**空仓库**（Private 也可以，Render 能连私有仓库），然后在本目录执行：

```powershell
git init
git add .
git commit -m "folia cloud"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

### 2. 在 Render 建 Blueprint

1. 打开 <https://dashboard.render.com/blueprints> → **New Blueprint Instance**
2. 连接你的 GitHub，选刚推的仓库
3. Render 会读出 `render.yaml`，显示要创建的两个服务
4. **填 `OPENAI_API_KEY`**（唯一的必填项，用你的 DeepSeek key）
5. 点 **Apply**

### 3. 等构建完成

- `folia-netease-api` 先起（网易云 API）
- `folia-web` 后起，`FOLIA_NETEASE_TARGET` 会自动注入前者的公网地址

完成后访问：

```
https://folia-web-xxxx.onrender.com
```

密码默认 **`qjzQJZ2012`**（在 Render 面板的 `FOLIA_PASSWORD` 改）。

---

## 必须知道的四件事

### 1. 免费实例会休眠

Render 免费 web 服务**闲置 15 分钟后休眠**，下次请求要**冷启动 30–60 秒**。
两个服务都会休眠，所以久不访问后第一次打开会比较慢。

想缓解，可以用免费的 uptime 监控（如 UptimeRobot）每 10 分钟打一次
`https://<你的服务>/healthz` 保温。但**这属于灰色用法**，Render 有权限限制，是否使用自行判断。

### 2. 汽水音乐依然不可用

汽水必须跑 Electron（原生 Windows 签名模块 `bdms.node` + `metasecml.dll`），Render 是 Linux 容器，
跑不了。所以云端版**只有网易云**（可搜、可播、带歌词）+ AI 主题。

### 3. 换域名 = 换 origin

本地音乐库、界面设置、密码登录状态都存在**浏览器按域名隔离的存储**里。
从 `trycloudflare.com` 换到 `onrender.com` 后，这些**不会跟过来**，需要重新配一次。

### 4. 局域网专属能力没了

云端是公网 HTTPS，所以：
- ✅ PWA 安装（"添加到主屏幕"）**可用**（有效证书）
- ✅ 本地音乐文件夹导入**可用**（安全上下文成立）
- ❌ 局域网直连（`192.168.10.106`）没有意义了，统一走公网域名

---

## 以后怎么更新前端

本包里的 `public/` 是**构建产物快照**。上游 Folia 更新后想跟进，在源码仓库重新构建再替换：

```powershell
cd C:\Users\Administrator\Desktop\folia-major
$env:VITE_NETEASE_API_BASE = '/netease'
$env:VITE_AI_PROVIDER     = 'openai'
npm run build

robocopy .\dist C:\Users\Administrator\Desktop\folia-cloud\public /MIR
cd C:\Users\Administrator\Desktop\folia-cloud
git add -A; git commit -m "update frontend"; git push
```

Render 会自动重新部署。

---

## 环境变量速查

| 变量 | 服务 | 说明 |
| --- | --- | --- |
| `FOLIA_PASSWORD` | folia-web | 访问密码 |
| `FOLIA_AUTH_SECRET` | folia-web | cookie 签名密钥，Render 自动生成；**别用落盘方式**，云端文件系统是临时的 |
| `FOLIA_AI_PROVIDER` | folia-web | `openai`（DeepSeek）或 `gemini` |
| `OPENAI_API_URL` | folia-web | `https://api.deepseek.com/v1` |
| `OPENAI_API_MODEL` | folia-web | `deepseek-chat` |
| `OPENAI_API_KEY` | folia-web | 手动填，**secret** |
| `FOLIA_NETEASE_TARGET` | folia-web | 自动取自 `folia-netease-api` 的公网地址 |
| `ENABLE_GENERAL_UNBLOCK` | folia-netease-api | 保持 `false` |
