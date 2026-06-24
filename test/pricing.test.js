// pricing.test.js — asserts the three reference totals from SPEC §8.
// Run before every deploy:  node --test
//
// These three cases pin the whole pricing chain: hourly rate, work + travel
// hours, the season multiplier, and the tax multiplier. If any of them drift,
// either pricing.config.json changed on purpose (update the expected values
// below) or pricing.js has a regression (fix the code).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeQuote } from "../pricing.js";

// Load the config via fs (no JSON import attribute needed under Node 22).
const cfg = JSON.parse(readFileSync(new URL("../pricing.config.json", import.meta.url), "utf8"));

// Wrap so each call uses the loaded config, matching how the Worker calls it.
const quote = (input) => computeQuote(input, cfg);

// Base move used across the doc examples: 4½, 3 movers, 35 km.
const BASE = { size: "4.5", movers: 3, distanceKm: 35, flags: [] };

test("§8 — March move (season ×1.00) → 1241.73", () => {
  const r = quote({ ...BASE, date: "2026-03-15" });
  assert.equal(r.ok, true);
  assert.equal(r.type, "instant_quote");
  assert.equal(r.total, 1241.73);
});

test("§8 — May move (season ×1.15) → 1427.99", () => {
  const r = quote({ ...BASE, date: "2026-05-15" });
  assert.equal(r.total, 1427.99);
});

test("§8 — July 1st peak (season ×2.50) → 3104.33", () => {
  const r = quote({ ...BASE, date: "2026-07-01" });
  assert.equal(r.total, 3104.33);
});

// --- A few guardrail cases beyond the doc, so the contract stays honest ---

test("exclusion: distance > 700 km → custom_quote (reason: distance)", () => {
  const r = quote({ ...BASE, date: "2026-03-15", distanceKm: 800 });
  assert.equal(r.type, "custom_quote");
  assert.equal(r.reason, "distance");
});

test("exclusion: special flag (piano) → custom_quote (reason: special)", () => {
  const r = quote({ ...BASE, date: "2026-03-15", flags: ["piano"] });
  assert.equal(r.type, "custom_quote");
  assert.equal(r.reason, "special");
});

test("validation: bad size + out-of-range movers → ok:false with errors", () => {
  const r = quote({ size: "9.9", movers: 99, distanceKm: 10, date: "2026-03-15" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 2);
});

test("validation: invalid date → ok:false with 'date invalide'", () => {
  const r = quote({ ...BASE, date: "not-a-date" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes("date invalide"));
});

test("travel: local move (≤40 km) uses the 1.0 h forfait", () => {
  const r = quote({ ...BASE, date: "2026-03-15", distanceKm: 10 });
  assert.equal(r.breakdown.travelHours, 1.0);
});

test("travel: long haul rounds distance/90 to nearest 0.5 h", () => {
  // 300 km / 90 = 3.33… → rounds to 3.5 h
  const r = quote({ ...BASE, date: "2026-03-15", distanceKm: 300 });
  assert.equal(r.breakdown.travelHours, 3.5);
});
