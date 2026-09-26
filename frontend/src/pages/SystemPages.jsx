import { useState } from "react";
import { useRequest } from "../hooks/useRequest";
import { api } from "../api";
import { BLOOD_GROUPS, CITIES, RH_FACTORS } from "../constants";
import { AvailabilityBadge, Button, Checkbox, ConfirmDeleteModal, EmptyState, ErrorState, Field, LoadingState, Notice, PageHeader, PartialResults, RoleBadge, SectionCard, SimulatedBadge, StatusBadge } from "../components/UI";
import { ageFromDate, errorDetails, formatBloodType, formatDate, formatDateTime, formatNumber, friendlyError, listFrom } from "../utils";

function cityEntries(cities) {
  if (!cities) return [];
  return Object.entries(cities).map(([code, value]) => ({ code, ...value }));
}

function cityState(city) {
  if (!city) return { state: "Unknown", tone: "neutral" };
  const primary = city.primary_up === false ? "Down" : "Up";
  const replica = city.replica_up === false ? "Down" : "Up";
  return { state: `${primary} primary · ${replica} replica`, tone: primary === "Down" || replica === "Down" ? "danger" : "success" };
}

export function HealthPage() {
  const request = useRequest(() => Promise.all([api.health.live(), api.health.ready()]).then(([live, ready]) => ({ live, ready })), []);
  const ready = request.data?.ready;
  const cities = cityEntries(ready?.cities);
  const healthyCities = cities.filter((city) => city.primary_up !== false && city.replica_up !== false).length;
  return (
    <div className="page-stack">
      <PageHeader eyebrow="System workspace" title="Service health" description="Readiness and liveness signals returned by the API on the current single port." actions={<Button variant="secondary" onClick={request.reload}>Refresh checks</Button>} />
      {request.loading ? <SectionCard><LoadingState label="Checking service health" /></SectionCard> : null}{request.error ? <ErrorState error={request.error} onRetry={request.reload} /> : null}
      {request.data ? <>
        <div className="stat-grid"><div className="stat-card stat-card-green"><span>Readiness</span><strong>{ready?.status || "Unknown"}</strong><small>API response</small></div><div className="stat-card stat-card-blue"><span>Liveness</span><strong>{request.data.live?.status || "Unknown"}</strong><small>Process response</small></div><div className="stat-card stat-card-purple"><span>Healthy cities</span><strong>{healthyCities} / {cities.length || "—"}</strong><small>Primary and replica</small></div><div className="stat-card stat-card-slate"><span>Instance</span><strong className="stat-instance">{ready?.instance_id || "—"}</strong><small>Response header signal</small></div></div>
        <SectionCard title="City readiness" description="Replica and failure signals are SIMULATED router behavior, not physical database node state." action={<SimulatedBadge />}>
          {cities.length ? <div className="health-grid">{cities.map((city) => { const state = cityState(city); return <article className="health-card" key={city.code}><div className="health-card-top"><strong>{city.code}</strong><StatusBadge status={state.state} /></div><div className="health-signal-row"><span className={`signal-dot ${city.primary_up === false ? "signal-down" : "signal-up"}`} /><div><span>Primary shard</span><strong>{city.primary_up === false ? "Unavailable" : "Writable"}</strong></div><SimulatedBadge /></div><div className="health-signal-row"><span className={`signal-dot ${city.replica_up === false ? "signal-down" : "signal-up"}`} /><div><span>Read model</span><strong>{city.replica_up === false ? "Unavailable" : "Serving"}</strong></div><SimulatedBadge /></div><div className="health-card-footer"><span>Replica lag</span><strong>{formatNumber(city.replica_lag_ms)} ms</strong></div></article>; })}</div> : <EmptyState title="No city health rows">Readiness did not return city signals.</EmptyState>}
        </SectionCard>
      </> : null}
    </div>
  );
}

