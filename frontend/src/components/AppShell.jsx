import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { ROLE_LABELS, ROLE_SHORT_LABELS } from "../constants";
import { useAuth } from "../auth";
import { useRequest } from "../hooks/useRequest";
import { api } from "../api";
import { displayUserName, listFrom } from "../utils";
import { Button, Icon, RoleBadge, UserAvatar } from "./UI";

const navigation = {
  HOSPITAL_ADMIN: [
    { to: "/app/hospital/search", label: "Find blood", detail: "Search & reserve", icon: "search" },
    { to: "/app/hospital/reservations", label: "Reservations", detail: "Track requests", icon: "calendar" },
    { to: "/app/hospital/donor-requests", label: "Donor call-outs", detail: "Ask a donor", icon: "megaphone" },
    { to: "/app/hospital/map", label: "Network map", detail: "Live stock map", icon: "map" },
  ],
  BLOODBANK_ADMIN: [
    { to: "/app/bank/dashboard", label: "Dashboard", detail: "Live analytics", icon: "gauge" },
    { to: "/app/bank/inventory", label: "Inventory", detail: "Units & expiry", icon: "boxes" },
    { to: "/app/bank/donations", label: "Donations", detail: "Record collection", icon: "droplet" },
    { to: "/app/bank/donor-requests", label: "Donor call-outs", detail: "Ask a donor", icon: "megaphone" },
    { to: "/app/bank/screening", label: "Screening", detail: "Pending checks", icon: "beaker" },
    { to: "/app/bank/dispatch", label: "Dispatch", detail: "Release units", icon: "truck" },
    { to: "/app/bank/discard", label: "Discard", detail: "Quarantine control", icon: "trash" },
  ],
  DONOR: [
    { to: "/app/donor/profile", label: "My profile", detail: "Eligibility", icon: "user" },
    { to: "/app/donor/requests", label: "Blood requests", detail: "Accept or decline", icon: "inbox" },
    { to: "/app/donor/donations", label: "Donation history", detail: "Past collections", icon: "history" },
  ],
  SYSTEM_ADMIN: [
    { to: "/app/system/dashboard", label: "Analytics", detail: "Network dashboards", icon: "gauge" },
    { to: "/app/system/map", label: "Network map", detail: "Live stock map", icon: "map" },
    { to: "/app/system/health", label: "Health", detail: "Service checks", icon: "activity" },
    { to: "/app/system/chaos", label: "Chaos controls", detail: "Failure switches", icon: "sliders" },
    { to: "/app/system/cluster", label: "Cluster status", detail: "Shard telemetry", icon: "server" },
    { to: "/app/system/donors", label: "Donor directory", detail: "Availability by city", icon: "users" },
    { to: "/app/system/hospitals", label: "Hospitals & banks", detail: "Register facilities", icon: "hospital" },
    { to: "/app/system/users", label: "Registered Users", detail: "Accounts and access", icon: "shield" },
  ],
};

export default function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const items = navigation[user?.role] || [];
  const current = items.find((item) => location.pathname.startsWith(item.to));
  const donorRequests = useRequest(
    () => user?.role === "DONOR" ? api.donorRequests.list({ limit: 50 }) : Promise.resolve({ requests: [] }),
    [user?.role],
  );
  const pendingDonorRequests = user?.role === "DONOR"
    ? listFrom(donorRequests.data, ["requests"]).filter((request) => request.status === "PENDING").length
    : 0;

  useEffect(() => {
    if (user?.role === "DONOR") donorRequests.reload();
  }, [location.pathname, user?.role]);

  useEffect(() => {
    if (user?.role !== "DONOR") return undefined;
    const refreshRequests = () => donorRequests.reload();
    const intervalId = window.setInterval(refreshRequests, 30_000);
    window.addEventListener("donor-requests-updated", refreshRequests);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("donor-requests-updated", refreshRequests);
    };
  }, [user?.role]);

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}>
        <div className="brand-lockup">
          <span className="brand-mark"><Icon name="droplet" size={20} /></span>
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
              <span className="nav-item-mark" aria-hidden="true"><Icon name={item.icon} size={17} /></span>
              <span className="nav-item-copy">
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </span>
              {item.to === "/app/donor/requests" && pendingDonorRequests > 0 ? (
                <span
                  className="nav-notification"
                  aria-label={`${pendingDonorRequests} pending blood ${pendingDonorRequests === 1 ? "request" : "requests"}`}
                  title={`${pendingDonorRequests} pending blood ${pendingDonorRequests === 1 ? "request" : "requests"}`}
                >
                  {pendingDonorRequests > 99 ? "99+" : pendingDonorRequests}
                </span>
              ) : null}
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
          <Button variant="ghost" size="sm" onClick={handleLogout}>
            <Icon name="logout" size={16} />
            Sign out
          </Button>
        </div>
      </aside>
      {menuOpen ? <button type="button" className="sidebar-overlay" aria-label="Close navigation" onClick={() => setMenuOpen(false)} /> : null}
      <div className="main-column">
        <header className="topbar">
          <button type="button" className="mobile-menu-button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}>
            <Icon name="menu" size={18} />
          </button>
          <div className="topbar-context">
            <span className="topbar-dot" />
            <strong>{current?.label || "Workspace"}</strong>
            <span className="topbar-divider" />
            <span className="topbar-subtle">Secure workspace</span>
            {/* <span className="topbar-divider" /> */}
            {/* <code>/api/v1</code> */}
          </div>
          <div className="topbar-role">{ROLE_LABELS[user?.role] || "Workspace"}</div>
        </header>
        <main className="main-content">
          <Outlet />
        </main>
        <footer className="app-footer">
          <span>DBBEMN operations portal</span>
          
        </footer>
      </div>
    </div>
  );
}
