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
elementor/widget.client.txt ← the front-end widget (form + style + logic), served by the Worker at /widget.js
elementor/embed.html        ← tiny snippet pasted ONCE into Elementor (loads /widget.js)
```

The page loads the widget from the Worker, so editing `widget.client.txt` and
merging to `main` updates the live form automatically — no re-pasting.

## Develop & test

```bash
npm install        # installs wrangler (test runner is built into Node)
npm test           # runs the pricing tests — green = pricing chain intact
npm run dev        # local Worker at http://localhost:8787
```

`npm test` is wired into `npm run deploy`, so the reference totals are
re-checked before every deploy. Quotes are shown **without taxes** (taxes en
sus), so the totals are the pre-tax subtotals. Estimated work hours are trimmed
by **1 h** for every size except **Maison** (`timeAdjustmentHours` in the
config). Travel is billed **aller-retour** (×2, the return trip; `travel.roundTripMultiplier`)
and a flat **$1.8/km fuel** surcharge (`fuel.dollarsPerKm`) is added to the total.
So the 4½ / 35 km base example is work `5−1=4` + travel `1×2=2` = `6 h` → labour
`1080` + fuel `35×1.8=63` → total `1143` pre-tax (`1305` in May, `2763` on Jul 1).

## Go-live checklist

The domain, the Monday board, and the column mapping are all wired in
`wrangler.toml`. What's left:

1. **Monday token (secret, never committed)** — add `MONDAY_TOKEN` as an
   encrypted secret in the Cloudflare dashboard
   (Workers & Pages → `quotecalculatorrapido` → Settings → Variables and
   Secrets → Encrypt), or via CLI: `npx wrangler secret put MONDAY_TOKEN`.
2. **Deploy** — merge to `main` (the connected Workers Build deploys), or run
   `npm run deploy` locally.
3. **Paste `elementor/embed.html` ONCE** into an Elementor HTML widget (or
   WPCode if a security plugin strips inline `<script>` — see SPEC §6). It loads
   the widget from the Worker, so you never paste again — future changes ship by
   merging to `main`. Then send one real test lead.

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
| Origin address | Adresse de Départ (Location) | `location_mm2m9m5y` |
| Destination address | Adresse de Destination (Location) | `location_mm2m5srv` |
| Service type | Service (status) | `color_mm2msnf5` |
| Provenance | Provenance (status) | `color_mm2m5yvt` |
| Moving date | Date de service | `date_mm2mzac7` |
| Submission date | Date contact | `date_mm2mjfdg` |
| Size / movers / distance / hours / season / subtotal / total / flags | Détails / Projet | `long_text_mm2m85we` |

Notes on this mapping:

- **Movers is derived from size** (`pricing.config.json` → `sizes[*].movers`),
  not chosen by the client. 2½ = 2 movers, every other size = 3.
- **Special items** (piano / coffre-fort / objet d'art) add a flat **$250 each**
  (`pricing.config.json` → `specialFee`) to the subtotal — still an instant
  quote, not itemized in the widget. Other special situations (accès difficile,
  entreposage, adresses multiples, commercial) still route to a custom quote.
- **Quotes are pre-tax** (taxes en sus); `taxMultiplier` stays in config for
  reference but isn't applied to the shown total.
- **Only `residentiel` is auto-priced.** Commercial / Livraison / Transport /
  Sous-Traitance route to a `custom_quote` (reason `service`).
- **Addresses fill the Location (map-pin) columns.** Monday location columns
  need lat/lng, so the Worker geocodes each free-text address before writing
  (`geocode()` in `src/worker.js`). The two lookups run **sequentially**, not in
  parallel, and geocoding tries **multiple providers** in order — Google (if
  `GOOGLE_MAPS_API_KEY` is set) → Nominatim (with a retry) → Photon. That
  redundancy exists because the keyless public geocoders rate-limit by IP and a
  Worker shares its egress IP, which was making the *second* (destination) lookup
  come back empty; the fallback provider now covers a throttled request. Setting
  `GOOGLE_MAPS_API_KEY` sidesteps the shared-IP limits entirely and is
  recommended for volume. Still best-effort — if every provider fails the pin is
  skipped, but the full address always appears in **Détails / Projet**.
- **Status columns** (Service, Provenance) are sent with `create_labels_if_missing`,
  so a label that isn't pre-defined is created rather than failing the item.
  The `Statut` column is left for Bruno's pipeline to set.
- A var left empty or as a `<PLACEHOLDER>` is skipped, so partial mappings never
  break lead creation.

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
