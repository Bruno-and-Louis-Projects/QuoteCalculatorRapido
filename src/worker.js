// worker.js — Cloudflare Worker HTTP handler for Groupe Rapido's quote tool.
//
// Responsibilities (SPEC §8.1):
//   1. CORS, locked to Rapido's origin + OPTIONS preflight.
//   2. Parse the POST /quote body.
//   3. Honeypot + basic per-IP rate limit (abuse guard, SPEC §5).
//   4. computeQuote() — pricing logic stays server-side, never in the browser.
//   5. On a submission, create a lead in SmartMoving (CRM).
//   6. Respond with the JSON contract from SPEC §3.
//
// Pricing numbers live in pricing.config.json; logic in pricing.js. This file
// only does transport, abuse-guarding, and the SmartMoving side effect.

import { computeQuote } from "../pricing.js";
import pricingConfig from "../pricing.config.json"; // bundler inlines this JSON
import widgetClient from "../elementor/widget.client.txt"; // served at GET /widget.js
import { createSmartMovingLead, isConfigured, clean } from "./smartmoving.js";

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);
    const url = new URL(request.url);

    // --- Serve the front-end widget script (loaded by elementor/embed.html) ---
    // Public, cacheable for 5 min so merges propagate quickly. This is what makes
    // the WordPress block auto-update: the page loads /widget.js, not a paste.
    if (request.method === "GET" && url.pathname === "/widget.js") {
      return new Response(widgetClient, {
        status: 200,
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=300",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // --- CORS preflight ---
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Only POST /quote is supported.
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
      service: body?.service,                 // residentiel | commercial | ...
      distanceKm: toNumber(body?.distanceKm),  // movers is derived from size, not sent
      date: body?.date,
      flags: Array.isArray(body?.flags) ? body.flags : [],
    };

    const result = computeQuote(quoteInput, pricingConfig);

    if (!result.ok) {
      return json(result, 400, cors);
    }

    // --- Create the SmartMoving lead (instant quotes AND custom-quote requests) ---
    // We want the lead either way: an instant quote is a hot lead, and a
    // custom-quote case is one Bruno needs to follow up on manually.
    const lead = {
      name: clean(body?.name),
      phone: clean(body?.phone),
      email: clean(body?.email),
      originAddress: clean(body?.originAddress),
      destAddress: clean(body?.destAddress),
      provenance: clean(body?.provenance),
      notes: clean(body?.notes),
      // Human-readable label for the chosen service (used in the lead note).
      serviceLabel: pricingConfig.services?.[quoteInput.service]?.label || "",
    };

    // Don't let a SmartMoving outage block the customer's quote: fire it but
    // still return the price. ctx.waitUntil keeps the request alive for the call.
    if (isConfigured(env.SMARTMOVING_PROVIDER_KEY)) {
      ctx.waitUntil(
        createSmartMovingLead({ lead, input: quoteInput, result, env }).catch((err) => {
          console.error("SmartMoving lead creation failed:", err?.message || err);
        })
      );
    } else {
      // Loud on purpose. A missing key drops the lead in a way the customer's
      // response can't reveal — they still get their price — so without this
      // line `wrangler tail` shows nothing at all and a dead integration looks
      // identical to a healthy one. The usual cause is a Worker VERSION that
      // predates the secret: a version is an immutable snapshot of code AND
      // bindings, so adding a secret creates a new version rather than
      // attaching to existing ones (a preview build from before the secret was
      // set will never see it). Rebuild, don't re-set the secret.
      console.error(
        "SMARTMOVING_PROVIDER_KEY not configured on this Worker version — lead NOT sent",
        `(${result.type}, ${result.total ?? "n/a"} $)`
      );
    }

    return json(result, 200, cors);
  },
};

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

function toNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return v; // let validate() reject it
}
