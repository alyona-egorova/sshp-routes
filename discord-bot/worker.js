/**
 * SSHP route bot — Cloudflare Worker (Discord HTTP interactions, no slash commands for members)
 *
 * What members see: one pinned "kiosk" message in a channel with two buttons.
 *   [ 🔍 Find a route ]  → private reply with two dropdowns (direction, distance) and Show
 *   [ ➕ Add a route ]   → popup with one box: paste the Strava link
 * Results are ephemeral (only the tapper sees them). Adding calls the same Apps
 * Script endpoint the web page uses, so both stay in sync.
 *
 * SETUP
 * -----
 * 1. Discord app: https://discord.com/developers/applications → New Application.
 *    General Information: copy APPLICATION ID and PUBLIC KEY.
 *    Bot tab: Reset Token → copy BOT TOKEN. Turn OFF "Public Bot".
 *    Installation tab: Install Link = Discord Provided; Guild Install scopes: bot,
 *    applications.commands; bot permissions: Send Messages, Embed Links.
 *    Open the install link and add the bot to your server.
 *
 * 2. Deploy this worker (needs Node + `npm i -g wrangler`; wrangler login once):
 *      wrangler deploy
 *      wrangler secret put DISCORD_PUBLIC_KEY
 *      wrangler secret put DISCORD_BOT_TOKEN
 *      wrangler secret put DISCORD_APP_ID
 *      wrangler secret put ADD_ENDPOINT     (the Apps Script web app URL)
 *      wrangler secret put ADD_KEY          (the club password from Apps Script; blank if none)
 *      wrangler secret put SHEET_CSV_URL    (the published CSV URL)
 *      wrangler secret put ADMIN_SECRET     (any long random string; used once in step 4)
 *    Wrangler prints the worker URL, e.g. https://sshp-routes.<you>.workers.dev
 *
 * 3. Back in the Discord app → General Information → INTERACTIONS ENDPOINT URL:
 *    paste the worker URL and Save. Discord pings it; if the save fails, the
 *    public key secret is wrong.
 *
 * 4. Post the kiosk message. Get the channel ID (Discord → User Settings →
 *    Advanced → Developer Mode on, then right-click the channel → Copy ID), then:
 *      curl -X POST "https://<worker-url>/kiosk?channel=<CHANNEL_ID>&secret=<ADMIN_SECRET>"
 *    Pin the message it posts. Done — no commands for anyone to learn.
 */

const DIRS = [
  { v: "West", l: "West" }, { v: "North-West", l: "North-West" }, { v: "North", l: "North" },
  { v: "North-East", l: "North-East" }, { v: "East", l: "East" }, { v: "South", l: "South" },
  { v: "Local", l: "City of Toronto" },
];
const DISTS = [
  { v: "<50", l: "Under 50 km", f: r => r.k < 50 },
  { v: "50-100", l: "50–100 km", f: r => r.k >= 50 && r.k <= 100 },
  { v: ">100", l: "Over 100 km", f: r => r.k > 100 },
];
const GROUP = { W: "West", SW: "West", NW: "North-West", N: "North", NE: "North-East", E: "East", SE: "East", S: "South", Local: "Local" };
const PAGE = 8;
const COLOR = 0x365314;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/kiosk") return postKiosk(url, env);
    if (req.method !== "POST") return new Response("SSHP route bot is up.", { status: 200 });

    const body = await req.text();
    if (!(await verify(req, body, env.DISCORD_PUBLIC_KEY))) return new Response("bad signature", { status: 401 });
    const i = JSON.parse(body);

    if (i.type === 1) return json({ type: 1 }); // PING

    if (i.type === 3) { // component
      const id = i.data.custom_id;
      if (id === "find") return json(reply(finderView("", "")));
      if (id === "addbtn") return json(addModal());
      if (id.startsWith("dir:") || id.startsWith("dist:")) {
        let [, dir, dist] = id.split(":");
        if (id.startsWith("dir:")) dir = i.data.values[0]; else dist = i.data.values[0];
        return json(update(finderView(dir, dist)));
      }
      if (id.startsWith("show:") || id.startsWith("pg:")) {
        const [, dir, dist, pg] = id.split(":");
        const routes = await loadRoutes(env);
        return json(update(resultsView(routes, dir, dist, Number(pg || 0), env)));
      }
    }

    if (i.type === 5 && i.data.custom_id === "addmodal") { // modal submit
      const link = i.data.components[0].components[0].value.trim();
      ctx.waitUntil(addAndFollowUp(i, link, env));
      return json({ type: 5, data: { flags: 64 } }); // deferred, ephemeral
    }

    return json(reply({ content: "Sorry, I didn't understand that.", flags: 64 }));
  },
};

// ---------- views ----------

function kioskMessage(env) {
  return {
    embeds: [{
      color: COLOR,
      title: "🚴 SSHP route library",
      description: "Tap **Find a route** to browse by direction and distance.\nTap **Add a route** to paste a Strava link — details are filled in automatically.\n\nReplies are only visible to you.",
    }],
    components: [{ type: 1, components: [
      { type: 2, style: 1, label: "Find a route", emoji: { name: "🔍" }, custom_id: "find" },
      { type: 2, style: 3, label: "Add a route", emoji: { name: "➕" }, custom_id: "addbtn" },
    ] }],
  };
}

