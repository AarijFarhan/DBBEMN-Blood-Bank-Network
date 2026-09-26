import { useMemo, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { useRequest } from "../hooks/useRequest";
import { BLOOD_GROUPS, COMPONENTS, RH_FACTORS, UNIT_STATUSES } from "../constants";
import { Button, EmptyState, ErrorState, Field, LoadingState, Modal, Notice, PageHeader, SectionCard, StatusBadge } from "../components/UI";
import { errorDetails, formatBloodType, formatComponent, formatDate, formatDateTime, formatNumber, friendlyError, listFrom, normalizeResult } from "../utils";

function UnitFilters({ status, setStatus, query, setQuery }) {
  return (
    <div className="toolbar">
      <input className="search-input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by unit, group, or bank" aria-label="Filter inventory" />
      <select className="compact-select" value={status} onChange={(event) => setStatus(event.target.value)}>{UNIT_STATUSES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
    </div>
  );
}

function UnitTable({ units, onDiscard, emptyTitle = "No units in this view" }) {
  if (!units.length) return <EmptyState title={emptyTitle}>Try another status filter or refresh the shard view.</EmptyState>;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead><tr><th>Unit</th><th>Component</th><th>Group</th><th>Expiry</th><th>Status</th><th /></tr></thead>
        <tbody>{units.map((unit) => <tr key={unit.unitId || unit.id}><td><strong className="mono-text">{unit.unitId?.slice(0, 12) || "—"}</strong><small>{unit.cityCode || "Local shard"}</small></td><td>{formatComponent(unit.componentType)}<small>{formatNumber(unit.volumeMl)} ml</small></td><td><span className="table-blood-type">{formatBloodType(unit.bloodGroup, unit.rhFactor)}</span></td><td>{formatDate(unit.expiryDate)}</td><td><StatusBadge status={unit.status} /></td><td>{onDiscard && ["AVAILABLE", "QUARANTINE"].includes(unit.status) ? <Button variant="ghost" size="sm" onClick={() => onDiscard(unit)}>Discard</Button> : null}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

export function BankInventoryPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState("AVAILABLE");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [reason, setReason] = useState("");
  const [action, setAction] = useState({ loading: false, error: null, success: null });
  const request = useRequest(() => api.units.list({ bankId: user?.bloodBankId, status: status || undefined, limit: 100 }), [status, user?.bloodBankId]);
  const units = useMemo(() => listFrom(request.data, ["units", "items"]).map(normalizeResult).filter((unit) => !query || [unit.unitId, unit.bloodGroup, unit.rhFactor, unit.componentType, unit.status].some((value) => String(value || "").toLowerCase().includes(query.toLowerCase()))), [request.data, query]);
  const available = units.filter((unit) => unit.status === "AVAILABLE").length;
  const quarantine = units.filter((unit) => unit.status === "QUARANTINE").length;
  const expiring = units.filter((unit) => unit.expiryDate && new Date(unit.expiryDate).getTime() - Date.now() < 7 * 86400000).length;

  function openDiscard(unit) {
    setSelected(unit);
    setReason("");
    setAction({ loading: false, error: null, success: null });
  }

  async function discard() {
    if (!selected) return;
    setAction({ loading: true, error: null, success: null });
    try {
      await api.units.discard(selected.unitId, { reason: reason || undefined });
      setAction({ loading: false, error: null, success: "Unit moved to discarded status." });
      setSelected(null);
      request.reload();
    } catch (error) {
      setAction({ loading: false, error, success: null });
    }
  }

  return (
    <div className="page-stack">
      <PageHeader eyebrow="Blood bank workspace" title="Inventory control" description="See the live unit ledger for your bank, with expiry and quarantine signals first." actions={<Button variant="secondary" onClick={request.reload}>Refresh inventory</Button>} />
      {action.success ? <Notice tone="success" title="Inventory updated">{action.success}</Notice> : null}
      <div className="stat-grid"><div className="stat-card stat-card-blue"><span>Available</span><strong>{available}</strong><small>Ready to reserve</small></div><div className="stat-card stat-card-amber"><span>Quarantine</span><strong>{quarantine}</strong><small>Awaiting screening</small></div><div className="stat-card stat-card-red"><span>Expiring soon</span><strong>{expiring}</strong><small>Within seven days</small></div></div>
      <SectionCard title="Unit ledger" description="Search and filter the current response from your tenant-scoped shard."><UnitFilters status={status} setStatus={setStatus} query={query} setQuery={setQuery} />{request.loading ? <LoadingState label="Loading unit inventory" /> : null}{request.error ? <ErrorState error={request.error} onRetry={request.reload} /> : null}{!request.loading && !request.error ? <UnitTable units={units} onDiscard={openDiscard} /> : null}</SectionCard>
      <Modal open={Boolean(selected)} title="Discard unit" onClose={() => setSelected(null)} footer={<><Button variant="ghost" onClick={() => setSelected(null)}>Keep unit</Button><Button variant="danger" onClick={discard} disabled={action.loading}>{action.loading ? "Discarding…" : "Discard unit"}</Button></>}>
        {action.error ? <Notice tone="error" title="Discard failed">{friendlyError(action.error)}{errorDetails(action.error) ? ` ${errorDetails(action.error)}` : ""}</Notice> : null}
        <p className="modal-copy">Discarding is restricted to available and quarantined units. The state transition is recorded by the primary shard.</p>
        <Field label="Reason" hint="Optional audit context."><textarea rows="3" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Temperature excursion, expired label, or other reason" /></Field>
      </Modal>
    </div>
  );
}

export function BankDonationsPage() {
  const { user } = useAuth();
  const [form, setForm] = useState({ donorId: "", volumeMl: 450, componentType: "PRBC" });
  const [action, setAction] = useState({ loading: false, error: null, success: null });
  const donations = useRequest(() => api.donations.list({ limit: 100 }), []);
  const donors = useRequest(() => api.search.donors({ available: "true", limit: 100 }), []);

  function update(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    setAction({ loading: true, error: null, success: null });
    try {
      await api.donations.create({ donorId: form.donorId, bloodBankId: user?.bloodBankId, volumeMl: Number(form.volumeMl), components: [{ componentType: form.componentType, volumeMl: Number(form.volumeMl) }] });
      setAction({ loading: false, error: null, success: "Donation recorded. New units are in quarantine until screening." });
      donations.reload();
    } catch (error) {
      setAction({ loading: false, error, success: null });
    }
  }

  const rows = listFrom(donations.data, ["donations"]);
  const donorRows = listFrom(donors.data, ["donors"]);
  return (
    <div className="page-stack">
      <PageHeader eyebrow="Blood bank workspace" title="Record donations" description="Capture a collection in one transaction and keep its units quarantined until screening." />
      {action.success ? <Notice tone="success" title="Donation recorded">{action.success}</Notice> : null}
      <div className="workspace-grid workspace-grid-wide">
        <SectionCard title="New collection" description="Eligibility is checked against age, weight, availability, and donation interval.">
          <form className="stack-form" onSubmit={submit}>
            <Field label="Donor"><select required value={form.donorId} onChange={(event) => update("donorId", event.target.value)}><option value="">Select an available donor</option>{donorRows.map((donor) => <option key={donor.donorId} value={donor.donorId}>{donor.fullName} · {formatBloodType(donor.bloodGroup, donor.rhFactor)} · {donor.cityCode}</option>)}</select></Field>
            {donors.error ? <span className="field-hint">Donor search unavailable. Paste a donor UUID below.</span> : null}
            <Field label="Donor ID" hint="Required UUID from the donor directory."><input required value={form.donorId} onChange={(event) => update("donorId", event.target.value)} placeholder="00000000-0000-0000-0000-000000000000" /></Field>
            <div className="form-grid form-grid-two"><Field label="Collected volume (ml)"><input type="number" min="350" max="500" step="1" required value={form.volumeMl} onChange={(event) => update("volumeMl", event.target.value)} /></Field><Field label="Component"><select value={form.componentType} onChange={(event) => update("componentType", event.target.value)}>{COMPONENTS.map((component) => <option key={component.value} value={component.value}>{component.label}</option>)}</select></Field></div>
            <Button type="submit" disabled={action.loading}>{action.loading ? "Recording donation…" : "Record donation"}</Button>
          </form>
        </SectionCard>
        <SectionCard title="Eligibility snapshot" description="Available donors returned by the bank-local search.">
          {donors.loading ? <LoadingState label="Loading donor directory" /> : null}{!donors.loading && donorRows.length ? <div className="compact-list">{donorRows.slice(0, 8).map((donor) => <div className="compact-list-row" key={donor.donorId}><div><strong>{donor.fullName}</strong><span>{formatBloodType(donor.bloodGroup, donor.rhFactor)} · {donor.cityCode}</span></div><span className="availability-dot" aria-label="Available" /></div>)}</div> : null}{!donors.loading && !donorRows.length ? <EmptyState title="No available donors">Donor eligibility and availability will appear here.</EmptyState> : null}
        </SectionCard>
      </div>
      <SectionCard title="Recent donations" description="The latest collection records for your bank.">
        {donations.loading ? <LoadingState label="Loading donation history" /> : null}{donations.error ? <ErrorState error={donations.error} onRetry={donations.reload} /> : null}{!donations.loading && !donations.error ? rows.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Collected</th><th>Donor</th><th>Volume</th><th>Screening</th><th>Bank</th></tr></thead><tbody>{rows.map((donation) => <tr key={donation.donationId}><td>{formatDateTime(donation.collectedAt)}</td><td className="mono-text">{donation.donorId?.slice(0, 12)}</td><td>{formatNumber(donation.volumeMl)} ml</td><td><StatusBadge status={donation.screeningStatus} /></td><td className="mono-text">{donation.bloodBankId?.slice(0, 12)}</td></tr>)}</tbody></table></div> : <EmptyState title="No donations recorded">New collections will appear here after they are saved.</EmptyState> : null}
      </SectionCard>
    </div>
  );
}

export function BankScreeningPage() {
  const [action, setAction] = useState({ id: null, error: null, success: null });
  const request = useRequest(() => api.donations.list({ limit: 100 }), []);
  const donations = listFrom(request.data, ["donations"]).filter((item) => item.screeningStatus === "PENDING");

  async function screen(donation, status) {
    setAction({ id: donation.donationId, error: null, success: null });
    try {
      await api.donations.screen(donation.donationId, { screeningStatus: status });
      setAction({ id: null, error: null, success: status === "PASSED" ? "Screening passed. Units moved to available inventory." : "Screening failed. Units moved to discarded status." });
      request.reload();
    } catch (error) {
      setAction({ id: null, error, success: null });
    }
  }

  return (
    <div className="page-stack">
      <PageHeader eyebrow="Blood bank workspace" title="Screening queue" description="Resolve quarantined donations before units can enter the reserveable inventory pool." actions={<Button variant="secondary" onClick={request.reload}>Refresh queue</Button>} />
      {action.success ? <Notice tone="success" title="Screening saved">{action.success}</Notice> : null}
      {action.error ? <Notice tone="error" title="Screening failed">{friendlyError(action.error)}{errorDetails(action.error) ? ` ${errorDetails(action.error)}` : ""}</Notice> : null}
      <SectionCard title="Pending screening" description="Only PENDING donations can transition from quarantine.">
        {request.loading ? <LoadingState label="Loading screening queue" /> : null}{request.error ? <ErrorState error={request.error} onRetry={request.reload} /> : null}{!request.loading && !request.error ? donations.length ? <div className="screening-list">{donations.map((donation) => <div className="screening-row" key={donation.donationId}><div><strong>Donation {donation.donationId?.slice(0, 12)}</strong><span>{formatDateTime(donation.collectedAt)} · {formatNumber(donation.volumeMl)} ml</span></div><div className="card-actions"><Button variant="secondary" size="sm" onClick={() => screen(donation, "FAILED")} disabled={Boolean(action.id)}>Mark failed</Button><Button size="sm" onClick={() => screen(donation, "PASSED")} disabled={Boolean(action.id)}>{action.id === donation.donationId ? "Saving…" : "Mark passed"}</Button></div></div>)}</div> : <EmptyState title="Screening queue is clear">New quarantined donations will appear here.</EmptyState> : null}
      </SectionCard>
    </div>
  );
}

export function BankDispatchPage() {
  const [action, setAction] = useState({ id: null, error: null, success: null });
  const request = useRequest(() => api.reservations.list({ status: "ACTIVE", limit: 100 }), []);
  const reservations = listFrom(request.data, ["reservations"]);

  async function dispatch(reservation) {
    setAction({ id: reservation.reservationId, error: null, success: null });
    try {
      await api.reservations.dispatch(reservation.reservationId, {}, { city: reservation.cityCode });
      setAction({ id: null, error: null, success: "Unit dispatched. The reservation is now in transit." });
      request.reload();
    } catch (error) {
      setAction({ id: null, error, success: null });
    }
  }

  return (
    <div className="page-stack">
      <PageHeader eyebrow="Blood bank workspace" title="Dispatch queue" description="Release active holds for units owned by your bank. The primary shard performs the final state check." actions={<Button variant="secondary" onClick={request.reload}>Refresh queue</Button>} />
      {action.success ? <Notice tone="success" title="Dispatch confirmed">{action.success}</Notice> : null}{action.error ? <Notice tone="error" title="Dispatch failed">{friendlyError(action.error)}{errorDetails(action.error) ? ` ${errorDetails(action.error)}` : ""}</Notice> : null}
      <SectionCard title="Active reservations" description="Dispatch is limited to ACTIVE holds and your bank tenant scope.">
        {request.loading ? <LoadingState label="Loading dispatch queue" /> : null}{request.error ? <ErrorState error={request.error} onRetry={request.reload} /> : null}{!request.loading && !request.error ? reservations.length ? <div className="card-list">{reservations.map((reservation) => <article className="reservation-card" key={reservation.reservationId}><div className="reservation-card-main"><div className="blood-type-mark small">{formatBloodType(reservation.patientBloodGroup, reservation.patientRh)}</div><div><strong>Reservation {reservation.reservationId?.slice(0, 12)}</strong><span>{reservation.cityCode} · hospital {reservation.hospitalId?.slice(0, 12)}</span></div></div><div className="reservation-meta"><div><span>Hold expires</span><strong>{formatDateTime(reservation.holdExpiresAt)}</strong></div><div><span>Status</span><StatusBadge status={reservation.status} /></div></div><div className="card-actions"><Button size="sm" onClick={() => dispatch(reservation)} disabled={Boolean(action.id)}>{action.id === reservation.reservationId ? "Dispatching…" : "Dispatch unit"}</Button></div></article>)}</div> : <EmptyState title="No active reservations">Hospital requests assigned to this bank will appear here.</EmptyState> : null}
      </SectionCard>
    </div>
  );
}

export function BankDiscardPage() {
  const [action, setAction] = useState({ loading: false, error: null, success: null });
  const [selected, setSelected] = useState(null);
  const [reason, setReason] = useState("");
  const request = useRequest(() => api.units.list({ status: "QUARANTINE", limit: 100 }), []);
  const units = listFrom(request.data, ["units", "items"]).map(normalizeResult);

  async function discard() {
    if (!selected) return;
    setAction({ loading: true, error: null, success: null });
    try {
      await api.units.discard(selected.unitId, { reason: reason || undefined });
      setAction({ loading: false, error: null, success: "Unit moved to discarded status." });
      setSelected(null);
      request.reload();
    } catch (error) {
      setAction({ loading: false, error, success: null });
    }
  }

  return (
    <div className="page-stack">
      <PageHeader eyebrow="Blood bank workspace" title="Discard units" description="Quarantine inventory that must not enter the reserveable pool." actions={<Button variant="secondary" onClick={request.reload}>Refresh quarantine</Button>} />
      {action.success ? <Notice tone="success" title="Inventory updated">{action.success}</Notice> : null}
      <SectionCard title="Quarantine units" description="Discard is permitted for QUARANTINE or AVAILABLE units only.">
        {request.loading ? <LoadingState label="Loading quarantine units" /> : null}{request.error ? <ErrorState error={request.error} onRetry={request.reload} /> : null}{!request.loading && !request.error ? <UnitTable units={units} onDiscard={setSelected} emptyTitle="No quarantined units" /> : null}
      </SectionCard>
      <Modal open={Boolean(selected)} title="Discard quarantined unit" onClose={() => setSelected(null)} footer={<><Button variant="ghost" onClick={() => setSelected(null)}>Keep unit</Button><Button variant="danger" onClick={discard} disabled={action.loading}>{action.loading ? "Discarding…" : "Discard unit"}</Button></>}>
        {action.error ? <Notice tone="error" title="Discard failed">{friendlyError(action.error)}{errorDetails(action.error) ? ` ${errorDetails(action.error)}` : ""}</Notice> : null}<p className="modal-copy">This action is checked against the current unit status on the primary shard.</p><Field label="Reason"><textarea rows="3" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Optional reason" /></Field>
      </Modal>
    </div>
  );
}
