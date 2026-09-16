/**
 * SSHP route board — "Add route" backend (Google Apps Script, bound to the routes sheet)
 *
 * SETUP — do these once, in order
 * ---------------------------------------------------------------------------
 * 1. Open your routes Google Sheet → Extensions → Apps Script. Delete any code
 *    there and paste this whole file. Save (name it anything).
 *
 * 2. Script properties: in the editor, Project Settings (gear icon) → Script
 *    properties → add:
 *      STRAVA_CLIENT_ID      from https://www.strava.com/settings/api
 *      STRAVA_CLIENT_SECRET  same page
 *      ADD_KEY               a simple club password people type when adding
 *                            (leave it out entirely to allow anyone with the page URL)
 *      SHEET_NAME            optional; the tab name. Defaults to the first tab.
 *
 * 3. Strava authorisation (once). In a browser, open this URL with your client id:
 *      https://www.strava.com/oauth/authorize?client_id=YOUR_ID&redirect_uri=http://localhost&response_type=code&scope=read
 *    Click Authorize. You land on a localhost page that fails to load — that's
 *    expected. Copy the `code=...` value from the address bar.
 *    Back in the editor: paste that value into AUTH_CODE below, pick the
 *    function `exchangeAuthCode` in the toolbar and Run it. Check the log says
 *    "Stored refresh token". Then clear AUTH_CODE again (it's single-use).
 *
 * 4. Deploy: Deploy → New deployment → type "Web app":
 *      Execute as: Me
 *      Who has access: Anyone
 *    Copy the Web app URL and paste it into ADD_ENDPOINT in index.html.
 *    Every time you edit this script you must Deploy → Manage deployments →
 *    edit → New version, or the live URL keeps running the old code.
 *
 * 5. Test: run `selfTest` from the editor. It fetches one public route and
 *    logs what it would write, without writing anything.
 * ---------------------------------------------------------------------------
 */

var AUTH_CODE = ""; // paste here for step 3, run exchangeAuthCode, then clear

var TORONTO = { lat: 43.6532, lng: -79.3832 };
var LOCAL_RADIUS_KM = 12;

// ---------- HTTP entry points ----------

