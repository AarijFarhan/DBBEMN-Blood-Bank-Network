import { useCallback, useState } from "react";

/**
 * Client-side form validation.
 *
 * Mirrors the server-side Zod rules in backend/src/utils/validators.js so the
 * user gets immediate, field-level feedback instead of a generic 422 response.
 * The server remains authoritative; these rules are a friendly first pass.
 */

export const patterns = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  phone: /^[+]?[\d\s().-]{5,30}$/,
  username: /^[A-Za-z0-9._-]{3,50}$/,
  uuid: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
};

export function byteLength(value) {
  const text = String(value ?? "");
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  return unescape(encodeURIComponent(text)).length;
}

export function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

/* Rule factories: each returns a function (value, values) => message | "" */

export const required = (label = "This field") => (value) =>
  isBlank(value) ? `${label} is required.` : "";

export const minLength = (length, label = "This field") => (value) =>
  !isBlank(value) && String(value).trim().length < length
    ? `${label} must be at least ${length} characters.`
    : "";

export const maxLength = (length, label = "This field") => (value) =>
  !isBlank(value) && String(value).trim().length > length
    ? `${label} must be at most ${length} characters.`
    : "";

export const matches = (regex, message) => (value) =>
  !isBlank(value) && !regex.test(String(value).trim()) ? message : "";

export const email = (value) =>
  !isBlank(value) && !patterns.email.test(String(value).trim()) ? "Enter a valid email address." : "";

export const username = (label = "Username") => (value) =>
  !isBlank(value) && !patterns.username.test(String(value).trim())
    ? `${label} may only use letters, numbers, dot, dash and underscore.`
    : "";

export const phone = (label = "Phone") => (value) =>
  !isBlank(value) && !patterns.phone.test(String(value).trim())
    ? `${label} is not a valid phone number.`
    : "";

export const uuid = (label = "This field") => (value) =>
  !isBlank(value) && !patterns.uuid.test(String(value).trim())
    ? `${label} must be a valid UUID.`
    : "";

export const oneOf = (list, label = "This field") => (value) =>
  !isBlank(value) && !list.includes(value) ? `${label} is not a valid option.` : "";

export const number = ({ min, max, integer = false, label = "This field" } = {}) => (value) => {
  if (isBlank(value)) return "";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return `${label} must be a number.`;
  if (integer && !Number.isInteger(parsed)) return `${label} must be a whole number.`;
  if (min !== undefined && parsed < min) return `${label} must be at least ${min}.`;
  if (max !== undefined && parsed > max) return `${label} must be at most ${max}.`;
  return "";
};

export const password = (label = "Password") => (value) => {
  if (isBlank(value)) return "";
  if (String(value).length < 8) return `${label} must be at least 8 characters.`;
  if (byteLength(value) > 72) return `${label} must be at most 72 bytes.`;
  return "";
};

export const validDate = (label = "Date") => (value) => {
  if (isBlank(value)) return "";
  return Number.isNaN(new Date(`${value}T00:00:00`).getTime())
    ? `${label} is not a valid date.`
    : "";
};

export function ageOn(dateValue) {
  if (isBlank(dateValue)) return null;
  const birth = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(birth.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const month = today.getMonth() - birth.getMonth();
  if (month < 0 || (month === 0 && today.getDate() < birth.getDate())) age -= 1;
  return age;
}

export const ageRange = (min, max, label = "Age") => (value) => {
  const age = ageOn(value);
  if (age === null) return "";
  if (age < min || age > max) return `${label} must be between ${min} and ${max} (current: ${age}).`;
  return "";
};

/**
 * Run a rules map against a values object. Rules are `{ field: [check, ...] }`
 * and the first failing check per field wins.
 */
export function validate(values, rules) {
  const errors = {};
  for (const field of Object.keys(rules)) {
    for (const check of rules[field]) {
      const message = check(values[field], values);
      if (message) {
        errors[field] = message;
        break;
      }
    }
  }
  return errors;
}

export function hasErrors(errors) {
  return Object.keys(errors).length > 0;
}

/**
 * Small hook to hold field errors and clear them as the user edits.
 * Returns the same `setErrors` used by `validate`.
 */
export function useFieldErrors() {
  const [errors, setErrors] = useState({});
  const clearError = useCallback((field) => {
    setErrors((current) => {
      if (!(field in current)) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }, []);
  const clearAll = useCallback(() => setErrors({}), []);
  return { errors, setErrors, clearError, clearAll };
}
