# Sunset Predictor

A polished, single-screen browser app that predicts how good the next
sunset (or sunrise) will look — wherever you are.

The UI is intentionally minimal: a soft cloud sky background, a single big
score in the center, and quiet monospace labels in the corners.

## Run

```sh
bun install
bun run dev
```

## How it works

- `astronomy-engine` computes sunrise/sunset and civil twilight bounds
  (`SearchRiseSet`, observer elevation, refraction, `SearchAltitude` at -6°).
- Open-Meteo's forecast + air-quality APIs are sampled at the exact event
  minute (interpolated from hourly time series, with worst-weather-code lookup
  in a ±1h window).
- The launch model is an explainable, additive score with named contributions
  for mid/low/high cloud, AOD, humidity, weather code, twilight length,
  magic-gap geometry, marine layer, smoke, and dust. Hard caps apply for fog,
  precipitation, snow, and thunderstorms.

## Controls

- **← / →** — previous / next day
- **↑ / ↓** — toggle sunrise ↔ sunset
- **d** — open/close detailed forecast sheet
- **t** — jump back to today
- **b** or click anywhere — release a flock of birds
- **Esc** — close the details sheet

## Files

- `src/main.js` — app state, rendering, interactions
- `src/sky.js` — animated canvas sky + cloud renderer
- `src/birds.js` — bird flock easter egg
- `src/sunsetPredictor.js` — astronomy, weather sampling, scoring
- `src/styles.css` — full UI styling

## Next step

Calibration: log the raw feature vector, predicted score, user rating,
optional photo metadata, and region/season. Once enough real outcomes exist,
fit regional weights or a monotonic model that preserves the hard constraints
around fog, heavy low cloud, precipitation, and extreme smoke.
