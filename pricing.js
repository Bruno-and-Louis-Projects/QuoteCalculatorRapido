// pricing.js — deterministic quote engine for Groupe Rapido (résidentiel)
// Pure functions only. No I/O, no fetch, no email. The Worker imports computeQuote()
// and wraps it with the HTTP handler + lead email. Keeping pricing pure means it can
// be unit-tested in isolation and Bruno's numbers live entirely in pricing.config.json.
//
// Input contract:
//   {
//     size:       "2.5" | "3.5" | "4.5" | "5.5" | "6.5" | "maison",
//     movers:     1..5,
//     distanceKm: number >= 0,
//     date:       "YYYY-MM-DD" (moving date),
//     flags:      string[]  (optional: "piano","coffreFort","adressesMultiples",...)
//   }

import config from "./pricing.config.json" with { type: "json" };

export function computeQuote(input, cfg = config) {
  const errors = validate(input, cfg);
  if (errors.length) return { ok: false, errors };

  const sizeDef = cfg.sizes[input.size];

  // Route excluded cases to a custom quote instead of a (possibly wrong) final price.
  const reason = checkExclusions(input, sizeDef, cfg);
  if (reason) {
    return {
      ok: true,
      type: "custom_quote",
      reason, // "distance" | "size" | "special"
      message: "Ce déménagement nécessite une soumission personnalisée."
    };
  }

  const workHours = sizeDef.workHours;
  const travelHours = travelHoursFor(input.distanceKm, cfg);
  const totalHours = workHours + travelHours;

  const hourlyRate = cfg.hourlyRate.base + cfg.hourlyRate.perMover * input.movers;
  const seasonMult = seasonMultiplier(input.date, cfg);

  const subtotal = round2(hourlyRate * totalHours * seasonMult);
  const total = round2(subtotal * cfg.taxMultiplier); // taxes incluses

  return {
    ok: true,
    type: "instant_quote",
    currency: cfg.currency,
    inputs: { size: input.size, movers: input.movers, distanceKm: input.distanceKm, date: input.date },
    breakdown: { hourlyRate, workHours, travelHours, totalHours, seasonMult, subtotal, taxMultiplier: cfg.taxMultiplier },
    total
  };
}

function travelHoursFor(distanceKm, cfg) {
  const t = cfg.travel;
  if (distanceKm <= t.localThresholdKm) return t.localHours;
  return roundNearest(distanceKm / t.speedKmh, t.roundToHours);
}

function seasonMultiplier(date, cfg) {
  const md = monthDay(date); // "MM-DD"
  for (const band of cfg.season) {
    if (md >= band.from && md <= band.to) return band.multiplier;
  }
  return cfg._seasonDefault ?? 1.0;
}

function checkExclusions(input, sizeDef, cfg) {
  const ex = cfg.exclusions;
  if (input.distanceKm > ex.maxDistanceKm) return "distance";
  if (sizeDef.autoQuote === false) return "size";
  if ((input.flags || []).some(f => ex.specialFlags.includes(f))) return "special";
  return null;
}

function validate(input, cfg) {
  const e = [];
  if (!input || typeof input !== "object") return ["payload invalide"];
  if (!cfg.sizes[input.size]) e.push("size invalide");
  if (!(Number.isFinite(input.movers) && input.movers >= cfg.hourlyRate.minMovers && input.movers <= cfg.hourlyRate.maxMovers))
    e.push("nombre de déménageurs hors plage (1-5)");
  if (!(typeof input.distanceKm === "number" && input.distanceKm >= 0)) e.push("distance invalide");
  if (!isValidDate(input.date)) e.push("date invalide");
  return e;
}

// --- helpers ---
function monthDay(date) {
  const d = new Date(date);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}
function roundNearest(value, step) { return Math.round(value / step) * step; }
function round2(n) { return Math.round(n * 100) / 100; }
function isValidDate(s) { const d = new Date(s); return !Number.isNaN(d.getTime()); }

// --- sanity check (matches doc section 8): 4½, 3 movers, 35 km, March ---
// hourly 180, hours 5+1=6, mult 1.00 -> subtotal 1080.00 -> total 1241.73
