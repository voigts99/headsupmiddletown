# HeadsUp Middletown — Phase 1 (live test)

What was that, and what's coming in Middletown, DE.

Live sources in Phase 1:
- **/api/sky**: aircraft within ~15 nm from adsb.lol (ODbL). Helicopters and planes under 2,000 ft are flagged.
- **/api/train**: Frogtown Crossing status from TomTom road speed on N. Broad St.
- **/api/alerts**: active National Weather Service alerts for Middletown.

## Files
```
public/index.html        the site (map + sections)
functions/api/sky.js     helicopters & low planes
functions/api/train.js   Frogtown Crossing
functions/api/alerts.js  weather alerts
lib/util.js              shared helpers (JSON, edge cache)
package.json
```

## Cloudflare Pages settings
- Framework preset: None
- Build command: (leave empty)
- Build output directory: `public`
- Environment variable (Secret): `TOMTOM_API_KEY` = your rotated TomTom key

## Notes
- Responses are edge-cached (sky 15 s, train 60 s, alerts 2 min) to stay inside free tiers.
- Some police/government aircraft don't broadcast, so not every helicopter will appear.
- Train status rule: "likely blocked" when speed < 40% of normal or travel time > 3× normal; "slow" under 75% of normal.
