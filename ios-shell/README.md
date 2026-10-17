# Folia iOS 壳

把前端产物（`www/`，1868 个文件）打进 App 本体，所以应用外壳**不走网络、瞬间打开**；
只有网易云/QQ 的接口调用走网络（返回的是几 KB JSON）。

## 已完成的准备

- `www/` 已用**绝对接口地址**构建：`VITE_NETEASE_API_BASE=https://folia-always.netlify.app/netease`、`VITE_QQ_API_BASE=https://folia-always.netlify.app/qq`
- Netlify 侧已给这两个接口开了 CORS（函数里直接发头，`netlify.toml` 的 [[headers]] 对函数无效）
- `/api/*`（AI 主题）**仍然受密码门保护** → 见下面的已知限制

## 在 Codemagic 上构建

1. 把本目录推到 GitHub（**Codemagic 只能从仓库拉代码**）
2. Codemagic → Add application → 选这个仓库
3. 它会自动识别 `codemagic.yaml`，选 `ios-unsigned` 工作流
4. Start build

`codemagic.yaml` 里已经写好：装依赖 → `npx cap add ios` → `npx cap sync ios` → `xcodebuild` 出未签名 IPA。

## 已知限制

1. **未签名 IPA 装不上真机**：Codemagic 能产出，但要装到 iPhone 需 Apple Developer（$99/年）或 Sideloadly 免费签名（7 天重签）
2. **AI 主题在 IPA 里用不了**：跨域 + 密码门，壳内没有 cookie。网页版正常
3. **Codemagic 的 macOS 构建需要仓库**，不能上传 zip

## 本地验证

```powershell
cd C:\Users\Administrator\Desktop\folia-ios
npm install
npx cap add ios
npx cap sync ios
```