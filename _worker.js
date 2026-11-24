// HeadsUp Middletown API — Phase 1 (flight feeds, TomTom, NWS) + Phase 2 (DelDOT, Delaware business licenses)
// Shared helpers for the API functions.
const CENTER = { lat: 39.449, lon: -75.716 }; // Middletown, DE

function json(body, status = 200, maxAge = 30) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${maxAge}`,
    },
  });
}

// Fetch with a short edge cache so many visitors don't multiply upstream calls.
// Falls back to a plain fetch where the Cache API isn't available.
async function cachedFetch(ctx, cacheKey, url, init, ttlSeconds) {
  let cache;
  try { cache = caches.default; } catch (e) { cache = null; }
  const keyReq = new Request(cacheKey);
  if (cache) {
    const hit = await cache.match(keyReq);
    if (hit) return hit;
  }
  const res = await fetch(url, init);
  if (cache && res.ok) {
    const copy = new Response(res.clone().body, res);
    copy.headers.set('cache-control', `public, max-age=${ttlSeconds}`);
    ctx.waitUntil(cache.put(keyReq, copy));
  }
  return res;
}

// GET /api/sky — aircraft within ~15 nautical miles of Middletown, from adsb.lol (ODbL).

// Common helicopter type codes (ICAO). Category A7 = rotorcraft.
const HELI = new Set([
  'EC20','EC30','EC35','EC45','EC55','EC75','H130','H135','H145','H160','H175',
  'B06','B06T','B407','B427','B429','B430','B212','B412','B505','BK17',
  'A109','A119','A139','A169','A189','AS50','AS55','AS65','AS32','AS3B',
  'R22','R44','R66','S76','S92','S70','H60','UH1','UH1Y','H47','H53','V22',
  'MD52','MD60','EXPL','EN28','EN48','HUCO','B47G'
]);

const COMPASS = ['N','NE','E','SE','S','SW','W','NW'];


// OpenSky Network (free account, non-commercial). OAuth2 client credentials; token cached in memory.
let oskyToken = null, oskyExp = 0;
async function openskyStates(env) {
  if (!env.OPENSKY_CLIENT_ID || !env.OPENSKY_CLIENT_SECRET) return null;
  if (!oskyToken || Date.now() > oskyExp) {
    const t = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.OPENSKY_CLIENT_ID, client_secret: env.OPENSKY_CLIENT_SECRET }),
    });
    if (!t.ok) throw new Error('opensky_auth_' + t.status);
    const tj = await t.json(); oskyToken = tj.access_token; oskyExp = Date.now() + ((tj.expires_in || 1800) - 60) * 1000;
  }
  const r = await fetch('https://opensky-network.org/api/states/all?lamin=39.23&lomin=-76.0&lamax=39.67&lomax=-75.43&extended=1',
    { headers: { authorization: 'Bearer ' + oskyToken } });
  if (!r.ok) throw new Error('opensky_' + r.status);
  const d = await r.json();
  const R = 3440.065, toRad = x => x * Math.PI / 180;
  const ac = (d.states || []).filter(s => s[5] != null && s[6] != null).map(s => {
    const la1 = toRad(CENTER.lat), la2 = toRad(s[6]), dl = toRad(s[5] - CENTER.lon);
    const dst = 2 * R * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dl / 2) ** 2));
    const brg = (Math.atan2(Math.sin(dl) * Math.cos(la2), Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dl)) * 180 / Math.PI + 360) % 360;
    return { hex: s[0], flight: s[1], alt_baro: s[8] ? 'ground' : (s[7] != null ? Math.round(s[7] * 3.28084) : undefined),
      gs: s[9] != null ? s[9] * 1.94384 : undefined, track: s[10] ?? undefined, lat: s[6], lon: s[5],
      category: s[17] === 8 ? 'A7' : undefined, dst, dir: brg };
  }).filter(a => a.dst <= 15);
  return { ac, now: (d.time || Date.now() / 1000) * 1000 };
}
async function skyHandler(ctx) {
  // Free community flight feeds, tried in order (non-commercial test phase).
  const sources = [
    ['airplanes.live', `https://api.airplanes.live/v2/point/${CENTER.lat}/${CENTER.lon}/15`],
    ['adsb.fi', `https://opendata.adsb.fi/api/v2/lat/${CENTER.lat}/lon/${CENTER.lon}/dist/15`],
    ['adsb.lol', `https://api.adsb.lol/v2/point/${CENTER.lat}/${CENTER.lon}/15`],
  ];
  let res = null, used = null, tried = [];
  try {
    const o = await openskyStates(ctx.env);
    if (o) res = new Response(JSON.stringify(o)), used = 'OpenSky Network';
  } catch (e) { tried.push(String(e.message || e)); }
  if (!res) for (const [name, url] of sources) {
    try {
      const r = await cachedFetch(ctx, 'https://cache.local/sky-' + name, url,
        { headers: { 'user-agent': 'HeadsUpMiddletown/0.1 (headsupmiddletown.ny4fc7cnvz.workers.dev)' } }, 15);
      if (r.ok) { res = r; used = name; break; }
      tried.push(name + ':' + r.status);
    } catch (e) { tried.push(name + ':error'); }
  }
  if (!res) return json({ error: 'source_unavailable', tried }, 502, 5);

  const d = await res.json();
  const aircraft = (d.ac || d.aircraft || [])
    .filter(a => typeof a.lat === 'number' && typeof a.lon === 'number')
    .map(a => {
      const alt = a.alt_baro === 'ground' ? 0 : (typeof a.alt_baro === 'number' ? a.alt_baro : null);
      const type = a.t || null;
      return {
        hex: a.hex,
        call: (a.flight || '').trim() || null,
        reg: a.r || null,
        type,
        desc: a.desc || null,
        owner: a.ownOp || null,
        alt,
        speed: typeof a.gs === 'number' ? Math.round(a.gs) : null,
        track: typeof a.track === 'number' ? Math.round(a.track) : null,
        lat: a.lat,
        lon: a.lon,
        miles: typeof a.dst === 'number' ? Math.round(a.dst * 1.15078 * 10) / 10 : null,
        dir: typeof a.dir === 'number' ? COMPASS[Math.round(a.dir / 45) % 8] : null,
        heli: a.category === 'A7' || (type && HELI.has(type)),
        military: typeof a.dbFlags === 'number' && (a.dbFlags & 1) === 1,
        low: alt !== null && alt > 0 && alt < 2000,
        seen: a.seen ?? null,
      };
    })
    .sort((x, y) => (y.heli - x.heli) || ((x.alt ?? 99999) - (y.alt ?? 99999)));

  return json({ updated: d.now || Date.now(), count: aircraft.length, aircraft,
    source: used }, 200, 15);
}

