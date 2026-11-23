// HeadsUp Middletown — Phase 1 API (adsb.lol, TomTom, NWS)
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


// Cloudflare Pages advanced mode: /api/* runs here, everything else is a static file.
export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const c = { request, env, waitUntil: p => ctx.waitUntil(p) };
    try {
      if (pathname === '/api/sky') return await skyHandler(c);
      if (pathname === '/api/train') return await trainHandler(c);
      if (pathname === '/api/alerts') return await alertsHandler(c);
      if (pathname === '/api/check') return json({ tomtom_key: !!env.TOMTOM_API_KEY, opensky_id: !!env.OPENSKY_CLIENT_ID, opensky_secret: !!env.OPENSKY_CLIENT_SECRET }, 200, 0);
    } catch (e) {
      return json({ error: 'server_error' }, 500, 5);
    }
    if (pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404, 60);
    return env.ASSETS.fetch(request);
  }
};
