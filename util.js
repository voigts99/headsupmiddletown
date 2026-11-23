// Shared helpers for the API functions.
export const CENTER = { lat: 39.449, lon: -75.716 }; // Middletown, DE

export function json(body, status = 200, maxAge = 30) {
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
export async function cachedFetch(ctx, cacheKey, url, init, ttlSeconds) {
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
