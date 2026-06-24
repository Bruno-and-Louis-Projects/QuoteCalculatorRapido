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

Everything is built and tested. To put it live you still need a few values that
only Bruno/LC can provide — fill them in, then deploy:

1. **`wrangler.toml` → `ALLOWED_ORIGIN`** — the live Rapido domain (locks CORS).
2. **`wrangler.toml` → Monday IDs** — `MONDAY_BOARD_ID`, `MONDAY_GROUP_ID`, and
   the `MONDAY_COL_*` column IDs (phone, email, size, movers, distance, date,
   total, type). The customer **name** becomes the Monday item title.
3. **Monday token (secret, never committed):**
   ```bash
   npx wrangler secret put MONDAY_TOKEN
   ```
4. **`elementor/widget.html` → `WORKER_URL`** — the deployed Worker URL ending
   in `/quote` (and `CONTACT_URL` for the custom-quote button).
5. **Deploy:** `npm run deploy`
6. Paste `widget.html` into an Elementor HTML widget (or WPCode if a security
   plugin strips inline `<script>` — see SPEC §6), and send one real test lead.

## Getting the Monday IDs

The board ID is in the board URL (`…/boards/18419200008`) and is already set in
`wrangler.toml`. The **group ID** and **column IDs** aren't in the URL — pull
them with this query (no token needed: open
<https://monday.com/developers/v2/try-it-yourself> while logged into Monday,
paste, and run):

```graphql
query {
  boards(ids: 18419200008) {
    name
    groups { id title }
    columns { id title type }
  }
}
```

Then map the returned `columns[].id` values into the `MONDAY_COL_*` vars in
`wrangler.toml` (match by `title`), and optionally set `MONDAY_GROUP_ID` to the
group you want leads to land in. Watch the `type` field — `phone`, `email`,
`date`, and `status` columns use structured values (handled in
`buildColumnValues()`); plain `text`/`numbers` columns just take a string.

Until a column is mapped, the Worker simply skips it — leads still get created
with the customer name as the item title, so nothing breaks while you fill these
in incrementally.

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
