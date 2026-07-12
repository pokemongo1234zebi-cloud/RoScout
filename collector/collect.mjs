/* ================================================================
   🌌 RoScout Collector — tourne sur GitHub Actions toutes les ~15 min
   - appelle l'API Roblox EN DIRECT (pas de proxy : côté serveur, pas de CORS)
   - découvre les jeux (charts profonds + recherche + recommandations)
   - maintient un univers cumulatif (jusqu'à 30 000 jeux)
   - construit l'historique continu (points 15 min sur 3 j + agrégats journaliers sur 400 j)
   - détecte les liens Discord des groupes
   - envoie des alertes Discord (webhook) quand un jeu décolle
   ================================================================ */
import fs from "fs/promises";

const DATA = "data";
const UNIVERSE_CAP = 30000;   // jeux max dans l'univers
const HIST_CAP = 4000;        // jeux avec historique détaillé
const RUN_BUDGET = 6000;      // jeux rafraîchis par run
const SHARDS = 16;            // fichiers d'historique
const WEBHOOK = process.env.DISCORD_WEBHOOK || "";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = Date.now();
const ymd = t => new Date(t).toISOString().slice(0, 10);

/* Chaîne d'hôtes : Roblox bloque parfois les IP des datacenters (dont GitHub),
   donc chaque requête essaie roblox.com puis les relais publics. */
const HOSTS = ["roblox.com", "roproxy.com", "ff-roproxy.com"];
const errStats = {};
async function jget(sub, path, tries = 2) {
  for (const host of HOSTS) {
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(`https://${sub}.${host}${path}`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; RoScout/1.0)" } });
        if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
        if (!r.ok) throw new Error("HTTP " + r.status);
        return await r.json();
      } catch (e) {
        const k = sub + "@" + host + ":" + (e.message || e);
        errStats[k] = (errStats[k] || 0) + 1;
        await sleep(500 * (i + 1));
      }
    }
  }
  return null;
}
async function pMap(items, fn, limit = 8) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array(Math.min(limit, items.length)).fill().map(async () => {
    while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx]); } catch { out[idx] = null; } }
  }));
  return out;
}
async function loadJson(path, fallback) {
  try { return JSON.parse(await fs.readFile(path, "utf8")); } catch { return fallback; }
}
async function saveJson(path, obj) { await fs.writeFile(path, JSON.stringify(obj)); }

/* ---------- chargement de l'état ---------- */
await fs.mkdir(DATA, { recursive: true });
const universe = await loadJson(`${DATA}/universe.json`, {});          // uid -> meta+stats
const groups = await loadJson(`${DATA}/groups.json`, {});              // groupId -> {n, m, d(iscord), t}
const state = await loadJson(`${DATA}/state.json`, { alerts: {}, rot: 0, run: 0 });
const tracked = await loadJson(`tracked.json`, { placeIds: [] });      // tes jeux suivis à la main
const shards = [];
for (let s = 0; s < SHARDS; s++) shards.push(await loadJson(`${DATA}/hist-${s}.json`, {}));
const shardOf = uid => shards[Number(uid) % SHARDS];
state.run++;

