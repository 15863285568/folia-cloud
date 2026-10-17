// 网易云 API 的启动入口（云端用）。
// @deploy 原来的方案是让 Render 从官方公开仓库直接部署，但 Blueprint 的跨仓库 `repo:` 字段不确定性高。
// 改成把官方 npm 包装进本仓库，用这个入口启动，两个服务就都来自同一个仓库，部署不会因为字段问题失败。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { serveNcmApi } = require('@neteasecloudmusicapienhanced/api/server.js');

const port = Number(process.env.PORT || 3000);
// 云端容器必须绑 0.0.0.0，否则 Render 的健康检查与网关都连不上
const host = process.env.HOST || '0.0.0.0';

serveNcmApi({ port, host })
  .then(() => {
    console.log(`[folia-netease-api] listening on ${host}:${port}`);
  })
  .catch((error) => {
    console.error('[folia-netease-api] failed to start:', error);
    process.exit(1);
  });
