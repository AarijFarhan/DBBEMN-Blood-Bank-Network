import { ROLE_LABELS } from "../constants";
import { errorDetails, friendlyError, initials } from "../utils";

const ICONS = {
  droplet: <path d="M12 3 6.9 8.1a7.2 7.2 0 1 0 10.2 0L12 3Z" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20.5 20.5-3.9-3.9" /></>,
  calendar: <><rect x="3" y="4.5" width="18" height="16" rx="2.5" /><path d="M3 9.5h18M8 3v3.5M16 3v3.5" /></>,
  megaphone: <path d="M4 10.5v3a1.5 1.5 0 0 0 1.5 1.5H7l4 4V6.5l-4 4H5.5A1.5 1.5 0 0 0 4 12Zm3 4.5v3.5h2.6V16M15 8.6a4 4 0 0 1 0 6.8M18 6.2a7.4 7.4 0 0 1 0 11.6" />,
  boxes: <><rect x="3" y="3.5" width="8" height="8" rx="1.6" /><rect x="13" y="3.5" width="8" height="8" rx="1.6" /><rect x="3" y="13.5" width="8" height="7" rx="1.6" /><rect x="13" y="13.5" width="8" height="7" rx="1.6" /></>,
  clipboard: <><path d="M9 4.5H7.5A2 2 0 0 0 5.5 6.5v13A2 2 0 0 0 7.5 21.5h9a2 2 0 0 0 2-2v-13a2 2 0 0 0-2-2H15" /><rect x="9" y="2.8" width="6" height="3.4" rx="1.3" /></>,
  truck: <><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h9A1.5 1.5 0 0 1 15 6.5V17H3Z" /><path d="M15 9h3.6a1.5 1.5 0 0 1 1.3.75L21.5 12.5V17H15Z" /><circle cx="7" cy="18.2" r="1.8" /><circle cx="17.5" cy="18.2" r="1.8" /></>,
  trash: <path d="M4 7h16M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7m2.5 0-.8 12a1.6 1.6 0 0 1-1.6 1.5H8.9A1.6 1.6 0 0 1 7.3 19L6.5 7M10 11v5M14 11v5" />,
  user: <><circle cx="12" cy="8" r="3.6" /><path d="M4.8 20.2a7.2 7.2 0 0 1 14.4 0" /></>,
  inbox: <><path d="M4 13.5 6.2 5.4A1.6 1.6 0 0 1 7.75 4.2h8.5a1.6 1.6 0 0 1 1.55 1.2L20 13.5" /><path d="M4 13.5h4l1.2 2.2h5.6L16 13.5h4v4.6A1.9 1.9 0 0 1 18.1 20H5.9A1.9 1.9 0 0 1 4 18.1Z" /></>,
  history: <><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8" /><path d="M4 4v4h4" /><path d="M12 8v4l3 1.8" /></>,
  activity: <path d="M3 12.5h3.6l2.2-6 3.4 12 2.3-6H21" />,
  sliders: <><path d="M5 20v-6M5 10V4M12 20v-9M12 7V4M19 20v-4M19 12V4" /><circle cx="5" cy="12" r="2" /><circle cx="12" cy="9" r="2" /><circle cx="19" cy="14" r="2" /></>,
  server: <><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
  users: <><circle cx="9" cy="8.5" r="3.3" /><path d="M3.5 19.5a5.7 5.7 0 0 1 11 0" /><path d="M16 5.4a3.3 3.3 0 0 1 0 6.4M17.5 19.5a5.6 5.6 0 0 0-1.7-4" /></>,
  hospital: <><path d="M4 21V8.4a1.6 1.6 0 0 1 .8-1.4l6.4-3.7a1.6 1.6 0 0 1 1.6 0l6.4 3.7a1.6 1.6 0 0 1 .8 1.4V21" /><path d="M9 21v-5h6v5M12 7v4M10 9h4M3 21h18" /></>,
  shield: <><path d="M12 3.2 5.5 6v5.4c0 4.2 2.7 7.5 6.5 9.4 3.8-1.9 6.5-5.2 6.5-9.4V6Z" /><path d="m9.3 11.8 1.9 1.9 3.6-3.7" /></>,
  refresh: <><path d="M20 6.5v4.5h-4.5" /><path d="M19.2 11A7.4 7.4 0 1 0 17 5.4L20 8" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  chevron: <path d="m9 5.5 6.5 6.5L9 18.5" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  alert: <><path d="M12 4 2.7 20h18.6Z" /><path d="M12 10v4M12 17h.01" /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 7.8h.01" /></>,
  logout: <><path d="M15 4.5h3a1.8 1.8 0 0 1 1.8 1.8v11.4a1.8 1.8 0 0 1-1.8 1.8h-3" /><path d="M10 8.5 6.5 12l3.5 3.5M6.5 12H15" /></>,
  pitchfork: <><path d="M6 4v16M18 4v16M6 8h12M12 4v16" /></>,
  bell: <><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" /><path d="M10 19a2 2 0 0 0 4 0" /></>,
  filter: <path d="M4 6h16l-6 7v6l-4-2v-4Z" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  map: <><path d="M12 21s6.5-5.4 6.5-10.5a6.5 6.5 0 1 0-13 0C5.5 15.6 12 21 12 21Z" /><circle cx="12" cy="10.5" r="2.4" /></>,
  phone: <path d="M6.5 4h2.2l1.4 3.5-1.7 1.3a11 11 0 0 0 5.3 5.3l1.3-1.7L18.5 14v2.2a2 2 0 0 1-2.2 2A13.6 13.6 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4Z" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 1.8" /></>,
  layers: <><path d="m12 3 8.5 4.5L12 12 3.5 7.5Z" /><path d="m3.5 12.2 8.5 4.5 8.5-4.5M3.5 16.6 12 21l8.5-4.4" /></>,
  heart: <path d="M12 20s-7.5-4.4-7.5-9.7A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 3.1C19.5 15.6 12 20 12 20Z" />,
  beaker: <><path d="M9 4h6M10 4v5.2L5.8 17A2.2 2.2 0 0 0 7.7 20.5h8.6a2.2 2.2 0 0 0 1.9-3.5L14 9.2V4" /><path d="M7.5 15h9" /></>,
  file: <><path d="M7 3.5h6.5L18 8v11.5A1.5 1.5 0 0 1 16.5 21h-9A1.5 1.5 0 0 1 6 19.5v-14A1.5 1.5 0 0 1 7.5 4Z" /><path d="M13 3.5V8h4.5M9 13h6M9 16.5h4" /></>,
  wifi: <><path d="M3.5 9a13 13 0 0 1 17 0M6.5 12.2a8.5 8.5 0 0 1 11 0M9.5 15.4a4 4 0 0 1 5 0" /><path d="M12 18.5h.01" /></>,
  power: <><path d="M12 3.5v8" /><path d="M7.2 6.3a7 7 0 1 0 9.6 0" /></>,
  gauge: <><path d="M4 18a8 8 0 1 1 16 0" /><path d="m12 14 3.5-3.5" /><path d="M4 18h16" /></>,
};