// GET /api/train — Frogtown Crossing (N. Broad St at Middletown Warwick Rd), from TomTom road speed.

const TRAIN_POINT = '39.4620,-75.7208'; // N. Broad St approach, just south of the crossing

async function trainHandler(ctx) {
  const key = ctx.env.TOMTOM_API_KEY;
  if (!key) return json({ error: 'missing_key' }, 500, 5);

  const url = `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=${TRAIN_POINT}&unit=mph&key=${encodeURIComponent(key)}`;
  let res;
  try {
    // 60-second edge cache keeps TomTom calls inside the free tier.
    res = await cachedFetch(ctx, 'https://cache.local/train', url, {}, 60);
  } catch (e) {
    return json({ error: 'source_unavailable' }, 502, 10);
  }
  if (!res.ok) return json({ error: 'source_unavailable', status: res.status }, 502, 10);

  const f = (await res.json()).flowSegmentData || {};
  const cur = f.currentSpeed, free = f.freeFlowSpeed;
  const tt = f.currentTravelTime, ftt = f.freeFlowTravelTime;
  const ratio = cur && free ? cur / free : 1;

  let status = 'clear';
  if (f.roadClosure) status = 'closed';
  else if (ratio < 0.4 || (tt && ftt && tt > 3 * ftt)) status = 'likely_blocked';
  else if (ratio < 0.75) status = 'slow';

  return json({
    crossing: 'Frogtown Crossing — N. Broad St at Middletown Warwick Rd',
    status,
    currentSpeed: cur ?? null,
    freeFlowSpeed: free ?? null,
    travelTime: tt ?? null,
    normalTravelTime: ftt ?? null,
    confidence: f.confidence ?? null,
    checked: Date.now(),
    source: 'TomTom Traffic',
  }, 200, 60);
}

// GET /api/alerts — active National Weather Service alerts for Middletown.

async function alertsHandler(ctx) {
  const url = `https://api.weather.gov/alerts/active?point=${CENTER.lat},${CENTER.lon}`;
  let res;
  try {
    res = await cachedFetch(ctx, 'https://cache.local/alerts', url, {
      headers: {
        // NWS asks every app to identify itself.
        'user-agent': 'HeadsUpMiddletown/0.1 (headsupmiddletown.pages.dev)',
        accept: 'application/geo+json',
      },
    }, 120);
  } catch (e) {
    return json({ error: 'source_unavailable' }, 502, 30);
  }
  if (!res.ok) return json({ error: 'source_unavailable', status: res.status }, 502, 30);

  const d = await res.json();
  const alerts = (d.features || []).map(f => {
    const p = f.properties || {};
    return {
      id: p.id,
      event: p.event,
      headline: p.headline,
      severity: p.severity,
      onset: p.onset || p.effective,
      ends: p.ends || p.expires,
      description: (p.description || '').slice(0, 600),
      instruction: (p.instruction || '').slice(0, 400),
    };
  });
  return json({ count: alerts.length, alerts, checked: Date.now(),
    source: 'National Weather Service' }, 200, 120);
}

// ===================== Phase 2 sources =====================
const UA2 = 'HeadsUpMiddletown/0.2 (headsupmiddletown.pages.dev)';
// About 8 miles around Middletown (Odessa, Townsend, St. Georges edge, Summit Bridge).
const BBOX = { s: 39.335, n: 39.565, w: -75.865, e: -75.565 };
const inBox = (lat, lon) => lat >= BBOX.s && lat <= BBOX.n && lon >= BBOX.w && lon <= BBOX.e;
// Used only for records with no coordinates. Statewide roads (SR 1) are left out on purpose.
const LOCAL_WORDS = /middletown|odessa|townsend|st\.? ?georges|summit bridge|boyds corner|bunker hill|warwick|levels r|marl pit|choptank|cedar lane|lorewood|armstrong corner|bethel church|\b(sr|rt|route)\.? ?(299|71|896|15|9)\b/i;

