import { useMemo, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { useRequest } from "../hooks/useRequest";
import { BLOOD_GROUPS, CITIES, DONOR_REQUEST_STATUSES, RH_FACTORS, URGENCIES } from "../constants";
import { Button, EmptyState, ErrorState, Field, LoadingState, Notice, PageHeader, SectionCard, StatusBadge } from "../components/UI";
import { errorDetails, formatBloodType, formatDateTime, friendlyError, listFrom } from "../utils";

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

/**
 * Hospital and blood bank view: search the donor directory for someone who can
 * give the requested blood type, send them a call-out, and track what happened.
 */
export function SendDonorRequestsPage() {
  const { user } = useAuth();
  const [filters, setFilters] = useState({ city: "", bloodGroup: "", rh: "", available: "true" });
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
  const [statusFilter, setStatusFilter] = useState("");

  const donors = useRequest(
    () => api.search.donors({ ...filters, limit: 50 }),
    [filters.city, filters.bloodGroup, filters.rh, filters.available],
  );
  const requests = useRequest(
    () => api.donorRequests.list({ ...(statusFilter ? { status: statusFilter } : {}), limit: 100 }),
    [statusFilter],
  );

  const donorRows = listFrom(donors.data, ["donors"]);
  const requestRows = listFrom(requests.data, ["requests"]);
  const byStatus = requests.data?.byStatus || {};
  const pendingCount = byStatus.PENDING ?? 0;
  const acceptedCount = byStatus.ACCEPTED ?? 0;

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
  }

  function pickDonor(donor) {
    setForm((current) => ({
      ...current,
      donorId: donor.donorId,
      cityCode: donor.cityCode,
      requiredBloodGroup: donor.bloodGroup,
      requiredRh: donor.rhFactor,
    }));
    setAction({ loading: false, error: null, success: `Selected ${donor.fullName} (${formatBloodType(donor.bloodGroup, donor.rhFactor)}). Fill the details and send.` });
  }

  async function submit(event) {
    event.preventDefault();
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
      setForm({ donorId: "", cityCode: "", requiredBloodGroup: "", requiredRh: "POS", urgency: "ROUTINE", slotsRequested: 1, patientRef: "", notes: "" });
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
        actions={<Button variant="secondary" onClick={requests.reload} disabled={requests.loading}>Refresh requests</Button>}
      />

      <SectionCard title="Step 1 · Find a donor" description="Donors are held in per-city shards. Narrow by group if you need a specific type.">
        <div className="form-grid form-grid-four">
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
        {!donors.loading && !donors.error ? donorRows.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Donor</th><th>Blood type</th><th>City</th><th>Availability</th><th>Last donation</th><th>Phone</th><th className="table-actions-head">Action</th></tr></thead>
              <tbody>
                {donorRows.map((donor) => (
                  <tr key={donor.donorId} className={form.donorId === donor.donorId ? "row-selected" : ""}>
                    <td><strong>{donor.fullName}</strong></td>
                    <td>{formatBloodType(donor.bloodGroup, donor.rhFactor)}</td>
                    <td>{donor.cityCode}</td>
                    <td><StatusBadge status={donor.isAvailable ? "AVAILABLE" : "UNAVAILABLE"} /></td>
                    <td>{donor.lastDonationDate || "—"}</td>
                    <td className="mono-text">{donor.phone || "—"}</td>
                    <td><Button size="sm" variant={form.donorId === donor.donorId ? "primary" : "secondary"} onClick={() => pickDonor(donor)} disabled={!donor.isAvailable}>{form.donorId === donor.donorId ? "Selected" : "Select"}</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState title="No donors matched">Loosen the filters, or ask donors to sign up in your city.</EmptyState> : null}
      </SectionCard>

      <SectionCard title="Step 2 · Send the call-out" description="The requested blood type must be one the selected donor can actually give.">
        <form className="stack-form" onSubmit={submit}>
          <div className="form-grid form-grid-two">
            <Field label="Selected donor" hint={form.donorId ? undefined : "Pick a donor above"}>
              <input required readOnly value={form.donorId} placeholder="No donor selected" className="mono-text" />
            </Field>
            <Field label="Donor city shard">
              <input required readOnly value={form.cityCode} placeholder="Set when you select a donor" className="mono-text" />
            </Field>
          </div>
          <div className="form-grid form-grid-four">
            <Field label="Required blood group" hint="Required">
              <select required value={form.requiredBloodGroup} onChange={(event) => update("requiredBloodGroup", event.target.value)}>
                <option value="">Select</option>
                {BLOOD_GROUPS.map((group) => <option key={group} value={group}>{group}</option>)}
              </select>
            </Field>
            <Field label="Required Rh" hint="Required">
              <select required value={form.requiredRh} onChange={(event) => update("requiredRh", event.target.value)}>
                {RH_FACTORS.map((factor) => <option key={factor} value={factor}>{factor === "POS" ? "Positive" : "Negative"}</option>)}
              </select>
            </Field>
            <Field label="Urgency">
              <select value={form.urgency} onChange={(event) => update("urgency", event.target.value)}>
                {URGENCIES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </Field>
            <Field label="Slots" hint="1 to 10">
              <input type="number" min={1} max={10} value={form.slotsRequested} onChange={(event) => update("slotsRequested", event.target.value)} />
            </Field>
          </div>
          <Field label="Patient reference" hint="Optional, internal only">
            <input value={form.patientRef} onChange={(event) => update("patientRef", event.target.value)} placeholder="e.g. Bed 12, ICU-3" />
          </Field>
          <Field label="Message to the donor" hint="Optional">
            <textarea rows={3} value={form.notes} onChange={(event) => update("notes", event.target.value)} placeholder="Explain where and when to come in." />
          </Field>
          {form.requiredBloodGroup ? <span className="field-hint">{compatibleCount} of the listed donors can donate to this exact type.</span> : null}
          <Button type="submit" disabled={action.loading || !form.donorId}>{action.loading ? "Sending…" : "Send call-out"}</Button>
          {!form.donorId ? <span className="field-hint">Select a donor from the table above to enable sending.</span> : null}
          {action.success ? <Notice tone="success" title="Call-out sent">{action.success}</Notice> : null}
          {action.error ? <Notice tone="error" title="Could not send call-out">{friendlyError(action.error)}{errorDetails(action.error) ? ` ${JSON.stringify(errorDetails(action.error))}` : ""}</Notice> : null}
        </form>
      </SectionCard>

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
                        <td>{request.responseNotes || request.notes || "—"}</td>
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
  const requests = useRequest(() => api.donorRequests.list({ limit: 100 }), []);

  const requestRows = listFrom(requests.data, ["requests"]);
  const pending = requestRows.filter((item) => item.status === "PENDING");
  const answered = requestRows.filter((item) => item.status !== "PENDING");
  const byStatus = requests.data?.byStatus || {};

  async function respond(requestId, response) {
    setAction({ loadingId: requestId, error: null, success: null });
    try {
      await api.donorRequests.respond(requestId, {
        response,
        responseNotes: notes[requestId]?.trim() || undefined,
      });
      setAction({
        loadingId: null,
        error: null,
        success: response === "ACCEPTED"
          ? "You accepted this call-out. The facility will contact you to confirm the slot."
          : "You declined this call-out.",
      });
      requests.reload();
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
                    <input value={notes[request.requestId] || ""} onChange={(event) => setNotes((current) => ({ ...current, [request.requestId]: event.target.value }))} placeholder="e.g. I can come in tomorrow morning" />
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
                    <td>{request.responseNotes || "—"}</td>
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