function doPost(e) {
  var out;
  try {
    var body = {};
    try { body = JSON.parse(e.postData.contents || "{}"); } catch (_) { body = e.parameter || {}; }
    out = addRoute(String(body.url || ""), String(body.key || ""));
  } catch (err) {
    out = { ok: false, error: "Server error: " + (err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  // Handy health check: open the web app URL in a browser.
  return ContentService.createTextOutput(JSON.stringify({ ok: true, routes: sheet_().getLastRow() - 1 }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- core ----------

function addRoute(url, key) {
  var props = PropertiesService.getScriptProperties();
  var required = props.getProperty("ADD_KEY");
  if (required && key !== required) return { ok: false, error: "Wrong club password." };

  var m = /strava\.com\/routes\/(\d+)/.exec(url);
  if (!m) return { ok: false, error: "That doesn't look like a Strava route link (expected strava.com/routes/…)." };
  var id = m[1];
  var cleanUrl = "https://www.strava.com/routes/" + id;

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet_();
    var existing = findRow_(sh, id);
    if (existing) return { ok: false, error: "Already in the library as \"" + existing.name + "\".", route: existing };

    var r = fetchStravaRoute_(id);
    if (r.error) return { ok: false, error: r.error };

    var row = [r.name, cleanUrl, r.km, r.elev, r.dir];
    sh.appendRow(row);
    return { ok: true, route: { n: r.name, u: cleanUrl, k: r.km, e: r.elev, d: r.dir } };
  } finally {
    lock.releaseLock();
  }
}

function fetchStravaRoute_(id) {
  var token = accessToken_();
  var res = UrlFetchApp.fetch("https://www.strava.com/api/v3/routes/" + id, {
    headers: { Authorization: "Bearer " + token }, muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code === 404 || code === 403) return { error: "Strava says this route is private or doesn't exist. Ask the owner to make it public, then try again." };
  if (code === 429) return { error: "Strava rate limit hit — try again in 15 minutes." };
  if (code !== 200) return { error: "Strava returned " + code + "." };
  var d = JSON.parse(res.getContentText());
  var poly = d.map && d.map.summary_polyline ? d.map.summary_polyline : "";
  return {
    name: String(d.name || "").trim(),
    km: Math.round((d.distance || 0) / 100) / 10,
    elev: Math.round(d.elevation_gain || 0),
    dir: directionFromToronto_(poly)
  };
}

// ---------- Strava OAuth ----------

function exchangeAuthCode() {
  if (!AUTH_CODE) throw new Error("Paste the code into AUTH_CODE first.");
  var p = PropertiesService.getScriptProperties();
  var res = UrlFetchApp.fetch("https://www.strava.com/oauth/token", {
    method: "post", muteHttpExceptions: true,
    payload: { client_id: p.getProperty("STRAVA_CLIENT_ID"), client_secret: p.getProperty("STRAVA_CLIENT_SECRET"),
               code: AUTH_CODE, grant_type: "authorization_code" }
  });
  var d = JSON.parse(res.getContentText());
  if (!d.refresh_token) throw new Error("Strava did not return a refresh token: " + res.getContentText());
  p.setProperty("STRAVA_REFRESH_TOKEN", d.refresh_token);
  p.setProperty("STRAVA_ACCESS_TOKEN", d.access_token);
  p.setProperty("STRAVA_EXPIRES_AT", String(d.expires_at));
  Logger.log("Stored refresh token. Now clear AUTH_CODE.");
}

function accessToken_() {
  var p = PropertiesService.getScriptProperties();
  var exp = Number(p.getProperty("STRAVA_EXPIRES_AT") || 0);
  var now = Math.floor(Date.now() / 1000);
  if (p.getProperty("STRAVA_ACCESS_TOKEN") && exp - now > 300) return p.getProperty("STRAVA_ACCESS_TOKEN");
  var refresh = p.getProperty("STRAVA_REFRESH_TOKEN");
  if (!refresh) throw new Error("Strava not authorised yet — run exchangeAuthCode (see setup step 3).");
  var res = UrlFetchApp.fetch("https://www.strava.com/oauth/token", {
    method: "post", muteHttpExceptions: true,
    payload: { client_id: p.getProperty("STRAVA_CLIENT_ID"), client_secret: p.getProperty("STRAVA_CLIENT_SECRET"),
               refresh_token: refresh, grant_type: "refresh_token" }
  });
  var d = JSON.parse(res.getContentText());
  if (!d.access_token) throw new Error("Strava token refresh failed: " + res.getContentText());
  p.setProperty("STRAVA_ACCESS_TOKEN", d.access_token);
  p.setProperty("STRAVA_REFRESH_TOKEN", d.refresh_token || refresh);
  p.setProperty("STRAVA_EXPIRES_AT", String(d.expires_at));
  return d.access_token;
}

// ---------- sheet helpers ----------

function sheet_() {
  var ss = SpreadsheetApp.getActive();
  var name = PropertiesService.getScriptProperties().getProperty("SHEET_NAME");
  var sh = name ? ss.getSheetByName(name) : ss.getSheets()[0];
  if (!sh) throw new Error("Sheet tab not found: " + name);
  return sh;
}

function findRow_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return null;
  var vals = sh.getRange(2, 1, last - 1, 5).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][1]).indexOf("/routes/" + id) >= 0) {
      return { n: vals[i][0], u: vals[i][1], k: vals[i][2], e: vals[i][3], d: vals[i][4], name: vals[i][0] };
    }
  }
  return null;
}

// ---------- geometry (same rules as fill_strava_routes.py) ----------

function decodePolyline_(s) {
  var pts = [], i = 0, lat = 0, lng = 0;
  while (i < s.length) {
    var b, shift = 0, result = 0;
    do { b = s.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = s.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    pts.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return pts;
}

function haversineKm_(a, b) {
  var R = 6371, toR = Math.PI / 180;
  var dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearingDeg_(a, b) {
  var toR = Math.PI / 180;
  var y = Math.sin((b.lng - a.lng) * toR) * Math.cos(b.lat * toR);
  var x = Math.cos(a.lat * toR) * Math.sin(b.lat * toR) - Math.sin(a.lat * toR) * Math.cos(b.lat * toR) * Math.cos((b.lng - a.lng) * toR);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function directionFromToronto_(poly) {
  if (!poly) return "";
  var pts = decodePolyline_(poly);
  var far = null, farD = -1;
  for (var i = 0; i < pts.length; i++) {
    var d = haversineKm_(TORONTO, pts[i]);
    if (d > farD) { farD = d; far = pts[i]; }
  }
  if (farD < LOCAL_RADIUS_KM) return "Local";
  var sectors = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return sectors[Math.floor((bearingDeg_(TORONTO, far) + 22.5) / 45) % 8];
}

// ---------- tests ----------

function selfTest() {
  var r = fetchStravaRoute_("20167346"); // "The other boot" — public
  Logger.log(JSON.stringify(r));         // expect ~35.8 km, 273 m, W
  Logger.log("Sheet has " + (sheet_().getLastRow() - 1) + " routes; duplicate check: " + JSON.stringify(findRow_(sheet_(), "20167346")));
}
