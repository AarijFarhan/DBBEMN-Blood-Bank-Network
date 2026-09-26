import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { ROLE_LABELS, ROLE_SHORT_LABELS, roleHome } from "../constants";
import { useAuth } from "../auth";
import { displayUserName } from "../utils";
import { Button, RoleBadge, UserAvatar } from "./UI";

const navigation = {
  HOSPITAL_ADMIN: [
    { to: "/app/hospital/search", label: "Find blood", detail: "Search & reserve" },
    { to: "/app/hospital/reservations", label: "Reservations", detail: "Track requests" },
    { to: "/app/hospital/donor-requests", label: "Donor call-outs", detail: "Ask a donor" },
  ],
  BLOODBANK_ADMIN: [
    { to: "/app/bank/inventory", label: "Inventory", detail: "Units & expiry" },
    { to: "/app/bank/donations", label: "Donations", detail: "Record collection" },
    { to: "/app/bank/donor-requests", label: "Donor call-outs", detail: "Ask a donor" },
    { to: "/app/bank/screening", label: "Screening", detail: "Pending checks" },
    { to: "/app/bank/dispatch", label: "Dispatch", detail: "Release units" },
    { to: "/app/bank/discard", label: "Discard", detail: "Quarantine control" },
  ],
  DONOR: [
    { to: "/app/donor/profile", label: "My profile", detail: "Eligibility" },
    { to: "/app/donor/requests", label: "Blood requests", detail: "Accept or decline" },
    { to: "/app/donor/donations", label: "Donation history", detail: "Past collections" },
  ],
  SYSTEM_ADMIN: [
    { to: "/app/system/health", label: "Health", detail: "Service checks" },
    { to: "/app/system/chaos", label: "Chaos controls", detail: "Failure switches" },
    { to: "/app/system/cluster", label: "Cluster status", detail: "Shard telemetry" },
    { to: "/app/system/donors", label: "Donor directory", detail: "Availability by city" },
    { to: "/app/system/hospitals", label: "Hospitals & banks", detail: "Register facilities" },
    { to: "/app/system/users", label: "Users", detail: "Accounts and access" },
  ],
};

export default function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const items = navigation[user?.role] || [];

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}>
        <div className="brand-lockup">
          <span className="brand-mark">D</span>
          <div>
            <strong>DBBEMN</strong>
            <span>Blood bank network</span>
          </div>
        </div>
        <div className="workspace-label">
          <span>Workspace</span>
          <RoleBadge role={user?.role} />
        </div>
        <nav className="sidebar-nav" aria-label="Workspace navigation">
          <span className="nav-section-label">Operations</span>
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `nav-item ${isActive ? "nav-item-active" : ""}`}
              onClick={() => setMenuOpen(false)}
            >
              <span className="nav-item-mark" aria-hidden="true" />
              <span>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="session-card">
            <UserAvatar user={user} size="sm" />
            <div>
              <strong>{displayUserName(user)}</strong>
              <span>{ROLE_SHORT_LABELS[user?.role] || "Workspace"}</span>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={handleLogout}>Sign out</Button>
        </div>
      </aside>
      {menuOpen ? <button type="button" className="sidebar-overlay" aria-label="Close navigation" onClick={() => setMenuOpen(false)} /> : null}
      <div className="main-column">
        <header className="topbar">
          <button type="button" className="mobile-menu-button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}>☰</button>
          <div className="topbar-context">
            <span className="topbar-dot" />
            <span>Secure workspace</span>
            <span className="topbar-divider" />
            <code>/api/v1</code>
          </div>
          <div className="topbar-role">{ROLE_LABELS[user?.role] || "Workspace"}</div>
        </header>
        <main className="main-content">
          <Outlet />
        </main>
        <footer className="app-footer">
          <span>DBBEMN operations portal</span>
          <span>Availability signals may be delayed across the network.</span>
        </footer>
      </div>
    </div>
  );
}
