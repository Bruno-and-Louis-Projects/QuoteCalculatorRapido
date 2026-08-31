// smartmoving.js — maps a computed quote onto a SmartMoving CRM lead and posts it.
//
// Split out of worker.js so the mapping (name split, address parsing, payload
// shape) can be unit-tested: worker.js imports the widget as a .txt module,
// which only the Cloudflare bundler can resolve, so it can't be imported from
// `node --test`. This file has no bundler-specific imports.

// ---------------------------------------------------------------------------
// SmartMoving — create a lead via the "lead from provider" endpoint.
//
//   POST https://api.smartmoving.com/api/leads/from-provider/v2?providerKey=...
//   Content-Type: application/json
//
// The provider key is the credential, so it lives in the SMARTMOVING_PROVIDER_KEY
// secret (never in wrangler.toml). Optional SMARTMOVING_BRANCH_ID routes leads to
// a specific branch. Only the name is required by SmartMoving; every other field
// is sent only when we have a value. Any field SmartMoving doesn't recognise is
// appended to the lead's Notes rather than rejected — but we deliberately send
// only documented fields and put everything else in `notes` ourselves, so the
// note stays readable instead of being a dump of key/value pairs.
// ---------------------------------------------------------------------------
const SMARTMOVING_LEAD_URL = "https://api.smartmoving.com/api/leads/from-provider/v2";

export async function createSmartMovingLead({ lead, input, result, env }) {
  // SmartMoving wants the address split into street / city / state / zip, but the
  // form collects one free-text line. Geocode each address to get clean parts,
  // falling back to a local comma-parse (and finally to the raw line as street),
  // so a throttled geocoder never loses the address.
  //
  // Do the two lookups SEQUENTIALLY, not in parallel: the keyless default
  // (Nominatim) allows only ~1 request/sec, so two concurrent lookups get one
  // throttled — that's why a second address used to come back empty. Google has
  // no such limit, so only pace the calls on the keyless path. This runs in
  // ctx.waitUntil, so the wait never delays the customer's quote.
  const paceNominatim = !isConfigured(env.GOOGLE_MAPS_API_KEY);
  const originParts = await resolveAddress(lead.originAddress, env);
  if (paceNominatim && lead.originAddress && lead.destAddress) await sleep(1100);
  const destParts = await resolveAddress(lead.destAddress, env);

  const payload = buildLeadPayload({ lead, input, result, originParts, destParts });

  const url = new URL(SMARTMOVING_LEAD_URL);
  url.searchParams.set("providerKey", normalizeProviderKey(env.SMARTMOVING_PROVIDER_KEY));
  if (isConfigured(env.SMARTMOVING_BRANCH_ID)) {
    url.searchParams.set("branchId", env.SMARTMOVING_BRANCH_ID);
  }

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`SmartMoving API ${res.status}: ${text.slice(0, 500)}`);
  }
  return text;
}

// Maps our lead fields onto SmartMoving's documented lead-provider payload. Every
// property sits at the ROOT of the object. The quote breakdown, the provenance
// and the customer's own message have no dedicated SmartMoving field, so they go
// into `notes`. An empty value is omitted rather than sent blank.
export function buildLeadPayload({ lead, input, result, originParts, destParts }) {
  const p = {};

  // Name: SmartMoving accepts firstName + lastName OR fullName — never both.
  const { firstName, lastName } = splitName(lead.name);
  if (firstName && lastName) {
    p.firstName = firstName;
    p.lastName = lastName;
  } else {
    // Name is the one required field, so always send something identifiable.
    p.fullName = lead.name || lead.email || lead.phone || "Soumission web";
  }

  if (lead.phone) p.phoneNumber = lead.phone;
  if (lead.email) p.email = lead.email;

  // moveDate is YYYYMMDD; the form gives YYYY-MM-DD.
  if (typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    p.moveDate = input.date.replace(/-/g, "");
  }

  // Bedrooms, derived from the Québec-style size (3½ = 1 chambre, 4½ = 2, …).
  // Left off for "maison", where the room count isn't implied by the label.
  const bedrooms = BEDROOMS[input.size];
  if (bedrooms !== undefined) p.bedrooms = bedrooms;

  if (originParts.street) p.originStreet = originParts.street;
  if (originParts.city) p.originCity = originParts.city;
  if (originParts.state) p.originState = originParts.state;
  if (originParts.zip) p.originZip = originParts.zip;

  if (destParts.street) p.destinationStreet = destParts.street;
  if (destParts.city) p.destinationCity = destParts.city;
  if (destParts.state) p.destinationState = destParts.state;
  if (destParts.zip) p.destinationZip = destParts.zip;

  p.notes = buildDetails({ lead, input, result });

  return p;
}

