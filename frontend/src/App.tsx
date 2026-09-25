import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bug,
  Database,
  Gauge,
  Layers3,
  RefreshCw,
  Search,
  ServerCog,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  getArchivedEvent,
  getIssue,
  getIssues,
  getOverview,
} from "./api";
import type {
  ArchivedEventPayload,
  IssueDetailResponse,
  IssueEvent,
  IssueStatus,
  IssueSummary,
  Overview,
} from "./types";

type View = "overview" | "issues";

const STATUS_LABELS: Record<IssueStatus, string> = {
  unresolved: "未解决",
  resolved: "已解决",
  ignored: "已忽略",
};

function formatNumber(value: number | undefined): string {
  return new Intl.NumberFormat("zh-CN").format(value ?? 0);
}

function formatTime(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "dashboard_not_configured") {
      return "Pages Function 尚未配置 TELEMETRY_API_BASE 或 ADMIN_TOKEN。";
    }
    if (error.status === 401) {
      return "管理 API 拒绝了请求，请检查 Pages 与 Worker 的 ADMIN_TOKEN 是否一致。";
    }
    if (error.status === 502) {
      return "暂时无法连接 Nori.Telemetry Worker。";
    }
    return error.message;
  }

  return error instanceof Error ? error.message : "出现了未知错误。";
}

