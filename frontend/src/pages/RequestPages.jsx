import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { useRequest } from "../hooks/useRequest";
import { BLOOD_GROUPS, CITIES, DONOR_REQUEST_STATUSES, RH_FACTORS, URGENCIES } from "../constants";
import { Button, EmptyState, ErrorState, Field, Icon, LoadingState, Modal, Notice, PageHeader, SectionCard, StatusBadge } from "../components/UI";
import { errorDetails, formatBloodType, formatDateTime, friendlyError, listFrom } from "../utils";
import { hasErrors, maxLength, number, oneOf, required, uuid, validate, useFieldErrors } from "../validation";

const CALLOUT_RULES = {
  donorId: [required("Selected donor"), uuid("Selected donor")],
  cityCode: [required("Donor city shard"), oneOf(CITIES.map((city) => city.cityCode), "Donor city shard")],
  requiredBloodGroup: [required("Required blood group"), oneOf(BLOOD_GROUPS, "Required blood group")],
  requiredRh: [required("Required Rh"), oneOf(RH_FACTORS, "Required Rh")],
  urgency: [required("Urgency"), oneOf(URGENCIES.map((item) => item.value), "Urgency")],
  slotsRequested: [required("Slots"), number({ min: 1, max: 10, integer: true, label: "Slots" })],
  patientRef: [maxLength(120, "Patient reference")],
  notes: [maxLength(1000, "Message to the donor")],
};

function UrgencyBadge({ urgency }) {
  const tone = urgency === "CRITICAL" ? "danger" : urgency === "URGENT" ? "warning" : "neutral";
  return <StatusBadge status={urgency} />;
}

function RequestStatusBadge({ status }) {
  return <StatusBadge status={status} />;
}

function requesterLabel(request) {
  if (request.hospitalName) return request.hospitalName;
  if (request.bloodBankName) return request.bloodBankName;
  return "Unknown requester";
}

function useDebouncedValue(value, delay = 300) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedValue(value), delay);
    return () => window.clearTimeout(timeout);
  }, [value, delay]);

  return debouncedValue;
}

/**
 * Hospital and blood bank view: search the donor directory for someone who can
 * give the requested blood type, send them a call-out, and track what happened.
 */
