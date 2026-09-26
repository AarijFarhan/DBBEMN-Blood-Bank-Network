import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import app from "../src/app.js";
import { schemasFor } from "../src/db/shard-router.js";
import { getCatalogPool, getPoolForCity, waitForDatabases } from "../src/db/registry.js";

// Every shard assertion in this file is about KHI, so the shard fixtures and
// teardown target that one city node. Catalog rows are a different node entirely:
// catalog.users, catalog.hospitals and catalog.blood_banks only exist on the
// catalog node, so those statements must not be sent to a city pool.
const CITY = "KHI";
const catalogPool = getCatalogPool();
const cityPool = getPoolForCity(CITY);
const { hot, hist } = schemasFor(CITY);

const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const adminUsername = `phase2-admin-${suffix}`;
const adminEmail = `${adminUsername}@example.test`;
const donorUsername = `phase2-donor-${suffix}`;
const donorEmail = `${donorUsername}@example.test`;
const ineligibleUsername = `phase2-low-${suffix}`;
const ineligibleEmail = `${ineligibleUsername}@example.test`;
const testPassword = "Phase2-Test-Password-Only";
const donorIds = [];
const donationIds = [];
const unitIds = [];
const bankIds = [];
const hospitalIds = [];
let server;
let baseUrl;

async function request(path, { method = "GET", token, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    response,
    data: text ? JSON.parse(text) : null,
  };
}

