import { useEffect, useRef, useState } from "react";
import { useRequest } from "../hooks/useRequest";
import { usePagination } from "../hooks/usePagination";
import { api } from "../api";
import { BLOOD_GROUPS, CITIES, RH_FACTORS } from "../constants";
import { AvailabilityBadge, Button, Checkbox, ConfirmDeleteModal, EmptyState, ErrorState, Field, Icon, LoadingState, Modal, Notice, PageHeader, PaginationControls, PartialResults, RoleBadge, SectionCard, SimulatedBadge, StatusBadge } from "../components/UI";
import { ageFromDate, donorDisplayName, errorDetails, formatBloodType, formatDate, formatDateTime, formatNumber, friendlyError, listFrom } from "../utils";
import { email as emailRule, hasErrors, maxLength, minLength, number, oneOf, password as passwordRule, phone as phoneRule, required, username as usernameRule, validate, useFieldErrors } from "../validation";

function useDebouncedValue(value, delay = 300) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedValue(value), delay);
    return () => window.clearTimeout(timeout);
  }, [value, delay]);

  return debouncedValue;
}

function useAutoRefresh(reload, interval = 30_000) {
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    const timer = window.setInterval(() => reloadRef.current(), interval);
    return () => window.clearInterval(timer);
  }, [interval]);
}

const FACILITY_RULES = {
  cityCode: [required("City shard"), oneOf(CITIES.map((city) => city.cityCode), "City shard")],
  name: [required("Name"), minLength(2, "Name"), maxLength(160, "Name")],
  address: [maxLength(500, "Address")],
  phone: [phoneRule("Phone")],
  latitude: [number({ min: -90, max: 90, label: "Latitude" })],
  longitude: [number({ min: -180, max: 180, label: "Longitude" })],
};

const USER_RULES = {
  username: [required("Username"), usernameRule("Username"), maxLength(50, "Username")],
  email: [required("Email"), emailRule],
  password: [required("Password"), passwordRule("Password")],
};
const HOSPITAL_RULES = { ...FACILITY_RULES, ...USER_RULES };
const BLOOD_BANK_RULES = HOSPITAL_RULES;

const LAG_RULES = { lag: [required("Replica lag"), number({ min: 0, max: 60000, integer: true, label: "Replica lag" })] };

function cityEntries(cities) {
  if (!cities) return [];
  return Object.entries(cities).map(([code, value]) => ({ code, ...value }));
}

function ChaosSimulationSummary({ flags }) {
  if (!flags) return <small className="telemetry-updated">Simulation status unavailable.</small>;
  return (
    <div className="health-signal-row">
      <span className="eyebrow">Shared Details</span>
      <span>Writes: {flags.primary_down ? "blocked" : "available"} · Reads: {flags.replica_down ? "blocked" : "available"} · Lag: {formatNumber(flags.extra_lag_ms)} ms</span>
    </div>
  );
}

export function HealthPage() {
  const request = useRequest(() => Promise.all([api.health.live(), api.health.ready()]).then(([live, ready]) => ({ live, ready })), []);
  const simulationRequest = useRequest(() => api.system.chaosStatus(), []);
  useAutoRefresh(request.reload);
  useAutoRefresh(simulationRequest.reload, 2500);
  const ready = request.data?.ready;
  const cities = cityEntries(ready?.cities);
  const respondingCities = cities.filter((city) => city.primary?.status === "up").length;
  const streamingReplicas = cities.filter((city) => city.replica?.status === "up").length;
  return (
    <div className="page-stack">
      <PageHeader eyebrow="System workspace" title="Service health" description="Live PostgreSQL connection and role probes for every configured city primary and physical replica." actions={<Button variant="secondary" onClick={request.reload}>Refresh checks</Button>} />
      {request.loading ? <SectionCard><LoadingState label="Checking service health" /></SectionCard> : null}{request.error ? <ErrorState error={request.error} onRetry={request.reload} /> : null}
      {request.data ? <>
        <div className="stat-grid"><div className={`stat-card ${ready?.status === "ready" ? "stat-card-green" : "stat-card-amber"}`}><span>Database readiness</span><strong>{ready?.status || "Unknown"}</strong><small>Actual primary connection checks</small></div><div className="stat-card stat-card-blue"><span>Liveness</span><strong>{request.data.live?.status || "Unknown"}</strong><small>API process response</small></div><div className="stat-card stat-card-purple"><span>Responding primaries</span><strong>{respondingCities} / {cities.length || "—"}</strong><small>{streamingReplicas} streaming replicas</small></div><div className="stat-card stat-card-slate"><span>Instance</span><strong className="stat-instance">{ready?.instance_id || "—"}</strong><small>Monitoring API</small></div></div>
        {ready?.status === "degraded" ? <Notice tone="error" title="Database readiness degraded">The catalog or one or more configured city primary databases could not be reached or did not report the expected primary role.</Notice> : null}
        <SectionCard title="Live city database status" description="Your configured catalog and city databases are checked directly. A physical standby is optional and separate from the city databases themselves.">
          {cities.length ? <div className="health-grid">
            {ready?.catalog ? <article className="health-card">
              <div className="health-card-top"><strong>CATALOG</strong><StatusBadge status={ready.catalog.status === "up" ? "Connected" : "Attention"} /></div>
              <div className="health-signal-row"><span className={`signal-dot ${ready.catalog.status === "up" ? "signal-up" : "signal-down"}`} /><div><span>Catalog database</span><strong>{databaseNodeLabel(ready.catalog, "primary")}</strong></div></div>
              {ready.catalog.status === "unavailable" ? <small className="telemetry-updated">Catalog probe failed: {ready.catalog.error_code}</small> : null}
            </article> : null}
            {cities.map((city) => {
            const primary = city.primary;
            const replica = city.replica;
            const healthy = primary?.status === "up";
            return <article className="health-card" key={city.code}>
              <div className="health-card-top"><strong>{city.code}</strong><StatusBadge status={healthy ? "Connected" : "Attention"} /></div>
              <div className="health-signal-row"><span className={`signal-dot ${healthy ? "signal-up" : "signal-down"}`} /><div><span>Primary database</span><strong>{databaseNodeLabel(primary, "primary")}</strong></div></div>
                {replica?.configured ? (
                  <div className="health-signal-row"><span className={`signal-dot ${replica.status === "up" ? "signal-up" : "signal-down"}`} /><div><span>Optional physical standby</span><strong>{databaseNodeLabel(replica, "replica")}</strong></div></div>
                ) : null}
              {primary?.status === "up" ? <div className="health-card-footer"><span>PostgreSQL {primary.server_version}</span><strong>{formatUptime(primary.uptime_seconds)}</strong></div> : null}
              {primary?.status === "unavailable" ? <small className="telemetry-updated">Primary probe failed: {primary.error_code}</small> : null}
              {replica?.status === "unavailable" ? <small className="telemetry-updated">Replica probe failed: {replica.error_code}</small> : null}
              <ChaosSimulationSummary flags={simulationRequest.data?.flags?.[city.code]} />
            </article>;
            })}
          </div> : <EmptyState title="No city health rows">Readiness did not return database probe results.</EmptyState>}
          {simulationRequest.error ? <ErrorState error={simulationRequest.error} onRetry={simulationRequest.reload} /> : null}
          <Notice tone="info" title="Your databases are monitored">Catalog and all city databases are checked directly above.</Notice>
        </SectionCard>
      </> : null}
    </div>
  );
}

