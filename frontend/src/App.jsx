import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import { roleHome } from "./constants";
import AppShell from "./components/AppShell";
import { LoadingState } from "./components/UI";
import { LoginPage, RegisterPage } from "./pages/AuthPages";
import { HospitalReservationsPage, HospitalSearchPage } from "./pages/HospitalPages";
import { BankDiscardPage, BankDonationsPage, BankDispatchPage, BankInventoryPage, BankScreeningPage } from "./pages/BankPages";
import { DonorDonationsPage, DonorProfilePage } from "./pages/DonorPages";
import { ChaosPage, ClusterPage, DonorDirectoryPage, HealthPage, HospitalsBanksPage, UsersPage } from "./pages/SystemPages";
import { MyDonorRequestsPage, SendDonorRequestsPage } from "./pages/RequestPages";

function RequireAuth({ roles, children }) {
  const { user, booting, session } = useAuth();
  if (booting) return <div className="full-page-state"><LoadingState label="Restoring secure session" /></div>;
  if (!session || !user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to={roleHome(user.role)} replace />;
  return children;
}

function LandingRedirect() {
  const { user, booting } = useAuth();
  if (booting) return <div className="full-page-state"><LoadingState label="Opening workspace" /></div>;
  return <Navigate to={user ? roleHome(user.role) : "/login"} replace />;
}

function NotFound() {
  const { user } = useAuth();
  return <Navigate to={user ? roleHome(user.role) : "/login"} replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route element={<RequireAuth roles={["HOSPITAL_ADMIN"]}><AppShell /></RequireAuth>}>
            <Route path="/app/hospital/search" element={<HospitalSearchPage />} />
            <Route path="/app/hospital/reservations" element={<HospitalReservationsPage />} />
            <Route path="/app/hospital/donor-requests" element={<SendDonorRequestsPage />} />
          </Route>
          <Route element={<RequireAuth roles={["BLOODBANK_ADMIN"]}><AppShell /></RequireAuth>}>
            <Route path="/app/bank/inventory" element={<BankInventoryPage />} />
            <Route path="/app/bank/donations" element={<BankDonationsPage />} />
            <Route path="/app/bank/screening" element={<BankScreeningPage />} />
            <Route path="/app/bank/dispatch" element={<BankDispatchPage />} />
            <Route path="/app/bank/discard" element={<BankDiscardPage />} />
            <Route path="/app/bank/donor-requests" element={<SendDonorRequestsPage />} />
          </Route>
          <Route element={<RequireAuth roles={["DONOR"]}><AppShell /></RequireAuth>}>
            <Route path="/app/donor/profile" element={< DonorProfilePage />} />
            <Route path="/app/donor/donations" element={<DonorDonationsPage />} />
            <Route path="/app/donor/requests" element={<MyDonorRequestsPage />} />
          </Route>
          <Route element={<RequireAuth roles={["SYSTEM_ADMIN"]}><AppShell /></RequireAuth>}>
            <Route path="/app/system/health" element={<HealthPage />} />
            <Route path="/app/system/chaos" element={<ChaosPage />} />
            <Route path="/app/system/cluster" element={<ClusterPage />} />
            <Route path="/app/system/donors" element={<DonorDirectoryPage />} />
            <Route path="/app/system/hospitals" element={<HospitalsBanksPage />} />
            <Route path="/app/system/users" element={<UsersPage />} />
          </Route>
          <Route path="/" element={<LandingRedirect />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
