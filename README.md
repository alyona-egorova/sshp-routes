# SSHP route board

Three pieces, each optional after the first:

| Piece | Files | What it does |
|---|---|---|
| Web page | `index.html`, `logo.png`, `routes.js` | Mobile-first route list. Reads the published Google Sheet; `routes.js` is an offline fallback. |
| Add-route backend | `Code.gs` | Google Apps Script bound to the sheet. Takes a Strava link, fetches name/distance/elevation/direction from Strava, appends a row. Setup steps are at the top of the file. |
| Discord bot | `discord-bot/worker.js`, `discord-bot/wrangler.toml` | Cloudflare Worker (free tier). Posts a pinned message with **Find a route** / **Add a route** buttons. No slash commands for members. Setup steps at the top of `worker.js`. |

## Order of setup
1. Web page → GitHub Pages. Already works with the published sheet.
2. `Code.gs` → paste the web app URL into `ADD_ENDPOINT` in `index.html`. The **+** button appears.
3. Discord bot → uses the same `ADD_ENDPOINT` and the same sheet CSV URL.

## Maintenance
- Edit routes in the Google Sheet; page and bot pick it up within ~5 min.
- Refresh the offline fallback occasionally: `python make_routes_js.py <exported-sheet>.xlsx` → commit `routes.js`.
- After editing `Code.gs`: Deploy → Manage deployments → New version (or the live URL runs old code).
- After editing `worker.js`: `wrangler deploy`.
