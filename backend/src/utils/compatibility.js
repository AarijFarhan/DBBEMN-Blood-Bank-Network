const ABO_DONORS = Object.freeze({
  O: Object.freeze(["O"]),
  A: Object.freeze(["O", "A"]),
  B: Object.freeze(["O", "B"]),
  AB: Object.freeze(["O", "A", "B", "AB"]),
});

const GROUPS = Object.freeze(["O", "A", "B", "AB"]);
const RH_FACTORS = Object.freeze(["NEG", "POS"]);

/**
 * UI hint mirror only. The SQL function common.compatible_donor is the
 * authoritative compatibility rule used by database-backed matching.
 */
export function compatibleDonors(patientGroup, patientRh, component) {
  if (component !== "PRBC") {
    return [{ group: patientGroup, rh: patientRh }];
  }

  return GROUPS.flatMap((donorGroup) =>
    RH_FACTORS
      .filter((donorRh) => patientRh === "POS" || donorRh === "NEG")
      .filter(() => ABO_DONORS[patientGroup]?.includes(donorGroup))
      .map((donorRh) => ({ group: donorGroup, rh: donorRh })),
  );
}