// Human-readable quote summary dropped into the SmartMoving lead's Notes so
// Bruno sees the whole computation at a glance, instant or custom.
function buildDetails({ lead, input, result }) {
  const flags = (input.flags || []).map(flagLabel).join(", ") || "aucun";
  const lines = [];
  if (result.type === "instant_quote") {
    const b = result.breakdown;
    lines.push("Soumission instantanée (calculateur web)");
    lines.push(`Service : ${lead.serviceLabel || "Déménagement Résidentiel"}`);
    lines.push(`Logement : ${sizeLabel(input.size)}`);
    lines.push(`Déménageurs : ${b.movers}`);
    lines.push(`Distance : ${input.distanceKm} km`);
    lines.push(`Date du déménagement : ${input.date}`);
    lines.push(`Heures estimées : ${b.totalHours} h (travail ${b.workHours} + déplacement ${b.travelHours})`);
    lines.push(`Tarif horaire : ${b.hourlyRate} $/h`);
    lines.push(`Majoration saison : ×${b.seasonMult}`);
    lines.push(`Main-d'œuvre : ${b.laborSubtotal} $`);
    if (b.specialFee) lines.push(`Frais éléments particuliers : ${b.specialFee} $`);
    if (b.fuelCost) lines.push(`Carburant : ${b.fuelCost} $`);
    lines.push(`TOTAL (taxes en sus) : ${result.total} $`);
  } else {
    lines.push("Soumission PERSONNALISÉE requise (calculateur web)");
    lines.push(`Raison : ${reasonLabel(result.reason)}`);
    lines.push(`Service : ${lead.serviceLabel || "—"}`);
    lines.push(`Logement : ${sizeLabel(input.size)}`);
    lines.push(`Distance : ${input.distanceKm} km`);
    lines.push(`Date du déménagement : ${input.date}`);
  }
  lines.push(`Adresse de départ : ${lead.originAddress || "—"}`);
  lines.push(`Adresse de destination : ${lead.destAddress || "—"}`);
  lines.push(`Éléments particuliers : ${flags}`);
  lines.push(`Provenance : ${lead.provenance || "—"}`);
  if (lead.notes) {
    lines.push("");
    lines.push(`Notes du client : ${lead.notes}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Addresses — SmartMoving takes street / city / state / zip separately, the form
// collects one free-text line. Two independent sources, merged:
//
//   1. a geocoder (Google if keyed, else Nominatim → Photon), which normalises
//      the address properly but can be throttled;
//   2. a local comma-parse, which needs no network and covers the usual
//      "123 rue Principale, Montréal, QC H2X 1Y4" shape.
//
// The geocoder wins field by field; the local parse fills whatever it left
// empty; and the raw line is always the last-resort street, so the address can
// never be dropped entirely. The full line is also written into the note.
// ---------------------------------------------------------------------------
async function resolveAddress(address, env) {
  if (!address) return {};
  const local = parseAddressText(address);
  let geo = null;
  try {
    geo = await geocode(address, env);
  } catch (err) {
    console.error("Geocode failed:", err?.message || err);
  }
  geo = geo || {};
  return {
    street: geo.street || local.street || address,
    city: geo.city || local.city || "",
    state: geo.state || local.state || "",
    zip: geo.zip || local.zip || "",
  };
}

// Best-effort split of a typed address line, no network involved.
// "123 rue Principale, Montréal, QC H2X 1Y4" → street / city / QC / H2X 1Y4
const CA_POSTAL = /\b([A-Za-z]\d[A-Za-z])[ -]?(\d[A-Za-z]\d)\b/;
export function parseAddressText(address) {
  const out = { street: "", city: "", state: "", zip: "" };
  let rest = String(address || "").trim();
  if (!rest) return out;

  // Postal code can sit anywhere; pull it out first so it doesn't pollute a part.
  const pc = rest.match(CA_POSTAL);
  if (pc) {
    out.zip = (pc[1] + " " + pc[2]).toUpperCase();
    rest = (rest.slice(0, pc.index) + " " + rest.slice(pc.index + pc[0].length)).trim();
  }

  let parts = rest.split(",").map((s) => s.trim()).filter(Boolean);

  // Drop a trailing country, then take a trailing province — as its own comma
  // part ("…, Montréal, QC") or tacked onto the last one ("…, Montréal QC").
  if (parts.length > 1 && isCountry(parts[parts.length - 1])) parts.pop();
  while (parts.length > 1 && provinceCode(parts[parts.length - 1])) {
    out.state = provinceCode(parts.pop());
  }
  if (!out.state && parts.length) {
    const last = parts[parts.length - 1];
    const m = last.match(/^(.*?)[\s,]+(\S+)$/);
    const code = m && provinceCode(m[2]);
    if (code && m[1].trim()) {
      out.state = code;
      parts[parts.length - 1] = m[1].trim();
    }
  }

  out.street = parts.shift() || "";
  out.city = parts.shift() || "";
  return out;
}

// Canadian province/territory → two-letter code. Accent- and case-insensitive,
// accepts the code itself, and the English or French name. Returns "" if the
// value isn't a province, which is what makes it usable as a test.
const PROVINCES = {
  ab: "AB", alberta: "AB",
  bc: "BC", "british columbia": "BC", "colombie britannique": "BC", "colombie-britannique": "BC",
  mb: "MB", manitoba: "MB",
  nb: "NB", "new brunswick": "NB", "nouveau brunswick": "NB", "nouveau-brunswick": "NB",
  nl: "NL", "newfoundland and labrador": "NL", "terre neuve et labrador": "NL",
  ns: "NS", "nova scotia": "NS", "nouvelle ecosse": "NS", "nouvelle-ecosse": "NS",
  nt: "NT", "northwest territories": "NT", "territoires du nord ouest": "NT",
  nu: "NU", nunavut: "NU",
  on: "ON", ontario: "ON",
  pe: "PE", pei: "PE", "prince edward island": "PE", "ile du prince edouard": "PE",
  qc: "QC", quebec: "QC", pq: "QC",
  sk: "SK", saskatchewan: "SK",
  yt: "YT", yukon: "YT",
};
export function provinceCode(value) {
  const key = normalize(value);
  return PROVINCES[key] || "";
}
function isCountry(value) {
  const key = normalize(value);
  return key === "canada" || key === "ca";
}
// Lowercase, strip accents and trailing punctuation, collapse whitespace — so
// "Québec", "QUEBEC" and "Qc." all land on the same key.
function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Geocoding — turn a free-text address into { street, city, state, zip }.
//
// Reliability is the whole game here. The keyless public geocoders (Nominatim,
// Photon) rate-limit HARD by IP, and a Cloudflare Worker shares its egress IP
// with countless other tenants — so a lookup can be throttled at random. That's
// exactly why the *second* address (destination) kept coming back empty. The fix
// is to not depend on any single provider: we try them in order and, for the
// throttle-prone ones, retry once before moving on. If a key is set we use the
// keyed provider first (no shared-IP limits). Best-effort throughout: the caller
// falls back to the local parse and to the raw line, so nothing is ever lost.
// ---------------------------------------------------------------------------
async function geocode(address, env) {
  if (!address) return null;
  const providers = [];
  if (isConfigured(env.GOOGLE_MAPS_API_KEY)) {
    providers.push(() => geocodeGoogle(address, env.GOOGLE_MAPS_API_KEY));
  }
  providers.push(() => geocodeNominatim(address));
  providers.push(() => geocodePhoton(address));

  for (const run of providers) {
    try {
      const geo = await run();
      if (geo) return geo;
    } catch (err) {
      console.error("Geocoder error:", err?.message || err);
    }
  }
  return null;
}

async function geocodeGoogle(address, key) {
  const url =
    "https://maps.googleapis.com/maps/api/geocode/json?address=" +
    encodeURIComponent(address) + "&region=ca&key=" + encodeURIComponent(key);
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const hit = data?.results?.[0];
  if (!hit) return null;
  const part = (type) =>
    (hit.address_components || []).find((c) => (c.types || []).includes(type));
  const streetNumber = part("street_number")?.long_name || "";
  const route = part("route")?.long_name || "";
  return nonEmptyParts({
    street: [streetNumber, route].filter(Boolean).join(" "),
    city:
      part("locality")?.long_name ||
      part("postal_town")?.long_name ||
      part("administrative_area_level_2")?.long_name ||
      "",
    // short_name is already the two-letter code (QC, ON, …).
    state: part("administrative_area_level_1")?.short_name || "",
    zip: part("postal_code")?.long_name || "",
  });
}

// OpenStreetMap Nominatim. Requires an identifying User-Agent, and
// addressdetails=1 for the structured breakdown. Retries once on a throttle/5xx
// (returns null on a genuine "no match" so we don't waste the retry).
async function geocodeNominatim(address) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&countrycodes=ca&q=" +
    encodeURIComponent(address);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(1500); // back off before the retry
    const res = await fetch(url, {
      headers: { "User-Agent": "GroupeRapidoQuoteBot/1.0 (https://servicerapido.com)" },
    });
    if (res.status === 429 || res.status === 403 || res.status >= 500) continue; // throttled → retry
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;
    const a = data[0].address || {};
    // ISO3166-2-lvl4 looks like "CA-QC"; fall back to the spelled-out state name.
    const iso = String(a["ISO3166-2-lvl4"] || "").split("-")[1] || "";
    return nonEmptyParts({
      street: [a.house_number, a.road].filter(Boolean).join(" "),
      city: a.city || a.town || a.village || a.municipality || a.suburb || "",
      state: provinceCode(iso) || provinceCode(a.state) || "",
      zip: a.postcode || "",
    });
  }
  return null; // exhausted retries → caller falls through to the next provider
}

// Komoot Photon (also OSM-based) — a second, independent free provider used as a
// fallback when Nominatim throttles our shared IP.
async function geocodePhoton(address) {
  const url = "https://photon.komoot.io/api/?limit=1&q=" + encodeURIComponent(address);
  const res = await fetch(url, {
    headers: { "User-Agent": "GroupeRapidoQuoteBot/1.0 (https://servicerapido.com)" },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const props = data?.features?.[0]?.properties;
  if (!props) return null;
  return nonEmptyParts({
    street: [props.housenumber, props.street].filter(Boolean).join(" ") || props.name || "",
    city: props.city || props.town || props.village || props.district || "",
    state: provinceCode(props.state) || "",
    zip: props.postcode || "",
  });
}

// A geocoder "hit" that resolved nothing useful is treated as a miss, so the
// next provider gets a turn instead of us accepting four empty strings.
function nonEmptyParts(parts) {
  return Object.values(parts).some((v) => v) ? parts : null;
}

// Small delay used to keep the keyless Nominatim geocoder within its ~1 req/sec
// usage policy when we look up two addresses back to back.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// "Prénom Nom" → first / last. SmartMoving wants firstName + lastName OR a
// single fullName, never both; a one-word name has no usable split, so the
// caller sends it as fullName instead.
export function splitName(name) {
  const parts = clean(name).split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { firstName: "", lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

// Human-readable size label for the CRM, falling back to the raw key.
const SIZE_LABELS = {
  "2.5": "2½", "3.5": "3½", "4.5": "4½", "5.5": "5½", "6.5": "6½ et plus", maison: "Maison",
};
function sizeLabel(size) { return SIZE_LABELS[size] || size || ""; }

// Québec sizes count total rooms, SmartMoving counts bedrooms: 3½ = 1 chambre,
// 4½ = 2, 5½ = 3, 6½+ = 4. 2½ is a studio, sent as 1 to match the form's own
// "studio / 1 chambre" label. "maison" is left out — the label implies no count,
// and the size always appears in full in the note anyway.
const BEDROOMS = { "2.5": 1, "3.5": 1, "4.5": 2, "5.5": 3, "6.5": 4 };

// Labels for special-item flags and custom-quote reasons (used in the CRM note).
const FLAG_LABELS = {
  piano: "Piano", coffreFort: "Coffre-fort", objetArt: "Objet d'art",
  accesDifficile: "Accès difficile", entreposage: "Entreposage",
  adressesMultiples: "Adresses multiples", commercial: "Commercial",
};
function flagLabel(f) { return FLAG_LABELS[f] || f; }

const REASON_LABELS = {
  service: "Service non résidentiel (soumission sur mesure)",
  distance: "Distance supérieure à 700 km",
  size: "Type de logement à confirmer",
  special: "Élément particulier à évaluer",
};
function reasonLabel(r) { return REASON_LABELS[r] || r || ""; }

// A var is "configured" only if it's a non-empty string that isn't a leftover
// "<PLACEHOLDER>". Lets us ship wrangler.toml with placeholders and have the
// Worker simply skip whatever isn't filled in yet.
export function isConfigured(v) {
  return typeof v === "string" && v.trim() !== "" && !v.trim().startsWith("<");
}

export function clean(v) { return typeof v === "string" ? v.trim() : ""; }

// ---------------------------------------------------------------------------
// Provider key hygiene.
//
// A key SmartMoving doesn't recognise is rejected with
// 400 {"message":"Provider not found."} — which says nothing about WHY, so a
// stray character costs a full debugging cycle. Two defences:
//
//   1. SmartMoving's own UI offers both a "Provider Key" and an "API Link"
//      (their help article is literally titled "Lookup a Provider Key / API
//      Link"), so pasting the whole URL instead of the bare key is an easy and
//      invisible mistake. Accept either.
//   2. Trim whitespace and wrapping quotes — a trailing newline from a copy or
//      a dashboard field survives into the query string as %0A and fails the
//      lookup while looking perfectly correct on screen.
// ---------------------------------------------------------------------------
export function normalizeProviderKey(raw) {
  const trimmed = clean(raw).replace(/^["']+|["']+$/g, "").trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const fromUrl = new URL(trimmed).searchParams.get("providerKey");
      if (fromUrl && fromUrl.trim()) return fromUrl.trim();
    } catch {
      // Not a parseable URL after all — fall through and use it as-is.
    }
  }
  return trimmed;
}

// Shape of the configured key, for /health. Never returns the value itself —
// only what's needed to tell "wrong key" from "malformed key": a pasted URL or
// a truncated paste shows up immediately as a wrong length / non-UUID shape.
const PROVIDER_KEY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function describeProviderKey(raw) {
  const key = normalizeProviderKey(raw);
  return {
    present: key !== "",
    length: key.length,
    looksLikeUuid: PROVIDER_KEY_UUID.test(key),
    extractedFromUrl: /^https?:\/\//i.test(clean(raw)),
  };
}
