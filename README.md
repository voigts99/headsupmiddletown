# HeadsUp Middletown — live test (Phase 1 + Phase 2)

What was that, and what's coming in Middletown, DE.

All API routes live in `_worker.js` (Cloudflare Worker with static assets; see `wrangler.jsonc`).
`index.html` is the site. `sky.js`, `train.js`, `alerts.js` and `util.js` are the original
Phase 1 function files, kept for reference only; they aren't deployed (see `.assetsignore`).

## Live sources

Phase 1
- **/api/sky**: aircraft within ~15 nm. OpenSky (if keys are set), then airplanes.live, adsb.fi, adsb.lol. Helicopters and planes under 2,000 ft are flagged.
- **/api/train**: Frogtown Crossing status from TomTom road speed on N. Broad St.
- **/api/alerts**: active National Weather Service alerts for Middletown.

Phase 2
- **/api/roads**: DelDOT closures, crashes, hazards and work zones within ~8 miles (box around Middletown, Odessa, Townsend, Summit Bridge).
  Tries the DelDOT TMC advisory feed first, then deldot.gov, then the DelDOT TMC ArcGIS layer (driver reports via Waze; shown as "Possible", traffic jams hidden).
  Records without coordinates are kept only if they name a local place or road (SR 299, 71, 896, 15; Levels Rd, Bunker Hill, etc.).
- **/api/business**: businesses licensed in ZIP 19709 in the last 90 days, from Delaware Open Data
  ([Business Licenses, 5zy2-grhr](https://data.delaware.gov/d/5zy2-grhr)). The state record shows when the current license started,
  so new businesses and renewals both appear unless the dataset has a first-issue date.
- **/api/sources**: diagnostics. Hits every Phase 2 upstream and returns the status, record count and field names. Use this after deploy to confirm the feeds' formats.
- **/api/check**: shows which secrets are set.

## Cloudflare settings
- Secret `TOMTOM_API_KEY` (required for the train crossing)
- Secrets `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` (optional)
- Secret `SOCRATA_APP_TOKEN` (optional; free from data.delaware.gov, raises the open-data rate limit)

## Notes
- Edge cache: sky 15 s, train 60 s, roads 2 min, alerts 2 min, business licenses 6 h.
- Parsers for the Phase 2 feeds accept several field-name layouts (plain JSON, ArcGIS, GeoJSON), so a renamed column falls back instead of breaking the page.
- Some police/government aircraft don't broadcast, so not every helicopter will appear.
- Train status rule: "likely blocked" when speed < 40% of normal or travel time > 3× normal; "slow" under 75% of normal.
