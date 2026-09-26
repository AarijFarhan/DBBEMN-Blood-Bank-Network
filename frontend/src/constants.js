export const ROLES = {
  HOSPITAL_ADMIN: "HOSPITAL_ADMIN",
  BLOODBANK_ADMIN: "BLOODBANK_ADMIN",
  DONOR: "DONOR",
  SYSTEM_ADMIN: "SYSTEM_ADMIN",
};

export const ROLE_LABELS = {
  HOSPITAL_ADMIN: "Hospital admin",
  BLOODBANK_ADMIN: "Blood bank admin",
  DONOR: "Donor",
  SYSTEM_ADMIN: "System admin",
};

export const ROLE_SHORT_LABELS = {
  HOSPITAL_ADMIN: "Hospital",
  BLOODBANK_ADMIN: "Blood bank",
  DONOR: "Donor",
  SYSTEM_ADMIN: "System",
};

export const CITIES = [
  { cityCode: "KHI", name: "Karachi" },
  { cityCode: "LHE", name: "Lahore" },
  { cityCode: "ISB", name: "Islamabad" },
];

export const BLOOD_GROUPS = ["A", "B", "AB", "O"];
export const RH_FACTORS = ["POS", "NEG"];
export const COMPONENTS = [
  { value: "PRBC", label: "Packed red blood cells", short: "PRBC", shelfLife: 42 },
  { value: "WHOLE_BLOOD", label: "Whole blood", short: "Whole blood", shelfLife: 35 },
  { value: "PLATELETS", label: "Platelets", short: "Platelets", shelfLife: 5 },
  { value: "PLASMA", label: "Plasma", short: "Plasma", shelfLife: 365 },
];

export const RESERVATION_STATUSES = [
  { value: "", label: "All reservations" },
  { value: "ACTIVE", label: "Active" },
  { value: "DISPATCHED", label: "Dispatched" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "EXPIRED", label: "Expired" },
];

export const UNIT_STATUSES = [
  { value: "", label: "All inventory" },
  { value: "AVAILABLE", label: "Available" },
  { value: "QUARANTINE", label: "Quarantine" },
  { value: "RESERVED", label: "Reserved" },
  { value: "DISPATCHED", label: "Dispatched" },
  { value: "TRANSFUSED", label: "Transfused" },
  { value: "EXPIRED", label: "Expired" },
  { value: "DISCARDED", label: "Discarded" },
];

export const SCREENING_STATUSES = ["PENDING", "PASSED", "FAILED"];

export const DONOR_REQUEST_STATUSES = [
  { value: "", label: "All requests" },
  { value: "PENDING", label: "Awaiting donor" },
  { value: "ACCEPTED", label: "Accepted" },
  { value: "DECLINED", label: "Declined" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "EXPIRED", label: "Expired" },
];

export const URGENCIES = [
  { value: "ROUTINE", label: "Routine" },
  { value: "URGENT", label: "Urgent" },
  { value: "CRITICAL", label: "Critical" },
];

export function roleHome(role) {
  if (role === ROLES.HOSPITAL_ADMIN) return "/app/hospital/search";
  if (role === ROLES.BLOODBANK_ADMIN) return "/app/bank/inventory";
  if (role === ROLES.DONOR) return "/app/donor/profile";
  if (role === ROLES.SYSTEM_ADMIN) return "/app/system/health";
  return "/login";
}