// Flatten a record (plain, ArcGIS {attributes,geometry} or GeoJSON {properties,geometry})
// into one object with lowercase dotted keys so field-name differences don't break parsing.
function flat(r) {
  const out = {};
  const add = (o, pre, depth) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      const key = (pre + k).toLowerCase();
      if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2) add(v, key + '.', depth + 1);
      else if (!(key in out)) out[key] = v;
    }
  };
  add(r.attributes, '', 1); add(r.properties, '', 1); add(r, '', 0);
  const g = r.geometry;
  if (g && typeof g.y === 'number') { out._lat = g.y; out._lon = g.x; }
  else if (g && Array.isArray(g.coordinates) && typeof g.coordinates[0] === 'number') { out._lat = g.coordinates[1]; out._lon = g.coordinates[0]; }
  return out;
}
const pick = (o, keys) => { for (const k of keys) { const v = o[k]; if (v != null && v !== '') return v; } return null; };
const num = v => { const n = typeof v === 'string' ? parseFloat(v) : v; return typeof n === 'number' && isFinite(n) ? n : null; };
function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;
  if (/^\d+$/.test(v)) return toMs(Number(v));
  const t = Date.parse(v); return isNaN(t) ? null : t;
}
// First array found in a JSON payload (handles {advisories:[...]}, {features:[...]}, [...]).
function firstArray(d) {
  if (Array.isArray(d)) return d;
  if (!d || typeof d !== 'object') return [];
  for (const k of ['advisories', 'restrictions', 'features', 'items', 'data', 'results']) if (Array.isArray(d[k])) return d[k];
  for (const v of Object.values(d)) if (Array.isArray(v)) return v;
  return [];
}

// ---------- GET /api/roads — DelDOT advisories and closures near Middletown ----------
const ROAD_SOURCES = [
  { name: 'DelDOT TMC advisories', official: true, url: 'https://tmc.deldot.gov/json/advisory.json' },
  { name: 'DelDOT advisories', official: true, url: 'https://deldot.gov/json/advisory.json' },
  { name: 'DelDOT TMC feed (Waze reports)', official: false,
    url: 'https://enterprise.firstmaptest.delaware.gov/arcgis/rest/services/Transportation/DE_TMC_Traffic_Feeds/FeatureServer/0/query?' +
      new URLSearchParams({ where: '1=1', geometry: `${BBOX.w},${BBOX.s},${BBOX.e},${BBOX.n}`, geometryType: 'esriGeometryEnvelope',
        inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: '*', outSR: '4326', returnGeometry: 'true',
        resultRecordCount: '300', f: 'json' }) },
];
function roadKind(text) {
  const t = text.toLowerCase();
  if (/clos/.test(t)) return 'closure';
  if (/crash|accident|collision|overturn/.test(t)) return 'crash';
  if (/construct|work|restrict|lane|paving|utility|maint/.test(t)) return 'work';
  if (/flood|water|ice|snow|weather|tree|debris|hazard|signal/.test(t)) return 'hazard';
  if (/jam|congest|delay|heavy/.test(t)) return 'traffic';
  return 'other';
}
function parseRoads(payload, src) {
  const items = [];
  for (const raw of firstArray(payload)) {
    const o = flat(raw);
    const lat = num(pick(o, ['_lat', 'where.lat', 'lat', 'latitude', 'location.lat', 'location.latitude', 'y']));
    const lon = num(pick(o, ['_lon', 'where.lon', 'where.lng', 'lon', 'lng', 'longitude', 'location.lon', 'location.lng', 'location.longitude', 'x']));
    const type = String(pick(o, ['type.name', 'type', 'eventtype', 'event_type', 'category', 'title', 'subtype']) || 'Advisory');
    const subtype = String(pick(o, ['subtype', 'type.subtype']) || '');
    const where = String(pick(o, ['where.location', 'location', 'road', 'roadway', 'street', 'address', 'name', 'city']) || '');
    const desc = String(pick(o, ['description', 'details', 'detail', 'message', 'reportdescription', 'summary', 'published.description']) || '');
    const county = String(pick(o, ['where.county', 'county']) || '');
    const time = toMs(pick(o, ['timestamp', 'published.timestamp', 'updated', 'lastupdated', 'starttime', 'start', 'pubmillis', 'created', 'creationdate']));
    const id = String(pick(o, ['id', 'advisoryid', 'uuid', 'objectid', 'fid']) ?? (where + type));
    const text = `${type} ${subtype} ${where} ${desc}`;
    // Keep it local: coordinates inside the box, or (no coordinates) a Middletown-area place name.
    if (lat != null && lon != null) { if (!inBox(lat, lon)) continue; }
    else if (!LOCAL_WORDS.test(text) || (county && !/new castle/i.test(county))) continue;
    const kind = roadKind(text);
    if (!src.official && kind === 'traffic') continue; // Waze jams are too noisy to show.
    // Waze subtypes repeat the type ("ROAD_CLOSED_CONSTRUCTION"), so show the more specific one.
    const label = (subtype && subtype.toUpperCase().startsWith(type.toUpperCase()) ? subtype : subtype ? `${type} · ${subtype}` : type)
      .replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase());
    items.push({ id, kind, type: src.official ? type : label,
      where: where.slice(0, 160), description: desc.slice(0, 400), lat, lon, time, official: src.official });
  }
  const order = { closure: 0, crash: 1, hazard: 2, work: 3, traffic: 4, other: 5 };
  items.sort((a, b) => (order[a.kind] - order[b.kind]) || ((b.time || 0) - (a.time || 0)));
  return items.slice(0, 40);
}
async function roadsHandler(ctx) {
  const tried = [];
  for (const src of ROAD_SOURCES) {
    try {
      const r = await cachedFetch(ctx, 'https://cache.local/roads-' + encodeURIComponent(src.name), src.url,
        { headers: { 'user-agent': UA2, accept: 'application/json', referer: 'https://deldot.gov/' } }, 120);
      if (!r.ok) { tried.push(`${src.name}:${r.status}`); continue; }
      const d = await r.json();
      if (d && d.error) { tried.push(`${src.name}:arcgis_error`); continue; }
      const all = firstArray(d);
      if (!all.length && !Array.isArray(d) && !Array.isArray(d.advisories) && !Array.isArray(d.features)) { tried.push(`${src.name}:no_list`); continue; }
      const items = parseRoads(d, src);
      return json({ count: items.length, statewide: all.length, items, official: src.official, checked: Date.now(),
        source: src.name, tried }, 200, 120);
    } catch (e) { tried.push(`${src.name}:error`); }
  }
  return json({ error: 'source_unavailable', tried }, 502, 30);
}

