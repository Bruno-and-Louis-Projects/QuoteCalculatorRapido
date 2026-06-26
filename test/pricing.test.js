// pricing.test.js — pins the pricing chain. Run before every deploy: node --test
//
// NOTE: quotes are now shown WITHOUT taxes (taxes en sus), so the totals are the
// pre-tax subtotals. The doc §8 examples were tax-included (1241.73 / 1427.99 /
// 3104.33); their pre-tax equivalents are 1080 / 1242 / 2700 (= subtotal before
// ×1.14975). Special items (piano/coffre-fort/objet d'art) add a flat $250 each.

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

test("§8 — March move (season ×1.00), pre-tax → 1080.00", () => {
  const r = quote({ ...BASE, date: "2026-03-15" });
  assert.equal(r.ok, true);
  assert.equal(r.type, "instant_quote");
  assert.equal(r.breakdown.movers, 3); // derived from size 4½
  assert.equal(r.total, 1080.0);
});

test("§8 — May move (season ×1.15), pre-tax → 1242.00", () => {
  const r = quote({ ...BASE, date: "2026-05-15" });
  assert.equal(r.total, 1242.0);
});

test("§8 — July 1st peak (season ×2.50), pre-tax → 2700.00", () => {
  const r = quote({ ...BASE, date: "2026-07-01" });
  assert.equal(r.total, 2700.0);
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
  assert.equal(r.total, 1330.0); // 1080 + 250
});

test("special fee: all three special items stack to $750", () => {
  const r = quote({ ...BASE, date: "2026-03-15", flags: ["piano", "coffreFort", "objetArt"] });
  assert.equal(r.type, "instant_quote");
  assert.equal(r.breakdown.specialFee, 750);
  assert.equal(r.total, 1830.0); // 1080 + 750
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

test("travel: local move (≤40 km) uses the 1.0 h forfait", () => {
  const r = quote({ ...BASE, date: "2026-03-15", distanceKm: 10 });
  assert.equal(r.breakdown.travelHours, 1.0);
});

test("travel: long haul rounds distance/90 to nearest 0.5 h", () => {
  // 300 km / 90 = 3.33… → rounds to 3.5 h
  const r = quote({ ...BASE, date: "2026-03-15", distanceKm: 300 });
  assert.equal(r.breakdown.travelHours, 3.5);
});