export function ChaosPage() {
  const request = useRequest(() => api.system.cluster(), []);
  const [city, setCity] = useState("KHI");
  const [lag, setLag] = useState("1500");
  const [action, setAction] = useState({ loading: null, error: null, success: null });
  const cities = cityEntries(request.data?.cities);
  const selected = cities.find((item) => item.code === city);
  const flags = selected || {};

  async function run(actionName, body) {
    setAction({ loading: actionName, error: null, success: null });
    try {
      await api.system.chaos(city, actionName, body);
      const labels = { "primary-down": "Primary marked unavailable", "primary-up": "Primary marked writable", "replica-down": "Replica marked unavailable", "replica-up": "Replica marked available", lag: "Artificial replica lag updated" };
      setAction({ loading: null, error: null, success: labels[actionName] || "Chaos setting updated" });
      request.reload();
    } catch (error) {
      setAction({ loading: null, error, success: null });
    }
  }

  return (
    <div className="page-stack">
      <PageHeader eyebrow="System workspace" title="Chaos controls" description="Exercise the failure paths of the distributed network. These switches do not stop real database nodes." actions={<SimulatedBadge label="SIMULATED FAILURE" />} />
      <Notice tone="warning" title="Simulation boundary">Replica and primary controls change router behavior for the demonstration environment. Do not use them as a substitute for production health management.</Notice>
      {action.success ? <Notice tone="success" title="Control updated">{action.success}</Notice> : null}{action.error ? <Notice tone="error" title="Control could not be changed">{friendlyError(action.error)}{errorDetails(action.error) ? ` ${errorDetails(action.error)}` : ""}</Notice> : null}
      <div className="workspace-grid workspace-grid-wide"><SectionCard title="Select a city shard" description="Flags are shared across API instances and should settle within one second."><div className="city-switcher">{cities.length ? cities.map((item) => <button type="button" key={item.code} className={`city-switch ${city === item.code ? "city-switch-active" : ""}`} onClick={() => setCity(item.code)}><strong>{item.code}</strong><span>{item.primary_up === false || item.replica_up === false ? "Attention" : "Healthy"}</span></button>) : CITIES.map((item) => <button type="button" key={item.cityCode} className={`city-switch ${city === item.cityCode ? "city-switch-active" : ""}`} onClick={() => setCity(item.cityCode)}><strong>{item.cityCode}</strong><span>{item.name}</span></button>)}</div></SectionCard><SectionCard title={`${city} controls`} description="Changes are recorded by the system control plane."><div className="chaos-actions"><div className="chaos-action-row"><div><strong>Primary shard</strong><span>{flags.primary_up === false ? "Writes unavailable" : "Writable"}</span></div><div className="button-pair"><Button variant={flags.primary_up === false ? "primary" : "danger"} size="sm" onClick={() => run(flags.primary_up === false ? "primary-up" : "primary-down")} disabled={Boolean(action.loading)}>{flags.primary_up === false ? "Bring primary up" : "Take primary down"}</Button></div></div><div className="chaos-action-row"><div><strong>Replica read model</strong><span>{flags.replica_up === false ? "Read model unavailable" : "Read model serving"}</span></div><Button variant={flags.replica_up === false ? "primary" : "secondary"} size="sm" onClick={() => run(flags.replica_up === false ? "replica-up" : "replica-down")} disabled={Boolean(action.loading)}>{flags.replica_up === false ? "Bring replica up" : "Take replica down"}</Button></div><div className="chaos-action-row lag-row"><div><strong>Artificial replica lag</strong><span>{formatNumber(flags.extra_lag_ms)} ms configured</span></div><div className="lag-control"><input type="number" min="0" max="60000" step="100" value={lag} onChange={(event) => setLag(event.target.value)} /><Button size="sm" onClick={() => run("lag", { ms: Number(lag) })} disabled={Boolean(action.loading)}>{action.loading === "lag" ? "Saving…" : "Apply lag"}</Button></div></div></div></SectionCard></div>
      {request.loading ? <SectionCard><LoadingState label="Loading chaos state" /></SectionCard> : null}{request.error ? <ErrorState error={request.error} onRetry={request.reload} /> : null}
    </div>
  );
}

