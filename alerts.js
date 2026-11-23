// GET /api/alerts — active National Weather Service alerts for Middletown.
import { CENTER, json, cachedFetch } from '../../lib/util.js';

export async function onRequestGet(ctx) {
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