function finderView(dir, dist) {
  return {
    content: "**Where are we riding, and how far?** (leave one blank for all)",
    flags: 64,
    components: [
      { type: 1, components: [{ type: 3, custom_id: `dir:${dir}:${dist}`, placeholder: "Direction from Toronto",
        options: DIRS.map(d => ({ label: d.l, value: d.v, default: d.v === dir })) }] },
      { type: 1, components: [{ type: 3, custom_id: `dist:${dir}:${dist}`, placeholder: "Distance",
        options: DISTS.map(d => ({ label: d.l, value: d.v, default: d.v === dist })) }] },
      { type: 1, components: [{ type: 2, style: 1, label: "Show routes", custom_id: `show:${dir}:${dist}:0` }] },
    ],
  };
}

function resultsView(routes, dir, dist, pg, env) {
  const df = DISTS.find(d => d.v === dist);
  let rows = routes.filter(r => (!dir || r.d === dir) && (!df || df.f(r))).sort((a, b) => a.k - b.k);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  pg = Math.min(Math.max(pg, 0), pages - 1);
  const slice = rows.slice(pg * PAGE, pg * PAGE + PAGE);
  const title = [dir ? (dir === "Local" ? "City of Toronto" : dir) : "All directions", df ? df.l : "any distance"].join(" · ");
  const lines = slice.map(r => `**${r.k} km** · [${r.n}](${r.u}) · ↑${r.e} m${dir ? "" : " · " + (r.d === "Local" ? "Toronto" : r.d)}`);
  const embed = {
    color: COLOR, title,
    description: lines.length ? lines.join("\n") : "No routes match. Try a different combination.",
    footer: { text: `${rows.length} route${rows.length === 1 ? "" : "s"} · page ${pg + 1} of ${pages}` + (env.BOARD_URL ? " · full list: " + env.BOARD_URL : "") },
  };
  const nav = { type: 1, components: [
    { type: 2, style: 2, label: "◀ Prev", custom_id: `pg:${dir}:${dist}:${pg - 1}`, disabled: pg === 0 },
    { type: 2, style: 2, label: "Next ▶", custom_id: `pg:${dir}:${dist}:${pg + 1}`, disabled: pg >= pages - 1 },
    { type: 2, style: 2, label: "Change filters", custom_id: "find" },
  ] };
  return { content: "", embeds: [embed], components: [nav], flags: 64 };
}

function addModal() {
  return { type: 9, data: {
    custom_id: "addmodal", title: "Add a route to the library",
    components: [{ type: 1, components: [{ type: 4, custom_id: "link", style: 1, label: "Strava route link",
      placeholder: "https://www.strava.com/routes/…", required: true, min_length: 20, max_length: 200 }] }],
  } };
}

// ---------- actions ----------

async function addAndFollowUp(i, link, env) {
  let msg;
  try {
    const res = await fetch(env.ADD_ENDPOINT, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ url: link, key: env.ADD_KEY || "" }), redirect: "follow" });
    const out = await res.json();
    if (out.ok) {
      const r = out.route, d = GROUP[r.d] || r.d;
      msg = { embeds: [{ color: COLOR, title: "✅ Added to the library",
        description: `**[${r.n}](${r.u})**\n${r.k} km · ↑${r.e} m · ${d === "Local" ? "City of Toronto" : d}` }] };
    } else {
      msg = { content: "❌ " + (out.error || "Couldn't add that route.") };
    }
  } catch (e) {
    msg = { content: "❌ Couldn't reach the route service. Try again in a minute." };
  }
  await fetch(`https://discord.com/api/v10/webhooks/${env.DISCORD_APP_ID}/${i.token}/messages/@original`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msg) });
}

async function postKiosk(url, env) {
  if (url.searchParams.get("secret") !== env.ADMIN_SECRET) return new Response("forbidden", { status: 403 });
  const channel = url.searchParams.get("channel");
  const res = await fetch(`https://discord.com/api/v10/channels/${channel}/messages`, {
    method: "POST", headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(kioskMessage(env)) });
  return new Response(await res.text(), { status: res.status });
}

// ---------- data ----------

let cache = { at: 0, rows: [] };
async function loadRoutes(env) {
  if (Date.now() - cache.at < 5 * 60 * 1000 && cache.rows.length) return cache.rows;
  const text = await (await fetch(env.SHEET_CSV_URL, { redirect: "follow" })).text();
  const rows = parseCSV(text);
  const hdr = rows[0].map(h => h.trim().toLowerCase());
  const col = (...k) => hdr.findIndex(h => k.some(x => h.includes(x)));
  const iN = col("name"), iL = col("link", "strava"), iD = col("dist"), iE = col("elev"), iR = col("direc");
  const out = rows.slice(1).map(r => ({ n: (r[iN] || "").trim(), u: (r[iL] || "").trim(), k: parseFloat(r[iD]), e: Math.round(parseFloat(r[iE])), d: GROUP[(r[iR] || "").trim()] || (r[iR] || "").trim() }))
    .filter(r => /strava\.com\/routes\/\d+/.test(r.u) && !isNaN(r.k) && !isNaN(r.e));
  cache = { at: Date.now(), rows: out };
  return out;
}

function parseCSV(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---------- discord plumbing ----------

const json = o => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } });
const reply = data => ({ type: 4, data });
const update = data => ({ type: 7, data });

async function verify(req, body, pubHex) {
  const sig = req.headers.get("x-signature-ed25519"), ts = req.headers.get("x-signature-timestamp");
  if (!sig || !ts) return false;
  const key = await crypto.subtle.importKey("raw", hex(pubHex), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, hex(sig), new TextEncoder().encode(ts + body));
}
const hex = s => new Uint8Array(s.match(/.{1,2}/g).map(b => parseInt(b, 16)));
