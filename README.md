# Rapido — Calculateur de soumission

Instant moving-quote tool for Groupe Rapido. A Cloudflare Worker holds the
pricing logic; a thin Elementor/WordPress widget collects inputs, POSTs them,
and renders the returned price. Successful submissions create a lead in
Rapido's SmartMoving CRM.

See [`SPEC.md`](./SPEC.md) for the full architecture and pricing reference.

## Repo layout

```
pricing.config.json   ← rates, hours, season table, exclusions (Bruno edits this)
pricing.js            ← deterministic computeQuote() (don't hand-edit numbers)
src/worker.js         ← HTTP handler: CORS, parse, price, abuse guard
src/smartmoving.js    ← maps a quote onto a SmartMoving lead and POSTs it
wrangler.toml         ← Worker config + vars (fill the <PLACEHOLDER>s)
test/pricing.test.js  ← asserts the three SPEC §8 totals + guardrails
test/smartmoving.test.js ← pins the CRM payload (fields, date format, notes)
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

## Hosting

The Worker runs on **Groupe Rapido's business Cloudflare account** and is served
from `https://quotecalculatorrapido.brunomjacques.workers.dev`. That hostname is
tied to the account: if the Worker ever moves accounts again, the `workers.dev`
subdomain changes and the `<script src>` in `elementor/embed.html` must be
re-pasted into Elementor, since the live page hardcodes it. Putting the Worker on
a custom domain (e.g. `quote.servicerapido.com`) would make the URL
account-independent and avoid that step — see SPEC §7.

Secrets (`SMARTMOVING_PROVIDER_KEY`, optional `GOOGLE_MAPS_API_KEY`) live in that
account only. They are write-only and cannot be exported, so they must be
re-entered by hand on any new account — and a missing or wrong
`SMARTMOVING_PROVIDER_KEY` fails **silently**: quotes still price correctly,
leads just stop reaching SmartMoving. Verify with a real test lead, never by
assuming a green deploy.

## Go-live checklist

The domain and the CRM mapping are wired in `wrangler.toml` + `src/smartmoving.js`.
What's left:

1. **SmartMoving provider key (secret, never committed)** — add
   `SMARTMOVING_PROVIDER_KEY` as an encrypted secret in the Cloudflare dashboard
   (Workers & Pages → `quotecalculatorrapido` → Settings → Variables and
   Secrets → Encrypt), or via CLI:
   `npx wrangler secret put SMARTMOVING_PROVIDER_KEY`. Look the key up in
   SmartMoving under Settings → Sales → Lead Providers → Your Website → View
   Instructions. It is the only credential the endpoint uses, which is why it
   is a secret and not a committed var.
2. **Deploy** — merge to `main` (the connected Workers Build deploys), or run
   `npm run deploy` locally.
3. **Paste `elementor/embed.html` ONCE** into an Elementor HTML widget (or
   WPCode if a security plugin strips inline `<script>` — see SPEC §6). It loads
   the widget from the Worker, so you never paste again — future changes ship by
   merging to `main`. Then send one real test lead.

## SmartMoving lead mapping

Leads are POSTed to SmartMoving's lead-provider endpoint:

```
POST https://api.smartmoving.com/api/leads/from-provider/v2?providerKey=<secret>
Content-Type: application/json
```

Every property sits at the **root** of the JSON body. Mapping lives in
`buildLeadPayload()` in `src/smartmoving.js`:

| Form field | SmartMoving field |
|---|---|
| Nom complet | `firstName` + `lastName` (one-word name → `fullName`) |
| Téléphone | `phoneNumber` |
| Courriel | `email` |
| Date du déménagement | `moveDate` (reformatted to `YYYYMMDD`) |
| Type de logement | `bedrooms` (3½ = 1, 4½ = 2, 5½ = 3, 6½ = 4; 2½ = 1; Maison omitted) |
| Adresse de départ | `originStreet` / `originCity` / `originState` / `originZip` |
| Adresse de destination | `destinationStreet` / `destinationCity` / `destinationState` / `destinationZip` |
| Service, distance, movers, hours, season, subtotal, **total**, special items, provenance, client message | `notes` |

Notes on this mapping:

- **Name is the only field SmartMoving requires.** It takes `firstName` +
  `lastName` **or** `fullName`, never both — so a one-word name is sent as
  `fullName`, and a blank name falls back to the email or phone rather than
  going out empty. Everything else is omitted when we have no value, never sent
  blank.
- **Addresses are split before sending.** SmartMoving wants street / city /
  state / zip, but the form collects one free-text line, so the Worker resolves
  each address twice and merges: a geocoder — Google (if `GOOGLE_MAPS_API_KEY`
  is set) → Nominatim (with a retry) → Photon — field-by-field wins, and a local
  comma-parser (`parseAddressText()`, no network) fills whatever it left empty.
  The two lookups run **sequentially**, not in parallel, because the keyless
  public geocoders rate-limit by IP and a Worker shares its egress IP — which is
  what used to make the *second* (destination) lookup come back empty. If every
  provider fails, the raw line is still sent as the street, and the full line is
  always in the notes, so an address can't be lost. Setting
  `GOOGLE_MAPS_API_KEY` sidesteps the shared-IP limits and is recommended for
  volume.
- **Anything with no SmartMoving field goes into `notes`** — the full quote
  breakdown, the provenance ("Comment nous avez-vous connus?"), the special
  items and the client's own message. SmartMoving appends *unrecognised* JSON
  fields to the lead's note too, but we deliberately send only documented fields
  and compose the note ourselves so it reads as a summary instead of a dump of
  key/value pairs.
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
- **Branch routing is optional.** Set `SMARTMOVING_BRANCH_ID` in `wrangler.toml`
  to pin every lead to one branch; left unset, SmartMoving assigns it.
- **No opt-in flag is sent.** SmartMoving accepts a `userOptIn` field for
  SMS/marketing consent, but the form has no consent checkbox, so the Worker
  doesn't assert one. Add a checkbox first if that consent is needed.

## Notes

- **Pricing is server-side only** — Bruno's formula never ships to the browser.
- **Abuse guard:** a honeypot field + basic per-IP rate limit live in the
  Worker. The rate limit is per-isolate (good enough for v1); upgrade to KV /
  Durable Objects or add Cloudflare Turnstile if spam appears (SPEC §5).
- **Field formats** (name split, `moveDate`, address parts) are set in
  `buildLeadPayload()` in `src/smartmoving.js` and pinned by
  `test/smartmoving.test.js`. Adjust there if SmartMoving expects something else.
- **Custom quotes** (distance > 700 km, special items, or a size with
  `autoQuote:false`) still create a SmartMoving lead so Bruno can follow up —
  the note says why it needs a manual quote.
- **A failed lead POST never blocks the customer's quote.** It runs in
  `ctx.waitUntil` and logs to `wrangler tail` on failure; the price still
  returns. That's why go-live needs one real test lead, not just a green deploy.
