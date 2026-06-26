// pricing.js — deterministic quote engine for Groupe Rapido (résidentiel)
// Pure functions only. No I/O, no fetch, no email. The Worker imports computeQuote()
// and wraps it with the HTTP handler + lead email. Keeping pricing pure means it can
// be unit-tested in isolation and Bruno's numbers live entirely in pricing.config.json.
//
// Input contract:
//   {
//     size:       "2.5" | "3.5" | "4.5" | "5.5" | "6.5" | "maison",
//     service:    "residentiel" | "commercial" | "livraison" | "transportCommercial" | "sousTraitance",
//     distanceKm: number >= 0,
//     date:       "YYYY-MM-DD" (moving date),
//     flags:      string[]  (optional: "piano","coffreFort","adressesMultiples",...)
//   }
// movers is NOT an input — it is derived from the size (cfg.sizes[size].movers).
//
// `cfg` is the parsed pricing.config.json, passed in by the caller. We don't
// import the JSON here on purpose: a bare JSON import needs an import attribute
// under Node 22 (`with { type: "json" }`) that the Worker's older bundler can't
// parse, and the attribute syntax that one bundler wants the other rejects.
// Decoupling sidesteps the whole mismatch — the Worker and the tests each load
// the JSON the way their environment prefers and hand it in.

export function computeQuote(input, cfg) {
  const errors = validate(input, cfg);
  if (errors.length) return { ok: false, errors };

  const sizeDef = cfg.sizes[input.size];
  const service = input.service || "residentiel"; // default to residential

  // Route excluded cases to a custom quote instead of a (possibly wrong) final price.
  const reason = checkExclusions(input, sizeDef, service, cfg);
  if (reason) {
    return {
      ok: true,
      type: "custom_quote",
      reason, // "service" | "distance" | "size" | "special"
      message: "Ce déménagement nécessite une soumission personnalisée."
    };
  }

  const movers = sizeDef.movers; // derived from size, not chosen by the client
  const workHours = sizeDef.workHours;
  const travelHours = travelHoursFor(input.distanceKm, cfg);
  const totalHours = workHours + travelHours;

  const hourlyRate = cfg.hourlyRate.base + cfg.hourlyRate.perMover * movers;
  const seasonMult = seasonMultiplier(input.date, cfg);

  const laborSubtotal = round2(hourlyRate * totalHours * seasonMult);
  const specialFee = specialFeeFor(input.flags, cfg); // flat surcharge (piano/coffre-fort/objet d'art)
  // Quote is shown WITHOUT taxes (taxes en sus). total = labour + flat fees, pre-tax.
  const subtotal = round2(laborSubtotal + specialFee);
  const total = subtotal;

  return {
    ok: true,
    type: "instant_quote",
    currency: cfg.currency,
    inputs: { size: input.size, service, movers, distanceKm: input.distanceKm, date: input.date },
    breakdown: {
      hourlyRate, movers, workHours, travelHours, totalHours, seasonMult,
      laborSubtotal, specialFee, subtotal, taxMultiplier: cfg.taxMultiplier
    },
    total // pré-taxes
  };
}

// Flat surcharge added per checked special item (piano / coffre-fort / objet d'art).
function specialFeeFor(flags, cfg) {
  const sf = cfg.specialFee;
  if (!sf || !sf.amount) return 0;
  const set = sf.flags || [];
  const count = (flags || []).filter((f) => set.includes(f)).length;
  return sf.amount * count;
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

function checkExclusions(input, sizeDef, service, cfg) {
  const ex = cfg.exclusions;
  // Non-residential services aren't covered by the residential pricing doc.
  if (cfg.services?.[service]?.autoQuote === false) return "service";
  if (input.distanceKm > ex.maxDistanceKm) return "distance";
  if (sizeDef.autoQuote === false) return "size";
  if ((input.flags || []).some(f => ex.specialFlags.includes(f))) return "special";
  return null;
}

function validate(input, cfg) {
  const e = [];
  if (!input || typeof input !== "object") return ["données invalides"];
  if (!cfg.sizes[input.size]) e.push("type de logement invalide");
  if (input.service && !cfg.services?.[input.service]) e.push("service invalide");
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
