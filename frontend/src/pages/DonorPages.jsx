import { useMemo, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { useRequest } from "../hooks/useRequest";
import { Button, EmptyState, ErrorState, Field, LoadingState, Notice, PageHeader, SectionCard, StatusBadge } from "../components/UI";
import { ageFromDate, errorDetails, formatBloodType, formatDate, formatDateTime, formatNumber, friendlyError, listFrom } from "../utils";

function DonorEligibility({ donor }) {
  const age = ageFromDate(donor.dateOfBirth);
  const weight = Number(donor.weightKg);
  const lastDate = donor.lastDonationDate ? new Date(`${donor.lastDonationDate}T00:00:00`) : null;
  const nextEligible = lastDate ? new Date(lastDate.getTime() + 90 * 86400000) : null;
  const checks = [
    { label: "Age 18–65", pass: age !== null && age >= 18 && age <= 65, detail: age === null ? "Date unavailable" : `${age} years` },
    { label: "Weight at least 50 kg", pass: weight >= 50, detail: `${formatNumber(weight)} kg` },
    { label: "Available to donate", pass: Boolean(donor.isAvailable), detail: donor.isAvailable ? "Accepting requests" : "Temporarily unavailable" },
    { label: "90-day interval", pass: !nextEligible || nextEligible <= new Date(), detail: nextEligible ? `Next eligible ${formatDate(nextEligible)}` : "No previous donation" },
  ];
  return <div className="eligibility-list">{checks.map((check) => <div className="eligibility-row" key={check.label}><span className={check.pass ? "check-pass" : "check-wait"}>{check.pass ? "✓" : "—"}</span><div><strong>{check.label}</strong><small>{check.detail}</small></div></div>)}</div>;
}

export function DonorProfilePage() {
  const { user } = useAuth();
  const donorId = user?.donorId;
  const [action, setAction] = useState({ loading: false, error: null, success: null });
  const request = useRequest(() => donorId ? api.donors.get(donorId) : Promise.reject(new Error("Your account is not linked to a donor profile.")), [donorId]);
  const donor = request.data?.donor;
  const isAvailable = Boolean(donor?.isAvailable);

  async function toggleAvailability() {
    if (!donorId) return;
    setAction({ loading: true, error: null, success: null });
    try {
      await api.donors.availability(donorId, !isAvailable);
      setAction({ loading: false, error: null, success: !isAvailable ? "You are now available to donate." : "Your availability is paused." });
      request.reload();
    } catch (error) {
      setAction({ loading: false, error, success: null });
    }
  }

  return (
    <div className="page-stack">
      <PageHeader eyebrow="Donor workspace" title="My profile" description="Keep your contact and availability signals current for nearby blood banks." actions={<Button variant={isAvailable ? "secondary" : "primary"} onClick={toggleAvailability} disabled={action.loading || request.loading}>{action.loading ? "Saving…" : isAvailable ? "Pause availability" : "Make available"}</Button>} />
      {action.success ? <Notice tone="success" title="Availability updated">{action.success}</Notice> : null}{action.error ? <Notice tone="error" title="Could not update availability">{friendlyError(action.error)}{errorDetails(action.error) ? ` ${errorDetails(action.error)}` : ""}</Notice> : null}
      {request.loading ? <SectionCard><LoadingState label="Loading donor profile" /></SectionCard> : null}
      {request.error ? <ErrorState error={request.error} onRetry={request.reload} /> : null}
      {donor ? <>
        <div className="profile-hero"><div className="profile-identity"><div className="profile-avatar">{donor.fullName?.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</div><div><span className="eyebrow">Donor identity</span><h2>{donor.fullName}</h2><p>{formatBloodType(donor.bloodGroup, donor.rhFactor)} · {donor.cityCode}</p></div></div><div className="availability-panel"><span>Current signal</span><strong>{isAvailable ? "Available" : "Paused"}</strong><small>Blood banks see this signal when scheduling a collection.</small></div></div>
        <div className="workspace-grid workspace-grid-wide"><SectionCard title="Eligibility snapshot" description="The primary shard is authoritative when a collection is submitted."><DonorEligibility donor={donor} /></SectionCard><SectionCard title="Donor details" description="Keep these details current with your registration profile."><div className="detail-grid"><div><span>Date of birth</span><strong>{formatDate(donor.dateOfBirth)}</strong></div><div><span>Weight</span><strong>{formatNumber(donor.weightKg)} kg</strong></div><div><span>Phone</span><strong>{donor.phone}</strong></div><div><span>Last donation</span><strong>{formatDate(donor.lastDonationDate)}</strong></div><div><span>City shard</span><strong>{donor.cityCode}</strong></div><div><span>Profile ID</span><strong className="mono-text">{donor.donorId}</strong></div></div></SectionCard></div>
      </> : null}
    </div>
  );
}

export function DonorDonationsPage() {
  const { user } = useAuth();
  const donorId = user?.donorId;
  const request = useRequest(() => donorId ? api.donations.list({ donorId, limit: 100 }) : Promise.reject(new Error("Your account is not linked to a donor profile.")), [donorId]);
  const donations = listFrom(request.data, ["donations"]);
  const passed = useMemo(() => donations.filter((donation) => donation.screeningStatus === "PASSED").length, [donations]);
  return (
    <div className="page-stack">
      <PageHeader eyebrow="Donor workspace" title="Donation history" description="A private history of collections recorded against your donor profile." />
      <div className="stat-grid"><div className="stat-card stat-card-blue"><span>Total collections</span><strong>{donations.length}</strong><small>Recorded history</small></div><div className="stat-card stat-card-green"><span>Passed screening</span><strong>{passed}</strong><small>Completed checks</small></div><div className="stat-card stat-card-amber"><span>Pending review</span><strong>{donations.length - passed}</strong><small>Awaiting bank result</small></div></div>
      <SectionCard title="Collection timeline" description="Use a pseudonymous reference for any follow-up with a blood bank.">
        {request.loading ? <LoadingState label="Loading donation history" /> : null}{request.error ? <ErrorState error={request.error} onRetry={request.reload} /> : null}{!request.loading && !request.error ? donations.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Collected</th><th>Volume</th><th>Screening</th><th>Bank</th><th>Donation ID</th></tr></thead><tbody>{donations.map((donation) => <tr key={donation.donationId}><td>{formatDateTime(donation.collectedAt)}</td><td>{formatNumber(donation.volumeMl)} ml</td><td><StatusBadge status={donation.screeningStatus} /></td><td className="mono-text">{donation.bloodBankId?.slice(0, 12)}</td><td className="mono-text">{donation.donationId?.slice(0, 12)}</td></tr>)}</tbody></table></div> : <EmptyState title="No donations yet">Your completed and pending collections will appear here.</EmptyState> : null}
      </SectionCard>
    </div>
  );
}