export function SendDonorRequestsPage() {
  const { user } = useAuth();
  const [filters, setFilters] = useState({ search: "", city: "", bloodGroup: "", rh: "", available: "true" });
  const debouncedSearch = useDebouncedValue(filters.search);
  const [form, setForm] = useState({
    donorId: "",
    cityCode: "",
    requiredBloodGroup: "",
    requiredRh: "POS",
    urgency: "ROUTINE",
    slotsRequested: 1,
    patientRef: "",
    notes: "",
  });
  const [action, setAction] = useState({ loading: false, error: null, success: null });
  const [calloutOpen, setCalloutOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");
  const { errors, setErrors, clearError, clearAll } = useFieldErrors();

  const donors = useRequest(
    () => api.search.donors({ ...filters, search: debouncedSearch.trim() || undefined, limit: 50 }),
    [debouncedSearch, filters.city, filters.bloodGroup, filters.rh, filters.available],
  );
  const donorRows = listFrom(donors.data, ["donors"]);
  const donorIdsKey = donorRows.map((donor) => donor.donorId).join(",");
  const requestStatuses = useRequest(
    () => donorRows.length
      ? api.donorRequests.list({ donorIds: donorRows.map((donor) => donor.donorId), limit: 50 })
      : Promise.resolve({ requests: [] }),
    [donorIdsKey],
  );
  const requests = useRequest(
    () => api.donorRequests.list({ ...(statusFilter ? { status: statusFilter } : {}), limit: 50 }),
    [statusFilter],
  );

  const requestRows = listFrom(requests.data, ["requests"]);
  const latestRequestByDonor = new Map();
  for (const request of listFrom(requestStatuses.data, ["requests"])) {
    const key = `${request.donorCityCode?.trim()}:${request.donorId}`;
    if (!latestRequestByDonor.has(key)) latestRequestByDonor.set(key, request);
  }
  const byStatus = requests.data?.byStatus || {};
  const pendingCount = byStatus.PENDING ?? 0;
  const acceptedCount = byStatus.ACCEPTED ?? 0;
  const declinedCount = byStatus.DECLINED ?? 0;

  const compatibleCount = useMemo(
    () => donorRows.filter((donor) => donor.bloodGroup === form.requiredBloodGroup
      && (form.requiredRh === "POS" ? donor.rhFactor === "POS" || donor.rhFactor === "NEG" : donor.rhFactor === "NEG")).length,
    [donorRows, form.requiredBloodGroup, form.requiredRh],
  );

  function updateFilter(name, value) {
    setFilters((current) => ({ ...current, [name]: value }));
  }

  function update(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
    clearError(name);
  }

  function pickDonor(donor) {
    setForm((current) => ({
      ...current,
      donorId: donor.donorId,
      cityCode: donor.cityCode,
      requiredBloodGroup: donor.bloodGroup,
      requiredRh: donor.rhFactor,
    }));
    clearAll();
    setAction({ loading: false, error: null, success: null });
    setCalloutOpen(true);
  }

  async function submit(event) {
    event.preventDefault();
    const nextErrors = validate(form, CALLOUT_RULES);
    setErrors(nextErrors);
    if (hasErrors(nextErrors)) return;
    setAction({ loading: true, error: null, success: null });
    try {
      const created = await api.donorRequests.create({
        donorId: form.donorId,
        cityCode: form.cityCode,
        requiredBloodGroup: form.requiredBloodGroup,
        requiredRh: form.requiredRh,
        urgency: form.urgency,
        slotsRequested: Number(form.slotsRequested),
        patientRef: form.patientRef || undefined,
        notes: form.notes || undefined,
      });
      setAction({ loading: false, error: null, success: `Call-out sent to ${created.donor.fullName}. They can accept or decline from their donor portal.` });
      setCalloutOpen(false);
      requestStatuses.reload();
      requests.reload();
    } catch (error) {
      setAction({ loading: false, error, success: null });
    }
  }

  async function cancel(requestId) {
    setAction({ loading: true, error: null, success: null });
    try {
      await api.donorRequests.cancel(requestId);
      setAction({ loading: false, error: null, success: "Call-out cancelled." });
      requests.reload();
    } catch (error) {
      setAction({ loading: false, error, success: null });
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={user?.role === "HOSPITAL_ADMIN" ? "Hospital workspace" : "Blood bank workspace"}
        title="Donor call-outs"
        description="Search the donor directory, then ask a specific donor to give blood. The donor accepts or declines from their own portal."
        actions={<Button variant="secondary" onClick={() => { requests.reload(); requestStatuses.reload(); }} disabled={requests.loading || requestStatuses.loading}>Refresh requests</Button>}
      />

      <SectionCard title="Step 1 · Find a donor" description="Donors are held in per-city shards. Narrow by group if you need a specific type.">
        <div className="form-grid">
          <Field label="Search donors">
            <span className="search-input-wrap">
              <Icon name="search" size={17} />
              <input value={filters.search} onChange={(event) => updateFilter("search", event.target.value)} placeholder="Name, phone, or donor ID" />
            </span>
          </Field>
          <Field label="City shard">
            <select value={filters.city} onChange={(event) => updateFilter("city", event.target.value)}>
              <option value="">All cities</option>
              {CITIES.map((item) => <option key={item.cityCode} value={item.cityCode}>{item.cityCode} · {item.name}</option>)}
            </select>
          </Field>
          <Field label="Blood group">
            <select value={filters.bloodGroup} onChange={(event) => updateFilter("bloodGroup", event.target.value)}>
              <option value="">Any group</option>
              {BLOOD_GROUPS.map((group) => <option key={group} value={group}>{group}</option>)}
            </select>
          </Field>
          <Field label="Rh factor">
            <select value={filters.rh} onChange={(event) => updateFilter("rh", event.target.value)}>
              <option value="">Any factor</option>
              {RH_FACTORS.map((factor) => <option key={factor} value={factor}>{factor === "POS" ? "Positive" : "Negative"}</option>)}
            </select>
          </Field>
          <Field label="Availability">
            <select value={filters.available} onChange={(event) => updateFilter("available", event.target.value)}>
              <option value="true">Available only</option>
              <option value="">Any availability</option>
            </select>
          </Field>
        </div>
      </SectionCard>

      <SectionCard title="Matching donors" description="Click a row to select that donor for a call-out.">
        {donors.loading ? <LoadingState label="Searching donors" /> : null}
        {donors.error ? <ErrorState error={donors.error} onRetry={donors.reload} /> : null}
        {requestStatuses.error ? <ErrorState error={requestStatuses.error} onRetry={requestStatuses.reload} /> : null}
        {!donors.loading && !donors.error ? donorRows.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Donor</th><th>Blood type</th><th>City</th><th>Availability</th><th>Last donation</th><th>Phone</th><th>Call-out</th><th className="table-actions-head">Action</th></tr></thead>
              <tbody>
                {donorRows.map((donor) => {
                  const request = latestRequestByDonor.get(`${donor.cityCode}:${donor.donorId}`);
                  const pending = request?.status === "PENDING";
                  const answeredStatus = request?.status === "ACCEPTED" || request?.status === "DECLINED";
                  const label = pending
                    ? "Request sent"
                    : request?.status === "ACCEPTED"
                      ? "Accepted"
                      : request?.status === "DECLINED"
                        ? "Rejected"
                        : requestStatuses.loading
                          ? "Checking…"
                          : form.donorId === donor.donorId
                            ? "Selected"
                            : "Select";
                  const message = pending
                    ? "Request sent — waiting for donor"
                    : request?.status === "ACCEPTED"
                      ? "Donor accepted this call-out"
                      : request?.status === "DECLINED"
                        ? "Donor rejected this call-out"
                        : null;
                  return (
                    <tr key={donor.donorId} className={form.donorId === donor.donorId ? "row-selected" : ""}>
                      <td><strong>{donor.fullName}</strong></td>
                      <td>{formatBloodType(donor.bloodGroup, donor.rhFactor)}</td>
                      <td>{donor.cityCode}</td>
                      <td><StatusBadge status={donor.isAvailable ? "AVAILABLE" : "UNAVAILABLE"} /></td>
                      <td>{donor.lastDonationDate || "—"}</td>
                      <td className="mono-text">{donor.phone || "—"}</td>
                      <td>{message || "—"}</td>
                      <td>
                        <Button
                          size="sm"
                          variant={form.donorId === donor.donorId ? "primary" : "secondary"}
                          onClick={() => pickDonor(donor)}
                          disabled={!donor.isAvailable || pending || answeredStatus || requestStatuses.loading || requestStatuses.error}
                        >
                          {label}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <EmptyState title="No donors matched">Loosen the filters, or ask donors to sign up in your city.</EmptyState> : null}
      </SectionCard>

      <Modal
        open={calloutOpen}
        title={`Send call-out to ${donorRows.find((donor) => donor.donorId === form.donorId)?.fullName || "selected donor"}`}
        onClose={() => { if (!action.loading) setCalloutOpen(false); }}
        className="modal-wide"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCalloutOpen(false)} disabled={action.loading}>Cancel</Button>
            <Button type="submit" form="donor-callout-form" disabled={action.loading || !form.donorId || requestStatuses.loading || requestStatuses.error || latestRequestByDonor.get(`${form.cityCode}:${form.donorId}`)?.status === "PENDING"}>
              {action.loading ? "Sending…" : latestRequestByDonor.get(`${form.cityCode}:${form.donorId}`)?.status === "PENDING" ? "Request sent" : "Send call-out"}
            </Button>
          </>
        }
      >
        <form id="donor-callout-form" className="stack-form" noValidate onSubmit={submit}>
          <div className="form-grid form-grid-two">
            <Field label="Selected donor" error={errors.donorId}>
              <input readOnly value={donorRows.find((donor) => donor.donorId === form.donorId)?.fullName || form.donorId} className="mono-text" />
            </Field>
            <Field label="Donor city shard" error={errors.cityCode}>
              <input readOnly value={form.cityCode} className="mono-text" />
            </Field>
          </div>
          <div className="form-grid form-grid-four">
            <Field label="Required blood group" hint="Required" error={errors.requiredBloodGroup}>
              <select value={form.requiredBloodGroup} onChange={(event) => update("requiredBloodGroup", event.target.value)}>
                <option value="">Select</option>
                {BLOOD_GROUPS.map((group) => <option key={group} value={group}>{group}</option>)}
              </select>
            </Field>
            <Field label="Required Rh" hint="Required" error={errors.requiredRh}>
              <select value={form.requiredRh} onChange={(event) => update("requiredRh", event.target.value)}>
                {RH_FACTORS.map((factor) => <option key={factor} value={factor}>{factor === "POS" ? "Positive" : "Negative"}</option>)}
              </select>
            </Field>
            <Field label="Urgency" error={errors.urgency}>
              <select value={form.urgency} onChange={(event) => update("urgency", event.target.value)}>
                {URGENCIES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </Field>
            <Field label="Slots" hint="1 to 10" error={errors.slotsRequested}>
              <input type="number" min={1} max={10} value={form.slotsRequested} onChange={(event) => update("slotsRequested", event.target.value)} />
            </Field>
          </div>
          <Field label="Patient reference" hint="Optional, internal only" error={errors.patientRef}>
            <input value={form.patientRef} onChange={(event) => update("patientRef", event.target.value)} placeholder="e.g. Bed 12, ICU-3" />
          </Field>
          <Field label="Message to the donor" hint="Optional" error={errors.notes}>
            <textarea rows={3} value={form.notes} onChange={(event) => update("notes", event.target.value)} placeholder="Explain where and when to come in." />
          </Field>
          {form.requiredBloodGroup ? <span className="field-hint">{compatibleCount} of the listed donors can donate to this exact type.</span> : null}
          {latestRequestByDonor.get(`${form.cityCode}:${form.donorId}`)?.status === "PENDING" ? <span className="field-hint">Request sent. The donor must accept or reject it before another call-out can be sent.</span> : null}
          {action.error ? <Notice tone="error" title="Could not send call-out">{friendlyError(action.error)}{errorDetails(action.error) ? ` ${JSON.stringify(errorDetails(action.error))}` : ""}</Notice> : null}
        </form>
      </Modal>

      {action.success ? <Notice tone="success" title="Call-out update">{action.success}</Notice> : null}

      <SectionCard title="Sent call-outs" description="Everything your facility has asked for, and how the donor responded.">
        <div className="form-grid form-grid-two">
          <Field label="Status">
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              {DONOR_REQUEST_STATUSES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </Field>
        </div>
        {requests.loading ? <LoadingState label="Loading call-outs" /> : null}
        {requests.error ? <ErrorState error={requests.error} onRetry={requests.reload} /> : null}
        {!requests.loading && !requests.error ? (
          <>
            <div className="stat-grid">
              <div className="stat-card stat-card-amber"><span>Awaiting donor</span><strong>{pendingCount}</strong><small>No response yet</small></div>
              <div className="stat-card stat-card-green"><span>Accepted</span><strong>{acceptedCount}</strong><small>Donor said yes</small></div>
              <div className="stat-card stat-card-red"><span>Rejected</span><strong>{declinedCount}</strong><small>Donor said no</small></div>
              <div className="stat-card stat-card-blue"><span>Total listed</span><strong>{requestRows.length}</strong><small>Matching the filter</small></div>
            </div>
            {requestRows.length ? (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>Donor</th><th>Needed</th><th>Donor type</th><th>Urgency</th><th>Status</th><th>Sent</th><th>Responded</th><th>Note</th><th className="table-actions-head">Action</th></tr></thead>
                  <tbody>
                    {requestRows.map((request) => (
                      <tr key={request.requestId}>
                        <td><strong>{request.donorName}</strong><small className="cell-sub">{requesterLabel(request)}</small></td>
                        <td>{formatBloodType(request.requiredBloodGroup, request.requiredRh)} × {request.slotsRequested}</td>
                        <td>{formatBloodType(request.donorBloodGroup, request.donorRhFactor)}</td>
                        <td><UrgencyBadge urgency={request.urgency} /></td>
                        <td><RequestStatusBadge status={request.status} /></td>
                        <td>{formatDateTime(request.requestedAt)}</td>
                        <td>{request.respondedAt ? formatDateTime(request.respondedAt) : "—"}</td>
                        <td>{request.responseNotes || (request.status === "PENDING" ? "Request sent — waiting for donor." : request.status === "ACCEPTED" ? "Donor accepted this request." : request.status === "DECLINED" ? "Donor rejected this request." : request.notes) || "—"}</td>
                        <td>{request.status === "PENDING" ? <Button size="sm" variant="danger" onClick={() => cancel(request.requestId)} disabled={action.loading}>Cancel</Button> : <span className="cell-sub">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <EmptyState title="No call-outs yet">Send your first one using the form above.</EmptyState>}
          </>
        ) : null}
      </SectionCard>
    </div>
  );
}

/**
 * Donor view: incoming call-outs addressed to this donor, with the two actions
 * the donor is allowed to take.
 */
export function MyDonorRequestsPage() {
  const [notes, setNotes] = useState({});
  const [action, setAction] = useState({ loadingId: null, error: null, success: null });
  const requests = useRequest(() => api.donorRequests.list({ limit: 50 }), []);

  const requestRows = listFrom(requests.data, ["requests"]);
  const pending = requestRows.filter((item) => item.status === "PENDING");
  const answered = requestRows.filter((item) => item.status !== "PENDING");
  const byStatus = requests.data?.byStatus || {};

  async function respond(requestId, response) {
    const note = notes[requestId]?.trim() || "";
    if (note.length > 500) {
      setAction({ loadingId: null, error: new Error("Reply note must be at most 500 characters."), success: null });
      return;
    }
    setAction({ loadingId: requestId, error: null, success: null });
    try {
      await api.donorRequests.respond(requestId, {
        response,
        responseNotes: note || undefined,
      });
      setAction({
        loadingId: null,
        error: null,
        success: response === "ACCEPTED"
          ? "You accepted this call-out. The facility will contact you to confirm the slot."
          : "You declined this call-out.",
      });
      requests.reload();
      window.dispatchEvent(new Event("donor-requests-updated"));
    } catch (error) {
      setAction({ loadingId: null, error, success: null });
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Donor workspace"
        title="Blood requests"
        description="Hospitals and blood banks can ask you directly to donate. Accept what you can manage and decline the rest."
        actions={<Button variant="secondary" onClick={requests.reload} disabled={requests.loading}>Refresh</Button>}
      />

      {action.success ? <Notice tone="success" title="Response recorded">{action.success}</Notice> : null}
      {action.error ? <Notice tone="error" title="Could not record your response">{friendlyError(action.error)}{errorDetails(action.error) ? ` ${JSON.stringify(errorDetails(action.error))}` : ""}</Notice> : null}

      <div className="stat-grid">
        <div className="stat-card stat-card-amber"><span>Waiting on you</span><strong>{pending.length}</strong><small>Need a response</small></div>
        <div className="stat-card stat-card-green"><span>Accepted</span><strong>{byStatus.ACCEPTED ?? 0}</strong><small>You said yes</small></div>
        <div className="stat-card stat-card-blue"><span>Declined</span><strong>{byStatus.DECLINED ?? 0}</strong><small>You said no</small></div>
        <div className="stat-card stat-card-slate"><span>Total received</span><strong>{requestRows.length}</strong><small>All time</small></div>
      </div>

      <SectionCard title="Needs your response" description="These facilities are waiting to hear from you.">
        {requests.loading ? <LoadingState label="Loading requests" /> : null}
        {requests.error ? <ErrorState error={requests.error} onRetry={requests.reload} /> : null}
        {!requests.loading && !requests.error ? (
          pending.length ? (
            <div className="callout-grid">
              {pending.map((request) => (
                <article className="callout-card" key={request.requestId}>
                  <div className="callout-card-top">
                    <div>
                      <strong>{requesterLabel(request)}</strong>
                      <small className="cell-sub">{requesterLabel(request) && (request.hospitalName ? "Hospital" : "Blood bank")} · {request.donorCityCode} shard</small>
                    </div>
                    <UrgencyBadge urgency={request.urgency} />
                  </div>
                  <dl className="callout-facts">
                    <div><dt>Blood needed</dt><dd>{formatBloodType(request.requiredBloodGroup, request.requiredRh)}</dd></div>
                    <div><dt>Slots</dt><dd>{request.slotsRequested}</dd></div>
                    <div><dt>Sent</dt><dd>{formatDateTime(request.requestedAt)}</dd></div>
                    {request.patientRef ? <div><dt>Reference</dt><dd>{request.patientRef}</dd></div> : null}
                  </dl>
                  {request.notes ? <p className="callout-note">{request.notes}</p> : null}
                  <Field label="Reply note" hint="Optional">
                    <input maxLength={500} value={notes[request.requestId] || ""} onChange={(event) => setNotes((current) => ({ ...current, [request.requestId]: event.target.value }))} placeholder="e.g. I can come in tomorrow morning" />
                  </Field>
                  <div className="button-pair">
                    <Button onClick={() => respond(request.requestId, "ACCEPTED")} disabled={action.loadingId === request.requestId}>{action.loadingId === request.requestId ? "Sending…" : "Accept"}</Button>
                    <Button variant="secondary" onClick={() => respond(request.requestId, "DECLINED")} disabled={action.loadingId === request.requestId}>Decline</Button>
                  </div>
                </article>
              ))}
            </div>
          ) : <EmptyState title="Nothing needs your response">When a hospital or blood bank asks you to donate, it will appear here.</EmptyState>
        ) : null}
      </SectionCard>

      <SectionCard title="Past responses" description="Call-outs you have already answered or that were withdrawn.">
        {answered.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Requester</th><th>Blood needed</th><th>Urgency</th><th>Status</th><th>Sent</th><th>Responded</th><th>Your note</th></tr></thead>
              <tbody>
                {answered.map((request) => (
                  <tr key={request.requestId}>
                    <td><strong>{requesterLabel(request)}</strong></td>
                    <td>{formatBloodType(request.requiredBloodGroup, request.requiredRh)}</td>
                    <td><UrgencyBadge urgency={request.urgency} /></td>
                    <td><RequestStatusBadge status={request.status} /></td>
                    <td>{formatDateTime(request.requestedAt)}</td>
                    <td>{request.respondedAt ? formatDateTime(request.respondedAt) : "—"}</td>
                    <td>{request.responseNotes || (request.status === "ACCEPTED" ? "You accepted this request." : request.status === "DECLINED" ? "You rejected this request." : "—")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState title="No past responses yet">Answered call-outs will be listed here.</EmptyState>}
      </SectionCard>
    </div>
  );
}
