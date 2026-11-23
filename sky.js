// GET /api/sky — aircraft within ~15 nautical miles of Middletown, from adsb.lol (ODbL).
import { CENTER, json, cachedFetch } from '../../lib/util.js';

// Common helicopter type codes (ICAO). Category A7 = rotorcraft.
const HELI = new Set([
  'EC20','EC30','EC35','EC45','EC55','EC75','H130','H135','H145','H160','H175',
  'B06','B06T','B407','B427','B429','B430','B212','B412','B505','BK17',
  'A109','A119','A139','A169','A189','AS50','AS55','AS65','AS32','AS3B',
  'R22','R44','R66','S76','S92','S70','H60','UH1','UH1Y','H47','H53','V22',
  'MD52','MD60','EXPL','EN28','EN48','HUCO','B47G'
]);

const COMPASS = ['N','NE','E','SE','S','SW','W','NW'];

export async function onRequestGet(ctx) {
  const url = `https://api.adsb.lol/v2/point/${CENTER.lat}/${CENTER.lon}/15`;
  let res;
  try {
    res = await cachedFetch(ctx, 'https://cache.local/sky', url,
      { headers: { 'user-agent': 'HeadsUpMiddletown/0.1 (headsupmiddletown.pages.dev)' } }, 15);
  } catch (e) {
    return json({ error: 'source_unavailable' }, 502, 5);
  }
  if (!res.ok) return json({ error: 'source_unavailable', status: res.status }, 502, 5);

  const d = await res.json();
  const aircraft = (d.ac || [])
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
    source: 'adsb.lol (ODbL)' }, 200, 15);
}