/* ---------- 1) DÉCOUVERTE ---------- */
const sid = crypto.randomUUID();
const found = new Map(); // uid -> label
const okUid = v => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 1e12; };
const harvest = (arr, label, allowId = false) => (arr || []).forEach(g => {
  const uid = g.universeId ?? g.universeID ?? (allowId ? g.id : null);
  if (okUid(uid) && !found.has(Number(uid))) found.set(Number(uid), label);
});
async function deepSort(sortId, label, pages) {
  let token = "";
  for (let p = 0; p < pages; p++) {
    const c = await jget("apis", `/explore-api/v1/get-sort-content?sessionId=${sid}&sortId=${encodeURIComponent(sortId)}&device=computer&country=all${token ? "&pageToken=" + encodeURIComponent(token) : ""}`);
    if (!c) break;
    harvest(c.games || c.sortContents, label);
    token = c.nextPageToken || c.nextPageCursor || "";
    if (!token) break;
  }
}
try {
  let sorts = [], sTok = "";
  for (let p = 0; p < 2; p++) {
    const d = await jget("apis", `/explore-api/v1/get-sorts?sessionId=${sid}&device=computer&country=all${sTok ? "&sortsPageToken=" + encodeURIComponent(sTok) : ""}`);
    if (!d) break;
    sorts = sorts.concat(d.sorts || []);
    sTok = d.nextSortsPageToken || "";
    if (!sTok) break;
  }
  const labelOf = s => s.sortDisplayName || s.sortId;
  const gems = sorts.filter(s => /up.?and.?coming|essor|rising|new|émergent|emerging/i.test((s.sortId || "") + " " + (s.sortDisplayName || "")));
  gems.forEach(s => harvest(s.games, labelOf(s)));
  await pMap(gems.filter(s => s.sortId), s => deepSort(s.sortId, labelOf(s), 10), 4);
  const classics = sorts.filter(s => !gems.includes(s) && /trend|tendance|playing|populaire|top/i.test((s.sortId || "") + " " + (s.sortDisplayName || "")));
  classics.forEach(s => harvest(s.games, labelOf(s)));
  await pMap(classics.filter(s => s.sortId), s => deepSort(s.sortId, labelOf(s), 2), 4);
  const niches = sorts.filter(s => !gems.includes(s) && !classics.includes(s) && s.sortId);
  await pMap(niches, async s => { harvest(s.games, labelOf(s)); await deepSort(s.sortId, labelOf(s), 4); }, 4);
  /* recherche par mots-clés (rotation) */
  const SEEDS = ["simulator","tycoon","obby","horror","anime","rp","battlegrounds","survival","escape","clicker","idle","tower defense","fishing","farm","racing","story","brainrot","pet","steal","grow"];
  const picked = SEEDS.slice(state.run % 4 * 5, state.run % 4 * 5 + 5);
  await pMap(picked, async q => {
    const d = await jget("apis", `/search-api/omni-search?searchQuery=${encodeURIComponent(q)}&sessionId=${sid}&pageType=all`);
    (d?.searchResults || []).forEach(sr => harvest((sr.contents || []).filter(c => c.universeId), "🔎 " + q));
  }, 4);
  /* radar : recommandations depuis les jeux jeunes de l'univers */
  const young = Object.values(universe).filter(g => (now - new Date(g.created)) / 864e5 < 45)
    .sort((a, b) => new Date(b.created) - new Date(a.created)).slice(0, 30);
  await pMap(young, async g => {
    const j = await jget("games", `/v1/games/recommendations/game/${g.universeId}?maxRows=12`);
    harvest(j?.games || j?.data, "🧭 Radar", true);
  }, 5);
} catch (e) { console.error("découverte:", e.message); }
console.log("découverte:", found.size, "jeux vus");
/* graines de secours : si la découverte est maigre (API bloquée ?), on part de gros jeux
   connus et le spider de recommandations élargira depuis eux au fil des runs */
if (found.size < 100) {
  const SEED_PLACES = [2753915549, 920587237, 4924922222, 142823291, 606849621, 15101393044, 16732694052, 6516141723, 1962086868, 13772394625, 10449761463, 8737899170];
  await pMap(SEED_PLACES, async pid => {
    const d = await jget("apis", `/universes/v1/places/${pid}/universe`);
    if (d?.universeId && !found.has(d.universeId)) found.set(d.universeId, "Graine");
  }, 5);
  const seedUids = [...found.keys()].slice(0, 40);
  for (let hop = 0; hop < 2; hop++) {
    const before = found.size;
    await pMap(seedUids.concat([...found.keys()].slice(-40)), async uid => {
      const j = await jget("games", `/v1/games/recommendations/game/${uid}?maxRows=12`);
      harvest(j?.games || j?.data, "🧭 Radar", true);
    }, 5);
    console.log("secours saut", hop + 1, ":", found.size, "jeux (", found.size - before, "nouveaux )");
  }
}

