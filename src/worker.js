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

// Maps our lead fields onto Monday column IDs. Each MONDAY_COL_* var is the
// column ID on Bruno's board; if a var is unset, that field is simply skipped.
function buildColumnValues({ contact, input, result, env }) {
  const cv = {};
  // Resolve a column ID only if it's really set — empty or a leftover
  // "<PLACEHOLDER>" means "not mapped yet", so we skip it rather than send a
  // bogus column ID (which Monday would reject for the whole item).
  const colId = (v) => (isConfigured(v) ? v : null);
  const set = (id, value) => { const c = colId(id); if (c && value !== undefined && value !== null && value !== "") cv[c] = value; };

  // text columns take a plain string
  set(env.MONDAY_COL_SIZE, sizeLabel(input.size));
  set(env.MONDAY_COL_MOVERS, String(input.movers));        // text or numbers col
  set(env.MONDAY_COL_DISTANCE, String(input.distanceKm));  // text or numbers col

  // phone column: { phone, countryShortName }
  if (colId(env.MONDAY_COL_PHONE) && contact.phone) {
    cv[env.MONDAY_COL_PHONE] = { phone: contact.phone, countryShortName: "CA" };
  }
  // email column: { email, text }
  if (colId(env.MONDAY_COL_EMAIL) && contact.email) {
    cv[env.MONDAY_COL_EMAIL] = { email: contact.email, text: contact.email };
  }
  // date column: { date: "YYYY-MM-DD" }
  if (colId(env.MONDAY_COL_DATE) && input.date) {
    cv[env.MONDAY_COL_DATE] = { date: input.date };
  }
  // total: numbers column wants a string; if it's a text column this still works
  set(env.MONDAY_COL_TOTAL, result.type === "instant_quote" ? String(result.total) : "");

  // Status/type so Bruno can tell instant quotes from custom-quote requests.
  // If MONDAY_COL_TYPE is a status column use { label: "..." }; if text, a string.
  if (colId(env.MONDAY_COL_TYPE)) {
    cv[env.MONDAY_COL_TYPE] = { label: result.type === "instant_quote" ? "Soumission auto" : "Soumission perso" };
  }

  return cv;
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
