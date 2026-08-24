// smartmoving.test.js — pins the CRM mapping: how a computed quote becomes the
// JSON body of POST /api/leads/from-provider/v2. Pricing itself is covered by
// pricing.test.js; this file only asserts the shape SmartMoving receives.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLeadPayload, parseAddressText, provinceCode, splitName } from "../src/smartmoving.js";

const lead = (over = {}) => ({
  name: "Marie Tremblay",
  phone: "514 555-1234",
  email: "marie@exemple.com",
  originAddress: "123 rue Principale, Montréal, QC H2X 1Y4",
  destAddress: "9 av. des Pins, Laval, QC H7N 3S5",
  provenance: "Facebook",
  notes: "Piano au 2e étage.",
  serviceLabel: "Déménagement Résidentiel",
  ...over,
});

const input = (over = {}) => ({
  size: "4.5", service: "residentiel", distanceKm: 35, date: "2026-09-15", flags: [], ...over,
});

const instant = {
  ok: true, type: "instant_quote", total: 1143, currency: "CAD",
  breakdown: {
    movers: 3, workHours: 4, travelHours: 2, totalHours: 6, hourlyRate: 180,
    seasonMult: 1, laborSubtotal: 1080, specialFee: 0, fuelCost: 63,
  },
};

const build = (over = {}) =>
  buildLeadPayload({
    lead: lead(), input: input(), result: instant,
    originParts: { street: "123 rue Principale", city: "Montréal", state: "QC", zip: "H2X 1Y4" },
    destParts: { street: "9 avenue des Pins", city: "Laval", state: "QC", zip: "H7N 3S5" },
    ...over,
  });

test("payload carries the documented SmartMoving fields at the root", () => {
  const p = build();
  assert.equal(p.firstName, "Marie");
  assert.equal(p.lastName, "Tremblay");
  assert.equal(p.phoneNumber, "514 555-1234");
  assert.equal(p.email, "marie@exemple.com");
  assert.equal(p.originStreet, "123 rue Principale");
  assert.equal(p.originCity, "Montréal");
  assert.equal(p.originState, "QC");
  assert.equal(p.originZip, "H2X 1Y4");
  assert.equal(p.destinationStreet, "9 avenue des Pins");
  assert.equal(p.destinationCity, "Laval");
});

test("name is firstName+lastName OR fullName, never both", () => {
  const split = build();
  assert.ok(!("fullName" in split), "a two-part name must not also send fullName");

  const single = build({ lead: lead({ name: "Cher" }) });
  assert.equal(single.fullName, "Cher");
  assert.ok(!("firstName" in single) && !("lastName" in single));

  // Name is the one required field: fall back to a contact detail, never blank.
  const nameless = build({ lead: lead({ name: "" }) });
  assert.equal(nameless.fullName, "marie@exemple.com");
});

test("moveDate is YYYYMMDD, and a malformed date is omitted rather than sent", () => {
  assert.equal(build().moveDate, "20260915");
  assert.ok(!("moveDate" in build({ input: input({ date: "15/09/2026" }) })));
  assert.ok(!("moveDate" in build({ input: input({ date: undefined }) })));
});

test("bedrooms are derived from the Québec size, and skipped for 'maison'", () => {
  assert.equal(build({ input: input({ size: "3.5" }) }).bedrooms, 1);
  assert.equal(build({ input: input({ size: "5.5" }) }).bedrooms, 3);
  assert.ok(!("bedrooms" in build({ input: input({ size: "maison" }) })));
});

test("empty address parts are omitted, never sent blank", () => {
  const p = build({ destParts: { street: "9 av. des Pins", city: "", state: "", zip: "" } });
  assert.equal(p.destinationStreet, "9 av. des Pins");
  assert.ok(!("destinationCity" in p) && !("destinationZip" in p));
});

test("notes carry the quote breakdown, provenance and the customer's message", () => {
  const n = build().notes;
  assert.match(n, /TOTAL \(taxes en sus\) : 1143 \$/);
  assert.match(n, /Déménageurs : 3/);
  assert.match(n, /Distance : 35 km/);
  assert.match(n, /Provenance : Facebook/);
  assert.match(n, /Notes du client : Piano au 2e étage\./);
  // The full free-text lines survive even when the split above succeeded.
  assert.match(n, /Adresse de départ : 123 rue Principale, Montréal, QC H2X 1Y4/);
});

test("a custom-quote request still produces a lead, with its reason", () => {
  const p = build({
    result: { ok: true, type: "custom_quote", reason: "distance" },
    input: input({ distanceKm: 900 }),
  });
  assert.equal(p.firstName, "Marie"); // contact details are still sent
  assert.match(p.notes, /Soumission PERSONNALISÉE requise/);
  assert.match(p.notes, /Distance supérieure à 700 km/);
});

test("parseAddressText splits a typed Québec address without a network call", () => {
  assert.deepEqual(parseAddressText("123 rue Principale, Montréal, QC H2X 1Y4"), {
    street: "123 rue Principale", city: "Montréal", state: "QC", zip: "H2X 1Y4",
  });
  // Province tacked onto the city part, postal code with no space, trailing country.
  assert.deepEqual(parseAddressText("9 av. des Pins, Laval Québec H7N3S5, Canada"), {
    street: "9 av. des Pins", city: "Laval", state: "QC", zip: "H7N 3S5",
  });
  // Nothing but a street: keep it, invent nothing.
  assert.deepEqual(parseAddressText("450 boulevard Saint-Laurent"), {
    street: "450 boulevard Saint-Laurent", city: "", state: "", zip: "",
  });
});

test("provinceCode is accent- and case-insensitive, and rejects non-provinces", () => {
  assert.equal(provinceCode("Québec"), "QC");
  assert.equal(provinceCode("qc."), "QC");
  assert.equal(provinceCode("Ontario"), "ON");
  assert.equal(provinceCode("Montréal"), "");
});

test("splitName keeps compound surnames together", () => {
  assert.deepEqual(splitName("Jean-Luc St Pierre"), { firstName: "Jean-Luc", lastName: "St Pierre" });
  assert.deepEqual(splitName("Cher"), { firstName: "", lastName: "" });
});
