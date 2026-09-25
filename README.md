# Nori.Telemetry

Nori 自托管遥测与崩溃收集服务。第一阶段面向 Nori.Desktop，使用 Cloudflare Workers、Queues、D1 与 R2 提供错误与崩溃收集链路。

本仓库采用 **Dashboard-first**：Cloudflare 资源、变量、Secret、Queue consumer、Cron Trigger 与 R2 Lifecycle 都在 Cloudflare Dashboard 管理。仓库不保存 `wrangler.jsonc`，GitHub Actions 也不会部署或修改生产 Cloudflare 配置。

## 当前能力

- `POST /v1/events` 接收脱敏异常事件并写入 Cloudflare Queue；
- Queue Consumer 计算稳定 fingerprint，将重复异常聚合为同一 Issue；
- D1 保存 Issue、事件索引、版本、运行环境与受影响安装数；
- R2 只归档新 Issue 的首个代表事件和 terminal 事件；
- Queue batch 会按 Issue 合并计数更新；
- event ID 幂等，Queue 重试不会重复累计 Issue 计数；
- 管理 API 提供 24h 概览、Issue 列表、Issue 详情与已归档事件 payload；
- 服务端再次执行隐私边界校验。

协议不接收异常 message、用户对象、请求正文、extra、contexts、breadcrumbs 或附件。Nori.Desktop 的 `TelemetrySanitizer` 仍是客户端第一层脱敏，本服务是第二层。

## 配额保护

默认实现优先降低 D1 / R2 超限风险：

- 请求默认最大 64 KiB；
- 使用 Workers Cache API 对“同一安装 + operation + 异常类型”做默认 6 秒的 best-effort 风暴抑制；
- Cache 风暴抑制是 fail-open，并且只在当前 Cloudflare 数据中心生效，不作为安全或强一致限流边界；
- 同一 Queue batch 的相同 Issue 只做一次聚合更新；
- Issue 的 `event_count`、`terminal_count`、`affected_installations` 使用增量更新；
- `issue_installations` 只在第一次看到“Issue + installationHash”时写入；
- R2 默认只保存新 Issue 第一份完整脱敏事件和 terminal 事件；
- R2 写失败不会触发 Queue 重试；
- D1 事件明细默认保留 30 天；
- 每次定时清理最多删除 2000 行；
- Issue 聚合统计不会随旧明细删除而丢失。

Dashboard 中可选配置这些变量；全部都有安全默认值：

```text
INGEST_PROJECT=nori-desktop
ENVIRONMENT=production
MAX_EVENT_BYTES=65536
STORM_GUARD_SECONDS=6
EVENT_RETENTION_DAYS=30
MAINTENANCE_DELETE_LIMIT=2000
ARCHIVE_TERMINAL_EVENTS=1
```

如果希望进一步压低 R2 写入，可把：

```text
ARCHIVE_TERMINAL_EVENTS=0
```

此时每个新 Issue 仍会保留一份代表性 R2 payload。

## 架构

```text
Nori.Desktop
    |
    | POST /v1/events
    v
Cloudflare Worker
    |
    | best-effort Cache storm guard
    v
Queue
    |
    v
Issue-batched Consumer
    |
    +----> D1
    |      Issue aggregate + recent event index
    |
    +----> R2
           first event of new issue
           + terminal events only
```

## Cloudflare Dashboard 配置

代码里的 binding 名称是固定协议。Dashboard 中需要使用以下名称：

```text
D1 database binding:  DB
R2 bucket binding:    EVENTS
Queue producer:       EVENT_QUEUE
Secret:               ADMIN_TOKEN
```

### 1. Worker

在 Cloudflare Dashboard 创建 Worker，例如 `nori-telemetry`。

本仓库只负责构建代码：

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

生成：

```text
dist/index.js
```

将这个 module Worker bundle 部署到 Worker。生产 Cloudflare 配置不要由 GitHub Actions 或仓库脚本维护。

如果把 Git 仓库连接到 Workers Builds，并保留默认 `wrangler deploy`，Cloudflare 会对没有 Wrangler 配置的项目运行自动配置并可能创建配置 PR。想保持纯 Dashboard-first 时，不要把默认 Wrangler deploy 当作生产配置来源。

### 2. D1

在 Dashboard 创建 D1 数据库，例如 `nori-telemetry`。

进入 Worker：