/* ---------- 2) SÉLECTION DES JEUX À RAFRAÎCHIR ---------- */
const trackedUids = [];
await pMap(tracked.placeIds || [], async pid => {
  const known = Object.values(universe).find(g => g.placeId === pid);
  if (known) { trackedUids.push(known.universeId); return; }
  const d = await jget("apis", `/universes/v1/places/${pid}/universe`);
  if (d?.universeId) trackedUids.push(d.universeId);
}, 5);
const priority = [...new Set([
  ...trackedUids,
  ...found.keys(),
  ...Object.values(universe).filter(g => g.playing >= 30 || (now - new Date(g.created)) / 864e5 < 60).map(g => g.universeId),
])];
const pset = new Set(priority.map(Number));
const rest = Object.keys(universe).map(Number).filter(u => !pset.has(u));
let rot = [];
if (rest.length) {
  state.rot = state.rot % rest.length;
  rot = rest.slice(state.rot, state.rot + Math.max(0, RUN_BUDGET - priority.length));
  state.rot += rot.length;
}
const uids = [...priority, ...rot].slice(0, RUN_BUDGET);
console.log("à rafraîchir:", uids.length, "(priorité:", priority.length, ")");

/* ---------- 3) STATS + VOTES (lots résilients : un lot rejeté est coupé en deux
   récursivement pour isoler un éventuel identifiant invalide) ---------- */
const cleanUids = [...new Set(uids.map(Number).filter(okUid))];
async function fetchChunk(path, c, out) {
  const j = await jget("games", `${path}${c.join(",")}`);
  if (j?.data) { out.push(...j.data); return; }
  if (c.length <= 8) return; // petit lot irrécupérable : on l'abandonne
  const mid = c.length >> 1;
  await fetchChunk(path, c.slice(0, mid), out);
  await fetchChunk(path, c.slice(mid), out);
}
const chunks = []; for (let i = 0; i < cleanUids.length; i += 50) chunks.push(cleanUids.slice(i, i + 50));
const gd = [], vd = [];
await pMap(chunks, c => fetchChunk("/v1/games?universeIds=", c, gd), 8);
await pMap(chunks, c => fetchChunk("/v1/games/votes?universeIds=", c, vd), 8);
const votes = {}; vd.forEach(v => votes[v.id] = v);
console.log("stats reçues:", gd.length, "/", cleanUids.length);
if (!gd.length) { console.error("Aucune donnée reçue — abandon du run."); process.exit(0); }

/* ---------- 4) FUSION UNIVERS + HISTORIQUE ---------- */
for (const g of gd) {
  const prev = universe[g.id] || {};
  universe[g.id] = {
    universeId: g.id, placeId: g.rootPlaceId, name: g.sourceName || g.name,
    desc: (g.description || "").slice(0, 300),
    creator: g.creator ? { id: g.creator.id, name: g.creator.name, type: g.creator.type } : null,
    playing: g.playing || 0, visits: g.visits || 0, favorites: g.favoritedCount || 0,
    created: g.created, updated: g.updated, maxPlayers: g.maxPlayers || null, genre: g.genre || "",
    up: votes[g.id]?.upVotes ?? prev.up ?? 0, down: votes[g.id]?.downVotes ?? prev.down ?? 0,
    chart: found.get(g.id) || prev.chart || null, lastSeen: now,
  };
}
/* élagage univers */
{
  let ids = Object.keys(universe);
  for (const u of ids) if (now - universe[u].lastSeen > 7 * 864e5) delete universe[u];
  ids = Object.keys(universe);
  if (ids.length > UNIVERSE_CAP) {
    ids.sort((a, b) => (universe[b].playing - universe[a].playing) || (universe[b].lastSeen - universe[a].lastSeen));
    ids.slice(UNIVERSE_CAP).forEach(u => delete universe[u]);
  }
}
/* qui a droit à l'historique détaillé : priorité + plus gros CCU, cap HIST_CAP */
const histSet = new Set([...trackedUids.map(Number),
  ...Object.values(universe).filter(g => g.playing >= 5).sort((a, b) => b.playing - a.playing).slice(0, HIST_CAP).map(g => g.universeId)]);
