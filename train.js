// GET /api/train — Frogtown Crossing (N. Broad St at Middletown Warwick Rd), from TomTom road speed.
import { json, cachedFetch } from '../../lib/util.js';

const POINT = '39.4620,-75.7208'; // N. Broad St approach, just south of the crossing

export async function onRequestGet(ctx) {
  const key = ctx.env.TOMTOM_API_KEY;
  if (!key) return json({ error: 'missing_key' }, 500, 5);

  const url = `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=${POINT}&unit=mph&key=${encodeURIComponent(key)}`;
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