function LoadingBlock({ label = "读取遥测数据…" }: { label?: string }) {
  return (
    <div className="empty-state" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function ErrorBlock({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="error-state">
      <AlertTriangle size={18} aria-hidden="true" />
      <div>
        <strong>读取失败</strong>
        <p>{message}</p>
      </div>
      <button className="secondary-button" type="button" onClick={retry}>
        重试
      </button>
    </div>
  );
}

function StatusBadge({ status }: { status: IssueStatus }) {
  return <span className={`status-badge status-${status}`}>{STATUS_LABELS[status]}</span>;
}

function BoolBadge({ value, positive }: { value: boolean; positive: string }) {
  return value ? <span className="event-badge">{positive}</span> : null;
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  danger = false,
}: {
  icon: typeof Activity;
  label: string;
  value: number | undefined;
  hint: string;
  danger?: boolean;
}) {
  return (
    <article className={`panel stat-card ${danger ? "stat-danger" : ""}`}>
      <div className="stat-icon">
        <Icon size={18} aria-hidden="true" />
      </div>
      <div className="stat-copy">
        <span>{label}</span>
        <strong>{formatNumber(value)}</strong>
        <small>{hint}</small>
      </div>
    </article>
  );
}

function OverviewView({
  overview,
  loading,
  error,
  lastUpdated,
  refresh,
}: {
  overview: Overview | null;
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  refresh: () => void;
}) {
  return (
    <>
      <header className="page-header">
        <div>
          <span className="eyebrow">NORI TELEMETRY</span>
          <h1>运行概览</h1>
          <p>只在打开页面与手动刷新时读取数据，避免 Dashboard 自己制造 D1 读取压力。</p>
        </div>
        <button className="refresh-button" type="button" onClick={refresh} disabled={loading}>
          <RefreshCw size={15} className={loading ? "spin" : ""} aria-hidden="true" />
          刷新
        </button>
      </header>

      {error ? <ErrorBlock message={error} retry={refresh} /> : null}

      <section className="stat-grid" aria-label="24 小时遥测指标">
        <StatCard
          icon={Activity}
          label="24h 事件"
          value={overview?.events}
          hint="最近 24 小时写入的事件索引"
        />
        <StatCard
          icon={AlertTriangle}
          label="Terminal"
          value={overview?.terminalEvents}
          hint="最近 24 小时终止类异常"
          danger={(overview?.terminalEvents ?? 0) > 0}
        />
        <StatCard
          icon={Bug}
          label="未解决 Issue"
          value={overview?.unresolvedIssues}
          hint="仍需关注的稳定 fingerprint"
        />
        <StatCard
          icon={Layers3}
          label="受影响安装"
          value={overview?.affectedInstallations}
          hint="最近 24 小时的匿名安装摘要"
        />
      </section>

      <section className="overview-grid">
        <article className="panel quota-panel">
          <div className="panel-heading">
            <div className="panel-icon"><ShieldCheck size={18} /></div>
            <div>
              <h2>配额保护</h2>
              <p>D1 / R2 当前采用低写入策略</p>
            </div>
          </div>
          <div className="guard-list">
            <div><span>Issue 聚合</span><strong>增量计数</strong></div>
            <div><span>R2 Payload</span><strong>稀疏归档</strong></div>
            <div><span>D1 明细</span><strong>30 天默认保留</strong></div>
            <div><span>异常风暴</span><strong>Cache 短 TTL 抑制</strong></div>
          </div>
        </article>

        <article className="panel service-panel">
          <div className="panel-heading">
            <div className="panel-icon"><ServerCog size={18} /></div>
            <div>
              <h2>服务状态</h2>
              <p>Dashboard 不进行后台轮询</p>
            </div>
          </div>
          <div className="service-status">
            <span className="status-dot" />
            <div>
              <strong>{error ? "管理 API 需要检查" : overview ? "管理 API 可用" : "等待首次读取"}</strong>
              <span>
                {lastUpdated ? `最后读取 ${formatTime(lastUpdated.toISOString())}` : "尚未读取"}
              </span>
            </div>
          </div>
          <div className="service-note">
            <Database size={15} />
            <span>刷新一次只读取当前页面所需的数据。</span>
          </div>
        </article>
      </section>

      {loading && !overview ? <LoadingBlock /> : null}
    </>
  );
}

function IssueTable({
  issues,
  loading,
  onSelect,
}: {
  issues: IssueSummary[];
  loading: boolean;
  onSelect: (issue: IssueSummary) => void;
}) {
  if (loading) return <LoadingBlock label="读取 Issue…" />;
  if (issues.length === 0) {
    return (
      <div className="empty-state">
        <ShieldCheck size={20} />
        <span>这个筛选条件下暂时没有 Issue。</span>
      </div>
    );
  }

  return (
    <div className="issue-table-wrap">
      <table className="issue-table">
        <thead>
          <tr>
            <th>Issue</th>
            <th>状态</th>
            <th>事件</th>
            <th>安装</th>
            <th>版本</th>
            <th>最后出现</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue) => (
            <tr key={issue.id} onClick={() => onSelect(issue)} tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") onSelect(issue);
              }}>
              <td>
                <div className="issue-main">
                  <strong>{issue.title}</strong>
                  <span>{issue.id} · {issue.operation}</span>
                </div>
              </td>
              <td><StatusBadge status={issue.status} /></td>
              <td>{formatNumber(issue.event_count)}</td>
              <td>{formatNumber(issue.affected_installations)}</td>
              <td><code>{issue.last_release}</code></td>
              <td>{formatTime(issue.last_seen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IssuesView({
  status,
  setStatus,
  search,
  setSearch,
  issues,
  loading,
  error,
  refresh,
  onSelect,
}: {
  status: IssueStatus;
  setStatus: (status: IssueStatus) => void;
  search: string;
  setSearch: (value: string) => void;
  issues: IssueSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  onSelect: (issue: IssueSummary) => void;
}) {
  return (
    <>
      <header className="page-header">
        <div>
          <span className="eyebrow">ISSUES</span>
          <h1>异常聚合</h1>
          <p>按稳定 fingerprint 聚合同类异常。这里同样不会自动轮询。</p>
        </div>
        <button className="refresh-button" type="button" onClick={refresh} disabled={loading}>
          <RefreshCw size={15} className={loading ? "spin" : ""} aria-hidden="true" />
          刷新
        </button>
      </header>

      <section className="panel issues-panel">
        <div className="issues-toolbar">
          <div className="segmented" role="group" aria-label="Issue 状态">
            {(["unresolved", "resolved", "ignored"] as IssueStatus[]).map((item) => (
              <button
                key={item}
                type="button"
                className={status === item ? "active" : ""}
                onClick={() => setStatus(item)}
              >
                {STATUS_LABELS[item]}
              </button>
            ))}
          </div>
          <label className="search-box">
            <Search size={15} aria-hidden="true" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索异常、operation、release…"
              aria-label="搜索 Issue"
            />
          </label>
        </div>

        {error ? <ErrorBlock message={error} retry={refresh} /> : null}
        {!error ? <IssueTable issues={issues} loading={loading} onSelect={onSelect} /> : null}
      </section>
    </>
  );
}

function EventRow({
  event,
  selected,
  loading,
  onOpen,
}: {
  event: IssueEvent;
  selected: boolean;
  loading: boolean;
  onOpen: (event: IssueEvent) => void;
}) {
  const archived = Boolean(event.archived);
  return (
    <button
      type="button"
      className={`event-row ${selected ? "selected" : ""}`}
      onClick={() => archived && onOpen(event)}
      disabled={!archived || loading}
      title={archived ? "查看完整归档 payload" : "该重复事件未归档 R2 payload"}
    >
      <div className="event-time">
        <strong>{formatTime(event.timestamp)}</strong>
        <span>{event.release}</span>
      </div>
      <div className="event-frame">
        <strong>{event.exception_type}</strong>
        <span>{event.top_frame || event.operation}</span>
      </div>
      <div className="event-flags">
        <BoolBadge value={Boolean(event.terminal)} positive="terminal" />
        <BoolBadge value={archived} positive="R2" />
        {!archived ? <span className="event-muted">索引</span> : null}
      </div>
    </button>
  );
}

function IssueDetailView({
  detail,
  loading,
  error,
  back,
  retry,
}: {
  detail: IssueDetailResponse | null;
  loading: boolean;
  error: string | null;
  back: () => void;
  retry: () => void;
}) {
  const [payload, setPayload] = useState<ArchivedEventPayload | null>(null);
  const [payloadEventId, setPayloadEventId] = useState<string | null>(null);
  const [payloadLoading, setPayloadLoading] = useState(false);
  const [payloadError, setPayloadError] = useState<string | null>(null);

  useEffect(() => {
    setPayload(null);
    setPayloadEventId(null);
    setPayloadError(null);
  }, [detail?.issue.id]);

  const openEvent = async (event: IssueEvent) => {
    setPayloadLoading(true);
    setPayloadError(null);
    setPayloadEventId(event.id);
    try {
      setPayload(await getArchivedEvent(event.id));
    } catch (eventError) {
      setPayload(null);
      setPayloadError(errorMessage(eventError));
    } finally {
      setPayloadLoading(false);
    }
  };

  return (
    <>
      <header className="page-header detail-header">
        <div>
          <button type="button" className="back-button" onClick={back}>
            <ArrowLeft size={15} />
            返回 Issues
          </button>
          <span className="eyebrow">ISSUE DETAIL</span>
          <h1>{detail?.issue.title ?? "Issue 详情"}</h1>
          {detail ? (
            <p><code>{detail.issue.id}</code> · {detail.issue.operation}</p>
          ) : null}
        </div>
        {detail ? <StatusBadge status={detail.issue.status} /> : null}
      </header>

      {error ? <ErrorBlock message={error} retry={retry} /> : null}
      {loading && !detail ? <LoadingBlock label="读取 Issue 详情…" /> : null}

      {detail ? (
        <>
          <section className="detail-summary">
            <article className="panel mini-stat">
              <span>事件总数</span><strong>{formatNumber(detail.issue.event_count)}</strong>
            </article>
            <article className="panel mini-stat">
              <span>Terminal</span><strong>{formatNumber(detail.issue.terminal_count)}</strong>
            </article>
            <article className="panel mini-stat">
              <span>受影响安装</span><strong>{formatNumber(detail.issue.affected_installations)}</strong>
            </article>
            <article className="panel mini-stat">
              <span>最新版本</span><strong className="release-value">{detail.issue.last_release}</strong>
            </article>
          </section>

          <section className="detail-grid">
            <article className="panel events-panel">
              <div className="panel-heading compact">
                <div className="panel-icon"><TerminalSquare size={18} /></div>
                <div>
                  <h2>最近事件</h2>
                  <p>仅显示最近 25 条索引；带 R2 标记的事件可查看完整 payload。</p>
                </div>
              </div>
              <div className="event-list">
                {detail.events.map((event) => (
                  <EventRow
                    key={event.id}
                    event={event}
                    selected={payloadEventId === event.id}
                    loading={payloadLoading}
                    onOpen={openEvent}
                  />
                ))}
              </div>
            </article>

            <article className="panel payload-panel">
              <div className="panel-heading compact">
                <div className="panel-icon"><Database size={18} /></div>
                <div>
                  <h2>R2 Payload</h2>
                  <p>完整内容已经过服务端隐私边界清理。</p>
                </div>
              </div>

              {payloadLoading ? <LoadingBlock label="读取归档…" /> : null}
              {payloadError ? (
                <div className="inline-error"><AlertTriangle size={15} />{payloadError}</div>
              ) : null}
              {!payloadLoading && !payloadError && !payload ? (
                <div className="payload-placeholder">
                  <Database size={22} />
                  <span>选择左侧带 R2 标记的事件。</span>
                </div>
              ) : null}
              {payload ? <pre className="payload-json">{JSON.stringify(payload, null, 2)}</pre> : null}
            </article>
          </section>
        </>
      ) : null}
    </>
  );
}

export function App() {
  const [view, setView] = useState<View>("overview");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const [status, setStatus] = useState<IssueStatus>("unresolved");
  const [search, setSearch] = useState("");
  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const loadedStatus = useRef<IssueStatus | null>(null);

  const [detail, setDetail] = useState<IssueDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const selectedIssueId = useRef<string | null>(null);

  const loadOverview = useCallback(async () => {
    setOverviewLoading(true);
    setOverviewError(null);
    try {
      setOverview(await getOverview());
      setLastUpdated(new Date());
    } catch (loadError) {
      setOverviewError(errorMessage(loadError));
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  const loadIssues = useCallback(async (nextStatus: IssueStatus) => {
    setIssuesLoading(true);
    setIssuesError(null);
    try {
      const result = await getIssues(nextStatus);
      setIssues(result.issues);
      loadedStatus.current = nextStatus;
    } catch (loadError) {
      setIssuesError(errorMessage(loadError));
    } finally {
      setIssuesLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (issueId: string) => {
    selectedIssueId.current = issueId;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const result = await getIssue(issueId);
      if (selectedIssueId.current === issueId) setDetail(result);
    } catch (loadError) {
      if (selectedIssueId.current === issueId) setDetailError(errorMessage(loadError));
    } finally {
      if (selectedIssueId.current === issueId) setDetailLoading(false);
    }
  }, []);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    if (view !== "issues" || detail) return;
    if (loadedStatus.current === status) return;
    void loadIssues(status);
  }, [view, status, detail, loadIssues]);

  const filteredIssues = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return issues;

    return issues.filter((issue) =>
      [
        issue.id,
        issue.title,
        issue.exception_type,
        issue.operation,
        issue.last_release,
      ].some((value) => value.toLowerCase().includes(query)),
    );
  }, [issues, search]);

  const selectIssue = (issue: IssueSummary) => {
    setDetail(null);
    setView("issues");
    void loadDetail(issue.id);
  };

  const leaveDetail = () => {
    selectedIssueId.current = null;
    setDetail(null);
    setDetailError(null);
  };

  const changeView = (next: View) => {
    if (next !== "issues") leaveDetail();
    setView(next);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">N</div>
          <div>
            <strong>Nori</strong>
            <span>Telemetry</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="Dashboard 导航">
          <button
            type="button"
            className={view === "overview" ? "active" : ""}
            onClick={() => changeView("overview")}
          >
            <Gauge size={17} />
            <span>概览</span>
          </button>
          <button
            type="button"
            className={view === "issues" ? "active" : ""}
            onClick={() => changeView("issues")}
          >
            <Bug size={17} />
            <span>Issues</span>
            {overview?.unresolvedIssues ? (
              <em>{Math.min(overview.unresolvedIssues, 999)}</em>
            ) : null}
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="privacy-chip">
            <ShieldCheck size={14} />
            <span>Privacy-first</span>
          </div>
          <p>管理凭证仅存在 Pages Function 与 Worker 服务端。</p>
        </div>
      </aside>

      <main className="main-content">
        {view === "overview" ? (
          <OverviewView
            overview={overview}
            loading={overviewLoading}
            error={overviewError}
            lastUpdated={lastUpdated}
            refresh={loadOverview}
          />
        ) : detail || detailLoading || detailError ? (
          <IssueDetailView
            detail={detail}
            loading={detailLoading}
            error={detailError}
            back={leaveDetail}
            retry={() => {
              if (selectedIssueId.current) void loadDetail(selectedIssueId.current);
            }}
          />
        ) : (
          <IssuesView
            status={status}
            setStatus={(next) => {
              setStatus(next);
              setSearch("");
            }}
            search={search}
            setSearch={setSearch}
            issues={filteredIssues}
            loading={issuesLoading}
            error={issuesError}
            refresh={() => loadIssues(status)}
            onSelect={selectIssue}
          />
        )}
      </main>
    </div>
  );
}