for (const g of gd) {
  if (!histSet.has(g.id)) continue;
  const sh = shardOf(g.id);
  const H = sh[g.id] = sh[g.id] || { r: [], d: [] };
  const u = universe[g.id];
  H.r.push([now, u.playing, u.visits, u.favorites, u.up, u.down]);
  if (H.r.length > 300) H.r = H.r.slice(-300); // ~3 jours à 15 min
  /* agrégat journalier */
  const day = ymd(now);
  let last = H.d[H.d.length - 1];
  if (!last || last[0] !== day) { H.d.push([day, u.playing, u.playing, u.visits, u.favorites, 1]); }
  else { last[1] = Math.round((last[1] * last[5] + u.playing) / (last[5] + 1)); last[2] = Math.max(last[2], u.playing); last[3] = u.visits; last[4] = u.favorites; last[5]++; }
  if (H.d.length > 400) H.d = H.d.slice(-400);
}
/* nettoyage des shards (jeux sortis de l'univers ou du histSet depuis > 14 j) */
for (const sh of shards) for (const uid of Object.keys(sh)) {
  const H = sh[uid];
  const lastT = H.r.length ? H.r[H.r.length - 1][0] : 0;
  if (!universe[uid] || now - lastT > 14 * 864e5) delete sh[uid];
}

/* ---------- 5) DISCORD DES GROUPES (budget 120/run) ---------- */
const needGroups = [...new Set(gd.filter(g => g.creator?.type === "Group").map(g => g.creator.id))]
  .filter(id => !groups[id] || now - groups[id].t > 3 * 864e5).slice(0, 120);
await pMap(needGroups, async id => {
  const g = await jget("groups", `/v1/groups/${id}`);
  if (!g) return;
  let d = null;
  const m = (g.description || "").match(/(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord\.com\/invite)\/[\w-]+/i);
  if (m) d = m[0].startsWith("http") ? m[0] : "https://" + m[0];
  if (!d) {
    const s = await jget("groups", `/v1/groups/${id}/social-links`);
    const l = (s?.data || []).find(x => (x.type || "").toLowerCase() === "discord");
    if (l) d = l.url;
  }
  groups[id] = { n: g.name, m: g.memberCount, d, t: now };
}, 6);

