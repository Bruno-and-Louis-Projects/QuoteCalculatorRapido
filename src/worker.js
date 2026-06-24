// worker.js — Cloudflare Worker HTTP handler for Groupe Rapido's quote tool.
//
// Responsibilities (SPEC §8.1):
//   1. CORS, locked to Rapido's origin + OPTIONS preflight.
//   2. Parse the POST /quote body.
//   3. Honeypot + basic per-IP rate limit (abuse guard, SPEC §5).
//   4. computeQuote() — pricing logic stays server-side, never in the browser.
//   5. On an instant quote, create a lead item in Monday.com (CRM).
//   6. Respond with the JSON contract from SPEC §3.
//
// Pricing numbers live in pricing.config.json; logic in pricing.js. This file
// only does transport, abuse-guarding, and the Monday side effect.

import { computeQuote } from "../pricing.js";
import pricingConfig from "../pricing.config.json"; // bundler inlines this JSON

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    // --- CORS preflight ---
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Only POST /quote is supported.
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/quote") {
      return json({ ok: false, errors: ["route inconnue"] }, 404, cors);
    }

    // --- Per-IP rate limit (basic, best-effort within an isolate) ---
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (isRateLimited(ip, env)) {
      return json({ ok: false, errors: ["trop de requêtes, réessayez plus tard"] }, 429, cors);
    }

    // --- Parse body ---
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, errors: ["JSON invalide"] }, 400, cors);
    }

    // --- Honeypot: a hidden field bots fill but humans never see ---
    // The widget renders <input name="company"> off-screen. If it's non-empty,
    // silently pretend success without creating a lead or computing a price.
    if (body && typeof body.company === "string" && body.company.trim() !== "") {
      return json({ ok: true, type: "instant_quote", total: 0, breakdown: {}, currency: "CAD" }, 200, cors);
    }

    // --- Pricing ---
    const quoteInput = {
      size: body?.size,
      movers: toNumber(body?.movers),
      distanceKm: toNumber(body?.distanceKm),
      date: body?.date,
      flags: Array.isArray(body?.flags) ? body.flags : [],
    };

    const result = computeQuote(quoteInput, pricingConfig);

    if (!result.ok) {
      return json(result, 400, cors);
    }

    // --- Create the Monday lead (instant quotes AND custom-quote requests) ---
    // We want the lead either way: an instant quote is a hot lead, and a
    // custom-quote case is one Bruno needs to follow up on manually.
    const contact = {
      name: clean(body?.name),
      phone: clean(body?.phone),
      email: clean(body?.email),
    };

    // Don't let a Monday outage block the customer's quote: fire it but still
    // return the price. ctx.waitUntil keeps the request alive for the call.
    if (isConfigured(env.MONDAY_TOKEN) && isConfigured(env.MONDAY_BOARD_ID)) {
      ctx.waitUntil(
        createMondayLead({ contact, input: quoteInput, result, env }).catch((err) => {
          console.error("Monday lead creation failed:", err?.message || err);
        })
      );
    }

    return json(result, 200, cors);
  },
};

// ---------------------------------------------------------------------------
// Monday.com — create a lead item via GraphQL create_item mutation.
//
// Bruno supplies the board/group/column IDs as wrangler vars and the token as a
// secret. Column *types* in Monday decide the value format; the defaults below
// cover the common types (text / phone / email / numbers / date). If a board
// column is a different type, adjust the matching line in buildColumnValues().
// ---------------------------------------------------------------------------
async function createMondayLead({ contact, input, result, env }) {
  const columnValues = buildColumnValues({ contact, input, result, env });

  const itemName = contact.name || contact.email || contact.phone || "Soumission web";

  const query = `
    mutation ($boardId: ID!, $groupId: String, $itemName: String!, $columnValues: JSON) {
      create_item(
        board_id: $boardId,
        group_id: $groupId,
        item_name: $itemName,
        column_values: $columnValues
      ) { id }
    }`;

  const variables = {
    boardId: String(env.MONDAY_BOARD_ID),
    groupId: isConfigured(env.MONDAY_GROUP_ID) ? env.MONDAY_GROUP_ID : null,
    itemName,
    columnValues: JSON.stringify(columnValues),
  };

  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: env.MONDAY_TOKEN,
      "API-Version": "2024-01",
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await res.json();
  if (data.errors) {
    throw new Error("Monday API error: " + JSON.stringify(data.errors));
  }
  return data;
}

