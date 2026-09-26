import { ROLE_LABELS } from "../constants";
import { errorDetails, friendlyError, initials } from "../utils";

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

export function StatusBadge({ status }) {
  const tone = String(status || "UNKNOWN").toLowerCase().replaceAll("_", "-");
  const label = String(status || "Unknown").replaceAll("_", " ").toLowerCase().replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
  return <Badge tone={`status-${tone}`}>{label}</Badge>;
}

export function AvailabilityBadge({ available }) {
  return <Badge tone={available ? "success" : "neutral"}>{available ? "Available" : "Unavailable"}</Badge>;
}

export function Notice({ tone = "info", title, children, action }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : "status"}>
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
      <div className="partial-icon">!</div>
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

export function ErrorState({ error, onRetry, compact = false }) {
  const details = errorDetails(error);
  return (
    <div className={`error-state ${compact ? "error-state-compact" : ""}`} role="alert">
      <div>
        <strong>{friendlyError(error)}</strong>
        {details ? <p>{details}</p> : null}
      </div>
      {onRetry ? <Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button> : null}
    </div>
  );
}

export function EmptyState({ title = "Nothing here yet", children, action }) {
  return (
    <div className="empty-state">
      <div className="empty-mark">DB</div>
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function PageHeader({ eyebrow, title, description, actions, children }) {
  return (
    <div className="page-header">
      <div>
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
        {children}
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </div>
  );
}

export function SectionCard({ title, description, action, children, className = "" }) {
  return (
    <section className={`section-card ${className}`.trim()}>
      {(title || action) ? (
        <div className="section-card-header">
          <div>
            {title ? <h2>{title}</h2> : null}
            {description ? <p>{description}</p> : null}
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
        {icon ? <span className="stat-icon">{icon}</span> : null}
      </div>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

export function Field({ label, hint, error, children, className = "" }) {
  return (
    <label className={`field ${className}`.trim()}>
      <span className="field-label">{label}</span>
      {children}
      {hint && !error ? <span className="field-hint">{hint}</span> : null}
      {error ? <span className="field-error">{error}</span> : null}
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
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>×</button>
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

export function Checkbox({ label, checked, onChange, hint }) {
  return (
    <label className="checkbox-field">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <strong>{label}</strong>
        {hint ? <small>{hint}</small> : null}
      </span>
    </label>
  );
}
