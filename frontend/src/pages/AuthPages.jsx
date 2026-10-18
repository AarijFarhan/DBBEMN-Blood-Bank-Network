import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CITIES } from "../constants";
import { api } from "../api";
import { useAuth } from "../auth";
import { Button, Field, Icon, Notice } from "../components/UI";
import { errorDetails, friendlyError } from "../utils";
import { ROLE_LABELS } from "../constants";
import { Navigate } from "react-router-dom";
import { roleHome } from "../constants";
import { BLOOD_GROUPS, RH_FACTORS } from "../constants";
import { ageRange, hasErrors, maxLength, minLength, number, password as passwordRule, required, username as usernameRule, email as emailRule, phone as phoneRule, oneOf, validate, useFieldErrors } from "../validation";

const LOGIN_RULES = {
  login: [required("Username or email")],
  password: [required("Password"), passwordRule("Password")],
};

const REGISTER_RULES = {
  fullName: [required("Full name"), minLength(2, "Full name"), maxLength(120, "Full name")],
  username: [required("Username"), usernameRule("Username"), maxLength(50, "Username")],
  email: [required("Email"), emailRule],
  phone: [required("Phone"), phoneRule("Phone")],
  dateOfBirth: [required("Date of birth"), ageRange(18, 65, "Donor age")],
  sex: [required("Sex"), oneOf(["M", "F"], "Sex")],
  weightKg: [required("Weight"), number({ min: 50, max: 400, label: "Weight" })],
  bloodGroup: [required("ABO group"), oneOf(BLOOD_GROUPS, "ABO group")],
  rhFactor: [required("Rh factor"), oneOf(RH_FACTORS, "Rh factor")],
  cityCode: [required("City"), oneOf(CITIES.map((city) => city.cityCode), "City")],
  password: [required("Password"), passwordRule("Password")],
};

function AuthFrame({ children, mode }) {
  return (
    <div className="auth-page">
      <div className="auth-visual">
        <div className="auth-brand"><span className="brand-mark"><Icon name="droplet" size={18} /></span><span>DBBEMN</span></div>
        <div className="auth-visual-copy">
          <span className="eyebrow eyebrow-light">Distributed care network</span>
          <h1>Every unit.<br /><em>Connected.</em></h1>
          <p>One operational view for hospitals, blood banks, donors, and the teams keeping the network moving.</p>
          <ul className="auth-features">
            <li><Icon name="search" size={16} /> Cross-city compatible unit search</li>
            <li><Icon name="shield" size={16} /> Role-scoped, tenant-isolated access</li>
            <li><Icon name="activity" size={16} /> Live shard and lag telemetry</li>
          </ul>
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
  const { errors, setErrors, clearError } = useFieldErrors();
  if (!booting && user) return <Navigate to={roleHome(user.role)} replace />;

  function update(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
    clearError(name);
  }

  async function submit(event) {
    event.preventDefault();
    const nextErrors = validate(form, LOGIN_RULES);
    setErrors(nextErrors);
    if (hasErrors(nextErrors)) return;
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
      <form className="stack-form" noValidate onSubmit={submit}>
        <Field label="Username or email" error={errors.login}>
          <input autoComplete="username" value={form.login} onChange={(event) => update("login", event.target.value)} placeholder="you@organization.org" />
        </Field>
        <Field label="Password" hint="Passwords are managed by your workspace administrator." error={errors.password}>
          <input type="password" autoComplete="current-password" value={form.password} onChange={(event) => update("password", event.target.value)} placeholder="Enter your password" />
        </Field>
        <Button type="submit" size="lg" disabled={submitting}>{submitting ? "Signing in…" : "Sign in to workspace"}</Button>
      </form>
      <div className="auth-switch">New donor? <Link to="/register">Create a donor profile</Link></div>
      <div className="auth-role-note"><span className="info-mark"><Icon name="info" size={13} /></span><span>Access is scoped to your role. Hospital and blood-bank records remain tenant isolated.</span></div>
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
  const { errors, setErrors, clearError } = useFieldErrors();

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
    clearError(name);
  }

  async function submit(event) {
    event.preventDefault();
    const nextErrors = validate(form, REGISTER_RULES);
    setErrors(nextErrors);
    if (hasErrors(nextErrors)) return;
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
      <form className="stack-form" noValidate onSubmit={submit}>
        <div className="form-grid form-grid-two">
          <Field label="Full name" error={errors.fullName}><input value={form.fullName} onChange={(event) => update("fullName", event.target.value)} placeholder="Your legal name" /></Field>
          <Field label="Username" error={errors.username}><input value={form.username} onChange={(event) => update("username", event.target.value)} placeholder="Choose a username" /></Field>
        </div>
        <div className="form-grid form-grid-two">
          <Field label="Email" error={errors.email}><input type="email" value={form.email} onChange={(event) => update("email", event.target.value)} placeholder="you@example.com" /></Field>
          <Field label="Phone" error={errors.phone}><input value={form.phone} onChange={(event) => update("phone", event.target.value)} placeholder="+92 300 0000000" /></Field>
        </div>
        <div className="form-grid form-grid-three">
          <Field label="Date of birth" error={errors.dateOfBirth}><input type="date" value={form.dateOfBirth} onChange={(event) => update("dateOfBirth", event.target.value)} /></Field>
          <Field label="Sex" error={errors.sex}><select value={form.sex} onChange={(event) => update("sex", event.target.value)}><option value="M">Male</option><option value="F">Female</option></select></Field>
          <Field label="Weight (kg)" error={errors.weightKg}><input type="number" min="30" max="400" step="0.1" value={form.weightKg} onChange={(event) => update("weightKg", event.target.value)} placeholder="70" /></Field>
        </div>
        <div className="form-grid form-grid-three">
          <Field label="ABO group" error={errors.bloodGroup}><select value={form.bloodGroup} onChange={(event) => update("bloodGroup", event.target.value)}><option>A</option><option>B</option><option>AB</option><option>O</option></select></Field>
          <Field label="Rh factor" error={errors.rhFactor}><select value={form.rhFactor} onChange={(event) => update("rhFactor", event.target.value)}><option value="POS">Positive</option><option value="NEG">Negative</option></select></Field>
          <Field label="City" error={errors.cityCode}><select value={form.cityCode} onChange={(event) => update("cityCode", event.target.value)}>{cities.map((city) => <option key={city.cityCode || city.code} value={city.cityCode || city.code}>{city.name || city.cityCode || city.code}</option>)}</select></Field>
        </div>
        <Field label="Password" hint="At least 8 characters. Never share credentials." error={errors.password}><input type="password" autoComplete="new-password" value={form.password} onChange={(event) => update("password", event.target.value)} placeholder="Create a strong password" /></Field>
        <Button type="submit" size="lg" disabled={submitting}>{submitting ? "Creating profile…" : "Create donor profile"}</Button>
      </form>
      <div className="auth-switch">Already registered? <Link to="/login">Sign in instead</Link></div>
    </AuthFrame>
  );
}