export function ChaosPage() {
  const request = useRequest(() => api.system.cluster(), []);
  const controlsRequest = useRequest(() => api.system.chaosStatus(), []);
  useAutoRefresh(request.reload);
  useAutoRefresh(controlsRequest.reload, 2500);
  const [city, setCity] = useState("KHI");
  const [lag, setLag] = useState("1500");
  const [action, setAction] = useState({ loading: null, error: null, success: null });
  const { errors, setErrors, clearError } = useFieldErrors();
  const cities = cityEntries(request.data?.cities);
  const selected = cities.find((item) => item.code === city);
  const flags = controlsRequest.data?.flags?.[city] || {};
  useEffect(() => {
    const configuredLag = controlsRequest.data?.flags?.[city]?.extra_lag_ms;
    if (configuredLag !== undefined) setLag(String(configuredLag));
  }, [city, controlsRequest.data?.flags?.[city]?.extra_lag_ms]);

  function applyLag() {
    const nextErrors = validate({ lag }, LAG_RULES);
    setErrors(nextErrors);
    if (hasErrors(nextErrors)) return;
    run("lag", { ms: Number(lag) });
  }

  async function run(actionName, body) {
    setAction({ loading: actionName, error: null, success: null });
    try {
      await api.system.chaos(city, actionName, body);
      const labels = { "primary-down": "Primary marked unavailable", "primary-up": "Primary marked writable", "replica-down": "Replica marked unavailable", "replica-up": "Replica marked available", lag: "Artificial replica lag updated" };
      setAction({ loading: null, error: null, success: labels[actionName] || "Chaos setting updated" });
      controlsRequest.reload();
    } catch (error) {
      setAction({ loading: null, error, success: null });
    }
  }

  return (
    <div className="page-stack">
      <PageHeader eyebrow="System workspace" title="Chaos controls" description="Live PostgreSQL status is shown separately from application-level failure simulations." actions={<SimulatedBadge label="SIMULATION CONTROLS" />} />
      <SectionCard title={`${city} live PostgreSQL status`} description="These values are measured from the configured database connections; the simulation controls below do not alter them.">
        {selected ? <div className="telemetry-grid">
          <div className="telemetry-signal"><span>Database</span><strong>{databaseNodeLabel(selected.primary, "primary")}</strong></div>
         
          
        
         
        </div> : request.loading ? <LoadingState label="Loading live PostgreSQL status" /> : request.error ? <ErrorState error={request.error} onRetry={request.reload} /> : <EmptyState title="No database status">No live probe data was returned for this city.</EmptyState>}
      </SectionCard>
      
      {action.success ? <Notice tone="success" title="Control updated">{action.success}</Notice> : null}{action.error ? <Notice tone="error" title="Control could not be changed">{friendlyError(action.error)}{errorDetails(action.error) ? ` ${errorDetails(action.error)}` : ""}</Notice> : null}
      <SectionCard title="Application-level chaos simulation" description={`Synthetic flags for ${city}; independent from live PostgreSQL health.`} action={<SimulatedBadge />}>
        <div className="city-switcher">{cities.length ? cities.map((item) => <button type="button" key={item.code} className={`city-switch ${city === item.code ? "city-switch-active" : ""}`} onClick={() => setCity(item.code)}><strong>{item.code}</strong><span>{item.primary?.status === "up" ? "Primary connected" : "Attention"}</span></button>) : CITIES.map((item) => <button type="button" key={item.cityCode} className={`city-switch ${city === item.cityCode ? "city-switch-active" : ""}`} onClick={() => setCity(item.cityCode)}><strong>{item.cityCode}</strong><span>{item.name}</span></button>)}</div>
        <div className="chaos-actions">
          <div className="chaos-action-row"><div><strong>Primary write simulation</strong><span>{flags.primary_down ? "Writes blocked by test flag" : "No simulated write outage"}</span></div><Button variant={flags.primary_down ? "primary" : "danger"} size="sm" onClick={() => run(flags.primary_down ? "primary-up" : "primary-down")} disabled={Boolean(action.loading) || !controlsRequest.data}>{flags.primary_down ? "Clear test outage" : "Simulate write outage"}</Button></div>
          <div className="chaos-action-row"><div><strong>Read-model simulation</strong><span>{flags.replica_down ? "Read model blocked by test flag" : "No simulated read outage"}</span></div><Button variant={flags.replica_down ? "primary" : "secondary"} size="sm" onClick={() => run(flags.replica_down ? "replica-up" : "replica-down")} disabled={Boolean(action.loading) || !controlsRequest.data}>{flags.replica_down ? "Clear test outage" : "Simulate read outage"}</Button></div>
          <div className="chaos-action-row lag-row"><div><strong>Artificial read-model lag</strong><span>{formatNumber(flags.extra_lag_ms)} ms configured</span></div><div className="lag-control"><input type="number" min="0" max="60000" step="100" value={lag} onChange={(event) => { setLag(event.target.value); clearError("lag"); }} /><Button size="sm" onClick={applyLag} disabled={Boolean(action.loading) || !controlsRequest.data}>{action.loading === "lag" ? "Saving…" : "Apply lag"}</Button></div>{errors.lag ? <span className="field-error">{errors.lag}</span> : null}</div>
        </div>
      </SectionCard>
      {controlsRequest.loading ? <SectionCard><LoadingState label="Loading simulation settings" /></SectionCard> : null}{controlsRequest.error ? <ErrorState error={controlsRequest.error} onRetry={controlsRequest.reload} /> : null}
    </div>
  );
}

