import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";
import { useRequest } from "../hooks/useRequest";
import { useEventStream } from "../hooks/useEventStream";
import EventFeed from "../components/EventFeed";
import { Button, ErrorState, LoadingState, PageHeader, PartialResults, SectionCard, SimulatedBadge, StatCard } from "../components/UI";
import { formatNumber, friendlyError } from "../utils";

const GROUP_ORDER = ["A+", "A−", "B+", "B−", "AB+", "AB−", "O+", "O−"];
const CHART_COLORS = ["#2563eb", "#7c3aed", "#0891b2", "#059669", "#d97706", "#dc2626", "#4f46e5", "#0d9488"];
const STATUS_COLORS = {
  AVAILABLE: "#059669",
  RESERVED: "#2563eb",
  QUARANTINE: "#d97706",
  DISPATCHED: "#7c3aed",
  TRANSFUSED: "#0891b2",
  EXPIRED: "#64748b",
  DISCARDED: "#94a3b8",
};
const URGENCY_COLORS = { CRITICAL: "#dc2626", URGENT: "#d97706", ROUTINE: "#64748b" };

function groupRows(matrix) {
  return GROUP_ORDER.map((group) => ({ group, ...(matrix?.[group] ?? { count: 0 }) }));
}

function statusRows(byStatus) {
  return Object.entries(byStatus || {}).map(([status, count]) => ({ status, count }));
}

function urgencyRows(byUrgency) {
  return Object.entries(byUrgency || {}).map(([urgency, count]) => ({ urgency, count }));
}