```text
Settings
→ Bindings
→ Add binding
→ D1 database
```

Binding 名必须为：

```text
DB
```

然后在 D1 Dashboard 的 SQL Console 执行：

```text
migrations/0001_init.sql
```

仓库保留 migration SQL 作为 schema 的版本来源，但不从 CI 自动执行远程 migration。

### 3. R2

创建 R2 bucket，例如：

```text
nori-telemetry-events
```

在 Worker 的 Bindings 添加 R2 binding：

```text
EVENTS
```

在 R2 bucket 的 Lifecycle Rules 中给前缀：

```text
events/
```

配置 **30 天过期**。

### 4. Queue

创建：

```text
nori-telemetry-events
nori-telemetry-dead-letter
```

给 Worker 添加 Queue producer binding：

```text
EVENT_QUEUE
```

再把同一个 Worker 配为 `nori-telemetry-events` 的 Consumer。建议：

```text
Max batch size:     25
Max batch timeout:  5 seconds
Max retries:        5
Dead letter queue:  nori-telemetry-dead-letter
```

### 5. Cron Trigger

Worker 包含 `scheduled` handler，用于有界清理 D1 旧事件。

在 Dashboard 添加每日 Cron Trigger。时间点不重要，建议每天一次即可，例如：

```text
17 3 * * *
```

### 6. Variables 与 Secret

在 Worker 的 Variables & Secrets 中添加需要覆盖的变量。没有添加时会使用代码默认值。

`ADMIN_TOKEN` 必须作为 Secret 配置，并使用足够长的随机值。管理 API 没有这个 Secret 时会保持不可访问。

### 7. Observability

Observability 可以直接在 Worker Dashboard 开启。仓库不保存这项生产设置。

## API

健康检查：

```http
GET /health
```

写入事件：

```http
POST /v1/events
Content-Type: application/json
```

成功入队返回 `202`。

Cache 风暴保护命中时返回 `429`。客户端应丢弃当前遥测并退避，不能紧密重试。

管理 API：

```text
GET /v1/admin/overview
GET /v1/admin/issues?status=unresolved&limit=50
GET /v1/admin/issues/{issueId}
GET /v1/admin/events/{eventId}
```

请求头：

```http
Authorization: Bearer <ADMIN_TOKEN>
```

Issue 详情中的事件带 `archived` 标记。普通重复事件可能只有 D1 索引和 top frame；没有 R2 payload 时详情接口返回 `payload_not_archived`。

## 协议 v1

示例：

```json
{
  "schemaVersion": 1,
  "release": "1.2.3",
  "environment": "production",
  "operation": "bridge.invoke",
  "handled": false,
  "terminal": false,
  "runtime": {
    "name": "native",
    "version": ".NET 10"
  },
  "device": {
    "os": "windows",
    "architecture": "x64",
    "sessionType": "windows"
  },
  "installationHash": "0123456789abcdef0123456789abcdef",
  "exception": {
    "type": "System.InvalidOperationException",
    "frames": [
      {
        "module": "Nori.Desktop",
        "function": "Run",
        "file": "App.cs",
        "line": 42,
        "inApp": true
      }
    ]
  },
  "tags": {
    "failure_kind": "plugin_load"
  }
}
```

`installationHash` 只接受 16–64 位十六进制摘要，不需要真实硬件 ID。

fingerprint 使用：

```text
project
exception.type
operation
top in-app frame module
top in-app frame function
top in-app frame file
```

## 本地与 CI

仓库不负责远程 Cloudflare 配置。

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

GitHub Actions 只验证上述代码路径，不执行 `wrangler deploy`，不会覆盖 Dashboard 设置。

## 与 Nori.Desktop 的迁移边界

Nori.Desktop 已通过 `ITelemetry` 隔离具体 SDK。后续迁移时继续保持：

- 用户明确同意前不初始化远程遥测；
- `CaptureException` 只上传异常类型、清理后的 stack frame、固定 operation 与白名单 tags；
- 收到 `429` 时丢弃当前遥测并执行退避；
- 本地发送队列需要有容量上限，不能因离线或服务失败无限堆积；
- `FlushAsync` 保持短超时；
- 遥测失败不能影响 Nori.Desktop 正常运行或退出。

Dashboard、Release Health、告警、source map / PDB 符号服务可在基础链路稳定后继续推进。
