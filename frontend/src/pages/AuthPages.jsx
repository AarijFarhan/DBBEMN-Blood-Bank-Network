import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CITIES } from "../constants";
import { api } from "../api";
import { useAuth } from "../auth";
import { Button, Field, Notice, PageHeader } from "../components/UI";
import { errorDetails, friendlyError } from "../utils";
import { ROLE_LABELS } from "../constants";
import { Navigate } from "react-router-dom";
import { roleHome } from "../constants";

function AuthFrame({ children, mode }) {
  return (
    <div className="auth-page">
      <div className="auth-visual">
        <div className="auth-brand"><span className="brand-mark">D</span><span>DBBEMN</span></div>
        <div className="auth-visual-copy">
          <span className="eyebrow eyebrow-light">Distributed care network</span>
          <h1>Every unit.<br /><em>Connected.</em></h1>
          <p>One operational view for hospitals, blood banks, donors, and the teams keeping the network moving.</p>
        </div>
        <div className="auth-network-lines" aria-hidden="true">
          <span /><span /><span /><span />
        </div>
        <div className="auth-visual-footer"><span>DBBEMN / 01</span><span>Secure role-based access</span></div>
      </div>
      <div className="auth-panel">
        <div className="auth-panel-inner">{children}</div>
        <div className="auth-panel-footer">Distributed Blood Bank &amp; Emergency Matching Network</div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { user, login, booting } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ login: "", password: "" });
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  if (!booting && user) return <Navigate to={roleHome(user.role)} replace />;

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const nextUser = await login(form);
      navigate(roleHome(nextUser.role), { replace: true });
    } catch (requestError) {
      setError(requestError);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthFrame mode="login">
      <div className="auth-heading">
        <span className="eyebrow">Operations portal</span>
        <h2>Welcome back</h2>
        <p>Sign in with your provisioned DBBEMN workspace account.</p>
      </div>
      {error ? <Notice tone="error" title="Sign-in failed">{friendlyError(error)}{errorDetails(error) ? ` ${errorDetails(error)}` : ""}</Notice> : null}
      <form className="stack-form" onSubmit={submit}>
        <Field label="Username or email">
          <input autoComplete="username" required value={form.login} onChange={(event) => setForm({ ...form, login: event.target.value })} placeholder="you@organization.org" />
        </Field>
        <Field label="Password" hint="Passwords are managed by your workspace administrator.">
          <input type="password" autoComplete="current-password" required minLength={12} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="Enter your password" />
        </Field>
        <Button type="submit" size="lg" disabled={submitting}>{submitting ? "Signing in…" : "Sign in to workspace"}</Button>
      </form>
      <div className="auth-switch">New donor? <Link to="/register">Create a donor profile</Link></div>
      <div className="auth-role-note"><span className="info-mark">i</span><span>Access is scoped to your role. Hospital and blood-bank records remain tenant isolated.</span></div>
    </AuthFrame>
  );
}

export function RegisterPage() {
  const { user, register } = useAuth();
  const navigate = useNavigate();
  const [cities, setCities] = useState(CITIES);
  const [form, setForm] = useState({
    username: "", email: "", password: "", fullName: "", phone: "", dateOfBirth: "", sex: "M", weightKg: "", bloodGroup: "O", rhFactor: "POS", cityCode: "KHI",
  });
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.catalog.cities()
      .then((result) => {
        if (Array.isArray(result?.cities) && result.cities.length) setCities(result.cities);
      })
      .catch(() => undefined);
  }, []);

  if (user) return <Navigate to={roleHome(user.role)} replace />;

  function update(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const nextUser = await register({ ...form, weightKg: Number(form.weightKg) });
      navigate(roleHome(nextUser.role), { replace: true });
    } catch (requestError) {
      setError(requestError);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthFrame mode="register">
      <div className="auth-heading">
        <span className="eyebrow">Donor onboarding</span>
        <h2>Join the network</h2>
        <p>Create a donor profile to manage availability and view your collection history.</p>
      </div>
      {error ? <Notice tone="error" title="Registration failed">{friendlyError(error)}{errorDetails(error) ? ` ${errorDetails(error)}` : ""}</Notice> : null}
      <form className="stack-form" onSubmit={submit}>
        <div className="form-grid form-grid-two">
          <Field label="Full name"><input required minLength={2} value={form.fullName} onChange={(event) => update("fullName", event.target.value)} placeholder="Your legal name" /></Field>
          <Field label="Username"><input required minLength={3} maxLength={50} value={form.username} onChange={(event) => update("username", event.target.value)} placeholder="Choose a username" /></Field>
        </div>
        <div className="form-grid form-grid-two">
          <Field label="Email"><input type="email" required value={form.email} onChange={(event) => update("email", event.target.value)} placeholder="you@example.com" /></Field>
          <Field label="Phone"><input required minLength={5} value={form.phone} onChange={(event) => update("phone", event.target.value)} placeholder="+92 300 0000000" /></Field>
        </div>
        <div className="form-grid form-grid-three">
          <Field label="Date of birth"><input type="date" required value={form.dateOfBirth} onChange={(event) => update("dateOfBirth", event.target.value)} /></Field>
          <Field label="Sex"><select value={form.sex} onChange={(event) => update("sex", event.target.value)}><option value="M">Male</option><option value="F">Female</option></select></Field>
          <Field label="Weight (kg)"><input type="number" min="30" max="400" step="0.1" required value={form.weightKg} onChange={(event) => update("weightKg", event.target.value)} placeholder="70" /></Field>
        </div>
        <div className="form-grid form-grid-three">
          <Field label="ABO group"><select value={form.bloodGroup} onChange={(event) => update("bloodGroup", event.target.value)}><option>A</option><option>B</option><option>AB</option><option>O</option></select></Field>
          <Field label="Rh factor"><select value={form.rhFactor} onChange={(event) => update("rhFactor", event.target.value)}><option value="POS">Positive</option><option value="NEG">Negative</option></select></Field>
          <Field label="City"><select value={form.cityCode} onChange={(event) => update("cityCode", event.target.value)}>{cities.map((city) => <option key={city.cityCode || city.code} value={city.cityCode || city.code}>{city.name || city.cityCode || city.code}</option>)}</select></Field>
        </div>
        <Field label="Password" hint="At least 12 characters. Never share credentials."><input type="password" autoComplete="new-password" required minLength={12} maxLength={72} value={form.password} onChange={(event) => update("password", event.target.value)} placeholder="Create a strong password" /></Field>
        <Button type="submit" size="lg" disabled={submitting}>{submitting ? "Creating profile…" : "Create donor profile"}</Button>
      </form>
      <div className="auth-switch">Already registered? <Link to="/login">Sign in instead</Link></div>
    </AuthFrame>
  );
}