function MatrixChart({ matrix, seriesKey = "count", stacked = true }) {
  const rows = useMemo(() => groupRows(matrix), [matrix]);
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={rows} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,.25)" vertical={false} />
        <XAxis dataKey="group" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 12 }} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip cursor={{ fill: "rgba(37,99,235,.06)" }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey={seriesKey} stackId={stacked ? "a" : undefined} fill="#2563eb" radius={stacked ? [4, 4, 0, 0] : 4} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function StatusPie({ rows, colorMap, nameKey = "status" }) {
  if (!rows.length) return <p className="chart-empty">No data in this view.</p>;
  return (
    <ResponsiveContainer width="100%" height={240}>
      <PieChart>
        <Pie data={rows} dataKey="count" nameKey={nameKey} innerRadius={58} outerRadius={92} paddingAngle={2}>
          {rows.map((row, index) => (
            <Cell key={row[nameKey]} fill={colorMap[row[nameKey]] || CHART_COLORS[index % CHART_COLORS.length]} />
          ))}
        </Pie>
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Tooltip />
      </PieChart>
    </ResponsiveContainer>
  );
}

function TrendChart({ points }) {
  if (!points?.length) return <p className="chart-empty">No donation history in this window.</p>;
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={points} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,.25)" vertical={false} />
        <XAxis dataKey="day" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={28} />
        <YAxis tick={{ fontSize: 12 }} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip />
        <Line type="monotone" dataKey="donations" stroke="#2563eb" strokeWidth={2.5} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/**
 * Shared dashboard body.
 *
 * Both the system admin (whole network) and the blood-bank admin (own tenant)
 * render the same charts; the API scopes the numbers. The SSE feed is what
 * makes the page live: every reservation, screening, sweep, or chaos flip
 * pushes a row into the activity panel without a manual refresh.
 */
function DashboardBody({ overview, timeseries, feed }) {
  const cities = overview?.cities ? Object.entries(overview.cities) : [];
  const totals = overview?.totals || {};
  const available = totals.unitsByStatus?.AVAILABLE ?? 0;
  const reserved = totals.unitsByStatus?.RESERVED ?? 0;
  const quarantine = totals.unitsByStatus?.QUARANTINE ?? 0;

  const groupSeries = useMemo(() => {
    if (!overview?.cities) return [];
    const combined = {};
    for (const [, city] of cities) {
      for (const [component, matrix] of Object.entries(city.matrix || {})) {
        if (!combined[component]) combined[component] = {};
        for (const [group, count] of Object.entries(matrix)) {
          combined[component][group] = (combined[component][group] ?? 0) + count;
        }
      }
    }
    return Object.entries(combined).map(([component, matrix]) => ({
      component,
      rows: groupRows(Object.fromEntries(Object.entries(matrix).map(([group, count]) => [group, { count }]))),
    }));
  }, [overview]);

  return (
    <>
      <div className="stat-grid">
        <StatCard label="Available units" value={formatNumber(available)} detail="Ready to reserve" tone="green" icon="droplet" />
        <StatCard label="Reserved" value={formatNumber(reserved)} detail="Held for a patient" tone="blue" icon="calendar" />
        <StatCard label="Quarantine" value={formatNumber(quarantine)} detail="Awaiting screening" tone="amber" icon="beaker" />
        <StatCard label="Expiring in 7 days" value={formatNumber(totals.expiring7d ?? 0)} detail="Needs attention" tone="red" icon="alert" />
        <StatCard label="Donations (30d)" value={formatNumber(totals.donationsLast30Days ?? 0)} detail="Collected network-wide" tone="purple" icon="heart" />
        <StatCard label="Transfusions (30d)" value={formatNumber(totals.transfusionsLast30Days ?? 0)} detail="Completed requests" tone="slate" icon="truck" />
      </div>

      {overview?.partial ? (
        <PartialResults meta={{ partial: true, unavailableCities: overview.unavailableCities }} />
      ) : null}

      <div className="dashboard-grid">
        <SectionCard title="Inventory by blood group" description="Available units per group across the shards in scope." icon="droplet">
          <MatrixChart matrix={totals.unitsByGroup} />
        </SectionCard>

        <SectionCard title="Reservation state" description="How current holds are distributed by status and urgency." icon="calendar">
          <div className="chart-split">
            <StatusPie rows={statusRows(totals.reservationsByStatus)} colorMap={STATUS_COLORS} />
            <StatusPie rows={urgencyRows(totals.reservationsByUrgency)} colorMap={URGENCY_COLORS} nameKey="urgency" />
          </div>
        </SectionCard>

        <SectionCard title="Donation trend" description="Collections per day over the last 30 days." icon="activity">
          <TrendChart points={timeseries?.points} />
        </SectionCard>

        <SectionCard
          title="Live activity"
          description="Server-sent events from every mutation on the network."
          icon="wifi"
          action={<SimulatedBadge label="LIVE SSE" />}
        >
          <EventFeed events={feed.events} connected={feed.connected} onClear={feed.clear} />
        </SectionCard>

        {cities.length > 1 ? (
          <SectionCard className="dashboard-grid-wide" title="City breakdown" description="Stock matrix per city shard, as served by the scatter-gather read." icon="server">
            <div className="city-chart-grid">
              {cities.map(([code, city]) => (
                <article className="city-chart-card" key={code}>
                  <div className="city-chart-head">
                    <strong>{code}</strong>
                    <span>
                      {formatNumber(city.available ?? 0)} avail · {formatNumber(city.reserved ?? 0)} held
                    </span>
                  </div>
                  <MatrixChart matrix={flattenCityMatrix(city.matrix)} stacked={false} />
                </article>
              ))}
            </div>
          </SectionCard>
        ) : null}
      </div>
    </>
  );
}

function flattenCityMatrix(matrix) {
  const combined = {};
  for (const groups of Object.values(matrix || {})) {
    for (const [group, count] of Object.entries(groups)) {
      combined[group] = { count: (combined[group]?.count ?? 0) + count };
    }
  }
  return combined;
}

export function SystemDashboardPage() {
  const overview = useRequest(() => api.stats.overview(), []);
  const timeseries = useRequest(() => api.stats.timeseries({ days: 30 }), []);
  const feed = useEventStream({ enabled: true });

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="System workspace"
        title="Network analytics"
        description="Live inventory, reservation, and donation analytics aggregated across every city shard."
        actions={<Button variant="secondary" onClick={() => { overview.reload(); timeseries.reload(); }}>Refresh analytics</Button>}
      />
      {overview.loading ? <SectionCard><LoadingState label="Aggregating shard statistics" /></SectionCard> : null}
      {overview.error ? <ErrorState error={overview.error} onRetry={overview.reload} /> : null}
      {overview.data ? (
        <DashboardBody
          overview={overview.data}
          timeseries={timeseries.data}
          feed={feed}
        />
      ) : null}
    </div>
  );
}

export function BankDashboardPage() {
  const overview = useRequest(() => api.stats.overview(), []);
  const timeseries = useRequest(() => api.stats.timeseries({ days: 30 }), []);
  const feed = useEventStream({ enabled: true });

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Blood bank workspace"
        title="Operations dashboard"
        description="Your bank's live stock, expiry pressure, and activity feed."
        actions={<Button variant="secondary" onClick={() => { overview.reload(); timeseries.reload(); }}>Refresh analytics</Button>}
      />
      {overview.loading ? <SectionCard><LoadingState label="Loading your bank's analytics" /></SectionCard> : null}
      {overview.error ? <ErrorState error={overview.error} onRetry={overview.reload} /> : null}
      {overview.data?.error ? <SectionCard><ErrorState error={new Error(friendlyError(overview.data))} onRetry={overview.reload} /></SectionCard> : null}
      {overview.data && !overview.data.error ? (
        <DashboardBody
          overview={overview.data}
          timeseries={timeseries.data}
          feed={feed}
        />
      ) : null}
    </div>
  );
}
