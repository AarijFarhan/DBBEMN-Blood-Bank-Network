import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { useRequest } from "../hooks/useRequest";
import { BLOOD_GROUPS, COMPONENTS, RH_FACTORS, RESERVATION_STATUSES } from "../constants";
import { Button, EmptyState, ErrorState, Field, LoadingState, Modal, Notice, PageHeader, PartialResults, SectionCard, SimulatedBadge, StatusBadge } from "../components/UI";
import { createRequestId, errorDetails, formatBloodType, formatComponent, formatDate, formatDateTime, formatNumber, friendlyError, listFrom, normalizeResult } from "../utils";

function UnitResult({ unit, onReserve, busy }) {
  const type = formatBloodType(unit.bloodGroup, unit.rhFactor);
  return (
    <article className="result-card">
      <div className="result-card-top">
        <div className="blood-type-mark">{type}</div>
        <div>
          <strong>{formatComponent(unit.componentType)}</strong>
          <span>{unit.bankName || "Blood bank"} · {unit.cityCode || "Network"}</span>
        </div>
        <StatusBadge status={unit.status || "AVAILABLE"} />
      </div>
      <div className="result-metrics">
        <div><span>Volume</span><strong>{formatNumber(unit.volumeMl)} ml</strong></div>
        <div><span>Expires</span><strong>{formatDate(unit.expiryDate)}</strong></div>
        <div><span>Distance</span><strong>{unit.distanceKm === undefined || unit.distanceKm === null ? "—" : `${Number(unit.distanceKm).toFixed(1)} km`}</strong></div>
      </div>
      <div className="result-card-footer">
        <span className="muted-text">Advisory availability · reserve re-checks the primary shard</span>
        <Button size="sm" onClick={() => onReserve(unit)} disabled={busy}>Reserve unit</Button>
      </div>
    </article>
  );
}

