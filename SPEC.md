# Rapido — Calculateur de soumission (SPEC)

Build brief for the Groupe Rapido instant-quote tool. This file is the source of
truth: `pricing.config.json` holds the numbers, `pricing.js` holds the math, and
this doc holds the architecture and the contract everything else builds against.

Origin pricing doc: `Tarification_Demenagement_Residentiel.docx` (Bruno Jacques, 17 juin 2026).
Decision for v1: encode the doc as-is; adjust by editing `pricing.config.json` during testing.

---

## 1. Architecture (Option 3 — Worker + thin Elementor frontend)

```
WordPress/Elementor page  --POST inputs-->  Cloudflare Worker  --returns price-->  page renders quote
(HTML widget, thin client)                  (pricing.js, hidden)        |
                                                                        +--> create lead item in Monday.com (CRM)
```

- Pricing logic lives in the Worker, never in the browser → Bruno's formula stays private.
- The Elementor widget is a dumb form: collect inputs, POST, render the returned number.
- On a successful quote, the Worker creates a lead item in Bruno's Monday.com board.
- Pure rule-based. **No Claude API** — the logic is deterministic; an LLM would only add latency and inconsistency.

## 2. Repo structure

```
rapido-quote/
├── SPEC.md                  ← this file
├── pricing.config.json      ← rates, hours, season table, exclusions (Bruno edits this)
├── pricing.js               ← deterministic computeQuote() (do not hand-edit numbers here)
├── src/
│   └── worker.js            ← fetch handler: CORS, parse, computeQuote, create Monday lead, respond
├── wrangler.toml            ← Worker config + bindings/secrets
├── test/
│   └── pricing.test.js      ← assert doc section 8 examples (1241.73 / 1427.99 / 3104.33)
└── elementor/
    └── widget.html          ← paste-into-HTML-widget client (form + fetch + render)
```

## 3. API contract

**Request** `POST /quote`
```json
{ "size": "4.5", "movers": 3, "distanceKm": 35, "date": "2026-03-15", "flags": [] }
```

**Response — instant quote**
```json
{
  "ok": true, "type": "instant_quote", "currency": "CAD",
  "breakdown": { "hourlyRate": 180, "workHours": 5, "travelHours": 1, "totalHours": 6,
                 "seasonMult": 1.0, "subtotal": 1080.0, "taxMultiplier": 1.14975 },
  "total": 1241.73
}
```

**Response — custom quote** (excluded case)
```json
{ "ok": true, "type": "custom_quote", "reason": "size",
  "message": "Ce déménagement nécessite une soumission personnalisée." }
```
Frontend shows "À partir de…" + a **Demander une soumission personnalisée** button instead of a final price.

**Response — validation error**
```json
{ "ok": false, "errors": ["date invalide"] }
```

## 4. Pricing reference (encoded in config/js)

- `tarif_horaire = 90 + 30 × movers`  →  120 / 150 / 180 / 210 / 240
- `heures_travail` by size: 2½=2.5, 3½=4, 4½=5, 5½=5.5, 6½+=6, Maison=5.5
- `heures_deplacement`: ≤40 km → 1.0 h ; else round_nearest_0.5(distance / 90)
- `majoration` = season table (peak around 1 juillet, ×2.50)
- `sous_total = tarif_horaire × heures_totales × majoration`
- `total = sous_total × 1.14975` (TPS + TVQ)

Exclusions → custom quote: distance > 700 km, any special flag (piano, coffre-fort, objet d'art,
accès difficile, entreposage, adresses multiples, commercial), or any size whose `autoQuote` is false.
All sizes default to `autoQuote: true` per the doc; 2½, 6½+, and Maison are flagged to watch.

## 5. Lead destination — Monday.com (CRM)

Rapido already runs its pipeline in Monday (the doc's pricing data was exported from it), so the
lead goes straight into a Monday board as a new item — no email provider, no DNS change, no Outlook
deliverability problem. This deletes the entire email branch.

- **Mechanism:** on a successful quote the Worker calls Monday's GraphQL API (`create_item` mutation).
- **Needed from Bruno (one-time):** Monday API token, target `boardId`, `groupId`, and the column IDs to
  map — customer name, phone, email, size, movers, distance, date, and the computed total.
- **Secret:** `wrangler secret put MONDAY_TOKEN`. Never in the repo.
- **Column values:** passed as a JSON string in the mutation. Claude Code writes the mutation; Bruno supplies the IDs.
- **Abuse guard (required for v1):** this is a public endpoint creating CRM items. Add a honeypot field +
  a basic per-IP rate limit in the Worker. Add Cloudflare Turnstile later only if spam shows up.
- **Optional later:** also email servicerapido@outlook.com as a secondary notification — not needed if the
  lead lands in Monday.

## 6. Elementor integration

- Build inside Elementor with a normal multi-field form, or hand-roll in the **HTML widget**.
- The widget JS intercepts submit, POSTs to the Worker, and injects `total` into a results div — no page reload.
- **CORS:** Worker must return `Access-Control-Allow-Origin: https://<rapido-site>` and handle the
  `OPTIONS` preflight. Lock the origin to Rapido's domain, not `*`.
- **If inline `<script>` is stripped** by a security plugin (Wordfence etc.), inject the JS via **WPCode**
  instead of the HTML widget. (LC has admin, so either works.)
- Distance: v1 can ask the customer for km directly, or compute it from two addresses via a maps API later.
  Start with a km field to avoid a maps dependency on day one.

## 7. For Bruno / open items

- From Bruno: Monday API token + target `boardId`, `groupId`, and the column IDs for the lead fields.
- During testing, decide whether 2½, 6½+, Maison stay `autoQuote: true` or flip to custom quote.
- Long-distance (distance/90) is unvalidated in the doc — sanity-check a few real long hauls before trusting it.
- (Optional) put a subdomain like `api.servicerapido.ca` on Cloudflare for a clean Worker URL — not required, `workers.dev` works.

## 8. Claude Code task list (build these around the fixed core above)

1. `src/worker.js` — fetch handler, CORS + OPTIONS, JSON parse, call `computeQuote`, create Monday lead item, respond. Include honeypot + per-IP rate limit.
2. `wrangler.toml` — Worker name, compatibility date, `MONDAY_TOKEN` secret ref, and board/group/column IDs as vars.
3. `test/pricing.test.js` — assert the three doc section-8 totals; run before every deploy.
4. `elementor/widget.html` — French UI: size select, movers, date picker, distance (km), special-item checkboxes,
   "Obtenir ma soumission" button, result/custom-quote rendering, error states.
5. Deploy; verify CORS from the live Rapido origin; send one real test lead to the Outlook address.
