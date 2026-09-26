import { COMPONENTS } from "./constants";

export function createRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === "x" ? random : (random & 3) | 8;
    return value.toString(16);
  });
}

export function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

export function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatNumber(value) {
  if (value === null || value === undefined || value === "") return "—";
  return new Intl.NumberFormat("en").format(Number(value));
}

export function formatBloodType(group, rh) {
  if (!group) return "—";
  const suffix = rh === "POS" ? "+" : rh === "NEG" ? "−" : "";
  return `${group}${suffix}`;
}

export function formatComponent(value) {
  const item = COMPONENTS.find((component) => component.value === value);
  return item?.label ?? value ?? "—";
}

export function initials(name = "") {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "DB";
}

export function displayUserName(user) {
  return user?.username || user?.email || "Workspace user";
}

export function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function buildQuery(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      value.filter((item) => item !== undefined && item !== null && item !== "").forEach((item) => search.append(key, item));
      return;
    }
    search.set(key, String(value));
  });
  const query = search.toString();
  return query ? `?${query}` : "";
}

export function listFrom(payload, keys = []) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

export function normalizeCityCode(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : value;
}

export function normalizeResult(result) {
  if (!result || typeof result !== "object") return result;
  return {
    ...result,
    unitId: result.unitId ?? result.unit_id ?? result.id,
    bloodBankId: result.bloodBankId ?? result.blood_bank_id ?? result.bankId,
    bloodGroup: result.bloodGroup ?? result.blood_group,
    rhFactor: result.rhFactor ?? result.rh_factor,
    componentType: result.componentType ?? result.component_type ?? result.component,
    volumeMl: result.volumeMl ?? result.volume_ml,
    collectedOn: result.collectedOn ?? result.collected_on,
    expiryDate: result.expiryDate ?? result.expiry_date,
    cityCode: normalizeCityCode(result.cityCode ?? result.city_code ?? result.city),
    bankName: result.bankName ?? result.blood_bank_name ?? result.bloodBankName,
    distanceKm: result.distanceKm ?? result.distance_km ?? result.distance,
    status: result.status ?? result.unitStatus ?? result.unit_status,
  };
}

export function ageFromDate(value) {
  if (!value) return null;
  const birth = new Date(value);
  if (Number.isNaN(birth.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const month = today.getMonth() - birth.getMonth();
  if (month < 0 || (month === 0 && today.getDate() < birth.getDate())) age -= 1;
  return age;
}

export function friendlyError(error) {
  const code = error?.code;
  const status = error?.status;
  if (code === "INVALID_CREDENTIALS") return "The username or password is incorrect.";
  if (code === "SHARD_WRITE_UNAVAILABLE") return "A city write shard is unavailable. Try again shortly.";
  if (code === "INSUFFICIENT_STOCK") return "There is not enough compatible inventory right now.";
  if (code === "UNIT_NOT_AVAILABLE" || code === "UNIT_ALREADY_RESERVED") return "That unit was just taken. Showing the next best match is recommended.";
  if (code === "UNIT_NOT_DISCARDABLE") return "Only quarantined or available units can be discarded.";
  if (code === "DONATION_ALREADY_SCREENED") return "That donation has already been screened.";
  if (status === 503) return "The service is temporarily unavailable. Retry with the same request ID.";
  if (status === 403) return "Your account does not have access to this action.";
  if (status === 404) return "The requested resource was not found.";
  return error?.message || "Something went wrong. Please try again.";
}

export function errorDetails(error) {
  const details = error?.details;
  if (!details) return "";
  if (typeof details === "string") return details;
  if (Array.isArray(details)) return details.map((item) => item.message || String(item)).join(" ");
  if (details.unavailableCities?.length) return `Unavailable cities: ${details.unavailableCities.join(", ")}.`;
  return "";
}
