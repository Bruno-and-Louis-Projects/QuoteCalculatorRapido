// smartmoving.test.js — pins the CRM mapping: how a computed quote becomes the
// JSON body of POST /api/leads/from-provider/v2. Pricing itself is covered by
// pricing.test.js; this file only asserts the shape SmartMoving receives.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLeadPayload, describeProviderKey, normalizeProviderKey,
  parseAddressText, provinceCode, splitName,
} from "../src/smartmoving.js";

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
    originParts: { street: "123 rue Principale", city: "Montréal", state: "QC", zip: "H2X 1Y4", full: lead().originAddress },
    destParts: { street: "9 avenue des Pins", city: "Laval", state: "QC", zip: "H7N 3S5", full: lead().destAddress },
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

test("bedrooms are derived from the Québec size, as a STRING, skipped for 'maison'", () => {
  // SmartMoving documents Bedrooms as a string, not a number.
  assert.strictEqual(build({ input: input({ size: "3.5" }) }).bedrooms, "1");
  assert.strictEqual(build({ input: input({ size: "4.5" }) }).bedrooms, "2");
  assert.strictEqual(build({ input: input({ size: "5.5" }) }).bedrooms, "3");
  assert.ok(!("bedrooms" in build({ input: input({ size: "maison" }) })));
});

test("addresses are sent as components OR AddressFull, never both", () => {
  // Components, because the split produced real structure.
  const split = build();
  assert.equal(split.originStreet, "123 rue Principale");
  assert.equal(split.originCity, "Montréal");
  assert.ok(!("originAddressFull" in split), "components and full must never both be sent");

  // No city and no postal code = an untrustworthy split, so hand over the raw
  // line and let SmartMoving parse it rather than passing it off as a street.
  const unparsed = build({
    destParts: { street: "", city: "", state: "", zip: "", full: "quelque part à Laval" },
  });
  assert.equal(unparsed.destinationAddressFull, "quelque part à Laval");
  assert.ok(!("destinationStreet" in unparsed) && !("destinationCity" in unparsed));

  // Nothing at all: send neither, rather than empty strings.
  const none = build({ destParts: {} });
  assert.ok(!("destinationAddressFull" in none) && !("destinationStreet" in none));
});

test("provenance becomes referralSource, not a line buried in the note", () => {
  const p = build();
  assert.equal(p.referralSource, "Facebook");
  assert.ok(!/Provenance :/.test(p.notes), "no longer duplicated into the note");
});

test("serviceType uses SmartMoving's vocabulary, and is omitted when unmapped", () => {
  assert.equal(build({ input: input({ service: "residentiel" }) }).serviceType, "Moving");
  assert.equal(build({ input: input({ service: "commercial" }) }).serviceType, "Commercial");
  // "livraison" has no equivalent in their closed list — better absent than wrong.
  assert.ok(!("serviceType" in build({ input: input({ service: "livraison" }) })));
});

test("notes carry the quote breakdown, provenance and the customer's message", () => {
  const n = build().notes;
  assert.match(n, /TOTAL \(taxes en sus\) : 1143 \$/);
  assert.match(n, /Déménageurs : 3/);
  assert.match(n, /Distance : 35 km/);
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

// --- Provider key hygiene ---------------------------------------------------
// A key SmartMoving doesn't recognise fails with 400 {"message":"Provider not
// found."} and no hint as to why, so the cheap paste mistakes are normalised.

test("normalizeProviderKey accepts the bare key, a pasted API link, or a messy paste", () => {
  const KEY = "54bc9848-ad05-4b43-bf74-b4a200fb9a9a";
  assert.equal(normalizeProviderKey(KEY), KEY);
  // The whole API link, which SmartMoving's own UI also offers.
  assert.equal(
    normalizeProviderKey(`https://api.smartmoving.com/api/leads/from-provider/v2?providerKey=${KEY}`),
    KEY
  );
  // Trailing newline / spaces / wrapping quotes from a copy-paste.
  assert.equal(normalizeProviderKey(`  ${KEY}\n`), KEY);
  assert.equal(normalizeProviderKey(`"${KEY}"`), KEY);
  assert.equal(normalizeProviderKey(""), "");
  assert.equal(normalizeProviderKey(undefined), "");
  // A URL with no providerKey param is left alone rather than silently emptied.
  assert.equal(normalizeProviderKey("https://example.com/nope"), "https://example.com/nope");
});

test("describeProviderKey reports shape without ever exposing the key", () => {
  const KEY = "54bc9848-ad05-4b43-bf74-b4a200fb9a9a";
  const good = describeProviderKey(KEY);
  assert.deepEqual(good, { present: true, length: 36, looksLikeUuid: true, extractedFromUrl: false });
  assert.ok(!JSON.stringify(good).includes(KEY), "the key must never appear in the report");

  assert.deepEqual(describeProviderKey(""), {
    present: false, length: 0, looksLikeUuid: false, extractedFromUrl: false,
  });
  // A truncated paste is visible as a wrong length / non-UUID shape.
  const short = describeProviderKey("54bc9848-ad05");
  assert.equal(short.looksLikeUuid, false);
  assert.equal(short.length, 13);
  // A pasted link is flagged, and measured after extraction.
  const fromUrl = describeProviderKey(`https://api.smartmoving.com/api/leads/from-provider/v2?providerKey=${KEY}`);
  assert.equal(fromUrl.extractedFromUrl, true);
  assert.equal(fromUrl.looksLikeUuid, true);
});
