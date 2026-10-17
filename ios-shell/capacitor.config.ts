import type { CapacitorConfig } from '@capacitor/cli';

// @deploy 壳内 origin 是 capacitor://localhost，所以：
//   1. webDir 指向打进包里的前端产物（不需要从 Netlify 下载 JS，这就是秒开的原因）
//   2. 接口必须用绝对地址指向 Netlify 上的函数
const config: CapacitorConfig = {
  appId: 'app.folia.web',
  appName: 'Folia',
  webDir: 'www',
  ios: {
    contentInset: 'always',
    // 允许 WebView 里加载 https 接口（默认允许，这里显式写出便于排查）
    limitsNavigationsToAppBoundDomains: false,
  },
  server: {
    // 壳内走 https 更能复用常规 CORS 规则
    iosScheme: 'https',
  },
};

export default config;