// Maps our lead fields onto the "New Leads Automatic Quote BETA" board columns.
// The board has no dedicated size/movers/distance/total columns, so contact
// fields map to their real columns and the full quote breakdown goes into the
// "Détails / Projet" long-text column. Each MONDAY_COL_* var is a column ID; an
// unset (empty / "<PLACEHOLDER>") var is simply skipped.
function buildColumnValues({ contact, input, result, env }) {
  const cv = {};
  const colId = (v) => (isConfigured(v) ? v : null);

  // Téléphone (phone): { phone, countryShortName }
  if (colId(env.MONDAY_COL_PHONE) && contact.phone) {
    cv[env.MONDAY_COL_PHONE] = { phone: contact.phone, countryShortName: "CA" };
  }
  // Adresse Courriel (email): { email, text }
  if (colId(env.MONDAY_COL_EMAIL) && contact.email) {
    cv[env.MONDAY_COL_EMAIL] = { email: contact.email, text: contact.email };
  }
  // Nom du client (text)
  if (colId(env.MONDAY_COL_CLIENT_NAME) && contact.name) {
    cv[env.MONDAY_COL_CLIENT_NAME] = contact.name;
  }
  // Date de service (date): the moving date → { date: "YYYY-MM-DD" }
  if (colId(env.MONDAY_COL_SERVICE_DATE) && input.date) {
    cv[env.MONDAY_COL_SERVICE_DATE] = { date: input.date };
  }
  // Date contact (date): submission date = today (UTC)
  if (colId(env.MONDAY_COL_CONTACT_DATE)) {
    cv[env.MONDAY_COL_CONTACT_DATE] = { date: new Date().toISOString().slice(0, 10) };
  }
  // Détails / Projet (long_text): the full quote breakdown
  if (colId(env.MONDAY_COL_DETAILS)) {
    cv[env.MONDAY_COL_DETAILS] = { text: buildDetails(input, result) };
  }

  return cv;
}

// Human-readable quote summary dropped into the "Détails / Projet" column so
// Bruno sees the whole computation at a glance, instant or custom.
function buildDetails(input, result) {
  const flags = (input.flags || []).map(flagLabel).join(", ") || "aucun";
  const lines = [];
  if (result.type === "instant_quote") {
    const b = result.breakdown;
    lines.push("Soumission instantanée (calculateur web)");
    lines.push(`Logement : ${sizeLabel(input.size)}`);
    lines.push(`Déménageurs : ${input.movers}`);
    lines.push(`Distance : ${input.distanceKm} km`);
    lines.push(`Date du déménagement : ${input.date}`);
    lines.push(`Heures estimées : ${b.totalHours} h (travail ${b.workHours} + déplacement ${b.travelHours})`);
    lines.push(`Tarif horaire : ${b.hourlyRate} $/h`);
    lines.push(`Majoration saison : ×${b.seasonMult}`);
    lines.push(`Sous-total : ${b.subtotal} $`);
    lines.push(`TOTAL (taxes incl.) : ${result.total} $`);
  } else {
    lines.push("Soumission PERSONNALISÉE requise (calculateur web)");
    lines.push(`Raison : ${reasonLabel(result.reason)}`);
    lines.push(`Logement : ${sizeLabel(input.size)}`);
    lines.push(`Déménageurs : ${input.movers}`);
    lines.push(`Distance : ${input.distanceKm} km`);
    lines.push(`Date du déménagement : ${input.date}`);
  }
  lines.push(`Éléments particuliers : ${flags}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// In-memory, per-isolate rate limit. Good enough for the basic abuse guard the
// SPEC asks for in v1. For durable limits across isolates, swap this for a KV
// or Durable Object counter (or Cloudflare's Rate Limiting binding) later.
const HITS = new Map(); // ip -> number[] (recent request timestamps, ms)
function isRateLimited(ip, env) {
  const windowMs = Number(env.RATE_LIMIT_WINDOW_MS || 60_000);
  const max = Number(env.RATE_LIMIT_MAX || 8);
  const now = Date.now();
  const recent = (HITS.get(ip) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  HITS.set(ip, recent);
  // opportunistic cleanup so the Map can't grow unbounded
  if (HITS.size > 5000) HITS.clear();
  return recent.length > max;
}

function corsHeaders(origin, env) {
  // Lock to Rapido's origin. ALLOWED_ORIGIN may be a comma-separated list.
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  const allowOrigin = allowed.includes(origin) ? origin : (allowed[0] || "");
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}

// A var is "configured" only if it's a non-empty string that isn't a leftover
// "<PLACEHOLDER>". Lets us ship wrangler.toml with placeholders and have the
// Worker simply skip whatever isn't filled in yet.
function isConfigured(v) {
  return typeof v === "string" && v.trim() !== "" && !v.trim().startsWith("<");
}

function toNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return v; // let validate() reject it
}
function clean(v) { return typeof v === "string" ? v.trim() : ""; }

// Human-readable size label for the CRM, falling back to the raw key.
const SIZE_LABELS = {
  "2.5": "2½", "3.5": "3½", "4.5": "4½", "5.5": "5½", "6.5": "6½ et plus", maison: "Maison",
};
function sizeLabel(size) { return SIZE_LABELS[size] || size || ""; }

// Labels for special-item flags and custom-quote reasons (used in the CRM note).
const FLAG_LABELS = {
  piano: "Piano", coffreFort: "Coffre-fort", objetArt: "Objet d'art",
  accesDifficile: "Accès difficile", entreposage: "Entreposage",
  adressesMultiples: "Adresses multiples", commercial: "Commercial",
};
function flagLabel(f) { return FLAG_LABELS[f] || f; }

const REASON_LABELS = {
  distance: "Distance supérieure à 700 km",
  size: "Type de logement à confirmer",
  special: "Élément particulier à évaluer",
};
function reasonLabel(r) { return REASON_LABELS[r] || r || ""; }