export function DonorDirectoryPage() {
  const [city, setCity] = useState("");
  const [bloodGroup, setBloodGroup] = useState("");
  const [rh, setRh] = useState("");
  const [availableOnly, setAvailableOnly] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const request = useRequest(
    () =>
      api.search.donors({
        ...(city ? { city } : {}),
        ...(bloodGroup ? { bloodGroup } : {}),
        ...(rh ? { rh } : {}),
        ...(availableOnly ? { available: "true" } : {}),
        limit: 100,
      }),
    [city, bloodGroup, rh, availableOnly],
  );

  const donors = listFrom(request.data, ["donors"]);
  const totalMatched = request.data?.total ?? donors.length;
  const availableCount = donors.filter((donor) => donor.isAvailable).length;
  const cityCount = new Set(donors.map((donor) => donor.cityCode)).size;
  const byCity = request.data?.byCity || {};

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.system.deleteDonor(pendingDelete.id, pendingDelete.city);
      setPendingDelete(null);
      request.reload();
    } catch (error) {
      setDeleteError(friendlyError(error));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="System workspace"
        title="Donor directory"
        description="Every donor profile held in the city history shards, with the availability signal blood banks read when scheduling a collection."
        actions={<Button variant="secondary" onClick={request.reload} disabled={request.loading}>Refresh directory</Button>}
      />
      <SectionCard title="Filters" description="Leave a field empty to search every city shard. Results are capped at 100 donors per city.">
        <div className="form-grid form-grid-four">
          <Field label="City shard">
            <select value={city} onChange={(event) => setCity(event.target.value)}>
              <option value="">All cities</option>
              {CITIES.map((item) => <option key={item.cityCode} value={item.cityCode}>{item.cityCode} · {item.name}</option>)}
            </select>
          </Field>
          <Field label="Blood group">
            <select value={bloodGroup} onChange={(event) => setBloodGroup(event.target.value)}>
              <option value="">Any group</option>
              {BLOOD_GROUPS.map((group) => <option key={group} value={group}>{group}</option>)}
            </select>
          </Field>
          <Field label="Rh factor">
            <select value={rh} onChange={(event) => setRh(event.target.value)}>
              <option value="">Any factor</option>
              {RH_FACTORS.map((factor) => <option key={factor} value={factor}>{factor === "POS" ? "Positive" : "Negative"}</option>)}
            </select>
          </Field>
          <Field label="Availability">
            <Checkbox label="Only donors currently available" checked={availableOnly} onChange={(event) => setAvailableOnly(event.target.checked)} />
          </Field>
        </div>
      </SectionCard>
      {request.loading ? <SectionCard><LoadingState label="Loading donor directory" /></SectionCard> : null}
      {request.error ? <ErrorState error={request.error} onRetry={request.reload} /> : null}
      {request.data ? <>
        {request.data.truncated ? <Notice tone="warning" title="Results are capped per city">{formatNumber(donors.length)} of {formatNumber(totalMatched)} matching donors are listed. {Object.entries(byCity).map(([code, count]) => `${code}: ${formatNumber(count)}`).join(" · ")}. Narrow the city or blood group filter to see the rest.</Notice> : null}
        <div className="stat-grid">
          <div className="stat-card stat-card-blue"><span>Donors matched</span><strong>{formatNumber(totalMatched)}</strong><small>Across the selected shards</small></div>
          <div className="stat-card stat-card-green"><span>Listed here</span><strong>{formatNumber(donors.length)}</strong><small>{request.data.truncated ? "Capped at 100 per city" : "Complete result set"}</small></div>
          <div className="stat-card stat-card-purple"><span>City shards</span><strong>{cityCount}</strong><small>With at least one donor</small></div>
          <div className="stat-card stat-card-amber"><span>Available in view</span><strong>{formatNumber(availableCount)}</strong><small>Of the listed rows</small></div>
        </div>
        <SectionCard title="Donor profiles" description="Donor records live in each city's history schema, so a profile is only visible from the shard that owns it.">
          {donors.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Donor</th><th>Blood type</th><th>City</th><th>Availability</th><th>Last donation</th><th>Age</th><th>Weight</th><th>Phone</th><th>Donor ID</th><th className="table-actions-head">Actions</th></tr></thead><tbody>{donors.map((donor) => <tr key={donor.donorId}><td><strong>{donor.fullName}</strong></td><td>{formatBloodType(donor.bloodGroup, donor.rhFactor)}</td><td>{donor.cityCode}</td><td><AvailabilityBadge available={Boolean(donor.isAvailable)} /></td><td>{formatDate(donor.lastDonationDate)}</td><td>{ageFromDate(donor.dateOfBirth) ?? "—"}</td><td>{formatNumber(donor.weightKg)} kg</td><td className="mono-text">{donor.phone || "—"}</td><td className="mono-text">{donor.donorId?.slice(0, 8)}</td><td><Button variant="danger" size="sm" onClick={() => { setDeleteError(null); setPendingDelete({ id: donor.donorId, city: donor.cityCode, name: donor.fullName }); }}>Delete</Button></td></tr>)}</tbody></table></div> : <EmptyState title="No donors matched">Adjust the filters, or register a donor profile from the donor sign-up page.</EmptyState>}
        </SectionCard>
      </> : null}
      <ConfirmDeleteModal
        open={Boolean(pendingDelete)}
        title="Delete donor profile"
        entityName={pendingDelete?.name}
        consequence={pendingDelete ? `The donor account linked to this profile, plus every donation, blood unit, reservation, status log and read-model entry for the donor in the ${pendingDelete.city} shard.` : null}
        busy={deleting}
        error={deleteError}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

export function HospitalsBanksPage() {
  const [city, setCity] = useState("");
  const [entity, setEntity] = useState("hospital");
  const [form, setForm] = useState({ name: "", address: "", phone: "", latitude: "", longitude: "" });
  const [action, setAction] = useState({ loading: false, error: null, success: null });
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const hospitals = useRequest(() => api.catalog.hospitals(city ? { city } : undefined), [city]);
  const banks = useRequest(() => api.catalog.bloodBanks(city ? { city } : undefined), [city]);
  const hospitalRows = listFrom(hospitals.data, ["hospitals"]);
  const bankRows = listFrom(banks.data, ["bloodBanks"]);

  const DELETE_CONSEQUENCES = {
    hospital: "Any hospital admin account attached to it, plus its reservations, transfusion records and cached search requests in the city shard.",
    bloodBank: "Any blood bank admin account attached to it, plus every donation, blood unit, reservation, status log and read-model entry for that bank in the city shard.",
  };

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      if (pendingDelete.kind === "hospital") {
        await api.system.deleteHospital(pendingDelete.id);
        hospitals.reload();
      } else {
        await api.system.deleteBloodBank(pendingDelete.id);
        banks.reload();
      }
      setPendingDelete(null);
    } catch (error) {
      setDeleteError(friendlyError(error));
    } finally {
      setDeleting(false);
    }
  }

  function update(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    setAction({ loading: true, error: null, success: null });
    const body = {
      name: form.name,
      cityCode: city,
      address: form.address || undefined,
      phone: form.phone || undefined,
      latitude: form.latitude ? Number(form.latitude) : undefined,
      longitude: form.longitude ? Number(form.longitude) : undefined,
    };
    try {
      if (entity === "hospital") {
        await api.system.createHospital(body);
        setAction({ loading: false, error: null, success: `Hospital "${form.name}" created in ${city}.` });
        hospitals.reload();
      } else {
        await api.system.createBloodBank(body);
        setAction({ loading: false, error: null, success: `Blood bank "${form.name}" created in ${city}.` });
        banks.reload();
      }
      setForm({ name: "", address: "", phone: "", latitude: "", longitude: "" });
    } catch (error) {
      setAction({ loading: false, error, success: null });
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="System workspace"
        title="Hospitals &amp; blood banks"
        description="Register the facilities that hospital and blood-bank admin accounts are attached to. A facility must exist before its admin account can be created."
      />
      <div className="workspace-grid workspace-grid-wide">
        <SectionCard title="Register a facility" description="City is required. Address and coordinates are optional but improve distance sorting.">
          <form className="stack-form" onSubmit={submit}>
            <div className="form-grid form-grid-two">
              <Field label="Facility type">
                <select value={entity} onChange={(event) => setEntity(event.target.value)}>
                  <option value="hospital">Hospital</option>
                  <option value="bloodBank">Blood bank</option>
                </select>
              </Field>
              <Field label="City shard" hint="Required">
                <select required value={city} onChange={(event) => setCity(event.target.value)}>
                  <option value="">Select a city</option>
                  {CITIES.map((item) => <option key={item.cityCode} value={item.cityCode}>{item.cityCode} · {item.name}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Name" hint="Required"><input required value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="e.g. Lahore General Hospital" /></Field>
            <Field label="Address"><input value={form.address} onChange={(event) => update("address", event.target.value)} placeholder="Street address" /></Field>
            <Field label="Phone"><input value={form.phone} onChange={(event) => update("phone", event.target.value)} placeholder="+92-000-0000000" /></Field>
            <div className="form-grid form-grid-two">
              <Field label="Latitude"><input type="number" step="any" value={form.latitude} onChange={(event) => update("latitude", event.target.value)} placeholder="31.520400" /></Field>
              <Field label="Longitude"><input type="number" step="any" value={form.longitude} onChange={(event) => update("longitude", event.target.value)} placeholder="74.358700" /></Field>
            </div>
            <Button type="submit" disabled={action.loading || !city}>{action.loading ? "Creating…" : `Create ${entity === "hospital" ? "hospital" : "blood bank"}`}</Button>
            {!city ? <span className="field-hint">Select a city shard to enable creation.</span> : null}
            {action.success ? <Notice tone="success" title="Facility created">{action.success}</Notice> : null}
            {action.error ? <Notice tone="error" title="Could not create facility">{friendlyError(action.error)}{errorDetails(action.error) ? ` ${errorDetails(action.error)}` : ""}</Notice> : null}
          </form>
        </SectionCard>
        <SectionCard title="City filter" description="Both lists read the shared catalog and are visible to every authenticated user.">
          <Field label="City shard">
            <select value={city} onChange={(event) => setCity(event.target.value)}>
              <option value="">All cities</option>
              {CITIES.map((item) => <option key={item.cityCode} value={item.cityCode}>{item.cityCode} · {item.name}</option>)}
            </select>
          </Field>
        </SectionCard>
      </div>
      <SectionCard title="Hospitals" description="Active hospital records in the catalog.">
        {hospitals.loading ? <LoadingState label="Loading hospitals" /> : null}
        {hospitals.error ? <ErrorState error={hospitals.error} onRetry={hospitals.reload} /> : null}
        {!hospitals.loading && !hospitals.error ? hospitalRows.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Name</th><th>City</th><th>Address</th><th>Phone</th><th>Coordinates</th><th>Hospital ID</th><th className="table-actions-head">Actions</th></tr></thead><tbody>{hospitalRows.map((row) => <tr key={row.hospitalId}><td><strong>{row.name}</strong></td><td>{row.cityCode}</td><td>{row.address || "—"}</td><td>{row.phone || "—"}</td><td>{row.latitude ? `${row.latitude}, ${row.longitude}` : "—"}</td><td className="mono-text">{row.hospitalId?.slice(0, 8)}</td><td><Button variant="danger" size="sm" onClick={() => { setDeleteError(null); setPendingDelete({ kind: "hospital", id: row.hospitalId, name: row.name }); }}>Delete</Button></td></tr>)}</tbody></table></div> : <EmptyState title="No hospitals registered">Create one with the form above, then attach an admin account from the Users page.</EmptyState> : null}
      </SectionCard>
      <SectionCard title="Blood banks" description="Active blood bank records in the catalog.">
        {banks.loading ? <LoadingState label="Loading blood banks" /> : null}
        {banks.error ? <ErrorState error={banks.error} onRetry={banks.reload} /> : null}
        {!banks.loading && !banks.error ? bankRows.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Name</th><th>City</th><th>Address</th><th>Phone</th><th>Coordinates</th><th>Bank ID</th><th className="table-actions-head">Actions</th></tr></thead><tbody>{bankRows.map((row) => <tr key={row.bloodBankId}><td><strong>{row.name}</strong></td><td>{row.cityCode}</td><td>{row.address || "—"}</td><td>{row.phone || "—"}</td><td>{row.latitude ? `${row.latitude}, ${row.longitude}` : "—"}</td><td className="mono-text">{row.bloodBankId?.slice(0, 8)}</td><td><Button variant="danger" size="sm" onClick={() => { setDeleteError(null); setPendingDelete({ kind: "bloodBank", id: row.bloodBankId, name: row.name }); }}>Delete</Button></td></tr>)}</tbody></table></div> : <EmptyState title="No blood banks registered">Create one with the form above, then attach an admin account from the Users page.</EmptyState> : null}
      </SectionCard>
      <ConfirmDeleteModal
        open={Boolean(pendingDelete)}
        title={pendingDelete?.kind === "bloodBank" ? "Delete blood bank" : "Delete hospital"}
        entityName={pendingDelete?.name}
        consequence={pendingDelete ? DELETE_CONSEQUENCES[pendingDelete.kind] : null}
        busy={deleting}
        error={deleteError}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

const USER_ROLE_OPTIONS = [
  { value: "HOSPITAL_ADMIN", label: "Hospital admin", needs: "hospitalId" },
  { value: "BLOODBANK_ADMIN", label: "Blood bank admin", needs: "bloodBankId" },
  { value: "DONOR", label: "Donor", needs: "donorId" },
  { value: "SYSTEM_ADMIN", label: "System admin", needs: null },
];

export function UsersPage() {
  const [form, setForm] = useState({ username: "", email: "", password: "", role: "HOSPITAL_ADMIN", facilityId: "", donorCity: "" });
  const [action, setAction] = useState({ loading: false, error: null, success: null });
  const users = useRequest(() => api.system.listUsers(), []);
  const hospitals = useRequest(() => api.catalog.hospitals(), []);
  const banks = useRequest(() => api.catalog.bloodBanks(), []);
  const userRows = listFrom(users.data, ["users"]);
  const hospitalRows = listFrom(hospitals.data, ["hospitals"]);
  const bankRows = listFrom(banks.data, ["bloodBanks"]);
  const selected = USER_ROLE_OPTIONS.find((option) => option.value === form.role);

  function update(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    setAction({ loading: true, error: null, success: null });
    const body = { username: form.username, email: form.email, password: form.password, role: form.role };
    if (form.role === "HOSPITAL_ADMIN") body.hospitalId = form.facilityId;
    if (form.role === "BLOODBANK_ADMIN") body.bloodBankId = form.facilityId;
    if (form.role === "DONOR") {
      body.donorId = form.facilityId;
      body.donorCityCode = form.donorCity;
    }
    try {
      const created = await api.system.createUser(body);
      setAction({ loading: false, error: null, success: `Account "${created.user?.username || form.username}" created. It can sign in at /login immediately.` });
      setForm({ username: "", email: "", password: "", role: "HOSPITAL_ADMIN", facilityId: "", donorCity: "" });
      users.reload();
    } catch (error) {
      setAction({ loading: false, error, success: null });
    }
  }

  const facilityOptions = form.role === "HOSPITAL_ADMIN"
    ? hospitalRows.map((row) => ({ value: row.hospitalId, label: `${row.name} · ${row.cityCode}` }))
    : bankRows.map((row) => ({ value: row.bloodBankId, label: `${row.name} · ${row.cityCode}` }));

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="System workspace"
        title="Users"
        description="Every portal identity in the system. Hospital and blood-bank accounts are tenant scoped to the facility they are attached to."
        actions={<Button variant="secondary" onClick={users.reload} disabled={users.loading}>Refresh list</Button>}
      />
      <SectionCard title="Create an account" description="The account can sign in straight after creation. Donor accounts need a donor profile that already exists in the chosen city shard.">
        <form className="stack-form" onSubmit={submit}>
          <div className="form-grid form-grid-two">
            <Field label="Role">
              <select value={form.role} onChange={(event) => { update("role", event.target.value); update("facilityId", ""); update("donorCity", ""); }}>
                {USER_ROLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </Field>
            <Field label="Username" hint="Required, unique"><input required value={form.username} onChange={(event) => update("username", event.target.value)} placeholder="lhe.hospital.admin" /></Field>
          </div>
          <Field label="Email" hint="Required"><input required type="email" value={form.email} onChange={(event) => update("email", event.target.value)} placeholder="admin@example.test" /></Field>
          <Field label="Password" hint="Minimum 12 characters"><input required type="password" minLength={12} value={form.password} onChange={(event) => update("password", event.target.value)} /></Field>
          {form.role === "DONOR" ? (
            <div className="form-grid form-grid-two">
              <Field label="Donor city shard" hint="Required">
                <select required value={form.donorCity} onChange={(event) => update("donorCity", event.target.value)}>
                  <option value="">Select a city</option>
                  {CITIES.map((item) => <option key={item.cityCode} value={item.cityCode}>{item.cityCode} · {item.name}</option>)}
                </select>
              </Field>
              <Field label="Donor ID" hint="UUID of an existing donor profile">
                <input required value={form.facilityId} onChange={(event) => update("facilityId", event.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />
              </Field>
            </div>
          ) : selected?.needs ? (
            <Field label={form.role === "HOSPITAL_ADMIN" ? "Hospital" : "Blood bank"} hint={form.role === "HOSPITAL_ADMIN" ? "Required" : "Required"}>
              <select required value={form.facilityId} onChange={(event) => update("facilityId", event.target.value)}>
                <option value="">{facilityOptions.length ? "Select a facility" : `No ${form.role === "HOSPITAL_ADMIN" ? "hospitals" : "blood banks"} registered yet`}</option>
                {facilityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </Field>
          ) : null}
          {selected?.needs && !facilityOptions.length && form.role !== "DONOR" ? <span className="field-hint">Register a facility on the Hospitals &amp; banks page first.</span> : null}
          <Button type="submit" disabled={action.loading}>{action.loading ? "Creating…" : "Create account"}</Button>
          {action.success ? <Notice tone="success" title="Account created">{action.success}</Notice> : null}
          {action.error ? <Notice tone="error" title="Could not create account">{friendlyError(action.error)}{errorDetails(action.error) ? ` ${errorDetails(action.error)}` : ""}</Notice> : null}
        </form>
      </SectionCard>
      <SectionCard title="Account directory" description="All portal identities across every city shard.">
        {users.loading ? <LoadingState label="Loading accounts" /> : null}
        {users.error ? <ErrorState error={users.error} onRetry={users.reload} /> : null}
        {!users.loading && !users.error ? userRows.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Username</th><th>Role</th><th>Email</th><th>Scope</th><th>Status</th><th>Created</th></tr></thead><tbody>{userRows.map((row) => <tr key={row.userId}><td><strong>{row.username}</strong></td><td><RoleBadge role={row.role} /></td><td>{row.email}</td><td className="mono-text">{row.hospitalId ? `Hospital ${row.hospitalId.slice(0, 8)}` : row.bloodBankId ? `Bank ${row.bloodBankId.slice(0, 8)}` : row.donorId ? `Donor ${row.donorCityCode} / ${row.donorId.slice(0, 8)}` : "All cities"}</td><td><StatusBadge status={row.isActive === false ? "INACTIVE" : "ACTIVE"} /></td><td>{formatDateTime(row.createdAt)}</td></tr>)}</tbody></table></div> : <EmptyState title="No accounts yet">Create the first account with the form above.</EmptyState> : null}
      </SectionCard>
    </div>
  );
}

export function ClusterPage() {
  const request = useRequest(() => api.system.cluster(), []);
  const cities = cityEntries(request.data?.cities);
  const totalAvailable = cities.reduce((sum, city) => sum + Number(city.available_units || 0), 0);
  const totalReserved = cities.reduce((sum, city) => sum + Number(city.reserved_units || 0), 0);
  return (
    <div className="page-stack">
      <PageHeader eyebrow="System workspace" title="Cluster status" description="Per-city inventory and replication telemetry from the system control plane." actions={<Button variant="secondary" onClick={request.reload}>Refresh cluster</Button>} />
      {request.data?.meta ? <PartialResults meta={request.data.meta} /> : null}
      {request.loading ? <SectionCard><LoadingState label="Loading cluster status" /></SectionCard> : null}{request.error ? <ErrorState error={request.error} onRetry={request.reload} /> : null}
      {request.data ? <>
        <div className="stat-grid"><div className="stat-card stat-card-blue"><span>Available units</span><strong>{formatNumber(totalAvailable)}</strong><small>Across responding cities</small></div><div className="stat-card stat-card-amber"><span>Reserved units</span><strong>{formatNumber(totalReserved)}</strong><small>Live holds</small></div><div className="stat-card stat-card-purple"><span>Cities</span><strong>{cities.length}</strong><small>Configured shards</small></div><div className="stat-card stat-card-slate"><span>Instance</span><strong className="stat-instance">{request.data.instance_id || "—"}</strong><small>Last response</small></div></div>
        <SectionCard title="City telemetry" description="All replica and failure indicators are explicitly simulated." action={<SimulatedBadge />}>
          {cities.length ? <div className="telemetry-grid">{cities.map((city) => <article className="telemetry-card" key={city.code}><div className="telemetry-header"><div><span className="eyebrow">City shard</span><h3>{city.code}</h3></div><StatusBadge status={city.primary_up === false || city.replica_up === false ? "Attention" : "Healthy"} /></div><div className="telemetry-signal"><span>Primary</span><strong>{city.primary_up === false ? "Down" : "Up"}</strong><SimulatedBadge /></div><div className="telemetry-signal"><span>Replica</span><strong>{city.replica_up === false ? "Down" : "Up"}</strong><SimulatedBadge /></div><div className="telemetry-metrics"><div><span>Inventory</span><strong>{formatNumber(city.available_units)}</strong><small>available</small></div><div><span>Holds</span><strong>{formatNumber(city.reserved_units)}</strong><small>reserved</small></div><div><span>Measured lag</span><strong>{formatNumber(city.replica_lag_ms)} ms</strong><small>read model</small></div></div><small className="telemetry-updated">Updated {formatDateTime(city.updated_at)}</small></article>)}</div> : <EmptyState title="No cluster rows">The control plane did not return city telemetry.</EmptyState>}
        </SectionCard>
      </> : null}
    </div>
  );
}