before(async () => {
  // Waits on all four nodes, not just one: the login below reads catalog.users from
  // the catalog node while every later assertion crosses into the KHI shard, so a
  // green run has to prove both are reachable.
  await waitForDatabases();
  const passwordHash = await bcrypt.hash(testPassword, 4);
  await catalogPool.query(
    `INSERT INTO catalog.users (username, email, password_hash, role)
     VALUES ($1, $2, $3, 'SYSTEM_ADMIN')`,
    [adminUsername, adminEmail, passwordHash],
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await cityPool.query(
    `DELETE FROM ${hot}.blood_units WHERE unit_id = ANY($1::uuid[])`,
    [unitIds],
  );
  await cityPool.query(
    `DELETE FROM ${hot}.outbox WHERE unit_id = ANY($1::uuid[])`,
    [unitIds],
  );
  await cityPool.query(
    `DELETE FROM ${hist}.unit_status_log WHERE unit_id = ANY($1::uuid[])`,
    [unitIds],
  );
  await cityPool.query(
    `DELETE FROM ${hist}.donations WHERE donation_id = ANY($1::uuid[])`,
    [donationIds],
  );
  await cityPool.query(
    `DELETE FROM ${hist}.donors WHERE donor_id = ANY($1::uuid[])`,
    [donorIds],
  );
  await catalogPool.query(
    `DELETE FROM catalog.users
     WHERE username = ANY($1::text[])`,
    [[adminUsername, donorUsername, ineligibleUsername, `phase2-bank-${suffix}`, `phase2-hospital-${suffix}`]],
  );
  await catalogPool.query("DELETE FROM catalog.hospitals WHERE hospital_id = ANY($1::uuid[])", [hospitalIds]);
  await catalogPool.query("DELETE FROM catalog.blood_banks WHERE blood_bank_id = ANY($1::uuid[])", [bankIds]);
  // Why here and not pool.end(): the app under test shares these pools, and ending
  // them is only safe once the server has stopped. Distinct objects only - in single
  // mode the catalog and KHI lookups are the same pool.
  for (const target of new Set([catalogPool, cityPool])) {
    await target.end().catch(() => {});
  }
});

test("Phase 2: auth, catalog, tenant scope, donors, donations, units, and health", async () => {
  const health = await request("/health/ready");
  assert.equal(health.response.status, 200);
  assert.ok(health.response.headers.get("x-instance-id"));
  assert.equal(health.data.status, "ready");
  assert.deepEqual(Object.keys(health.data.cities).sort(), ["ISB", "KHI", "LHE"]);

  const login = await request("/auth/login", {
    method: "POST",
    body: { login: adminEmail, password: testPassword },
  });
  assert.equal(login.response.status, 200);
  const adminToken = login.data.accessToken;

  const me = await request("/auth/me", { token: adminToken });
  assert.equal(me.response.status, 200);
  assert.equal(me.data.user.role, "SYSTEM_ADMIN");

  const cities = await request("/cities");
  assert.equal(cities.response.status, 200);
  assert.equal(cities.data.cities.length, 3);

  const hospital = await request("/admin/hospitals", {
    method: "POST",
    token: adminToken,
    body: { name: `Phase2 Hospital ${suffix}`, cityCode: "KHI", address: "Test road" },
  });
  assert.equal(hospital.response.status, 201);
  hospitalIds.push(hospital.data.hospital.hospitalId);

  const bank = await request("/admin/blood-banks", {
    method: "POST",
    token: adminToken,
    body: { name: `Phase2 Blood Bank ${suffix}`, cityCode: "KHI", address: "Test lane" },
  });
  assert.equal(bank.response.status, 201);
  bankIds.push(bank.data.bloodBank.bloodBankId);

  const forbidden = await request("/admin/hospitals", {
    method: "POST",
    token: "invalid-token",
    body: { name: "Unauthorized", cityCode: "KHI" },
  });
  assert.equal(forbidden.response.status, 401);

  const donor = await request("/auth/register-donor", {
    method: "POST",
    body: {
      username: donorUsername,
      email: donorEmail,
      password: testPassword,
      fullName: "Phase Two Donor",
      phone: "+92-300-0000000",
      dateOfBirth: "1991-06-12",
      sex: "F",
      weightKg: 62,
      bloodGroup: "O",
      rhFactor: "NEG",
      cityCode: "KHI",
    },
  });
  assert.equal(donor.response.status, 201);
  donorIds.push(donor.data.user.donorId);

  const self = await request(`/donors/${donor.data.user.donorId}`, {
    token: donor.data.accessToken,
  });
  assert.equal(self.response.status, 200);
  assert.equal(self.data.donor.cityCode, "KHI");

  const refreshed = await request("/auth/refresh", {
    method: "POST",
    body: { refreshToken: donor.data.refreshToken },
  });
  assert.equal(refreshed.response.status, 200);
  const replayedRefresh = await request("/auth/refresh", {
    method: "POST",
    body: { refreshToken: donor.data.refreshToken },
  });
  assert.equal(replayedRefresh.response.status, 401);

  const availability = await request(`/donors/${donor.data.user.donorId}/availability`, {
    method: "PATCH",
    token: refreshed.data.accessToken,
    body: { isAvailable: true },
  });
  assert.equal(availability.response.status, 200);
  assert.equal(availability.data.donor.isAvailable, true);

  const secondBank = await request("/admin/blood-banks", {
    method: "POST",
    token: adminToken,
    body: { name: `Phase2 Other Bank ${suffix}`, cityCode: "KHI" },
  });
  assert.equal(secondBank.response.status, 201);
  bankIds.push(secondBank.data.bloodBank.bloodBankId);

  const bankUser = await request("/admin/users", {
    method: "POST",
    token: adminToken,
    body: {
      username: `phase2-bank-${suffix}`,
      email: `phase2-bank-${suffix}@example.test`,
      password: testPassword,
      role: "BLOODBANK_ADMIN",
      bloodBankId: bank.data.bloodBank.bloodBankId,
    },
  });
  assert.equal(bankUser.response.status, 201);

  const bankLogin = await request("/auth/login", {
    method: "POST",
    body: { login: `phase2-bank-${suffix}`, password: testPassword },
  });
  assert.equal(bankLogin.response.status, 200);

  const bankCannotAdmin = await request("/admin/hospitals", {
    method: "POST",
    token: bankLogin.data.accessToken,
    body: { name: "Not allowed", cityCode: "KHI" },
  });
  assert.equal(bankCannotAdmin.response.status, 403);

  const crossTenantDonation = await request("/donations", {
    method: "POST",
    token: bankLogin.data.accessToken,
    body: {
      donorId: donor.data.user.donorId,
      bloodBankId: secondBank.data.bloodBank.bloodBankId,
      volumeMl: 450,
      components: [{ componentType: "PRBC", volumeMl: 250 }],
    },
  });
  assert.equal(crossTenantDonation.response.status, 403);

  const donation = await request("/donations", {
    method: "POST",
    token: bankLogin.data.accessToken,
    body: {
      donorId: donor.data.user.donorId,
      bloodBankId: bank.data.bloodBank.bloodBankId,
      volumeMl: 450,
      components: [
        { componentType: "PRBC", volumeMl: 250 },
        { componentType: "PLASMA", volumeMl: 200 },
      ],
    },
  });
  assert.equal(donation.response.status, 201);
  donationIds.push(donation.data.donation.donationId);
  unitIds.push(...donation.data.donation.units.map((unit) => unit.unitId));
  assert.ok(donation.data.donation.units.every((unit) => unit.status === "QUARANTINE"));

  const screened = await request(`/donations/${donation.data.donation.donationId}/screening`, {
    method: "PATCH",
    token: bankLogin.data.accessToken,
    body: { screeningStatus: "PASSED" },
  });
  assert.equal(screened.response.status, 200);
  assert.ok(screened.data.donation.units.every((unit) => unit.status === "AVAILABLE"));

  const inventory = await request(
    `/units?bankId=${bank.data.bloodBank.bloodBankId}&status=AVAILABLE`,
    { token: bankLogin.data.accessToken },
  );
  assert.equal(inventory.response.status, 200);
  assert.ok(inventory.data.units.some((unit) => unit.unitId === unitIds[0]));

  const discarded = await request(`/units/${unitIds[0]}/discard?city=KHI`, {
    method: "PATCH",
    token: bankLogin.data.accessToken,
    body: { reason: "Phase 2 test cleanup" },
  });
  assert.equal(discarded.response.status, 200);
  assert.equal(discarded.data.unit.status, "DISCARDED");

  const logout = await request("/auth/logout", {
    method: "POST",
    token: refreshed.data.accessToken,
    body: { refreshToken: refreshed.data.refreshToken },
  });
  assert.equal(logout.response.status, 204);
});