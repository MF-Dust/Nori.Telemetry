# Nori.Telemetry Dashboard

Nori.Telemetry 的只读管理前端。UI 使用 React + Vite，部署目标为 Cloudflare Pages；`functions/api/[[path]].ts` 作为同源服务端代理，将管理请求转发给 Nori.Telemetry Worker。

浏览器不会获得 `ADMIN_TOKEN`。

## 本地构建

```bash
pnpm install
pnpm typecheck
pnpm build
```

输出目录：

```text
dist
```

## Cloudflare Pages

创建 Pages 项目并连接 `MF-Dust/Nori.Telemetry`。

推荐配置：

```text
Root directory:
frontend

Build command:
pnpm build

Build output directory:
dist
```

React/Vite 的 Pages 构建输出目录为 `dist`。Pages Functions 位于项目根目录下的 `functions/`，不会打包进浏览器静态资源。

### Pages Variables & Secrets

Production 与需要使用的 Preview 环境分别配置：

```text
TELEMETRY_API_BASE
https://<Nori.Telemetry Worker 域名>

ADMIN_TOKEN
<与后端 Worker ADMIN_TOKEN 相同的 Secret>
```

`ADMIN_TOKEN` 必须设置为 Secret。

### 必须保护 Dashboard

Pages Function 持有管理 API Token，因此在添加生产 `ADMIN_TOKEN` 前，应当先用 Cloudflare Access 保护 Dashboard 域名，只允许你的账号访问。

不要把 `ADMIN_TOKEN` 写到：

- Vite 的 `VITE_*` 环境变量；
- React 源码；
- localStorage / sessionStorage；
- Pages 静态文件。

### Build watch paths

这个仓库同时包含后端 Worker。为了避免后端提交触发无意义的 Pages 构建，可以在 Pages：

```text
Settings
→ Build
→ Build watch paths
```

把 include path 限制为：

```text
frontend/*
```

## 代理边界

Pages Function 只允许：

```text
GET /api/overview
GET /api/issues
GET /api/issues/{issueId}
GET /api/events/{eventId}
```

对应后端：

```text
/v1/admin/overview
/v1/admin/issues
/v1/admin/issues/{issueId}
/v1/admin/events/{eventId}
```

它不是通用反向代理，也不会转发浏览器提供的 Authorization header。

## 配额策略

Dashboard 不做自动轮询：

- 首次进入概览时读取一次 `overview`；
- 首次打开某个 Issue 状态页时读取一次列表；
- 点击 Issue 时读取该 Issue 最近 25 条事件；
- 只有点击带 `R2` 标记的事件时才读取 R2 payload；
- 后续更新由用户手动点击“刷新”。

这样 Dashboard 本身不会持续制造 D1 / R2 请求。
