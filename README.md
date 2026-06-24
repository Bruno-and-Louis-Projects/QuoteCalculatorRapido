# Rapido — Calculateur de soumission

Instant moving-quote tool for Groupe Rapido. A Cloudflare Worker holds the
pricing logic; a thin Elementor/WordPress widget collects inputs, POSTs them,
and renders the returned price. Successful submissions create a lead item in
Bruno's Monday.com board.

See [`SPEC.md`](./SPEC.md) for the full architecture and pricing reference.

## Repo layout

```
pricing.config.json   ← rates, hours, season table, exclusions (Bruno edits this)
pricing.js            ← deterministic computeQuote() (don't hand-edit numbers)
src/worker.js         ← HTTP handler: CORS, parse, price, Monday lead, abuse guard
wrangler.toml         ← Worker config + vars (fill the <PLACEHOLDER>s)
test/pricing.test.js  ← asserts the three SPEC §8 totals + guardrails
elementor/widget.html ← French UI to paste into an Elementor HTML widget
```

## Develop & test

```bash
npm install        # installs wrangler (test runner is built into Node)
npm test           # runs the pricing tests — green = pricing chain intact
npm run dev        # local Worker at http://localhost:8787
```

`npm test` is wired into `npm run deploy`, so the three reference totals
(`1241.73 / 1427.99 / 3104.33`) are re-checked before every deploy.

## Go-live checklist

The domain, the Monday board, and the column mapping are all wired in
`wrangler.toml`. What's left:

1. **Monday token (secret, never committed)** — add `MONDAY_TOKEN` as an
   encrypted secret in the Cloudflare dashboard
   (Workers & Pages → `quotecalculatorrapido` → Settings → Variables and
   Secrets → Encrypt), or via CLI: `npx wrangler secret put MONDAY_TOKEN`.
2. **`elementor/widget.html` → `WORKER_URL`** — the deployed Worker URL ending
   in `/quote` (and `CONTACT_URL` for the custom-quote button).
3. **Deploy** — merge to `main` (the connected Workers Build deploys), or run
   `npm run deploy` locally.
4. Paste `widget.html` into an Elementor HTML widget (or WPCode if a security
   plugin strips inline `<script>` — see SPEC §6), and send one real test lead.

## Monday lead mapping

Leads land on board **New Leads Automatic Quote BETA** (`18419200008`), group
`topics` ("Nouveau Leads"). The board has no size/movers/distance/total columns,
so the full quote breakdown is written to the **Détails / Projet** long-text
column. Current mapping (`wrangler.toml` + `buildColumnValues()` in
`src/worker.js`):

| Lead field | Monday column | ID |
|---|---|---|
| Customer name | item title + Nom du client | `text_mm2m4rx1` |
| Phone | Téléphone | `phone_mm2m8m7s` |
| Email | Adresse Courriel | `email_mm2m1mmg` |
| Moving date | Date de service | `date_mm2mzac7` |
| Submission date | Date contact | `date_mm2mjfdg` |
| Size / movers / distance / hours / season / subtotal / total / flags | Détails / Projet | `long_text_mm2m85we` |

Status columns (Statut, Service, Provenance) are intentionally left unset —
setting a label that doesn't already exist on the board would fail the whole
`create_item`. To populate one, add its column ID and use the exact existing
label text. A var left empty or as a `<PLACEHOLDER>` is skipped, so partial
mappings never break lead creation.

## Notes

- **Pricing is server-side only** — Bruno's formula never ships to the browser.
- **Abuse guard:** a honeypot field + basic per-IP rate limit live in the
  Worker. The rate limit is per-isolate (good enough for v1); upgrade to KV /
  Durable Objects or add Cloudflare Turnstile if spam appears (SPEC §5).
- **Column value formats** (phone/email/date/status) are set in
  `buildColumnValues()` in `src/worker.js`. If a Monday column is a different
  type than assumed, adjust that one line.
- **Custom quotes** (distance > 700 km, special items, or a size with
  `autoQuote:false`) still create a Monday lead so Bruno can follow up.
