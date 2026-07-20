// pricing.test.js — pins the pricing chain. Run before every deploy: node --test
//
// NOTE: quotes are now shown WITHOUT taxes (taxes en sus), so the totals are the
// pre-tax subtotals. Special items (piano/coffre-fort/objet d'art) add a flat
// $250 each. Estimated work hours are trimmed by 1 h for every size except
// 'maison' (timeAdjustmentHours in the config). Travel hours are billed
// aller-retour (×2, the return trip). A fuel surcharge of $1.8/km is added flat
// to the total. So the 4½ base example below is work 5−1=4 + travel 1×2=2 = 6 h
// → labour 1080, + fuel 35×1.8=63 → total 1143.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeQuote } from "../pricing.js";

// Load the config via fs (no JSON import attribute needed under Node 22).
const cfg = JSON.parse(readFileSync(new URL("../pricing.config.json", import.meta.url), "utf8"));

// Wrap so each call uses the loaded config, matching how the Worker calls it.
const quote = (input) => computeQuote(input, cfg);

// Base move used across the doc examples: 4½ (auto-derives 3 movers), 35 km.
const BASE = { size: "4.5", service: "residentiel", distanceKm: 35, flags: [] };

test("March move (season ×1.00), pre-tax → 1143.00", () => {
  const r = quote({ ...BASE, date: "2026-03-15" });
  assert.equal(r.ok, true);
  assert.equal(r.type, "instant_quote");
  assert.equal(r.breakdown.movers, 3); // derived from size 4½
  assert.equal(r.breakdown.workHours, 4.0); // 5 − 1 h refinement
  assert.equal(r.breakdown.travelHours, 2.0); // 1 h one-way × 2 (aller-retour)
  assert.equal(r.breakdown.totalHours, 6.0); // work 4 + travel 2
  assert.equal(r.breakdown.fuelCost, 63.0); // 35 km × 1.8
  assert.equal(r.total, 1143.0); // labour 1080 + fuel 63
});

test("May move (season ×1.15), pre-tax → 1305.00", () => {
  const r = quote({ ...BASE, date: "2026-05-15" });
  assert.equal(r.total, 1305.0); // 180×6×1.15 = 1242 + fuel 63
});

test("July 1st peak (season ×2.50), pre-tax → 2763.00", () => {
  const r = quote({ ...BASE, date: "2026-07-01" });
  assert.equal(r.total, 2763.0); // 180×6×2.50 = 2700 + fuel 63
});

// --- A few guardrail cases beyond the doc, so the contract stays honest ---

test("exclusion: distance > 700 km → custom_quote (reason: distance)", () => {
  const r = quote({ ...BASE, date: "2026-03-15", distanceKm: 800 });
  assert.equal(r.type, "custom_quote");
  assert.equal(r.reason, "distance");
});

test("special fee: piano adds a flat $250 (still an instant quote)", () => {
  const r = quote({ ...BASE, date: "2026-03-15", flags: ["piano"] });
  assert.equal(r.type, "instant_quote");
  assert.equal(r.breakdown.specialFee, 250);
  assert.equal(r.total, 1393.0); // 1080 labour + 250 + fuel 63
});

test("special fee: all three special items stack to $750", () => {
  const r = quote({ ...BASE, date: "2026-03-15", flags: ["piano", "coffreFort", "objetArt"] });
  assert.equal(r.type, "instant_quote");
  assert.equal(r.breakdown.specialFee, 750);
  assert.equal(r.total, 1893.0); // 1080 labour + 750 + fuel 63
});

test("service: non-residential → custom_quote (reason: service)", () => {
  const r = quote({ ...BASE, date: "2026-03-15", service: "commercial" });
  assert.equal(r.type, "custom_quote");
  assert.equal(r.reason, "service");
});

test("movers: 2½ → 2, every other size → 3", () => {
  assert.equal(quote({ ...BASE, size: "2.5", date: "2026-03-15" }).breakdown.movers, 2);
  assert.equal(quote({ ...BASE, size: "3.5", date: "2026-03-15" }).breakdown.movers, 3);
  assert.equal(quote({ ...BASE, size: "6.5", date: "2026-03-15" }).breakdown.movers, 3);
  assert.equal(quote({ ...BASE, size: "maison", date: "2026-03-15" }).breakdown.movers, 3);
});

test("time refinement: −1 h off work hours for a non-house size (4½: 5 → 4)", () => {
  const r = quote({ ...BASE, size: "4.5", date: "2026-03-15" });
  assert.equal(r.breakdown.workHours, 4.0);
});

test("time refinement: 'maison' is exempt and keeps its full 5.5 h", () => {
  const r = quote({ ...BASE, size: "maison", date: "2026-03-15" });
  assert.equal(r.breakdown.workHours, 5.5); // no −1 h for a house
  // work 5.5 + travel 1×2 = 7.5 h, hourly 180, ×1.00 → 1350; + fuel 63 → 1413
  assert.equal(r.breakdown.totalHours, 7.5);
  assert.equal(r.total, 1413.0);
});

test("validation: bad size → ok:false with 'type de logement invalide'", () => {
  const r = quote({ ...BASE, size: "9.9", date: "2026-03-15" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes("type de logement invalide"));
});

test("validation: invalid date → ok:false with 'date invalide'", () => {
  const r = quote({ ...BASE, date: "not-a-date" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes("date invalide"));
});

test("travel: local move (≤40 km) uses the 1.0 h forfait, billed aller-retour → 2.0 h", () => {
  const r = quote({ ...BASE, date: "2026-03-15", distanceKm: 10 });
  assert.equal(r.breakdown.travelHours, 2.0); // 1.0 h one-way × 2
});

test("travel: long haul rounds distance/90 to nearest 0.5 h, then ×2 aller-retour", () => {
  // 300 km / 90 = 3.33… → rounds to 3.5 h one-way → ×2 = 7.0 h
  const r = quote({ ...BASE, date: "2026-03-15", distanceKm: 300 });
  assert.equal(r.breakdown.travelHours, 7.0);
});

test("fuel: flat $1.8/km added to the total, independent of distance banding", () => {
  const r = quote({ ...BASE, date: "2026-03-15", distanceKm: 100 });
  assert.equal(r.breakdown.fuelCost, 180.0); // 100 × 1.8
});
