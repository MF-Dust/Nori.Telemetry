# Nori.Telemetry

Nori 自托管遥测与崩溃收集服务。第一阶段面向 Nori.Desktop，使用 Cloudflare Workers、Queues、D1 与 R2 提供一条可替代 Sentry 核心错误收集能力的链路。

## 当前能力

- `POST /v1/events` 接收脱敏异常事件并立即写入 Cloudflare Queue；
- Queue Consumer 计算稳定 fingerprint，将重复异常聚合为同一 Issue；
- D1 保存 Issue、事件索引、版本、运行环境与受影响安装数；
- R2 只归档新 Issue 的首个代表事件和 terminal 事件，普通重复错误不会逐条写 R2；
- Queue batch 会按 Issue 合并计数更新，避免同一批重复执行昂贵聚合；
- 处理链路按 event ID 幂等，Queue 重试不会重复累计 Issue 计数；
- 管理 API 提供 24h 概览、Issue 列表、Issue 详情与已归档事件 payload；
- 协议在服务端再次执行隐私边界校验。

这套协议刻意不接收异常 message、用户对象、请求正文、extra、contexts、breadcrumbs 或附件。Nori.Desktop 现有的 `TelemetrySanitizer` 仍应作为客户端第一层脱敏，本服务是第二层。

## 配额保护

默认配置优先降低 D1/R2 配额意外耗尽的风险：

- 单个规范化前请求最大 64 KiB；
- 同一 `installationHash` 每分钟最多接收 10 个事件；
- 未携带安装摘要的旧客户端共享保守的匿名限流桶；
- Issue 的 `event_count`、`terminal_count`、`affected_installations` 使用增量更新，不再为每个事件重新 `COUNT` 历史表；
- 同一 Queue batch 中相同 Issue 只执行一次 Issue 聚合更新；
- `issue_installations` 只在首次看到“该 Issue + 该安装”时写入，不再随每次重复异常更新 `last_seen`；
- R2 默认只保存新 Issue 的第一份完整脱敏事件，以及 terminal 事件；
- R2 写入失败属于可选诊断信息丢失，不触发 Queue 重试，避免因 R2 故障放大 D1/R2 消耗；
- D1 事件明细默认保留 30 天；
- 每天的清理任务最多删除 2000 行，防止一次清理本身吃掉大量 D1 写额度；
- Issue 聚合统计不会随旧事件明细删除而丢失。

对应 `wrangler.jsonc`：

```text
MAX_EVENT_BYTES=65536
EVENT_RETENTION_DAYS=30
MAINTENANCE_DELETE_LIMIT=2000
ARCHIVE_TERMINAL_EVENTS=1
INGEST_RATE_LIMITER=10 events / 60 seconds / installation
```

如果未来事件量显著增加，可以进一步降低 `INGEST_RATE_LIMITER` 或关闭 terminal 的 R2 全量归档：

```json
{
  "ARCHIVE_TERMINAL_EVENTS": "0"
}
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
    | per-install rate limit
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

客户端上报完成于 Queue 入队，后台数据库或 R2 短暂故障不会卡住 Nori.Desktop。

## 协议 v1

最小事件：

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

`installationHash` 仅接受 16–64 位十六进制摘要。服务不需要也不接受真实设备 ID。

服务端 tag 白名单与 Nori.Desktop 当前 `TelemetrySanitizer` 对齐：

```text
operation
provider
failure_kind
plugin_id
plugin_version
host_api
exception_kind
hresult
assembly
type_name
```

fingerprint 当前由以下稳定字段生成，不包含行号，因此普通代码移动不会把同一问题拆成大量 Issue：

```text
project
exception.type
operation
top in-app frame module
top in-app frame function
top in-app frame file
```

## Cloudflare 初始化

先安装依赖：

```bash
pnpm install
```

创建资源：

```bash
pnpm wrangler d1 create nori-telemetry
pnpm wrangler r2 bucket create nori-telemetry-events
pnpm wrangler queues create nori-telemetry-events
pnpm wrangler queues create nori-telemetry-dead-letter
```

将 `wrangler d1 create` 输出的真实 database ID 写入 `wrangler.jsonc`，替换当前的：

```text
00000000-0000-0000-0000-000000000000
```

应用 D1 migration：

```bash
pnpm db:migrate:remote
```

管理 API 使用 Worker secret：

```bash
pnpm wrangler secret put ADMIN_TOKEN
```

### R2 生命周期

R2 payload 不应永久增长。创建 bucket 后为 `events/` 配置 30 天过期生命周期：

```bash
pnpm wrangler r2 bucket lifecycle add nori-telemetry-events --prefix events/ --expire-days 30
```

可以检查已配置规则：

```bash
pnpm wrangler r2 bucket lifecycle list nori-telemetry-events
```

生命周期删除由 R2 自身完成，不消耗 D1 写额度。

最后部署：

```bash
pnpm deploy
```

Cloudflare 当前推荐新 Workers 项目使用 `wrangler.jsonc` 作为配置源，本仓库也按这个方式维护。

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

成功入队返回 `202`：

```json
{
  "accepted": true,
  "eventId": "..."
}
```

超过单安装限流时返回 `429`，客户端应直接丢弃本次遥测事件，不做紧密重试。

管理 API 需要：

```http
Authorization: Bearer <ADMIN_TOKEN>
```

可用端点：

```text
GET /v1/admin/overview
GET /v1/admin/issues?status=unresolved&limit=50
GET /v1/admin/issues/{issueId}
GET /v1/admin/events/{eventId}
```

Issue 详情中的事件会带 `archived` 标记。未归档到 R2 的普通重复事件仍有 D1 索引和 top frame，但请求其完整 payload 会返回 `payload_not_archived`。

## 本地开发

```bash
pnpm db:migrate:local
pnpm dev
pnpm typecheck
pnpm test
```

## 与 Nori.Desktop 的迁移边界

Nori.Desktop 已经通过 `ITelemetry` 隔离具体 SDK，因此后续迁移不需要改业务层调用点。建议新增 `NoriTelemetry` 实现后保持：

- 用户明确同意前不初始化任何远程客户端；
- `CaptureException` 仍只上传异常类型、清理后的 stack frame、固定 operation 与白名单 tags；
- 客户端收到 `429` 后丢弃当前遥测，不把遥测系统变成重试风暴；
- `FlushAsync` 保持短超时，遥测失败永远不影响退出；
- 先并行验证 Nori.Telemetry，再删除 Sentry SDK 与发布期 Sentry secrets；
- 性能事务和 Web 前端遥测在错误收集稳定后单独迁移。

当前仓库先完成错误/崩溃收集基础设施；Dashboard、Release Health、告警、source map/PDB 符号服务属于后续阶段。
