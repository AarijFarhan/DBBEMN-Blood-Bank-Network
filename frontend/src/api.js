const RENDER_API_ORIGIN = "https://dbbemn-blood-bank-network.onrender.com";
const API_PREFIX = "/api/v1";

const configuredApiUrl = (import.meta.env.VITE_API_URL ?? "").trim().replace(/\/+$/, "");
const API_ROOT = configuredApiUrl.endsWith(API_PREFIX)
  ? configuredApiUrl
  : `${configuredApiUrl || RENDER_API_ORIGIN}${API_PREFIX}`;

const SESSION_KEY = "dbbemn.session";
const listeners = new Set();
let session = readSession();
let refreshPromise = null;

function readSession() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.accessToken || !parsed?.refreshToken) return null;
    return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
  } catch {
    try {
      window.localStorage.removeItem(SESSION_KEY);
    } catch {
      return null;
    }
    return null;
  }
}

function notifySession() {
  listeners.forEach((listener) => listener(session));
}

export function getSession() {
  return session;
}

export function setSession(next) {
  const nextSession = next?.accessToken && next?.refreshToken
    ? { accessToken: next.accessToken, refreshToken: next.refreshToken }
    : null;
  session = nextSession;
  if (typeof window !== "undefined") {
    try {
      if (nextSession) {
        window.localStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
      } else {
        window.localStorage.removeItem(SESSION_KEY);
      }
    } catch {
      session = null;
    }
  }
  notifySession();
}

export function clearSession() {
  setSession(null);
}

export function subscribeSession(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function parsePayload(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function makeError(response, payload) {
  const body = payload?.error ?? payload ?? {};
  const error = new Error(body.message || "The request failed.");
  error.status = response.status;
  error.code = body.code || "REQUEST_FAILED";
  error.details = body.details ?? null;
  error.retryAfter = response.headers.get("retry-after");
  return error;
}

async function refreshSession() {
  if (!session?.refreshToken) throw new Error("No refresh session is available.");
  if (refreshPromise) return refreshPromise;
  refreshPromise = fetch(`${API_ROOT}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  })
    .then(async (response) => {
      const payload = parsePayload(await response.text());
      if (!response.ok) throw makeError(response, payload);
      setSession(payload);
      return payload;
    })
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

async function request(path, options = {}) {
  const {
    method = "GET",
    body,
    auth = true,
    retry = true,
    headers = {},
  } = options;
  const requestHeaders = { ...headers };
  if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
  if (auth && session?.accessToken) requestHeaders.Authorization = `Bearer ${session.accessToken}`;
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = parsePayload(await response.text());
  if (!response.ok) {
    if (response.status === 401 && auth && retry && !path.startsWith("/auth/")) {
      try {
        await refreshSession();
        return request(path, { ...options, retry: false });
      } catch {
        clearSession();
      }
    }
    throw makeError(response, payload);
  }
  return payload;
}

function queryPath(path, params) {
  if (!params) return path;
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item !== undefined && item !== null && item !== "") search.append(key, item);
      });
    } else {
      search.set(key, String(value));
    }
  });
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export const api = {
  auth: {
    login: (credentials) => request("/auth/login", { method: "POST", body: credentials, auth: false }),
    registerDonor: (details) => request("/auth/register-donor", { method: "POST", body: details, auth: false }),
    me: () => request("/auth/me"),
    logout: (refreshToken) => request("/auth/logout", { method: "POST", body: { refreshToken }, auth: true }),
  },
  catalog: {
    cities: () => request("/cities", { auth: false }),
    hospitals: (params) => request(queryPath("/hospitals", params), { auth: false }),
    bloodBanks: (params) => request(queryPath("/blood-banks", params), { auth: false }),
  },
  search: {
    units: (params) => request(queryPath("/search/units", params)),
    donors: (params) => request(queryPath("/search/donors", params)),
  },
  stock: {
    summary: (params) => request(queryPath("/stock/summary", params)),
  },
  reservations: {
    list: (params) => request(queryPath("/reservations", params)),
    get: (id, params) => request(queryPath(`/reservations/${id}`, params)),
    create: (body) => request("/reservations", { method: "POST", body }),
    cancel: (id, body, params) => request(queryPath(`/reservations/${id}/cancel`, params), { method: "POST", body: body || {} }),
    transfuse: (id, body, params) => request(queryPath(`/reservations/${id}/transfuse`, params), { method: "POST", body }),
    dispatch: (id, body, params) => request(queryPath(`/reservations/${id}/dispatch`, params), { method: "POST", body: body || {} }),
  },
  units: {
    list: (params) => request(queryPath("/units", params)),
    get: (id, params) => request(queryPath(`/units/${id}`, params)),
    reserve: (id, body, params) => request(queryPath(`/units/${id}/reserve`, params), { method: "POST", body }),
    discard: (id, body, params) => request(queryPath(`/units/${id}/discard`, params), { method: "POST", body: body || {} }),
  },
  donations: {
    list: (params) => request(queryPath("/donations", params)),
    create: (body) => request("/donations", { method: "POST", body }),
    screen: (id, body) => request(`/donations/${id}/screening`, { method: "PATCH", body }),
  },
  donors: {
    get: (id, params) => request(queryPath(`/donors/${id}`, params)),
    availability: (id, isAvailable) => request(`/donors/${id}/availability`, { method: "PATCH", body: { isAvailable } }),
  },
  donorRequests: {
    list: (params) => request(queryPath("/donor-requests", params)),
    create: (body) => request("/donor-requests", { method: "POST", body }),
    respond: (id, body) => request(`/donor-requests/${id}/respond`, { method: "PATCH", body }),
    cancel: (id) => request(`/donor-requests/${id}`, { method: "DELETE" }),
  },
  health: {
    live: () => request("/health/live", { auth: false }),
    ready: () => request("/health/ready", { auth: false }),
  },
  system: {
    cluster: () => request("/admin/cluster-status"),
    chaos: (city, action, body) => request(`/admin/chaos/${city}/${action}`, { method: "POST", body }),
    listUsers: () => request("/admin/users"),
    createUser: (body) => request("/admin/users", { method: "POST", body }),
    createHospital: (body) => request("/admin/hospitals", { method: "POST", body }),
    createBloodBank: (body) => request("/admin/blood-banks", { method: "POST", body }),
    deleteHospital: (id) => request(`/admin/hospitals/${id}`, { method: "DELETE" }),
    deleteBloodBank: (id) => request(`/admin/blood-banks/${id}`, { method: "DELETE" }),
    deleteDonor: (id, city) => request(`/admin/donors/${id}?city=${city}`, { method: "DELETE" }),
  },
};