// ---------- GET /api/business — recent Delaware business licenses in 19709 ----------
const BIZ_DATASET = 'https://data.delaware.gov/resource/5zy2-grhr.json';
const BIZ_DAYS = 90;
function bizUrls() {
  const since = new Date(Date.now() - BIZ_DAYS * 864e5).toISOString().slice(0, 10) + 'T00:00:00';
  return [
    BIZ_DATASET + '?' + new URLSearchParams({ $where: `zip like '19709%' AND current_license_valid_from >= '${since}'`,
      $order: 'current_license_valid_from DESC', $limit: '300' }),
    // Fallback if the dataset's column names change: full-text search, filtered and sorted here.
    BIZ_DATASET + '?' + new URLSearchParams({ $q: '19709', $limit: '2000' }),
  ];
}
const titleCase = s => s ? s.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/\b(Llc|Inc|Dba|Usa)\b/g, w => w.toUpperCase()) : s;
function parseBiz(rows) {
  const cutoff = Date.now() - BIZ_DAYS * 864e5;
  const out = [];
  for (const raw of rows) {
    const o = flat(raw);
    const zip = String(pick(o, ['zip', 'zip_code', 'zipcode', 'postal_code']) || '');
    const city = String(pick(o, ['city', 'municipality']) || '');
    if (!zip.startsWith('19709') && !/middletown/i.test(city)) continue;
    const from = toMs(pick(o, ['current_license_valid_from', 'license_valid_from', 'valid_from', 'issue_date', 'license_issue_date', 'date_issued']));
    if (!from || from < cutoff || from > Date.now() + 864e5) continue;
    const first = toMs(pick(o, ['first_issue_date', 'original_issue_date', 'business_start_date', 'start_date']));
    const legal = String(pick(o, ['business_name', 'legal_name', 'name']) || '').trim();
    const trade = String(pick(o, ['trade_name', 'dba', 'doing_business_as']) || '').trim();
    const coords = o['geocoded_location.coordinates'];
    out.push({
      name: trade || legal || 'Unnamed business',
      legalName: trade && legal && trade.toLowerCase() !== legal.toLowerCase() ? legal : null,
      category: titleCase(String(pick(o, ['category', 'business_activity', 'license_category', 'business_type', 'activity']) || '').trim()) || null,
      address: titleCase(String(pick(o, ['address_1', 'address1', 'address', 'street_address', 'location_address']) || '').trim()) || null,
      city: city || null, zip: zip.slice(0, 5) || null,
      licensed: from,
      isNew: first ? (from - first) < 45 * 864e5 : null, // null = can't tell new from renewal
      lat: num(pick(o, ['geocoded_location.latitude', 'latitude', 'lat'])) ?? (Array.isArray(coords) ? num(coords[1]) : null),
      lon: num(pick(o, ['geocoded_location.longitude', 'longitude', 'lon'])) ?? (Array.isArray(coords) ? num(coords[0]) : null),
    });
  }
  // One row per business name (multi-category licenses show up more than once).
  const seen = new Set();
  return out.sort((a, b) => b.licensed - a.licensed)
    .filter(b => { const k = b.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .map(classifyBiz).filter(Boolean)
    .slice(0, 80);
}

// Privacy + signal: storefronts keep their address and map pin; home-based businesses keep only
// a business name and type (no owner name, address or pin); paperwork-only filings are dropped.
const BIZ_SKIP = /non-resident contractor|trade name only|bidding only|commerical lessor|commercial lessor|lessor|drayperson|transportation agent/i;
const BIZ_ALWAYS_STORE = /restaurant|alcohol|pharmacy/i;
const BIZ_COMMERCIAL_ADDR = /\b(ste|suite|unit|#)\b|#|\b(n|s)?\s*broad st|\b(e|w)?\s*main st|middletown warwick|summit bridge|peterson rd|wood st|patriot dr|ash blvd|industrial|pennington st|tower ln|green st|scott st|cass st|lake st/i;
const ENTITY = /\b(llc|l\.l\.c|inc|corp|co|company|group|studio|services|solutions|shop|market|supply|bakery|baked|cafe|kitchen|fitness|salon|hair|cleaning|landscaping|construction|builders|roofing|transport|transportation|logistics|consulting|marketing|media|designs?|creations|boutique|vending|entertainment|academy|aesthetics|printz?|crab|blooms|society|commerce|energy|ai)\b/i;
const FALLBACK = [39.45028, -75.71684]; // town-center point the state uses when it can't map an address
function classifyBiz(b) {
  const cat = b.category || '';
  if (BIZ_SKIP.test(cat)) return null;
  const fallback = b.lat != null && Math.abs(b.lat - FALLBACK[0]) < 1e-4 && Math.abs(b.lon - FALLBACK[1]) < 1e-4;
  const lat = fallback ? null : b.lat, lon = fallback ? null : b.lon;
  const store = BIZ_ALWAYS_STORE.test(cat) || BIZ_COMMERCIAL_ADDR.test(b.address || '');
  // A storefront licensed under a person's own name shows the business type instead of the name.
  const words = b.name.trim().split(/\s+/);
  const personLike = !ENTITY.test(b.name) && words.length >= 2 && words.length <= 4 && words.every(w => /^[A-Za-z'.-]+$/.test(w))
    && (!b.legalName || b.legalName.toUpperCase().includes(words[words.length - 1].toUpperCase()));
  if (store) return { kind: 'storefront', name: personLike ? null : b.name, category: cat || null, address: b.address, licensed: b.licensed, lat, lon };
  // Home-based: show the business name only if it reads like a business, never a person's name.
  const named = ENTITY.test(b.name) || !personLike;
  return { kind: 'home', name: named ? b.name : null, category: cat || null, licensed: b.licensed, lat: null, lon: null };
}
async function businessHandler(ctx) {
  const headers = { 'user-agent': UA2, accept: 'application/json' };
  if (ctx.env.SOCRATA_APP_TOKEN) headers['x-app-token'] = ctx.env.SOCRATA_APP_TOKEN;
  const tried = [];
  for (const [i, url] of bizUrls().entries()) {
    try {
      // The state updates this dataset about daily; a 6-hour cache is plenty.
      const r = await cachedFetch(ctx, 'https://cache.local/biz-' + i + '-' + new Date().toISOString().slice(0, 10), url, { headers }, 21600);
      if (!r.ok) { tried.push(`query${i + 1}:${r.status}`); continue; }
      const rows = await r.json();
      if (!Array.isArray(rows)) { tried.push(`query${i + 1}:not_list`); continue; }
      const items = parseBiz(rows);
      if (!items.length && i === 0 && rows.length) { tried.push('query1:unparsed'); continue; }
      return json({ count: items.length, days: BIZ_DAYS, items, checked: Date.now(),
        source: 'Delaware Open Data — Business Licenses', link: 'https://data.delaware.gov/d/5zy2-grhr', tried }, 200, 3600);
    } catch (e) { tried.push(`query${i + 1}:error`); }
  }
  return json({ error: 'source_unavailable', tried }, 502, 60);
}


// ---------- GET /api/urgent — official incident news near Middletown for the scrolling banner ----------
// Source: Delaware State Police press releases (official, links to the full release).
const NEAR = /\b(middletown|odessa|townsend|bear|glasgow|smyrna|port penn|st\.? georges|summit bridge|boyds corner|warwick|route 1|route 301|rt\.? 1|rt\.? 301|us 301|de 1|pulaski highway|wrangle hill|cedar lane|appoquinimink)\b/i;
const SKIP_DSP = /sex offender|notification|recruit|academy graduat|award|launch|ceremony|hiring|scholarship|toy drive|donat/i;
const strip = t => String(t || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#8217;|&rsquo;/g, "'").replace(/&#8211;|&ndash;/g, '-').replace(/&amp;/g, '&').replace(/&nbsp;|&#160;/g, ' ').replace(/&#\d+;/g, '').replace(/\s+/g, ' ').trim();
async function urgentHandler(ctx) {
  const items = [], tried = [];
  try {
    const r = await cachedFetch(ctx, 'https://cache.local/dsp', 'https://dsp.delaware.gov/feed/', { headers: { 'user-agent': UA2 } }, 300);
    if (r.ok) {
      const xml = await r.text();
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const get = tag => { const x = m[1].match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>')); return x ? x[1] : ''; };
        const title = strip(get('title')), link = strip(get('link')), when = Date.parse(strip(get('pubDate')));
        const body = strip(get('content:encoded') || get('description'));
        if (!title || !link || SKIP_DSP.test(title)) continue;
        if (!when || Date.now() - when > 48 * 3600e3) continue;
        const place = (title + ' ' + body).match(NEAR);
        if (!place) continue;
        items.push({ title, link, time: when, source: 'Delaware State Police', place: place[0] });
      }
    } else tried.push('dsp:' + r.status);
  } catch (e) { tried.push('dsp:error'); }
  items.sort((a, b) => b.time - a.time);
  return json({ count: items.length, items: items.slice(0, 8), checked: Date.now(), tried }, 200, 120);
}


// ---------- GET /tiles/flow/{z}/{x}/{y}.png — TomTom live traffic colors, proxied so the key stays secret ----------
async function flowTile(ctx, z, x, y) {
  const key = ctx.env.TOMTOM_API_KEY;
  if (!key) return new Response('missing key', { status: 500 });
  z = +z; x = +x; y = +y;
  // Only the Middletown area (keeps free-tier usage low).
  const n = 2 ** z, lon = x / n * 360 - 180, lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  if (z < 9 || z > 18 || lat < 39.0 || lat > 39.9 || lon < -76.3 || lon > -75.2) return new Response(null, { status: 204 });
  const url = `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/${z}/${x}/${y}.png?key=${encodeURIComponent(key)}&tileSize=256`;
  const r = await cachedFetch(ctx, `https://cache.local/flow/${z}/${x}/${y}`, url, {}, 120);
  if (!r.ok) return new Response(null, { status: 204 });
  return new Response(r.body, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=120' } });
}


// ---------- GET /api/projects — what's being built: state PLUS reviews + New Castle County development activity ----------
const BOX = '-75.84,39.37,-75.57,39.55'; // Middletown area
function unitsFrom(t) {
  let total = 0;
  for (const m of String(t || '').matchAll(/(\d[\d,]*)\s*(?:\+\/-|\+|±)?\s*(?:-?\s*lot)?\s*(?:[a-z()\-]+\s+){0,4}?(units|lots|homes|townhomes|townhouses|dwellings|apartments|duplexes)\b/gi)) {
    const n = +m[1].replace(/,/g, ''); if (n >= 2 && n < 5000) total += n;
  }
  if (!total) { const m = String(t || '').match(/(\d[\d,]*)[- ]lot\b/i); if (m) total = +m[1].replace(/,/g, ''); }
  return total || null;
}
function sqftFrom(t) { const m = String(t || '').match(/(\d{1,3}(?:,\d{3})+|\d{4,})\s*(?:square[- ]feet|square[- ]foot|sq\.?\s*ft|s\.\s*f\.?|sf)\b/i); return m ? +m[1].replace(/,/g, '') : null; }
function kindOf(t, devType) {
  const x = (String(devType || '') + ' ' + t).toLowerCase();
  const homes = /subdivi|residential|homes|townhouse|townhome|apartment|units|lots|dwelling|hamlet|village/.test(x);
  if (/clubhouse|school|church|fire company|vfc|public safety|library|park\b|civic|amenity/.test(x)) return 'community';
  if (/restaurant|retail|store|shopping|grocery|commercial|office|hotel|bank|gas|convenience|car ?wash|medical|daycare|fitness|self[- ]storage|storage/.test(x)) return homes ? 'mixed' : 'shops';
  if (/warehouse|industrial|distribution|manufactur|flex/.test(x)) return homes ? 'mixed' : 'industrial';
  if (homes) return 'homes';
  return 'other';
}
const cleanTitle = t => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/(^|[\s(\-/])\S/g, m => m.toUpperCase());
async function plusProjects(ctx) {
  const q = new URLSearchParams({ where: "PLUS_TYPE NOT LIKE 'Comprehensive%' AND PLUS_ID >= '2023'", geometry: BOX, geometryType: 'esriGeometryEnvelope', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', outFields: 'PLUS_ID,PLUS_TYPE,PROJECT_TITLE,PROJ_DESCRIPTION,DEVELOPMENT_TYPE,RESIDENTIAL_UNITS,COM_SQFT,PROJECT_AREA_ACRES,LOCATION,JURISDICTION,LATITUDE,LONGITUDE,REVIEW_STATUS,APP_URL,PROPOSED_USE',
    returnGeometry: 'false', orderByFields: 'PLUS_ID DESC', resultRecordCount: '60', f: 'json' });
  const url = 'https://enterprise.firstmap.delaware.gov/arcgis/rest/services/PlanningCadastre/DE_Planning_Development/FeatureServer/4/query?' + q;
  const r = await cachedFetch(ctx, 'https://cache.local/plus-' + new Date().toISOString().slice(0, 10), url, { headers: { 'user-agent': UA2 } }, 21600);
  if (!r.ok) throw new Error('plus_' + r.status);
  const d = await r.json();
  return (d.features || []).map(f => f.attributes).filter(a => !/rezoning|ordinance|text amendment/i.test(a.PLUS_TYPE || '')).map(a => {
    const desc = String(a.PROJ_DESCRIPTION || a.PROPOSED_USE || '').replace(/\s+/g, ' ').trim();
    const [y, m] = String(a.PLUS_ID || '').split('-');
    return {
      id: 'plus-' + a.PLUS_ID, title: cleanTitle(a.PROJECT_TITLE) || 'Proposed project',
      what: desc.length > 160 ? desc.slice(0, 157) + '…' : desc,
      kind: kindOf(desc + ' ' + (a.PROPOSED_USE || ''), a.DEVELOPMENT_TYPE),
      units: a.RESIDENTIAL_UNITS || unitsFrom(desc), sqft: a.COM_SQFT || sqftFrom(desc), acres: a.PROJECT_AREA_ACRES || null,
      where: cleanTitle(a.LOCATION) || (a.JURISDICTION && a.JURISDICTION !== 'Unincorporated' ? 'Town of ' + a.JURISDICTION : null),
      lat: a.LATITUDE || null, lon: a.LONGITUDE || null,
      date: y && m ? Date.UTC(+y, +m - 1, 1) : null,
      stage: 'Proposed', stageNote: 'Reviewed by the state (PLUS)', source: 'Delaware Office of State Planning', link: a.APP_URL || 'https://stateplanning.delaware.gov/plus/',
    };
  });
}
async function countyProjects(ctx) {
  const since = new Date(Date.now() - 2 * 365 * 864e5).toISOString().slice(0, 10);
  const q = new URLSearchParams({ where: `apdttm >= DATE '${since}'`, geometry: BOX, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    outFields: 'apno,projname,apdttm,aptype,worktype,status,descript,comments', returnGeometry: 'true', outSR: '4326', maxAllowableOffset: '0.0005', geometryPrecision: '5',
    orderByFields: 'apdttm DESC', resultRecordCount: '120', f: 'json' });
  const url = 'https://gis.nccde.org/agsserver/rest/services/BaseMaps/LandUse/MapServer/3/query?' + q;
  const r = await cachedFetch(ctx, 'https://cache.local/ncc-' + new Date().toISOString().slice(0, 10), url, { headers: { 'user-agent': UA2 } }, 21600);
  if (!r.ok) throw new Error('ncc_' + r.status);
  const d = await r.json();
  return (d.features || []).map(f => {
    const a = f.attributes, c = String(a.comments || '').replace(/\s+/g, ' ').trim();
    const sentences = c.split(/(?<=\.)\s+/);
    const where = sentences[0] && /side of|corner of|feet|intersection|end of/i.test(sentences[0]) ? sentences[0].replace(/\.$/, '') : null;
    const what = sentences.filter(x => x !== sentences[0] || !where).filter(x => !/zoning\.?$|^cd \d|hundred\.?$|^st\.?$/i.test(x)).join(' ').replace(/\s+St\.?$/, '').trim();
    const units = unitsFrom(c), sqft = sqftFrom(c);
    let pt = null; const ring = f.geometry?.rings?.[0];
    if (ring?.length) { let x = 0, y = 0; for (const p of ring) { x += p[0]; y += p[1]; } pt = [y / ring.length, x / ring.length]; }
    const st = { A: 'In review', R: 'Approved', C: 'Approved', E: 'Expired', I: 'On hold' }[a.status] || cleanTitle(a.descript) || 'Filed';
    return {
      id: 'ncc-' + a.apno, title: cleanTitle(a.projname) || 'County application', what: what.length > 160 ? what.slice(0, 157) + '…' : what,
      kind: kindOf(c), units, sqft, acres: null, where, lat: pt ? pt[0] : null, lon: pt ? pt[1] : null,
      date: a.apdttm || null, stage: st, stageNote: 'New Castle County land use', major: /MAJ/i.test(a.worktype || ''),
      source: 'New Castle County Land Use', link: 'https://www.nccde.org/174/Land-Use',
    };
  }).filter(p => p.stage !== 'Expired' && (p.major || (p.units || 0) >= 10 || (p.sqft || 0) >= 5000 || p.kind === 'shops'));
}
async function projectsHandler(ctx) {
  const tried = []; let items = [];
  const [a, b] = await Promise.allSettled([plusProjects(ctx), countyProjects(ctx)]);
  if (a.status === 'fulfilled') items.push(...a.value); else tried.push(String(a.reason?.message || 'plus'));
  if (b.status === 'fulfilled') items.push(...b.value); else tried.push(String(b.reason?.message || 'ncc'));
  if (!items.length && tried.length) return json({ error: 'source_unavailable', tried }, 502, 60);
  const norm = t => String(t || '').toLowerCase().replace(/'s\b/g, 's').replace(/[^a-z0-9]/g, '').replace(/subdivision|amenityspace|resubdivision/g, '');
  const seen = new Map();
  for (const p of items) { const k = norm(p.title); const q = seen.get(k);
    if (!q) seen.set(k, p); else { const keep = (p.date || 0) > (q.date || 0) ? p : q, other = keep === p ? q : p;
      for (const f of ['units', 'sqft', 'acres', 'where', 'lat', 'lon', 'what']) if (keep[f] == null || keep[f] === '') keep[f] = other[f];
      keep.links = [keep.link, other.link]; seen.set(k, keep); } }
  items = [...seen.values()];
  const rank = { shops: 0, mixed: 1, homes: 2, industrial: 3, community: 4, other: 5 };
  items.sort((x, y) => (y.date || 0) - (x.date || 0) || rank[x.kind] - rank[y.kind]);
  return json({ count: items.length, items: items.slice(0, 60), checked: Date.now(), tried }, 200, 3600);
}

// ---------- GET /api/sources — diagnostics: what each Phase 2 upstream actually returns ----------
// GET /api/iss — latest orbit data (TLE) for the International Space Station, from CelesTrak.
// The browser works out tonight's visible passes over Middletown from it.
async function issHandler(ctx) {
  const day = new Date().toISOString().slice(0, 10);
  const res = await cachedFetch(ctx, 'https://cache.headsup/iss/' + day,
    'https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE',
    { headers: { 'user-agent': 'HeadsUpMiddletown/1.0' } }, 43200);
  if (!res.ok) return json({ error: 'iss_unavailable', status: res.status }, 502, 300);
  const lines = (await res.text()).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const i = lines.findIndex(l => l.startsWith('1 '));
  if (i < 0 || !lines[i + 1]?.startsWith('2 ')) return json({ error: 'iss_bad_data' }, 502, 300);
  return json({ name: 'ISS', line1: lines[i], line2: lines[i + 1] }, 200, 3600);
}

// ---------- GET /api/feed — local news + local high school sports headlines (headline + link only) ----------
const FEEDS = [
  { id: 'dsp', name: 'Delaware State Police', url: 'https://dsp.delaware.gov/feed/' },
  { id: 'live', name: 'Delaware LIVE', url: 'https://delawarelive.com/feed/' },
  { id: 'spot', name: 'Spotlight Delaware', url: 'https://spotlightdelaware.org/feed/' },
  { id: 'state', name: 'Delaware.gov News', url: 'https://news.delaware.gov/feed/' },
  { id: 'dfn', name: 'Delaware Free News', url: 'https://delawarefreenews.org/feed/' },
  { id: 'live-sports', name: 'Delaware LIVE', url: 'https://delawarelive.com/category/sports/feed/' },
  { id: 'live-mtown', name: 'Delaware LIVE', url: 'https://delawarelive.com/tag/middletown/feed/', local: true },
  { id: 'live-appo', name: 'Delaware LIVE', url: 'https://delawarelive.com/tag/appoquinimink/feed/', local: true },
  { id: 'live-odessa', name: 'Delaware LIVE', url: 'https://delawarelive.com/tag/odessa/feed/', local: true },
  { id: 'spot-mtown', name: 'Spotlight Delaware', url: 'https://spotlightdelaware.org/tag/middletown/feed/', local: true },
  { id: 'state-mtown', name: 'Delaware.gov News', url: 'https://news.delaware.gov/tag/middletown/feed/', local: true },
];
// Only stories about Middletown and the towns right around it.
const LOCAL = /\b(middletown|odessa|townsend|appoquinimink|st\.? georges|port penn|warwick|boyds corner|summit bridge|silver lake|cantwell|bunker hill|19709|19734|mot charter|redding|everett meredith)\b/i;
const SCHOOLS = /\b(appoquinimink|middletown|odessa|st\.? georges|mot charter)\b/i;
const SPORT = /\b(football|soccer|basketball|baseball|softball|lacrosse|field hockey|volleyball|wrestling|track|cross country|swimming|tennis|golf|playoff|championship|state title|semifinal|quarterfinal|jaguars|cavaliers|ducks|hawks|diaa)\b/i;
const SKIP_FEED = /sex offender|obituar|recruit|hiring|sponsored|advertis/i;
function feedText(x) {
  return String(x || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
async function feedHandler(ctx) {
  const items = [], status = {};
  await Promise.all(FEEDS.map(async f => {
    try {
      const r = await cachedFetch(ctx, 'https://cache.local/feed/' + f.id, f.url, { headers: { 'user-agent': UA2, accept: 'application/rss+xml, application/xml, text/xml' } }, 600);
      if (!r.ok) { status[f.id] = r.status; return; }
      const xml = await r.text(); let n = 0;
      for (const m of xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/g)) {
        const get = tag => { const x = m[1].match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>')); return x ? feedText(x[1]) : ''; };
        const title = get('title'), link = get('link'), time = Date.parse(get('pubDate'));
        if (!title || !/^https:\/\//.test(link) || !time || Date.now() - time > 30 * 864e5 || SKIP_FEED.test(title)) continue;
        const cats = [...m[1].matchAll(/<category[^>]*>([\s\S]*?)<\/category>/g)].map(c => feedText(c[1])).join(' ');
        const body = get('description').slice(0, 600);
        const hay = title + ' ' + cats + ' ' + body;
        const isSport = SPORT.test(title + ' ' + cats);
        if (isSport && !SCHOOLS.test(title)) continue; // sports only when a local school is in the headline
        if (!f.local && !isSport && !LOCAL.test(hay)) continue;
        const sports = isSport;
        items.push({ id: link, title, link, time, source: f.name, kind: sports ? 'sports' : (f.id === 'dsp' || /police|arrest|troopers?|shooting|stabbing/i.test(title) ? 'police' : 'news') });
        n++;
      }
      status[f.id] = n;
    } catch (e) { status[f.id] = 'error'; }
  }));
  const seen = new Set();
  const out = items.sort((a, b) => b.time - a.time).filter(x => { const k = x.title.toLowerCase().slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; });
  return json({ count: out.length, items: out.slice(0, 30), checked: Date.now(), status }, 200, 300);
}

async function sourcesHandler() {
  const probe = async (name, url, headers = {}) => {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA2, accept: 'application/json', ...headers } });
      let keys = null, n = null;
      if (r.ok) { const d = await r.json(); const a = firstArray(d); n = a.length; keys = a[0] ? Object.keys(flat(a[0])).slice(0, 40) : Object.keys(d || {}).slice(0, 20); }
      return { name, status: r.status, records: n, keys };
    } catch (e) { return { name, error: String(e.message || e) }; }
  };
  const results = await Promise.all([
    ...ROAD_SOURCES.map(s => probe(s.name, s.url, { referer: 'https://deldot.gov/' })),
    probe('Business licenses (query 1)', bizUrls()[0]),
    probe('Business licenses (sample row)', BIZ_DATASET + '?$limit=1'),
  ]);
  return json({ checked: Date.now(), results }, 200, 0);
}

// Cloudflare Pages advanced mode: /api/* runs here, everything else is a static file.
export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const c = { request, env, waitUntil: p => ctx.waitUntil(p) };
    try {
      if (pathname === '/api/sky') return await skyHandler(c);
      if (pathname === '/api/train') return await trainHandler(c);
      if (pathname === '/api/alerts') return await alertsHandler(c);
      if (pathname === '/api/roads') return await roadsHandler(c);
      if (pathname === '/api/business') return await businessHandler(c);
      if (pathname === '/api/urgent') return await urgentHandler(c);
      if (pathname === '/api/projects') return await projectsHandler(c);
      if (pathname === '/api/iss') return await issHandler(c);
      if (pathname === '/api/feed') return await feedHandler(c);
      if (pathname === '/api/sources') return await sourcesHandler();
      if (pathname === '/api/check') return json({ tomtom_key: !!env.TOMTOM_API_KEY, opensky_id: !!env.OPENSKY_CLIENT_ID, opensky_secret: !!env.OPENSKY_CLIENT_SECRET, socrata_token: !!env.SOCRATA_APP_TOKEN }, 200, 0);
    } catch (e) {
      return json({ error: 'server_error' }, 500, 5);
    }
    const tm = pathname.match(/^\/tiles\/flow\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (tm) { try { return await flowTile(c, tm[1], tm[2], tm[3]); } catch (e) { return new Response(null, { status: 204 }); } }
    if (pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404, 60);
    return env.ASSETS.fetch(request);
  }
};
