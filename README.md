# SSHP route board

Two pieces; the second is optional:

| Piece | Files | What it does |
|---|---|---|
| Web page | `index.html`, `logo.png`, `routes.js` | Mobile-first route list. Reads the published Google Sheet; `routes.js` is an offline fallback. |
| Add-route backend | `Code.gs` | Google Apps Script bound to the sheet. Takes a Strava link, fetches name/distance/elevation/direction from Strava, appends a row. Setup steps are at the top of the file. |

## Order of setup
1. Web page → GitHub Pages. Already works with the published sheet.
2. `Code.gs` → paste the web app URL into `ADD_ENDPOINT` in `index.html`. The **+** button appears.

## Maintenance
- Edit routes in the Google Sheet; the page picks it up within ~5 min.
- Refresh the offline fallback occasionally: `python make_routes_js.py <exported-sheet>.xlsx` → commit `routes.js`.
- After editing `Code.gs`: Deploy → Manage deployments → New version (or the live URL runs old code).