export function DonorDirectoryPage() {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);
  const [city, setCity] = useState("");
  const [bloodGroup, setBloodGroup] = useState("");
  const [rh, setRh] = useState("");
  const [availableOnly, setAvailableOnly] = useState(false);
  const { page, limit: pageSize, setPage, resetPage } = usePagination({ defaultLimit: 20 });
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const request = useRequest(
    () =>
      api.search.donors({
        ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
        ...(city ? { city } : {}),
        ...(bloodGroup ? { bloodGroup } : {}),
        ...(rh ? { rh } : {}),
        ...(availableOnly ? { available: "true" } : {}),
        page,
        limit: pageSize,
      }),
    [page, pageSize, debouncedSearch, city, bloodGroup, rh, availableOnly],
  );

  const donors = listFrom(request.data, ["donors"]);
  const pageDonors = donors;
  const totalMatched = request.data?.total ?? donors.length;
  const availableCount = donors.filter((donor) => donor.isAvailable).length;
  const byCity = request.data?.byCity || {};
  const cityCount = Object.keys(byCity).length;

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.system.deleteDonor(pendingDelete.id, pendingDelete.city);
      setPendingDelete(null);
      request.reload();
      if (pageDonors.length === 1 && page > 1) setPage(page - 1);
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
        description="Search and page through donor profiles across all selected city shards."
        actions={<Button variant="secondary" onClick={request.reload} disabled={request.loading}>Refresh directory</Button>}
      />
      <SectionCard title="Search & filters" description="Search donor name, phone, or ID across all 10 city shards. Results are merged into one paginated directory.">
        <div className="form-grid form-grid-four">
          <Field label="Search donors">
            <span className="search-input-wrap">
              <Icon name="search" size={17} />
              <input value={search} onChange={(event) => { setSearch(event.target.value); resetPage(); }} placeholder="Name, phone, or donor ID" />
            </span>
          </Field>
          <Field label="City shard">
            <select value={city} onChange={(event) => { setCity(event.target.value); resetPage(); }}>
              <option value="">All cities</option>
              {CITIES.map((item) => <option key={item.cityCode} value={item.cityCode}>{item.cityCode} · {item.name}</option>)}
            </select>
          </Field>
          <Field label="Blood group">
            <select value={bloodGroup} onChange={(event) => { setBloodGroup(event.target.value); resetPage(); }}>
              <option value="">Any group</option>
              {BLOOD_GROUPS.map((group) => <option key={group} value={group}>{group}</option>)}
            </select>
          </Field>
          <Field label="Rh factor">
            <select value={rh} onChange={(event) => { setRh(event.target.value); resetPage(); }}>
              <option value="">Any factor</option>
              {RH_FACTORS.map((factor) => <option key={factor} value={factor}>{factor === "POS" ? "Positive" : "Negative"}</option>)}
            </select>
          </Field>
          <div className="field">
            <span className="field-label">Availability</span>
            <Checkbox label="Only donors currently available" checked={availableOnly} onChange={(event) => { setAvailableOnly(event.target.checked); resetPage(); }} />
          </div>
        </div>
      </SectionCard>
      {request.loading ? <SectionCard><LoadingState label="Loading donor directory" /></SectionCard> : null}
      {request.error ? <ErrorState error={request.error} onRetry={request.reload} /> : null}
      {request.data ? <>
        {request.data.meta?.unavailableCities?.length ? <Notice tone="warning" title="Partial donor results">These city shards did not respond: {request.data.meta.unavailableCities.join(", ")}. Refresh to retry.</Notice> : null}
        {request.data.totalApproximate ? <Notice tone="info" title="Estimated network total">The total uses PostgreSQL row statistics; this page of donor rows is merged from every responding shard.</Notice> : null}
        <div className="stat-grid">
          <div className="stat-card stat-card-blue"><span>{request.data.totalApproximate ? "Estimated donors" : "Donors matched"}</span><strong>{formatNumber(totalMatched)}</strong><small>Across the selected shards</small></div>
          <div className="stat-card stat-card-green"><span>Listed here</span><strong>{formatNumber(donors.length)}</strong><small>Page {page}</small></div>
          <div className="stat-card stat-card-purple"><span>City shards</span><strong>{cityCount}</strong><small>Searched shards</small></div>
          <div className="stat-card stat-card-amber"><span>Available in view</span><strong>{formatNumber(availableCount)}</strong><small>Of the listed rows</small></div>
        </div>
        <SectionCard title="Donor profiles" description="Donor records live in each city's history schema, so a profile is only visible from the shard that owns it.">
          {pageDonors.length ? <>
            <div className="table-wrap"><table className="data-table"><thead><tr><th>Donor</th><th>Blood type</th><th>City</th><th>Availability</th><th>Last donation</th><th>Age</th><th>Weight</th><th>Phone</th><th className="table-actions-head">Actions</th></tr></thead><tbody>{pageDonors.map((donor) => <tr key={donor.donorId}><td><strong>{donorDisplayName(donor.fullName)}</strong></td><td>{formatBloodType(donor.bloodGroup, donor.rhFactor)}</td><td>{donor.cityCode}</td><td><AvailabilityBadge available={Boolean(donor.isAvailable)} /></td><td>{formatDate(donor.lastDonationDate)}</td><td>{ageFromDate(donor.dateOfBirth) ?? "—"}</td><td>{formatNumber(donor.weightKg)} kg</td><td className="mono-text">{donor.phone || "—"}</td><td><Button variant="danger" size="sm" onClick={() => { setDeleteError(null); setPendingDelete({ id: donor.donorId, city: donor.cityCode, name: donor.fullName }); }}>Delete</Button></td></tr>)}</tbody></table></div>
            <PaginationControls page={page} pageSize={pageSize} totalItems={totalMatched} onPageChange={setPage} />
          </> : <EmptyState title="No donors matched">Adjust the filters, or register a donor profile from the donor sign-up page.</EmptyState>}
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
  const [cityFilter, setCityFilter] = useState("");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);
  const [entity, setEntity] = useState("hospital");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [form, setForm] = useState({ cityCode: "", name: "", address: "", phone: "", latitude: "", longitude: "" });
  const [action, setAction] = useState({ loading: false, error: null, success: null });
  const { errors, setErrors, clearError } = useFieldErrors();
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const hospitalPagination = usePagination({ defaultLimit: 20 });
  const bankPagination = usePagination({ defaultLimit: 20 });
  const hospitals = useRequest(
    () => api.catalog.hospitals({ ...(cityFilter ? { city: cityFilter } : {}), ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}) }),
    [cityFilter, debouncedSearch],
  );
  const banks = useRequest(
    () => api.catalog.bloodBanks({ ...(cityFilter ? { city: cityFilter } : {}), ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}) }),
    [cityFilter, debouncedSearch],
  );
  const hospitalRows = listFrom(hospitals.data, ["hospitals"]);
  const bankRows = listFrom(banks.data, ["bloodBanks"]);
  const pageSize = hospitalPagination.limit;
  const visibleHospitals = hospitalRows.slice((hospitalPagination.page - 1) * pageSize, hospitalPagination.page * pageSize);
  const visibleBanks = bankRows.slice((bankPagination.page - 1) * pageSize, bankPagination.page * pageSize);

  const DELETE_CONSEQUENCES = {
    hospital: "Any hospital admin account attached to it, plus its reservations, transfusion records and cached search requests in the city shard.",
    bloodBank: "Any blood bank admin account attached to it, plus every donation, blood unit, reservation, status log and read-model entry for that bank in the city shard.",
  };

  function openCreateModal(nextEntity) {
    setEntity(nextEntity);
    setForm({ cityCode: cityFilter, name: "", address: "", phone: "", latitude: "", longitude: "", username: "", email: "", password: "" });
    setErrors({});
    setAction({ loading: false, error: null, success: null });
    setShowCreateModal(true);
  }

  function closeCreateModal() {
    if (!action.loading) setShowCreateModal(false);
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      if (pendingDelete.kind === "hospital") {
        await api.system.deleteHospital(pendingDelete.id);
        hospitals.reload();
        if (visibleHospitals.length === 1 && hospitalPagination.page > 1) hospitalPagination.prevPage();
      } else {
        await api.system.deleteBloodBank(pendingDelete.id);
        banks.reload();
        if (visibleBanks.length === 1 && bankPagination.page > 1) bankPagination.prevPage();
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
    clearError(name);
  }

  async function submit(event) {
    event.preventDefault();
    const nextErrors = validate(form, entity === "hospital" ? HOSPITAL_RULES : BLOOD_BANK_RULES);
    setErrors(nextErrors);
    if (hasErrors(nextErrors)) return;
    setAction({ loading: true, error: null, success: null });
    const body = {
      name: form.name,
      cityCode: form.cityCode,
      address: form.address || undefined,
      phone: form.phone || undefined,
      latitude: form.latitude ? Number(form.latitude) : undefined,
      longitude: form.longitude ? Number(form.longitude) : undefined,
    };
    try {
      if (entity === "hospital") {
        await api.system.createHospital({ ...body, username: form.username, email: form.email, password: form.password });
        setAction({ loading: false, error: null, success: `Hospital "${form.name}" and its admin account were created in ${form.cityCode}.` });
        hospitals.reload();
      } else {
        await api.system.createBloodBank({ ...body, username: form.username, email: form.email, password: form.password });
        setAction({ loading: false, error: null, success: `Blood bank "${form.name}" and its admin account were created in ${form.cityCode}.` });
        banks.reload();
      }
      setForm({ cityCode: "", name: "", address: "", phone: "", latitude: "", longitude: "", username: "", email: "", password: "" });
      setShowCreateModal(false);
    } catch (error) {
      setAction({ loading: false, error, success: null });
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="System workspace"
        title="Hospitals &amp; blood banks"
        description="Registering a hospital or blood bank also creates its first facility admin account."
        actions={<><Button variant="secondary" onClick={() => openCreateModal("hospital")}>Add hospital</Button><Button onClick={() => openCreateModal("bloodBank")}>Add blood bank</Button></>}
      />
      {action.success ? <Notice tone="success" title="Facility created">{action.success}</Notice> : null}
      <SectionCard title="Search & filters" description="Search facility name, address, or phone and optionally filter both lists by city.">
        <div className="form-grid form-grid-two">
          <Field label="Search hospitals and banks">
            <input value={search} onChange={(event) => {
              setSearch(event.target.value);
              hospitalPagination.resetPage();
              bankPagination.resetPage();
            }} placeholder="Facility name, address, or phone" />
          </Field>
          <Field label="City shard">
            <select value={cityFilter} onChange={(event) => {
              setCityFilter(event.target.value);
              hospitalPagination.resetPage();
              bankPagination.resetPage();
            }}>
              <option value="">All cities</option>
              {CITIES.map((item) => <option key={item.cityCode} value={item.cityCode}>{item.cityCode} · {item.name}</option>)}
            </select>
          </Field>
        </div>
      </SectionCard>
      <SectionCard title="Hospitals" description="Active hospital records in the catalog.">
        {hospitals.loading ? <LoadingState label="Loading hospitals" /> : null}
        {hospitals.error ? <ErrorState error={hospitals.error} onRetry={hospitals.reload} /> : null}
        {!hospitals.loading && !hospitals.error ? hospitalRows.length ? <>
          <div className="table-wrap"><table className="data-table"><thead><tr><th>Name</th><th>City</th><th>Address</th><th>Phone</th><th>Coordinates</th><th>Hospital ID</th><th className="table-actions-head">Actions</th></tr></thead><tbody>{visibleHospitals.map((row) => <tr key={row.hospitalId}><td><strong>{row.name}</strong></td><td>{row.cityCode}</td><td>{row.address || "—"}</td><td>{row.phone || "—"}</td><td>{row.latitude ? `${row.latitude}, ${row.longitude}` : "—"}</td><td className="mono-text">{row.hospitalId?.slice(0, 8)}</td><td><Button variant="danger" size="sm" onClick={() => { setDeleteError(null); setPendingDelete({ kind: "hospital", id: row.hospitalId, name: row.name }); }}>Delete</Button></td></tr>)}</tbody></table></div>
          <PaginationControls page={hospitalPagination.page} pageSize={pageSize} totalItems={hospitalRows.length} onPageChange={hospitalPagination.setPage} />
        </> : <EmptyState title="No hospitals registered">Add a hospital with the button above, then attach an admin account from the Users page.</EmptyState> : null}
      </SectionCard>
      <SectionCard title="Blood banks" description="Active blood bank records in the catalog.">
        {banks.loading ? <LoadingState label="Loading blood banks" /> : null}
        {banks.error ? <ErrorState error={banks.error} onRetry={banks.reload} /> : null}
        {!banks.loading && !banks.error ? bankRows.length ? <>
          <div className="table-wrap"><table className="data-table"><thead><tr><th>Name</th><th>City</th><th>Address</th><th>Phone</th><th>Coordinates</th><th>Bank ID</th><th className="table-actions-head">Actions</th></tr></thead><tbody>{visibleBanks.map((row) => <tr key={row.bloodBankId}><td><strong>{row.name}</strong></td><td>{row.cityCode}</td><td>{row.address || "—"}</td><td>{row.phone || "—"}</td><td>{row.latitude ? `${row.latitude}, ${row.longitude}` : "—"}</td><td className="mono-text">{row.bloodBankId?.slice(0, 8)}</td><td><Button variant="danger" size="sm" onClick={() => { setDeleteError(null); setPendingDelete({ kind: "bloodBank", id: row.bloodBankId, name: row.name }); }}>Delete</Button></td></tr>)}</tbody></table></div>
          <PaginationControls page={bankPagination.page} pageSize={pageSize} totalItems={bankRows.length} onPageChange={bankPagination.setPage} />
        </> : <EmptyState title="No blood banks registered">Add a blood bank with the button above, then attach an admin account from the Users page.</EmptyState> : null}
      </SectionCard>
      <Modal open={showCreateModal} title={`Add ${entity === "hospital" ? "hospital" : "blood bank"}`} onClose={closeCreateModal}>
        <form className="stack-form" noValidate onSubmit={submit}>
          <Field label="City shard" hint="Required" error={errors.cityCode}>
            <select value={form.cityCode} onChange={(event) => update("cityCode", event.target.value)}>
              <option value="">Select a city</option>
              {CITIES.map((item) => <option key={item.cityCode} value={item.cityCode}>{item.cityCode} · {item.name}</option>)}
            </select>
          </Field>
          <Field label="Name" hint="Required" error={errors.name}><input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder={entity === "hospital" ? "e.g. Lahore General Hospital" : "e.g. Central Blood Bank"} /></Field>
          <Field label="Address" error={errors.address}><input value={form.address} onChange={(event) => update("address", event.target.value)} placeholder="Street address" /></Field>
          <Field label="Phone" error={errors.phone}><input value={form.phone} onChange={(event) => update("phone", event.target.value)} placeholder="+92-000-0000000" /></Field>
          <>
            <div className="auth-role-note"><span className="info-mark"><Icon name="shield" size={13} /></span><span>{entity === "hospital" ? "Hospital Admin" : "Blood-bank Admin"} portal login</span></div>
            <Field label="Admin username" hint="Required, unique" error={errors.username}><input autoComplete="username" value={form.username} onChange={(event) => update("username", event.target.value)} placeholder="hospital.admin" /></Field>
            <Field label="Admin email" hint="Required, unique" error={errors.email}><input type="email" autoComplete="email" value={form.email} onChange={(event) => update("email", event.target.value)} placeholder="admin@hospital.example" /></Field>
            <Field label="Admin password" hint="At least 8 characters" error={errors.password}><input type="password" autoComplete="new-password" value={form.password} onChange={(event) => update("password", event.target.value)} placeholder="Create a password" /></Field>
          </>
          <div className="form-grid form-grid-two">
            <Field label="Latitude" error={errors.latitude}><input type="number" step="any" value={form.latitude} onChange={(event) => update("latitude", event.target.value)} placeholder="31.520400" /></Field>
            <Field label="Longitude" error={errors.longitude}><input type="number" step="any" value={form.longitude} onChange={(event) => update("longitude", event.target.value)} placeholder="74.358700" /></Field>
          </div>
          {action.error ? <Notice tone="error" title="Could not create facility">{friendlyError(action.error)}{errorDetails(action.error) ? ` ${errorDetails(action.error)}` : ""}</Notice> : null}
          <div className="facility-form-actions">
            <Button variant="secondary" onClick={closeCreateModal} disabled={action.loading}>Cancel</Button>
            <Button type="submit" disabled={action.loading || !form.cityCode}>{action.loading ? "Creating…" : `Create ${entity === "hospital" ? "hospital" : "blood bank"}`}</Button>
          </div>
          {!form.cityCode ? <span className="field-hint">Select a city shard to enable creation.</span> : null}
        </form>
      </Modal>
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
  { value: "DONOR", label: "Donor" },
  { value: "SYSTEM_ADMIN", label: "System admin" },
];

export function UsersPage() {
  const [form, setForm] = useState({ username: "", email: "", password: "", role: "DONOR", facilityId: "", donorCity: "" });
  const [action, setAction] = useState({ loading: false, error: null, success: null });
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);
  const [cityFilter, setCityFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const { page, limit, setPage, resetPage } = usePagination({ defaultLimit: 25 });
  const { errors, setErrors, clearError } = useFieldErrors();
  const users = useRequest(
    () => api.system.listUsers({ page, limit, ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}), ...(cityFilter ? { city: cityFilter } : {}), ...(roleFilter ? { role: roleFilter } : {}) }),
    [page, limit, debouncedSearch, cityFilter, roleFilter],
  );
  const donors = useRequest(
    () => form.role === "DONOR" && form.donorCity
      ? api.search.donors({ city: form.donorCity, limit: 100 })
      : Promise.resolve({ donors: [] }),
    [form.role, form.donorCity],
  );
  const userRows = listFrom(users.data, ["users"]);
  const donorRows = listFrom(donors.data, ["donors"]);

  function update(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
    clearError(name);
  }

  function openCreateModal() {
    setForm({ username: "", email: "", password: "", role: "DONOR", facilityId: "", donorCity: "" });
    setErrors({});
    setAction({ loading: false, error: null, success: null });
    setShowCreateModal(true);
  }

  function closeCreateModal() {
    if (!action.loading) setShowCreateModal(false);
  }

  async function submit(event) {
    event.preventDefault();
    const nextErrors = validate(form, USER_RULES);
    if (form.role === "DONOR" && !form.facilityId) nextErrors.facilityId = "Select a donor profile.";
    if (form.role === "DONOR" && !form.donorCity) nextErrors.donorCity = "Donor city shard is required.";
    setErrors(nextErrors);
    if (hasErrors(nextErrors)) return;
    setAction({ loading: true, error: null, success: null });
    const body = { username: form.username, email: form.email, password: form.password, role: form.role };
    if (form.role === "DONOR") {
      body.donorId = form.facilityId;
      body.donorCityCode = form.donorCity;
    }
    try {
      const created = await api.system.createUser(body);
      setAction({ loading: false, error: null, success: `Account "${created.user?.username || form.username}" created. It can sign in at /login immediately.` });
      setForm({ username: "", email: "", password: "", role: "DONOR", facilityId: "", donorCity: "" });
      setShowCreateModal(false);
      resetPage();
      users.reload();
    } catch (error) {
      setAction({ loading: false, error, success: null });
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="System workspace"
        title="Users"
        description="Every portal identity in the system. Hospital and blood-bank accounts are tenant scoped to the facility they are attached to."
        actions={<><Button variant="secondary" onClick={users.reload} disabled={users.loading}>Refresh list</Button><Button onClick={openCreateModal}>Add user</Button></>}
      />
      {action.success ? <Notice tone="success" title="Account created">{action.success}</Notice> : null}
      <SectionCard title="Account directory" description="All portal identities across every city shard. Donor example emails are generated placeholders, not contact addresses.">
        <div className="form-grid form-grid-three user-directory-filters">
          <Field label="Search users">
            <input value={search} onChange={(event) => { setSearch(event.target.value); resetPage(); }} placeholder="Search username, email, or facility" />
          </Field>
          <Field label="City shard">
            <select value={cityFilter} onChange={(event) => { setCityFilter(event.target.value); resetPage(); }}>
              <option value="">All cities</option>
              {CITIES.map((item) => <option key={item.cityCode} value={item.cityCode}>{item.cityCode} · {item.name}</option>)}
            </select>
          </Field>
          <Field label="Role">
            <select value={roleFilter} onChange={(event) => { setRoleFilter(event.target.value); resetPage(); }}>
              <option value="">All roles</option>
              {[
                ["DONOR", "Donor"],
                ["SYSTEM_ADMIN", "System admin"],
                ["HOSPITAL_ADMIN", "Hospital admin"],
                ["BLOODBANK_ADMIN", "Blood-bank admin"],
              ].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
        </div>
        {users.loading ? <LoadingState label="Loading accounts" /> : null}
        {users.error ? <ErrorState error={users.error} onRetry={users.reload} /> : null}
        {users.data?.totalApproximate ? <Notice tone="info" title="Estimated account total">The unfiltered total uses PostgreSQL row statistics so the directory can load without counting every account.</Notice> : null}
        {!users.loading && !users.error ? userRows.length ? <>
          <div className="table-wrap"><table className="data-table"><thead><tr><th>Name / username</th><th>Role</th><th>Email</th><th>Scope</th><th>Status</th><th>Created</th></tr></thead><tbody>{userRows.map((row) => {
            const donorEmailName = row.donorName
              ?.normalize("NFKD")
              .replace(/[\u0300-\u036f]/g, "")
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, ".")
              .replace(/^\.+|\.+$/g, "");
            const email = row.role === "DONOR" && row.email?.endsWith("@donors.example.test")
              ? `${donorEmailName || "donor"}.${row.donorId?.slice(0, 8) || row.userId.slice(0, 8)}@donors.example.test`
              : row.email;
            return <tr key={row.userId}><td><strong>{row.donorName || (row.role === "DONOR" ? "Donor profile unavailable" : row.username)}</strong></td><td><RoleBadge role={row.role} /></td><td>{email}</td><td>{row.hospitalId ? `Hospital ${row.hospitalId.slice(0, 8)}` : row.bloodBankId ? `Bank ${row.bloodBankId.slice(0, 8)}` : row.role === "DONOR" ? `Donor · ${row.donorCityCode}` : "All cities"}</td><td><StatusBadge status={row.isActive === false ? "INACTIVE" : "ACTIVE"} /></td><td>{formatDateTime(row.createdAt)}</td></tr>;
          })}</tbody></table></div>
          <PaginationControls page={page} pageSize={limit} totalItems={users.data?.total ?? userRows.length} onPageChange={setPage} />
        </> : <EmptyState title="No users matched">Change the search or city filter and try again.</EmptyState> : null}
      </SectionCard>
      <Modal open={showCreateModal} title="Add user" onClose={closeCreateModal}>
        <form className="stack-form" noValidate onSubmit={submit}>
          <p className="modal-copy">The account can sign in as soon as it is created. Donor accounts must be linked to an existing donor profile.</p>
          <div className="form-grid form-grid-two">
            <Field label="Role">
              <select value={form.role} onChange={(event) => { update("role", event.target.value); update("facilityId", ""); update("donorCity", ""); }}>
                {USER_ROLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </Field>
            <Field label="Username" hint="Required, unique" error={errors.username}><input value={form.username} onChange={(event) => update("username", event.target.value)} placeholder="lhe.hospital.admin" /></Field>
          </div>
          <Field label="Email" hint="Required" error={errors.email}><input type="email" value={form.email} onChange={(event) => update("email", event.target.value)} placeholder="admin@example.test" /></Field>
          <Field label="Password" hint="Minimum 8 characters" error={errors.password}><input type="password" value={form.password} onChange={(event) => update("password", event.target.value)} /></Field>
          {form.role === "DONOR" ? (
            <div className="form-grid form-grid-two">
              <Field label="Donor city shard" hint="Required" error={errors.donorCity}>
                <select value={form.donorCity} onChange={(event) => update("donorCity", event.target.value)}>
                  <option value="">Select a city</option>
                  {CITIES.map((item) => <option key={item.cityCode} value={item.cityCode}>{item.cityCode} · {item.name}</option>)}
                </select>
              </Field>
              <Field label="Donor profile" hint="Choose an existing profile" error={errors.facilityId}>
                <select value={form.facilityId} onChange={(event) => update("facilityId", event.target.value)} disabled={!form.donorCity || donors.loading}>
                  <option value="">{!form.donorCity ? "Select a city first" : donors.loading ? "Loading donors…" : donorRows.length ? "Select a donor" : "No donors found in this city"}</option>
                  {donorRows.map((donor) => <option key={donor.donorId} value={donor.donorId}>{donor.fullName} · {formatBloodType(donor.bloodGroup, donor.rhFactor)}</option>)}
                </select>
              </Field>
            </div>
          ) : null}
          {action.error ? <Notice tone="error" title="Could not create account">{friendlyError(action.error)}{errorDetails(action.error) ? ` ${errorDetails(action.error)}` : ""}</Notice> : null}
          <div className="facility-form-actions">
            <Button variant="secondary" onClick={closeCreateModal} disabled={action.loading}>Cancel</Button>
            <Button type="submit" disabled={action.loading}>{action.loading ? "Creating…" : "Create account"}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [days ? `${days}d` : null, hours ? `${hours}h` : null, `${minutes}m`]
    .filter(Boolean)
    .join(" ");
}

function databaseNodeLabel(node, kind) {
  if (!node?.configured) return kind === "replica" ? "No physical standby" : "Unavailable";
  if (node.status === "not_checked") return "Not checked";
  if (node.status === "unavailable") return "Unreachable";
  if (node.status === "wrong_role") return kind === "primary" ? "Standby (unexpected)" : "Primary (unexpected)";
  if (node.status === "read_only") return "Read-only (unexpected primary)";
  if (node.status === "wrong_database") return "Connected · wrong database";
  if (node.status === "not_streaming") return "Connected · not streaming";
  return kind === "replica" ? "Streaming" : "Connected";
}

export function ClusterPage() {
  const request = useRequest(() => api.system.cluster(), []);
  const controlsRequest = useRequest(() => api.system.chaosStatus(), []);
  const reloadRef = useRef(request.reload);
  reloadRef.current = request.reload;
  useEffect(() => {
    const interval = window.setInterval(() => reloadRef.current(), 30_000);
    return () => window.clearInterval(interval);
  }, []);
  useAutoRefresh(controlsRequest.reload, 2500);
  const cities = cityEntries(request.data?.cities);
  const totalAvailable = cities.reduce((sum, city) => sum + Number(city.available_units ?? 0), 0);
  const totalReserved = cities.reduce((sum, city) => sum + Number(city.reserved_units ?? 0), 0);
  const respondingCities = cities.filter((city) => city.primary?.status === "up").length;
  const clusterHasIssues = cities.some((city) =>
    city.primary?.status !== "up" || (city.replica?.configured && city.replica?.status !== "up"),
  );
  return (
    <div className="page-stack">
      <PageHeader eyebrow="System workspace" title="Cluster status" description="Live PostgreSQL health and shared application simulation state for every city shard." actions={<Button variant="secondary" onClick={() => { request.reload(); controlsRequest.reload(); }}>Refresh cluster</Button>} />
      {request.data?.meta ? <PartialResults meta={request.data.meta} /> : null}
      {request.loading ? <SectionCard><LoadingState label="Loading cluster status" /></SectionCard> : null}{request.error ? <ErrorState error={request.error} onRetry={request.reload} /> : null}
      {request.data ? <>
        <div className="stat-grid">
          <div className="stat-card stat-card-blue"><span>Available units</span><strong>~{formatNumber(totalAvailable)}</strong><small>Estimated · {respondingCities} responding cities</small></div>
          <div className="stat-card stat-card-amber"><span>Reserved / dispatched</span><strong>~{formatNumber(totalReserved)}</strong><small>Estimated inventory status</small></div>
          <div className="stat-card stat-card-purple"><span>Cities</span><strong>{cities.length}</strong><small>Configured shards</small></div>
          <div className="stat-card stat-card-slate"><span>Instance</span><strong className="stat-instance">{request.data.instance_id || "—"}</strong><small>Monitoring API</small></div>
        </div>
        <SectionCard title="Live PostgreSQL telemetry" description="Connection, server role, uptime, connection usage, and inventory are checked directly from PostgreSQL." >
          {clusterHasIssues ? <Notice tone="warning" title="Cluster needs attention">One or more configured database nodes are unreachable or have an unexpected role.</Notice> : null}

          {cities.length ? <div className="telemetry-grid">{cities.map((city) => {
            const primary = city.primary;
            const replica = city.replica;
            const healthy = primary?.status === "up" && (!replica?.configured || replica?.status === "up");
            return (
              <article className="telemetry-card" key={city.code}>
                <div className="telemetry-header">
                  <div><span className="eyebrow">City shard</span><h3>{city.code}</h3></div>
                  <StatusBadge status={healthy ? replica?.configured ? "Healthy" : "Connected" : "Attention"} />
                </div>
                <div className="telemetry-signal">
                  <span>Primary database</span>
                  <strong>{databaseNodeLabel(primary, "primary")}</strong>
                </div>
                {primary?.configured && primary?.status !== "unavailable" ? (
                  <small className="telemetry-updated">
                    PostgreSQL {primary.server_version} · uptime {formatUptime(primary.uptime_seconds)}
                  </small>
                ) : null}
                {replica?.configured ? (
                  <>
              {replica?.configured ? (
                <>
                  <div className="telemetry-signal">
                    <span>Optional physical standby</span>
                    <strong>{databaseNodeLabel(replica, "replica")}</strong>
                  </div>
                  {replica.status === "unavailable" ? (
                    <small className="telemetry-updated">Probe failed: {replica.error_code}</small>
                  ) : null}
                </>
              ) : null}
                  </>
                ) : null}
                <div className="telemetry-metrics">
                  <div><span>Inventory</span><strong>{city.reachable && city.available_units != null ? `~${formatNumber(city.available_units)}` : "Unavailable"}</strong><small>available · estimated</small></div>
                  <div><span>Holds</span><strong>{city.reachable && city.reserved_units != null ? `~${formatNumber(city.reserved_units)}` : "Unavailable"}</strong><small>reserved · estimated</small></div>
                  <div><span>Primary connections</span><strong>{primary?.connections == null ? "—" : `${formatNumber(primary.connections)} / ${formatNumber(primary.max_connections)}`}</strong><small>connected / max</small></div>
                  {replica?.configured ? (
                    <div><span>Streaming replicas</span><strong>{primary?.streaming_replicas == null ? "—" : formatNumber(primary.streaming_replicas)}</strong><small>connected to primary</small></div>
                  ) : null}
                  {replica?.configured ? (
                    <div><span>Replica WAL lag</span><strong>{replica?.replay_lag_bytes == null ? "—" : `${formatNumber(replica.replay_lag_bytes)} B`}</strong><small>{replica?.replay_delay_ms == null ? "no replay timestamp" : `last replay ${formatNumber(replica.replay_delay_ms)} ms ago`}</small></div>
                  ) : null}
                </div>
                <ChaosSimulationSummary flags={controlsRequest.data?.flags?.[city.code]} />
                <small className="telemetry-updated">Probe completed {formatDateTime(city.updated_at)}</small>
              </article>
            );
          })}</div> : <EmptyState title="No cluster rows">The control plane did not return city telemetry.</EmptyState>}
          {controlsRequest.error ? <ErrorState error={controlsRequest.error} onRetry={controlsRequest.reload} /> : null}
        </SectionCard>
      </> : null}
    </div>
  );
}