export function HospitalSearchPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ patientBloodGroup: "O", patientRh: "NEG", component: "PRBC", unitsNeeded: 1, urgency: "URGENT", allowPartial: false, searchScope: "ALL_CITIES" });
  const [state, setState] = useState({ loading: false, error: null, data: null });
  const [action, setAction] = useState({ id: null, error: null, success: null });
  const hospitalId = user?.hospitalId;
  const results = useMemo(() => listFrom(state.data, ["units", "results", "items"]).map(normalizeResult), [state.data]);
  const meta = state.data?.meta || null;

  function update(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function search(event) {
    event.preventDefault();
    setState({ loading: true, error: null, data: null });
    setAction({ id: null, error: null, success: null });
    try {
      const data = await api.search.units({
        component: form.component,
        compatibleWith: `${form.patientBloodGroup}${form.patientRh === "POS" ? "+" : "-"}`,
        fromHospitalId: hospitalId,
        limit: 50,
        sortBy: "expiryDate",
        order: "asc",
      });
      setState({ loading: false, error: null, data });
    } catch (error) {
      setState({ loading: false, error, data: null });
    }
  }

  async function reserveUnits(event) {
    event.preventDefault();
    if (!hospitalId) {
      setAction({ id: "auto", error: new Error("Your account is not assigned to a hospital."), success: null });
      return;
    }
    setAction({ id: "auto", error: null, success: null });
    try {
      const result = await api.reservations.create({
        requestId: createRequestId(),
        hospitalId,
        patientBloodGroup: form.patientBloodGroup,
        patientRh: form.patientRh,
        component: form.component,
        unitsNeeded: Number(form.unitsNeeded),
        urgency: form.urgency,
        allowPartial: form.allowPartial,
        searchScope: form.searchScope,
      });
      setAction({ id: null, error: null, success: `Reserved ${listFrom(result, ["reservations"]).length} unit(s).` });
      setState((current) => ({ ...current, data: { ...(current.data || {}), reservations: result.reservations || [] } }));
    } catch (error) {
      setAction({ id: null, error, success: null });
    }
  }

  async function reserveOne(unit) {
    if (!hospitalId || !unit.unitId) return;
    setAction({ id: unit.unitId, error: null, success: null });
    try {
      await api.units.reserve(unit.unitId, {
        requestId: createRequestId(),
        hospitalId,
        patientBloodGroup: form.patientBloodGroup,
        patientRh: form.patientRh,
        component: form.component,
        urgency: form.urgency,
      }, { city: unit.cityCode });
      setAction({ id: null, error: null, success: "Unit reserved. It is now held for your hospital." });
    } catch (error) {
      setAction({ id: null, error, success: null });
    }
  }

  return (
    <div className="page-stack">
      <PageHeader eyebrow="Hospital workspace" title="Find compatible blood" description="Search the network, compare available units, and reserve with a primary-shard confirmation." actions={<Button variant="secondary" onClick={() => navigate("/app/hospital/reservations")}>View reservations</Button>} />
      {action.success ? <Notice tone="success" title="Reservation confirmed">{action.success}</Notice> : null}
      {action.error ? <Notice tone="error" title="Reservation could not be completed">{friendlyError(action.error)}{errorDetails(action.error) ? ` ${errorDetails(action.error)}` : ""}</Notice> : null}
      <div className="workspace-grid workspace-grid-wide">
        <SectionCard title="Emergency request" description="Use a unique request for each new allocation attempt.">
          <form className="stack-form" onSubmit={search}>
            <div className="form-grid form-grid-two">
              <Field label="Patient ABO group"><select value={form.patientBloodGroup} onChange={(event) => update("patientBloodGroup", event.target.value)}>{BLOOD_GROUPS.map((value) => <option key={value}>{value}</option>)}</select></Field>
              <Field label="Rh factor"><select value={form.patientRh} onChange={(event) => update("patientRh", event.target.value)}>{RH_FACTORS.map((value) => <option key={value} value={value}>{value === "POS" ? "Positive" : "Negative"}</option>)}</select></Field>
            </div>
            <div className="form-grid form-grid-two">
              <Field label="Component"><select value={form.component} onChange={(event) => update("component", event.target.value)}>{COMPONENTS.map((value) => <option key={value.value} value={value.value}>{value.label}</option>)}</select></Field>
              <Field label="Urgency"><select value={form.urgency} onChange={(event) => update("urgency", event.target.value)}><option value="CRITICAL">Critical · 60 minute hold</option><option value="URGENT">Urgent · 30 minute hold</option><option value="ROUTINE">Routine · 30 minute hold</option></select></Field>
            </div>
            <div className="form-grid form-grid-two">
              <Field label="Units needed"><input type="number" min="1" max="10" value={form.unitsNeeded} onChange={(event) => update("unitsNeeded", event.target.value)} /></Field>
              <Field label="Search scope"><select value={form.searchScope} onChange={(event) => update("searchScope", event.target.value)}><option value="ALL_CITIES">All cities · ranked</option><option value="LOCAL_FIRST">Local city first</option></select></Field>
            </div>
            <label className="checkbox-field checkbox-field-inline"><input type="checkbox" checked={form.allowPartial} onChange={(event) => update("allowPartial", event.target.checked)} /><span><strong>Allow partial fulfillment</strong><small>Keep available matches if one or more city shards cannot satisfy the full request.</small></span></label>
            <Button type="submit" disabled={state.loading}>{state.loading ? "Searching network…" : "Search available units"}</Button>
          </form>
        </SectionCard>
        <SectionCard title="Reserve from results" description="Reserve the ranked results directly, or use the request settings to auto-allocate.">
          <div className="reserve-action-panel">
            <div className="reserve-summary"><span className="summary-orb">{formatBloodType(form.patientBloodGroup, form.patientRh)}</span><div><strong>{formatComponent(form.component)}</strong><span>{form.unitsNeeded} unit{Number(form.unitsNeeded) === 1 ? "" : "s"} · {form.urgency.toLowerCase()}</span></div></div>
            <Button onClick={reserveUnits} disabled={Boolean(action.id)}>{action.id === "auto" ? "Reserving…" : "Auto-reserve request"}</Button>
            <p className="fine-print">Auto-reserve sends a new idempotency key each time. A retry after a network interruption should reuse the original request ID.</p>
          </div>
        </SectionCard>
      </div>
      <SectionCard title="Network results" description="Availability is advisory; the reservation transaction is authoritative." action={state.data ? <span className="data-count">{results.length} result{results.length === 1 ? "" : "s"}</span> : null}>
        {state.loading ? <LoadingState label="Searching city shards" /> : null}
        {state.error ? <ErrorState error={state.error} onRetry={search} /> : null}
        {!state.loading && !state.error && state.data ? <>
          <PartialResults meta={meta} />
          {meta?.source?.includes("SIMULATED") || meta?.source === "PRIMARY_FALLBACK" ? <div className="source-line"><SimulatedBadge /> <span>Source: {meta.source || "network read model"}</span></div> : null}
          {results.length ? <div className="result-grid">{results.map((unit) => <UnitResult key={unit.unitId || unit.id} unit={unit} onReserve={reserveOne} busy={Boolean(action.id)} />)}</div> : <EmptyState title="No matching units">Try a wider search scope or return after a nearby unit is released.</EmptyState>}
        </> : null}
        {!state.loading && !state.error && !state.data ? <EmptyState title="Search the network to begin">Set a patient profile and component to see ranked, FEFO-ordered matches.</EmptyState> : null}
      </SectionCard>
    </div>
  );
}

