import { Icon } from "./UI";
import { formatDateTime } from "../utils";

const EVENT_META = {
  "reservation.created": { icon: "calendar", tone: "blue", label: "Unit reserved" },
  "reservation.updated": { icon: "refresh", tone: "purple", label: "Reservation updated" },
  "unit.updated": { icon: "boxes", tone: "amber", label: "Unit updated" },
  "donation.created": { icon: "droplet", tone: "green", label: "Donation recorded" },
  "donation.screening": { icon: "beaker", tone: "green", label: "Screening completed" },
  "maintenance.sweep": { icon: "clock", tone: "slate", label: "Expiry sweep" },
  "chaos.changed": { icon: "sliders", tone: "red", label: "Chaos flag changed" },
  "inventory.changed": { icon: "boxes", tone: "blue", label: "Inventory changed" },
};

function describe(event) {
  const p = event.payload || {};
  switch (event.type) {
    case "reservation.created":
      return `Reservation for ${p.bloodGroup ?? "a unit"} in ${p.cityCode ?? "—"} · ${p.urgency ?? ""}`;
    case "reservation.updated":
      return `${p.change ?? "updated"} in ${p.cityCode ?? "—"}${p.reservationId ? ` · ${String(p.reservationId).slice(0, 8)}` : ""}${p.count ? ` · ${p.count} unit(s)` : ""}`;
    case "unit.updated":
      return `${p.change ?? "updated"} in ${p.cityCode ?? "—"}${p.unitId ? ` · ${String(p.unitId).slice(0, 8)}` : ""}`;
    case "donation.created":
      return `${p.units ?? 0} unit(s) quarantined in ${p.cityCode ?? "—"}`;
    case "donation.screening":
      return `${p.screeningStatus ?? ""} · ${p.units ?? 0} unit(s) in ${p.cityCode ?? "—"}`;
    case "maintenance.sweep":
      return `${p.released ?? 0} hold(s) released, ${p.expired ?? 0} expired in ${p.cityCode ?? "—"}`;
    case "chaos.changed":
      return `${p.cityCode ?? "—"} primary ${p.primaryDown ? "DOWN" : "up"}, replica ${p.replicaDown ? "DOWN" : "up"}`;
    default:
      return JSON.stringify(p);
  }
}

/**
 * Live operations feed.
 *
 * Renders the events pushed over SSE with a pulsing connection indicator, so
 * the dashboard visibly breathes rather than sitting still between manual
 * refreshes.
 */
export default function EventFeed({ events, connected, onClear }) {
  const items = [...events].reverse();
  return (
    <div className="event-feed">
      <div className="event-feed-header">
        <div className="event-feed-title">
          <span className={`signal-dot ${connected ? "signal-up" : "signal-down"}`} />
          <strong>Live activity</strong>
          <span className="event-feed-count">{events.length}</span>
        </div>
        {onClear ? (
          <button type="button" className="event-feed-clear" onClick={onClear}>Clear</button>
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className="event-feed-empty">
          {connected
            ? "Waiting for the next network event…"
            : "Connecting to the live feed…"}
        </p>
      ) : (
        <ul className="event-feed-list">
          {items.map((event) => {
            const meta = EVENT_META[event.type] || { icon: "activity", tone: "slate", label: event.type };
            return (
              <li key={`${event.id}-${event.at}`} className="event-feed-item">
                <span className={`event-feed-icon event-feed-icon-${meta.tone}`}>
                  <Icon name={meta.icon} size={14} />
                </span>
                <div className="event-feed-body">
                  <strong>{meta.label}</strong>
                  <span>{describe(event)}</span>
                </div>
                <time dateTime={event.at}>{formatDateTime(event.at)}</time>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