/* ---------- 6) EXPORT top.json POUR LE SITE ---------- */
const trendOf = (uid, hours) => {
  const H = shardOf(uid)[uid]; if (!H || H.r.length < 2) return null;
  const cutoff = now - hours * 3600e3;
  const old = H.r.find(p => p[0] >= cutoff) || H.r[0];
  if (!old[1]) return null;
  return ((universe[uid].playing - old[1]) / old[1]) * 100;
};
const w72 = uid => {
  const H = shardOf(uid)[uid]; if (!H || H.r.length < 2) return {};
  const cutoff = now - 72 * 3600e3;
  const pts = H.r.filter(p => p[0] >= cutoff);
  if (pts.length < 2) return {};
  const spanH = (pts[pts.length - 1][0] - pts[0][0]) / 3600e3;
  if (spanH < 0.2) return {};
  let area = 0; for (let i = 1; i < pts.length; i++) area += (pts[i][1] + pts[i - 1][1]) / 2 * (pts[i][0] - pts[i - 1][0]);
  const avgCcu = area / (pts[pts.length - 1][0] - pts[0][0]);
  const vG = Math.max(0, pts[pts.length - 1][2] - pts[0][2]);
  const scale = 72 / spanH;
  return {
    avgCcu: Math.round(avgCcu), v72: Math.round(vG * scale),
    f72: Math.round(Math.max(0, pts[pts.length - 1][3] - pts[0][3]) * scale),
    session: vG > 0 ? Math.round((avgCcu * spanH * 60) / vG) : null,
    histH: Math.round(spanH * 10) / 10,
  };
};
const topList = Object.values(universe)
  .filter(g => g.playing > 0 || (now - new Date(g.created)) / 864e5 < 120 || trackedUids.includes(g.universeId))
  .sort((a, b) => b.playing - a.playing).slice(0, 9000)
  .map(g => {
    const H = shardOf(g.universeId)[g.universeId];
    const spark = H ? H.r.slice(-30).map(p => p[1]) : [];
    const grp = g.creator?.type === "Group" ? groups[g.creator.id] : null;
    const w = w72(g.universeId);
    return [g.universeId, g.placeId, g.name, g.creator, g.playing, g.visits, g.favorites,
      g.created, g.updated, g.up, g.down, g.genre, g.maxPlayers, g.chart,
      grp ? { m: grp.m, d: grp.d } : null,
      trendOf(g.universeId, 24), trendOf(g.universeId, 72),
      w.v72 ?? null, w.f72 ?? null, w.session ?? null, w.avgCcu ?? null, w.histH ?? 0, spark];
  });
await saveJson(`${DATA}/top.json`, { t: now, games: topList });

/* ---------- 7) ALERTES DISCORD ---------- */
if (WEBHOOK) {
  const alerts = [];
  for (const g of Object.values(universe)) {
    if (g.playing < 100) continue;
    const t6 = trendOf(g.universeId, 6);
    const key = String(g.universeId);
    if (t6 != null && t6 >= 50 && (!state.alerts[key] || now - state.alerts[key] > 12 * 3600e3)) {
      state.alerts[key] = now;
      alerts.push(`🚀 **${g.name}** décolle : **+${t6.toFixed(0)}% en 6h** → ${g.playing} joueurs · note ${g.up + g.down > 0 ? Math.round(g.up / (g.up + g.down) * 100) : "?"}% · https://www.roblox.com/games/${g.placeId}`);
    }
    const age = (now - new Date(g.created)) / 864e5;
    if (age < 30 && g.playing >= 150 && g.playing <= 2000 && g.up + g.down > 50 && g.up / (g.up + g.down) >= 0.9
        && (!state.alerts["gem" + key] || now - state.alerts["gem" + key] > 3 * 864e5)) {
      state.alerts["gem" + key] = now;
      alerts.push(`💎 **Pépite détectée : ${g.name}** — ${Math.round(age)} j, ${g.playing} joueurs, ${Math.round(g.up / (g.up + g.down) * 100)}% 👍 · https://www.roblox.com/games/${g.placeId}`);
    }
  }
  for (const batch of alerts.slice(0, 8)) {
    try { await fetch(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: batch }) }); await sleep(600); } catch {}
  }
  console.log("alertes envoyées:", Math.min(8, alerts.length));
}

/* ---------- 8) SAUVEGARDE ---------- */
await saveJson(`${DATA}/universe.json`, universe);
await saveJson(`${DATA}/groups.json`, groups);
await saveJson(`${DATA}/state.json`, state);
for (let s = 0; s < SHARDS; s++) await saveJson(`${DATA}/hist-${s}.json`, shards[s]);
const topErrs = Object.entries(errStats).sort((a,b)=>b[1]-a[1]).slice(0,6);
if (topErrs.length) console.log("⚠️ erreurs réseau rencontrées:", topErrs.map(([k,v])=>k+" ×"+v).join(" · "));
console.log("✅ run terminé — univers:", Object.keys(universe).length, "jeux · exportés pour le site:", topList.length);