function ReservationCard({ reservation, onCancel, onTransfuse }) {
  const canCancel = ["ACTIVE", "DISPATCHED"].includes(reservation.status);
  const canTransfuse = reservation.status === "DISPATCHED";
  return (
    <article className="reservation-card">
      <div className="reservation-card-main">
        <div className="blood-type-mark small">{formatBloodType(reservation.patientBloodGroup, reservation.patientRh)}</div>
        <div><strong>{formatComponent(reservation.component || reservation.componentType)}</strong><span>{reservation.cityCode || "Network"} · {reservation.unitId?.slice(0, 8) || "Unit pending"}</span></div>
      </div>
      <div className="reservation-meta"><div><span>Status</span><StatusBadge status={reservation.status} /></div><div><span>Hold expires</span><strong>{formatDateTime(reservation.holdExpiresAt)}</strong></div><div><span>Reserved</span><strong>{formatDateTime(reservation.reservedAt)}</strong></div></div>
      {canCancel || canTransfuse ? <div className="card-actions">{canCancel ? <Button variant="secondary" size="sm" onClick={() => onCancel(reservation)}>Cancel</Button> : null}{canTransfuse ? <Button size="sm" onClick={() => onTransfuse(reservation)}>Confirm transfusion</Button> : null}</div> : null}
    </article>
  );
}

export function HospitalReservationsPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState(null);
  const [modal, setModal] = useState(null);
  const [reason, setReason] = useState("");
  const [patientRef, setPatientRef] = useState("");
  const [actionState, setActionState] = useState({ loading: false, error: null, success: null });
  const request = useReservationList(status, user?.hospitalId);
  const reservations = request.data?.reservations || [];

  function openCancel(reservation) {
    setSelected(reservation);
    setReason("");
    setActionState({ loading: false, error: null, success: null });
    setModal("cancel");
  }

  function openTransfuse(reservation) {
    setSelected(reservation);
    setPatientRef("");
    setActionState({ loading: false, error: null, success: null });
    setModal("transfuse");
  }

  async function completeAction() {
    if (!selected) return;
    setActionState({ loading: true, error: null, success: null });
    try {
      if (modal === "cancel") {
        await api.reservations.cancel(selected.reservationId, { reason: reason || undefined }, { city: selected.cityCode });
        setActionState({ loading: false, error: null, success: "Reservation cancelled and the unit returned through the state machine." });
      } else {
        await api.reservations.transfuse(selected.reservationId, { patientRef }, { city: selected.cityCode });
        setActionState({ loading: false, error: null, success: "Transfusion confirmed. The unit is now terminal." });
      }
      setModal(null);
      request.reload();
    } catch (error) {
      setActionState({ loading: false, error, success: null });
    }
  }

  return (
    <div className="page-stack">
      <PageHeader eyebrow="Hospital workspace" title="Reservations" description="Monitor holds, cancellations, and completed transfusions for your hospital." />
      {actionState.success ? <Notice tone="success" title="Reservation updated">{actionState.success}</Notice> : null}
      <SectionCard title="Reservation ledger" description="Only reservations within your hospital scope are shown." action={<select className="compact-select" value={status} onChange={(event) => setStatus(event.target.value)}>{RESERVATION_STATUSES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>}>
        {request.loading ? <LoadingState label="Loading reservations" /> : null}
        {request.error ? <ErrorState error={request.error} onRetry={request.reload} /> : null}
        {!request.loading && !request.error ? reservations.length ? <div className="card-list">{reservations.map((reservation) => <ReservationCard key={reservation.reservationId} reservation={reservation} onCancel={openCancel} onTransfuse={openTransfuse} />)}</div> : <EmptyState title="No reservations in this view">Completed requests and released holds will appear here.</EmptyState> : null}
      </SectionCard>
      <Modal open={Boolean(modal)} title={modal === "cancel" ? "Cancel reservation" : "Confirm transfusion"} onClose={() => setModal(null)} footer={<><Button variant="ghost" onClick={() => setModal(null)}>Keep open</Button><Button variant={modal === "cancel" ? "danger" : "primary"} onClick={completeAction} disabled={actionState.loading || (modal === "transfuse" && !patientRef.trim())}>{actionState.loading ? "Saving…" : modal === "cancel" ? "Cancel reservation" : "Confirm transfusion"}</Button></>}>
        {actionState.error ? <Notice tone="error" title="Action failed">{friendlyError(actionState.error)}{errorDetails(actionState.error) ? ` ${errorDetails(actionState.error)}` : ""}</Notice> : null}
        {modal === "cancel" ? <Field label="Reason" hint="Optional. The reason is stored with the reservation audit."><textarea rows="3" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason for cancellation" /></Field> : <Field label="Patient reference" hint="Use a pseudonymous reference, never a patient name."><input required value={patientRef} onChange={(event) => setPatientRef(event.target.value)} placeholder="Pseudonymous patient reference" /></Field>}
      </Modal>
    </div>
  );
}

function useReservationList(status, hospitalId) {
  return useRequest(() => api.reservations.list({ hospitalId, status: status || undefined, limit: 100 }), [status, hospitalId]);
}