export function Icon({ name, size = 18, strokeWidth = 1.75, className = "" }) {
  const content = ICONS[name];
  if (!content) return null;
  return (
    <svg
      className={`icon ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {content}
    </svg>
  );
}

export function Button({ children, variant = "primary", size = "md", className = "", type = "button", ...props }) {
  return (
    <button type={type} className={`button button-${variant} button-${size} ${className}`.trim()} {...props}>
      {children}
    </button>
  );
}

export function Badge({ children, tone = "neutral", className = "" }) {
  return <span className={`badge badge-${tone} ${className}`.trim()}>{children}</span>;
}

export function SimulatedBadge({ children = "SIMULATED", className = "" }) {
  return <Badge tone="simulated" className={className}>{children}</Badge>;
}

const STATUS_TONES = {
  ACTIVE: "blue",
  DISPATCHED: "purple",
  COMPLETED: "success",
  CANCELLED: "neutral",
  EXPIRED: "slate",
  AVAILABLE: "success",
  QUARANTINE: "warning",
  RESERVED: "blue",
  TRANSFUSED: "purple",
  DISCARDED: "slate",
  PENDING: "warning",
  PASSED: "success",
  FAILED: "danger",
  ACCEPTED: "success",
  DECLINED: "danger",
  URGENT: "warning",
  CRITICAL: "danger",
  ROUTINE: "neutral",
  ATTENTION: "warning",
  UNAVAILABLE: "neutral",
  UP: "success",
  HEALTHY: "success",
  OK: "success",
  DEGRADED: "warning",
  DOWN: "danger",
  ERROR: "danger",
};

export function StatusBadge({ status }) {
  const key = String(status || "UNKNOWN").toUpperCase();
  const tone = STATUS_TONES[key] || "neutral";
  const label = key.replaceAll("_", " ").toLowerCase().replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
  return <Badge tone={tone}>{label}</Badge>;
}

export function AvailabilityBadge({ available }) {
  return <Badge tone={available ? "success" : "neutral"}>{available ? "Available" : "Unavailable"}</Badge>;
}

export function Notice({ tone = "info", title, children, action }) {
  const iconName = tone === "success" ? "check" : tone === "error" ? "alert" : tone === "warning" ? "alert" : "info";
  return (
    <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <span className="notice-icon"><Icon name={iconName} size={17} /></span>
      <div className="notice-content">
        {title ? <strong>{title}</strong> : null}
        {children ? <div>{children}</div> : null}
      </div>
      {action ? <div className="notice-action">{action}</div> : null}
    </div>
  );
}

export function PartialResults({ meta, className = "" }) {
  if (!meta?.partial && !meta?.unavailableCities?.length) return null;
  return (
    <div className={`partial-banner ${className}`.trim()}>
      <span className="partial-icon"><Icon name="alert" size={15} /></span>
      <div>
        <strong>Partial results</strong>
        <p>
          {meta?.unavailableCities?.length
            ? `Some city shards did not respond: ${meta.unavailableCities.join(", ")}.`
            : "The network returned only the results available from responding shards."}
        </p>
        {meta?.replicaLagMs ? <small>Replica lag: {meta.replicaLagMs} ms.</small> : null}
      </div>
      <SimulatedBadge />
    </div>
  );
}

export function LoadingState({ label = "Loading workspace data" }) {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function Skeleton({ width = "100%", height = 14, radius = 8, className = "" }) {
  return <span className={`skeleton ${className}`.trim()} style={{ width, height, borderRadius: radius }} aria-hidden="true" />;
}

export function ErrorState({ error, onRetry, compact = false }) {
  const details = errorDetails(error);
  return (
    <div className={`error-state ${compact ? "error-state-compact" : ""}`} role="alert">
      <div className="error-state-body">
        <span className="error-state-icon"><Icon name="alert" size={18} /></span>
        <div>
          <strong>{friendlyError(error)}</strong>
          {details ? <p>{details}</p> : null}
        </div>
      </div>
      {onRetry ? <Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button> : null}
    </div>
  );
}

export function EmptyState({ title = "Nothing here yet", children, action, icon = "inbox" }) {
  return (
    <div className="empty-state">
      <span className="empty-mark"><Icon name={icon} size={20} /></span>
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function PageHeader({ eyebrow, title, description, actions, icon, children }) {
  return (
    <div className="page-header">
      <div className="page-header-main">
        {icon ? <span className="page-header-icon"><Icon name={icon} size={22} /></span> : null}
        <div>
          {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
          <h1>{title}</h1>
          {description ? <p>{description}</p> : null}
          {children}
        </div>
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </div>
  );
}

export function PaginationControls({ page, pageSize, totalItems, onPageChange }) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const start = totalItems === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalItems);

  return (
    <nav className="pagination-controls" aria-label="Pagination">
      <span className="pagination-summary">
        Showing {start}–{end} of {totalItems}
      </span>
      <div className="pagination-actions">
        <Button variant="secondary" size="sm" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
          Previous
        </Button>
        <span className="pagination-page">Page {page} of {totalPages}</span>
        <Button variant="secondary" size="sm" onClick={() => onPageChange(page + 1)} disabled={page >= totalPages}>
          Next
        </Button>
      </div>
    </nav>
  );
}

export function SectionCard({ title, description, action, children, className = "", icon }) {
  return (
    <section className={`section-card ${className}`.trim()}>
      {(title || action) ? (
        <div className="section-card-header">
          <div className="section-card-title">
            {icon ? <span className="section-card-icon"><Icon name={icon} size={17} /></span> : null}
            <div>
              {title ? <h2>{title}</h2> : null}
              {description ? <p>{description}</p> : null}
            </div>
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function StatCard({ label, value, detail, tone = "blue", icon }) {
  return (
    <div className={`stat-card stat-card-${tone}`}>
      <div className="stat-card-top">
        <span>{label}</span>
        {icon ? (
          typeof icon === "string"
            ? <span className="stat-icon"><Icon name={icon} size={18} /></span>
            : <span className="stat-icon">{icon}</span>
        ) : null}
      </div>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

export function Field({ label, hint, error, children, className = "" }) {
  return (
    <label className={`field ${error ? "field-invalid" : ""} ${className}`.trim()}>
      <span className="field-label">{label}</span>
      {children}
      {hint && !error ? <span className="field-hint">{hint}</span> : null}
      {error ? <span className="field-error" role="alert">{error}</span> : null}
    </label>
  );
}

export function Modal({ open, title, onClose, children, footer }) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}><Icon name="plus" size={18} className="icon-close" /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmDeleteModal({ open, title, entityName, consequence, busy, error, onClose, onConfirm }) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>{busy ? "Deleting…" : "Delete permanently"}</Button>
        </>
      }
    >
      <p className="confirm-copy">
        <strong>{entityName}</strong> will be removed permanently. This cannot be undone.
      </p>
      {consequence ? <Notice tone="warning" title="Also deleted from the database">{consequence}</Notice> : null}
      {error ? <Notice tone="error" title="Delete failed">{error}</Notice> : null}
    </Modal>
  );
}

export function UserAvatar({ user, size = "md" }) {
  return <span className={`avatar avatar-${size}`}>{initials(user?.username || user?.email || "DB")}</span>;
}

export function RoleBadge({ role }) {
  return <Badge tone="role">{ROLE_LABELS[role] || role || "Unknown role"}</Badge>;
}

export function Checkbox({ label, checked, onChange, hint, disabled = false }) {
  return (
    <label className={`checkbox-field ${disabled ? "checkbox-field-disabled" : ""}`.trim()}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
      <span>
        <strong>{label}</strong>
        {hint ? <small>{hint}</small> : null}
      </span>
    </label>
  );
}
