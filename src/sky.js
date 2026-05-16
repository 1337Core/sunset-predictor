// Animated sky background — fully dynamic atmospheric simulator.
//
// Reads predicted weather (cloud-cover layers, weather code, humidity,
// aerosols) and renders the predicted sunrise/sunset moment as:
//   • Time-of-day base gradient anchored at the event horizon.
//   • Sun/moon disc, with halo and horizon glow.
//   • Stars (when the sun is below the horizon).
//   • Three cloud layers whose density tracks cloud_cover_low/mid/high.
//   • Weather effects: rain, snow, thunder flashes, fog, haze/smoke tint.
//   • Vignette.
//
// Perf notes:
//   • Clouds are pre-rendered to per-cloud offscreen sprites and only
//     rebuilt when the tint key changes (after smoothing converges) or
//     on resize. Per-frame cost becomes a cheap drawImage call.
//   • Stars are pre-rendered to one offscreen canvas.
//   • Rain / snow are drawn as a single batched path.
//   • The main canvas is capped at 1.5× DPR — gradients are fuzzy so the
//     loss is imperceptible while pixel fill drops ~44% on Retina.

import { clamp } from "./sunsetPredictor.js";

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  const p = parseInt(hex.slice(1), 16);
  return [(p >> 16) & 0xff, (p >> 8) & 0xff, p & 0xff];
}

function rgbToCss(rgb, a = 1) {
  return `rgba(${rgb[0]|0}, ${rgb[1]|0}, ${rgb[2]|0}, ${a})`;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpRgbInto(out, a, b, t) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

function lerpRgb(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function relLum(rgb) {
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
}

function srgbChannel(v) {
  const c = clamp(v / 255, 0, 1);
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function wcagLum(rgb) {
  return 0.2126 * srgbChannel(rgb[0]) +
    0.7152 * srgbChannel(rgb[1]) +
    0.0722 * srgbChannel(rgb[2]);
}

function contrastRatio(a, b) {
  const l1 = wcagLum(a);
  const l2 = wcagLum(b);
  const light = Math.max(l1, l2);
  const dark = Math.min(l1, l2);
  return (light + 0.05) / (dark + 0.05);
}

function paletteAtY(out, palette, y) {
  const scaled = clamp(y, 0, 1) * (palette.length - 1);
  const index = Math.floor(scaled);
  const next = Math.min(index + 1, palette.length - 1);
  return lerpRgbInto(out, palette[index], palette[next], scaled - index);
}

function readableInkForBg(bg) {
  const lightInk = [246, 248, 252];
  const darkInk = [24, 28, 32];
  return contrastRatio(lightInk, bg) >= contrastRatio(darkInk, bg)
    ? lightInk
    : darkInk;
}

function rgbVar(rgb) {
  return `${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])}`;
}

// ---------------------------------------------------------------------------
// Base sky palette by solar altitude.
// ---------------------------------------------------------------------------

const SKY_BY_ALT = [
  { alt: 60,  stops: ["#1c4a8a", "#2f6cb8", "#5896d4", "#90bce6", "#bcdaef"] },
  { alt: 30,  stops: ["#23538f", "#3c7abf", "#6aa0d6", "#9fc2e8", "#cde3f4"] },
  { alt: 15,  stops: ["#2a4f88", "#5470a4", "#8ca2c4", "#bcc4d4", "#dfd4cf"] },
  { alt: 6,   stops: ["#324a78", "#6a5e90", "#b48896", "#e0b08c", "#f4cfa6"] },
  { alt: 2,   stops: ["#2c3f6c", "#735a82", "#cf7a6a", "#f3a572", "#ffcd92"] },
  { alt: 0,   stops: ["#22335a", "#604a72", "#c46868", "#ee9070", "#ffb47a"] },
  { alt: -2,  stops: ["#1a2a52", "#4a3a6a", "#a45878", "#dc7080", "#f2917a"] },
  { alt: -6,  stops: ["#0c1840", "#262050", "#5c2c6c", "#9c4480", "#c66c7c"] },
  { alt: -10, stops: ["#060e2a", "#0e1638", "#26204c", "#4c2c60", "#704066"] },
  { alt: -14, stops: ["#030722", "#06092a", "#0e1238", "#181c46", "#2a2452"] },
  { alt: -18, stops: ["#01020e", "#020514", "#04081f", "#070d28", "#0c1532"] },
  { alt: -30, stops: ["#000007", "#01010c", "#020414", "#03061a", "#050a22"] },
];
// Pre-convert palette stops to rgb once, since they're constants.
const SKY_BY_ALT_RGB = SKY_BY_ALT.map((row) => ({
  alt: row.alt,
  stops: row.stops.map(hexToRgb),
}));

// Mutates `out` (5 length array of [r,g,b]) in place.
function fillPaletteForAltitude(out, alt) {
  const list = SKY_BY_ALT_RGB;
  if (alt >= list[0].alt) {
    for (let i = 0; i < 5; i++) out[i] = list[0].stops[i].slice();
    return;
  }
  const last = list.length - 1;
  if (alt <= list[last].alt) {
    for (let i = 0; i < 5; i++) out[i] = list[last].stops[i].slice();
    return;
  }
  for (let j = 0; j < last; j++) {
    const a = list[j], b = list[j + 1];
    if (alt <= a.alt && alt >= b.alt) {
      const t = (a.alt - alt) / (a.alt - b.alt);
      for (let i = 0; i < 5; i++) {
        out[i] = out[i] || [0, 0, 0];
        lerpRgbInto(out[i], a.stops[i], b.stops[i], t);
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Solar altitude for the recreation of the predicted event moment.
// ---------------------------------------------------------------------------

function eventSolarAltitude({ score, time }) {
  const s = clamp(((score ?? 5) - 3) / 6, 0, 1);
  const center = lerp(0.8, -2.8, s);
  const drift = Math.sin(time * 0.06) * 0.7;
  return center + drift;
}

// ---------------------------------------------------------------------------
// Weather code → conditions
// ---------------------------------------------------------------------------

function classifyWeather(code) {
  if (code == null) return { kind: "clear", intensity: 0 };
  if (code === 0 || code === 1) return { kind: "clear", intensity: 0 };
  if (code === 2) return { kind: "partly", intensity: 0 };
  if (code === 3) return { kind: "overcast", intensity: 1 };
  if (code === 45 || code === 48) return { kind: "fog", intensity: code === 48 ? 1 : 0.7 };
  if (code === 51) return { kind: "rain", intensity: 0.25 };
  if (code === 53) return { kind: "rain", intensity: 0.45 };
  if (code === 55) return { kind: "rain", intensity: 0.6 };
  if (code === 56 || code === 57) return { kind: "rain", intensity: 0.55 };
  if (code === 61) return { kind: "rain", intensity: 0.45 };
  if (code === 63) return { kind: "rain", intensity: 0.7 };
  if (code === 65) return { kind: "rain", intensity: 1 };
  if (code === 66 || code === 67) return { kind: "rain", intensity: 0.75 };
  if (code === 71) return { kind: "snow", intensity: 0.4 };
  if (code === 73) return { kind: "snow", intensity: 0.7 };
  if (code === 75) return { kind: "snow", intensity: 1 };
  if (code === 77) return { kind: "snow", intensity: 0.35 };
  if (code === 80) return { kind: "rain", intensity: 0.5 };
  if (code === 81) return { kind: "rain", intensity: 0.75 };
  if (code === 82) return { kind: "rain", intensity: 1 };
  if (code === 85) return { kind: "snow", intensity: 0.6 };
  if (code === 86) return { kind: "snow", intensity: 1 };
  if (code === 95) return { kind: "storm", intensity: 0.8 };
  if (code === 96 || code === 99) return { kind: "storm", intensity: 1 };
  return { kind: "clear", intensity: 0 };
}

// ---------------------------------------------------------------------------
// Cloud generation
// ---------------------------------------------------------------------------

const TIER_HIGH = 0, TIER_MID = 1, TIER_LOW = 2;

function generateClouds(seed = 7) {
  let s = seed;
  const rand = () => ((s = (s * 9301 + 49297) % 233280), s / 233280);

  const layers = [
    { tier: TIER_HIGH, count: 14, yMin: 0.06, yMax: 0.24, speed: 0.004, scale: 1.2, fluff: 0.35 },
    { tier: TIER_MID,  count: 12, yMin: 0.22, yMax: 0.50, speed: 0.008, scale: 1.7, fluff: 0.7 },
    { tier: TIER_LOW,  count: 10, yMin: 0.50, yMax: 0.85, speed: 0.012, scale: 2.2, fluff: 1 },
  ];

  const clouds = [];
  layers.forEach((layer) => {
    for (let i = 0; i < layer.count; i++) {
      const puffs = 4 + Math.floor(rand() * 5);
      const cloudSeed = rand() * 1000;
      // Pre-compute per-puff sin/cos factors so they aren't recomputed per render.
      const puffFactors = [];
      for (let p = 0; p < puffs; p++) {
        puffFactors.push({
          ox: Math.sin(p * 1.7 + cloudSeed),
          oy: Math.cos(p * 2.3 + cloudSeed),
          rMul: 0.7 + (p % 3) * 0.25,
        });
      }
      clouds.push({
        tier: layer.tier,
        x: rand(),
        y: layer.yMin + rand() * (layer.yMax - layer.yMin),
        scale: layer.scale * (0.6 + rand() * 0.8),
        speed: layer.speed * (0.7 + rand() * 0.7),
        puffs,
        fluff: layer.fluff,
        puffFactors,
      });
    }
  });

  return clouds;
}

// Cloud lighting tint based on the current sky palette.
// Mutates and returns a singleton object to avoid per-frame allocation.
const _cloudTintOut = { highlight: [0, 0, 0], shadow: [0, 0, 0] };
function cloudTintsInto(out, palette, alt, sunsetMix) {
  const lowSky = palette[3];
  const horizon = palette[4];

  // Warm sunset light reaching cloud bases.
  const warm = [
    lerp(180, 255, sunsetMix),
    lerp(180, 170, sunsetMix),
    lerp(175, 120, sunsetMix),
  ];

  const dayMix = clamp((alt + 6) / 20, 0, 1);
  const dimNight = [70, 78, 96];
  const dayBright = [240, 244, 248];
  // highlight = lerp(dimNight, dayBright, dayMix), then lerp toward warm.
  out.highlight[0] = lerp(dimNight[0], dayBright[0], dayMix);
  out.highlight[1] = lerp(dimNight[1], dayBright[1], dayMix);
  out.highlight[2] = lerp(dimNight[2], dayBright[2], dayMix);
  out.highlight[0] = lerp(out.highlight[0], warm[0], sunsetMix * 0.7);
  out.highlight[1] = lerp(out.highlight[1], warm[1], sunsetMix * 0.7);
  out.highlight[2] = lerp(out.highlight[2], warm[2], sunsetMix * 0.7);

  out.shadow[0] = lerp(lowSky[0] * 0.5, horizon[0] * 0.55, sunsetMix);
  out.shadow[1] = lerp(lowSky[1] * 0.5, horizon[1] * 0.45, sunsetMix);
  out.shadow[2] = lerp(lowSky[2] * 0.55, horizon[2] * 0.42, sunsetMix);
  return out;
}

// Quantize tint to a single int so we can detect significant changes.
// 4 bits per channel × 6 channels = 24 bits (fits in a Number safely).
function tintSignature(tint) {
  const hi = tint.highlight, sh = tint.shadow;
  return (
    (((hi[0] >> 4) & 0xf) << 20) |
    (((hi[1] >> 4) & 0xf) << 16) |
    (((hi[2] >> 4) & 0xf) << 12) |
    (((sh[0] >> 4) & 0xf) <<  8) |
    (((sh[1] >> 4) & 0xf) <<  4) |
    ((sh[2] >> 4) & 0xf)
  );
}

// ---------------------------------------------------------------------------
// Cloud sprite rendering (pre-computed).
// Each cloud is drawn onto a small offscreen canvas with the current tint
// baked in. Per-frame draw becomes a single drawImage() call.
// ---------------------------------------------------------------------------

// Sprite canvas size. Max puff bounding extent is ~3.28 × baseR, so for a
// 256×256 sprite (center 128), keep baseR ≤ 128/3.28 ≈ 39. We use 36 with a
// small safety margin so puffs never clip at the edge.
const SPRITE_SIZE = 256;
const SPRITE_BASE_R = 36;

function createSpriteCanvas() {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(SPRITE_SIZE, SPRITE_SIZE);
  }
  const c = document.createElement("canvas");
  c.width = SPRITE_SIZE;
  c.height = SPRITE_SIZE;
  return c;
}

// Renders into an EXISTING canvas (clears first), to avoid per-rebake allocation.
function renderCloudSpriteInto(cnv, cloud, tint) {
  const tctx = cnv.getContext("2d");
  tctx.clearRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);

  const cx = SPRITE_SIZE / 2;
  const cy = SPRITE_SIZE / 2;
  const baseR = SPRITE_BASE_R;
  const fluff = cloud.fluff;
  const factors = cloud.puffFactors;

  const shStr = (a) => rgbToCss(tint.shadow, a);
  const hlStr = (a) => rgbToCss(tint.highlight, a);
  const shFull = shStr(0.35 * fluff);
  const shClear = shStr(0);
  const hlFull = hlStr(0.9 * fluff);
  const hlMid = hlStr(0.5 * fluff);
  const hlClear = hlStr(0);

  // Shadow puffs.
  for (let i = 0; i < cloud.puffs; i++) {
    const f = factors[i];
    const ox = f.ox * baseR * 1.6;
    const oy = f.oy * baseR * 0.5;
    const r = baseR * f.rMul;
    const px = cx + ox;
    const py = cy + oy + r * 0.3;
    const rOuter = r * 1.4;
    const g = tctx.createRadialGradient(px, py, 0, px, py, rOuter);
    g.addColorStop(0, shFull);
    g.addColorStop(1, shClear);
    tctx.fillStyle = g;
    tctx.beginPath();
    tctx.arc(px, py, rOuter, 0, Math.PI * 2);
    tctx.fill();
  }

  // Highlight puffs.
  for (let i = 0; i < cloud.puffs; i++) {
    const f = factors[i];
    const ox = f.ox * baseR * 1.6;
    const oy = f.oy * baseR * 0.5;
    const r = baseR * f.rMul;
    const px = cx + ox;
    const py = cy + oy;
    const rOuter = r * 1.1;
    const g = tctx.createRadialGradient(px, py, 0, px, py, rOuter);
    g.addColorStop(0, hlFull);
    g.addColorStop(0.55, hlMid);
    g.addColorStop(1, hlClear);
    tctx.fillStyle = g;
    tctx.beginPath();
    tctx.arc(px, py, rOuter, 0, Math.PI * 2);
    tctx.fill();
  }
}

// ---------------------------------------------------------------------------
// Star field
// ---------------------------------------------------------------------------

function renderStarField(w, h, count = 220) {
  const cnv =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const tctx = cnv.getContext("2d");
  let s = 13;
  const rand = () => ((s = (s * 9301 + 49297) % 233280), s / 233280);
  tctx.fillStyle = "#f0f4ff";
  // Single beginPath, all stars in one fill.
  tctx.beginPath();
  for (let i = 0; i < count; i++) {
    const x = rand() * w;
    const y = rand() * 0.7 * h;
    const r = 0.4 + rand() * 1.4;
    const brightness = 0.4 + rand() * 0.6;
    // Group sub-paths by brightness via globalAlpha would need separate passes;
    // here we approximate with varying radii since they all share the same fill.
    // To get brightness variety we apply a tiny secondary draw.
    tctx.moveTo(x + r * brightness, y);
    tctx.arc(x, y, r * brightness, 0, Math.PI * 2);
  }
  tctx.fill();
  return cnv;
}

// ---------------------------------------------------------------------------
// Particles (rain / snow)
// ---------------------------------------------------------------------------

function makeParticles(count, type) {
  const arr = [];
  for (let i = 0; i < count; i++) {
    arr.push({
      x: Math.random(),
      y: Math.random(),
      v: type === "rain" ? 0.6 + Math.random() * 0.5 : 0.06 + Math.random() * 0.08,
      drift: type === "snow" ? (Math.random() - 0.5) * 0.04 : 0.02,
      size: type === "rain" ? 0.8 + Math.random() * 1.2 : 1 + Math.random() * 2.5,
      phase: Math.random() * Math.PI * 2,
    });
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Main sky
// ---------------------------------------------------------------------------

export function createSky(canvas, getState) {
  const ctx = canvas.getContext("2d");
  const clouds = generateClouds(7);

  // Particle pools — kept tight for perf.
  const rainParticles = makeParticles(300, "rain");
  const snowParticles = makeParticles(160, "snow");

  // Sprite caches. Cloud canvases are allocated once and rebaked in place,
  // so re-tinting never allocates new canvas backing memory.
  const cloudSprites = clouds.map(() => createSpriteCanvas());
  let cloudTintSig = -1;
  let starSprite = null;
  let starSpriteW = 0;
  let starSpriteH = 0;

  let lastTime = performance.now();
  let timeAccum = 0;
  let cloudOffset = 0;

  // Reusable working state (avoid per-frame allocations).
  const palette = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const toneBg = {
    top: [0, 0, 0],
    hero: [0, 0, 0],
    bottom: [0, 0, 0],
  };
  let toneSignature = "";
  const target = {
    alt: 0, low: 0, mid: 0, high: 0, humidity: 50, aod: 0.1, pm25: 0,
    rain: 0, snow: 0, storm: 0, fog: 0, haze: 0, score: 5,
  };
  const smoothed = { ...target, alt: 30 };

  // Thunder timing.
  let nextFlashAt = 3 + Math.random() * 4;
  let flashStrength = 0;
  let flashTimer = 0;

  // Minimum frame interval. Caps at ~60 fps so the renderer doesn't push
  // 120/144 Hz on high-refresh displays — visually identical, half the GPU
  // work on those screens.
  const MIN_FRAME_MS = 1000 / 60 - 1;
  let frameCarry = 0;

  function resize() {
    // 1.5× DPR cap is enough sharpness for soft gradients & shaves ~44% pixels
    // off Retina versus 2×.
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const { innerWidth: w, innerHeight: h } = window;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Invalidate star sprite on resize; cloud sprites are size-independent.
    starSprite = null;
  }

  function approachAll(dt) {
    const rate = 0.8;
    const a = 1 - Math.exp(-rate * dt);
    smoothed.alt = lerp(smoothed.alt, target.alt, a);
    smoothed.low = lerp(smoothed.low, target.low, a);
    smoothed.mid = lerp(smoothed.mid, target.mid, a);
    smoothed.high = lerp(smoothed.high, target.high, a);
    smoothed.humidity = lerp(smoothed.humidity, target.humidity, a);
    smoothed.aod = lerp(smoothed.aod, target.aod, a);
    smoothed.pm25 = lerp(smoothed.pm25, target.pm25, a);
    smoothed.rain = lerp(smoothed.rain, target.rain, a);
    smoothed.snow = lerp(smoothed.snow, target.snow, a);
    smoothed.storm = lerp(smoothed.storm, target.storm, a);
    smoothed.fog = lerp(smoothed.fog, target.fog, a);
    smoothed.haze = lerp(smoothed.haze, target.haze, a);
    smoothed.score = lerp(smoothed.score, target.score, a);
  }

  function frame(now) {
    // Frame rate limiter.
    const elapsed = now - lastTime + frameCarry;
    if (elapsed < MIN_FRAME_MS) {
      requestAnimationFrame(frame);
      return;
    }
    frameCarry = elapsed - MIN_FRAME_MS;
    if (frameCarry > MIN_FRAME_MS) frameCarry = MIN_FRAME_MS; // don't overshoot

    const dt = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    timeAccum += dt;

    const w = window.innerWidth;
    const h = window.innerHeight;
    const minDim = Math.min(w, h);

    const raw = getState();
    canvas.dataset.mode = raw.mode || "sunset";
    const sample = raw.sample || {};
    const code = raw.weatherCode ?? sample.weather_code ?? null;
    const cls = classifyWeather(code);

    const alt = eventSolarAltitude({ score: raw.score, time: timeAccum });

    const haze =
      clamp(((sample.aerosol_optical_depth ?? 0) - 0.15) / 0.45, 0, 1) +
      clamp(((sample.pm2_5 ?? 0) - 20) / 60, 0, 1) * 0.6;

    target.alt = alt;
    target.low = sample.cloud_cover_low ?? 0;
    target.mid = sample.cloud_cover_mid ?? 0;
    target.high = sample.cloud_cover_high ?? 0;
    target.humidity = sample.relative_humidity_2m ?? 50;
    target.aod = sample.aerosol_optical_depth ?? 0.1;
    target.pm25 = sample.pm2_5 ?? 0;
    target.rain = cls.kind === "rain" ? cls.intensity : 0;
    target.snow = cls.kind === "snow" ? cls.intensity : 0;
    target.storm = cls.kind === "storm" ? cls.intensity : 0;
    target.fog = cls.kind === "fog" ? cls.intensity : 0;
    target.haze = clamp(haze, 0, 1);
    target.score = raw.score ?? 5;

    approachAll(dt);

    const effectiveRain = clamp(smoothed.rain + smoothed.storm * 0.8, 0, 1);
    const sunsetMix = clamp(1 - Math.abs(smoothed.alt) / 8, 0, 1);
    const scoreBoost = clamp((smoothed.score - 4) / 5, 0, 1);

    // ---- Base sky gradient (in-place palette manipulation) ----
    fillPaletteForAltitude(palette, smoothed.alt);

    if (sunsetMix > 0.05) {
      const boost = sunsetMix * (0.4 + scoreBoost * 0.7);
      const warmA = [255, 110, 70];
      const warmB = [255, 190, 110];
      const warmC = [180, 110, 140];
      lerpRgbInto(palette[1], palette[1], warmC, boost * 0.3);
      lerpRgbInto(palette[2], palette[2], warmA, boost * 0.55);
      lerpRgbInto(palette[3], palette[3], warmA, boost * 0.7);
      lerpRgbInto(palette[4], palette[4], warmB, boost * 0.85);
    }

    const overcast = clamp((smoothed.low * 0.6 + smoothed.mid * 0.4) / 100, 0, 1);
    if (overcast > 0.1) {
      const grayMix = overcast * 0.55;
      for (let i = 0; i < 5; i++) {
        const c = palette[i];
        const gray = (c[0] + c[1] + c[2]) / 3;
        c[0] = lerp(c[0], gray * 0.9, grayMix);
        c[1] = lerp(c[1], gray * 0.9, grayMix);
        c[2] = lerp(c[2], gray * 0.95, grayMix);
      }
    }

    const stormDark = clamp(smoothed.storm * 0.6 + effectiveRain * 0.35, 0, 0.7);
    if (stormDark > 0.02) {
      const k1 = 1 - stormDark * 0.5;
      const k2 = 1 - stormDark * 0.45;
      for (let i = 0; i < 5; i++) {
        const c = palette[i];
        c[0] *= k1;
        c[1] *= k1;
        c[2] *= k2;
      }
    }

    if (smoothed.haze > 0.05) {
      const smoke = [200, 130, 90];
      for (let i = 0; i < 5; i++) {
        const mix = smoothed.haze * (i >= 3 ? 0.55 : 0.3);
        lerpRgbInto(palette[i], palette[i], smoke, mix);
      }
    }

    if (flashStrength > 0.01) {
      const r = 220 * flashStrength;
      const g = 230 * flashStrength;
      const b = 255 * flashStrength;
      for (let i = 0; i < 5; i++) {
        const c = palette[i];
        c[0] = c[0] + r; if (c[0] > 255) c[0] = 255;
        c[1] = c[1] + g; if (c[1] > 255) c[1] = 255;
        c[2] = c[2] + b; if (c[2] > 255) c[2] = 255;
      }
    }

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    for (let i = 0; i < 5; i++) grad.addColorStop(i / 4, rgbToCss(palette[i]));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // ---- Stars (cached sprite, modulated by visibility) ----
    if (smoothed.alt < -2) {
      const visibility =
        clamp((-smoothed.alt - 2) / 8, 0, 1) *
        (1 - overcast * 0.85) *
        (1 - smoothed.fog * 0.9) *
        (1 - smoothed.haze * 0.5) *
        (1 - effectiveRain * 0.7);
      if (visibility > 0.01) {
        if (!starSprite || starSpriteW !== w || starSpriteH !== h) {
          starSprite = renderStarField(w, h, 200);
          starSpriteW = w;
          starSpriteH = h;
        }
        const prevAlpha = ctx.globalAlpha;
        // Subtle global shimmer instead of per-star twinkle (perf win, look kept).
        const shimmer = 0.85 + 0.15 * Math.sin(timeAccum * 1.4);
        ctx.globalAlpha = clamp(visibility * shimmer, 0, 1);
        ctx.drawImage(starSprite, 0, 0);
        ctx.globalAlpha = prevAlpha;
      }
    }

    // ---- Sun / moon disc ----
    drawCelestial(ctx, w, h, minDim, smoothed, sunsetMix, scoreBoost);

    // ---- Cloud layers (pre-rendered sprites) ----
    cloudOffset += dt;
    cloudTintsInto(_cloudTintOut, palette, smoothed.alt, sunsetMix);

    const sig = tintSignature(_cloudTintOut);
    if (sig !== cloudTintSig) {
      // Tint crossed a quantization boundary — rebake sprites in their
      // existing canvases. After scene convergence this stops firing.
      for (let i = 0; i < clouds.length; i++) {
        renderCloudSpriteInto(cloudSprites[i], clouds[i], _cloudTintOut);
      }
      cloudTintSig = sig;
    }

    const highCount = Math.round(clamp(smoothed.high / 100, 0, 1) * 14);
    const midCount = Math.round(clamp(smoothed.mid / 100, 0, 1) * 12);
    const lowCount = Math.round(clamp((smoothed.low + smoothed.storm * 80) / 100, 0, 1) * 10);

    const lowOpacity = Math.max(clamp(smoothed.low / 100, 0, 1), smoothed.storm * 0.95);
    const highOpacity = clamp(smoothed.high / 100, 0, 1) * 0.85;
    const midOpacity = clamp(smoothed.mid / 100, 0, 1) * 0.95;

    // Clouds are already in tier order (high → mid → low) so we can draw
    // them in place — no sort allocation needed.
    const prevAlpha = ctx.globalAlpha;
    const used = [0, 0, 0];
    for (let i = 0; i < clouds.length; i++) {
      const c = clouds[i];
      const cap = c.tier === TIER_HIGH ? highCount : c.tier === TIER_MID ? midCount : lowCount;
      if (used[c.tier] >= cap) continue;
      used[c.tier]++;

      const sprite = cloudSprites[i];
      const drift = (cloudOffset * c.speed) % 1.4 - 0.2;
      const x = (c.x + drift) % 1.2 - 0.1;
      const opacity =
        c.tier === TIER_HIGH ? highOpacity :
        c.tier === TIER_MID  ? midOpacity  :
                               lowOpacity;
      if (opacity < 0.01) continue;

      // Scale sprite to the cloud's natural size in screen pixels.
      const baseR = minDim * 0.055 * c.scale;
      // Sprite represents a cloud whose baseR == SPRITE_BASE_R; scale accordingly.
      const dw = (SPRITE_SIZE * baseR) / SPRITE_BASE_R;
      const dh = dw;

      ctx.globalAlpha = opacity;
      ctx.drawImage(sprite, x * w - dw / 2, c.y * h - dh / 2, dw, dh);
    }
    ctx.globalAlpha = prevAlpha;

    // ---- Fog overlay ----
    if (smoothed.fog > 0.02) {
      const fogG = ctx.createLinearGradient(0, h * 0.2, 0, h);
      const cBrightSide = smoothed.alt > 0;
      const fogR = cBrightSide ? 230 : 120;
      const fogG2 = cBrightSide ? 232 : 130;
      const fogB = cBrightSide ? 234 : 140;
      fogG.addColorStop(0, `rgba(${fogR},${fogG2},${fogB},${0.15 * smoothed.fog})`);
      fogG.addColorStop(1, `rgba(${fogR},${fogG2},${fogB},${0.85 * smoothed.fog})`);
      ctx.fillStyle = fogG;
      ctx.fillRect(0, 0, w, h);
    }

    // ---- Rain (batched into single stroke) ----
    if (effectiveRain > 0.02) {
      const len = 12 + effectiveRain * 18;
      ctx.strokeStyle = `rgba(190, 210, 230, ${0.35 + effectiveRain * 0.4})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const visibleCount = Math.floor(rainParticles.length * effectiveRain);
      const speedMul = dt * (1.5 + effectiveRain);
      const xDelta = 0.04 * dt;
      const lenY = -len;
      const lenX = -len * 0.15;
      for (let i = 0; i < visibleCount; i++) {
        const p = rainParticles[i];
        p.y += p.v * speedMul;
        p.x += xDelta;
        if (p.y > 1.05) { p.y = -0.05; p.x = Math.random(); }
        if (p.x > 1.05) p.x = -0.05;
        const x = p.x * w;
        const y = p.y * h;
        ctx.moveTo(x, y);
        ctx.lineTo(x + lenX, y + lenY);
      }
      ctx.stroke();
    }

    // ---- Snow (batched into single fill) ----
    if (smoothed.snow > 0.02) {
      ctx.fillStyle = `rgba(245, 248, 255, ${0.55 + smoothed.snow * 0.4})`;
      ctx.beginPath();
      const visibleCount = Math.floor(snowParticles.length * smoothed.snow);
      const fallMul = dt * (0.6 + smoothed.snow * 0.4);
      const swayBase = timeAccum * 0.6;
      for (let i = 0; i < visibleCount; i++) {
        const p = snowParticles[i];
        p.y += p.v * fallMul;
        p.x += Math.sin(swayBase + p.phase) * 0.0008 + p.drift * dt;
        if (p.y > 1.05) { p.y = -0.05; p.x = Math.random(); }
        if (p.x > 1.05) p.x = -0.05;
        if (p.x < -0.05) p.x = 1.05;
        const x = p.x * w;
        const y = p.y * h;
        ctx.moveTo(x + p.size, y);
        ctx.arc(x, y, p.size, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    // ---- Lightning ----
    if (smoothed.storm > 0.1) {
      nextFlashAt -= dt;
      if (nextFlashAt <= 0) {
        flashStrength = 0.5 + Math.random() * 0.5;
        flashTimer = 0.12 + Math.random() * 0.15;
        nextFlashAt = 2 + Math.random() * 6 * (1 - smoothed.storm);
        drawLightning(ctx, w, h, flashStrength);
      }
      if (flashTimer > 0) {
        flashTimer -= dt;
        flashStrength = Math.max(0, flashStrength - dt * 4);
      } else {
        flashStrength = Math.max(0, flashStrength - dt * 6);
      }
    } else {
      flashStrength = Math.max(0, flashStrength - dt * 6);
    }

    // ---- Vignette ----
    const vg = ctx.createRadialGradient(
      w / 2, h / 2, minDim * 0.32,
      w / 2, h / 2, Math.max(w, h) * 0.78,
    );
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, `rgba(0,0,0,${0.10 + stormDark * 0.25})`);
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);

    // ---- Dynamic text contrast ----
    // Sample the vertical sky gradient where fixed UI regions live, then
    // choose the ink color with the stronger contrast for each region.
    const avgLum =
      (relLum(palette[0]) + relLum(palette[1]) + relLum(palette[2]) +
       relLum(palette[3]) + relLum(palette[4])) / 5;
    const nightMode = avgLum < 90;
    const nightVal = nightMode ? "1" : "0";
    if (document.body.dataset.night !== nightVal) {
      document.body.dataset.night = nightVal;
    }
    paletteAtY(toneBg.top, palette, 0.08);
    paletteAtY(toneBg.hero, palette, 0.5);
    paletteAtY(toneBg.bottom, palette, 0.9);
    const topInk = readableInkForBg(toneBg.top);
    const heroInk = readableInkForBg(toneBg.hero);
    const bottomInk = readableInkForBg(toneBg.bottom);
    const nextToneSignature = `${rgbVar(topInk)}|${rgbVar(heroInk)}|${rgbVar(bottomInk)}`;
    if (nextToneSignature !== toneSignature) {
      const style = document.documentElement.style;
      style.setProperty("--ui-top-ink-rgb", rgbVar(topInk));
      style.setProperty("--ui-hero-ink-rgb", rgbVar(heroInk));
      style.setProperty("--ui-bottom-ink-rgb", rgbVar(bottomInk));
      toneSignature = nextToneSignature;
    }

    requestAnimationFrame(frame);
  }

  function drawCelestial(ctx, w, h, minDim, smoothed, sunsetMix, scoreBoost) {
    const alt = smoothed.alt;
    if (alt > 60 || alt < -20) return;

    const visibility = clamp(
      (1 - smoothed.fog * 0.95) *
      (1 - clamp(smoothed.high / 130, 0, 1)) *
      (1 - clamp(smoothed.mid / 220, 0, 1)) *
      (1 - smoothed.storm * 0.7),
      0, 1,
    );

    const mode = canvas.dataset.mode || "sunset";
    const sideX = mode === "sunrise" ? 0.22 : 0.78;
    const altT = clamp(alt / 60, -0.3, 1);
    const x = lerp(sideX, 0.5, clamp(altT, 0, 1));
    const yT = 1 - clamp((alt + 8) / 50, 0, 1);
    const y = lerp(0.12, 0.82, yT);

    const radius = minDim * 0.06;
    const px = x * w, py = y * h;

    if (alt > -3) {
      const sunColor = sunsetMix > 0.2
        ? lerpRgb([255, 245, 220], [255, 130, 70], sunsetMix * (0.5 + scoreBoost * 0.5))
        : [255, 250, 230];

      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const haloR = radius * (3 + sunsetMix * 2.5);
      const halo = ctx.createRadialGradient(px, py, radius * 0.4, px, py, haloR);
      halo.addColorStop(0, rgbToCss(sunColor, 0.55 * visibility));
      halo.addColorStop(0.4, rgbToCss(sunColor, 0.18 * visibility));
      halo.addColorStop(1, rgbToCss(sunColor, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(px, py, haloR, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = clamp(visibility * (0.85 + scoreBoost * 0.15), 0, 1);
      const disc = ctx.createRadialGradient(px, py, 0, px, py, radius);
      disc.addColorStop(0, "rgba(255, 252, 240, 1)");
      disc.addColorStop(0.7, rgbToCss(sunColor, 1));
      disc.addColorStop(1, rgbToCss(sunColor, 0.4));
      ctx.fillStyle = disc;
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (alt < -6) {
      const nightDepth = clamp((-alt - 6) / 12, 0, 1);
      const moonVis = visibility * nightDepth;
      if (moonVis < 0.05) return;
      const mx = 0.72 * w;
      const my = 0.22 * h;
      const r = minDim * 0.045;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const halo = ctx.createRadialGradient(mx, my, r * 0.3, mx, my, r * 3.5);
      halo.addColorStop(0, `rgba(220, 224, 240, ${0.35 * moonVis})`);
      halo.addColorStop(1, "rgba(220, 224, 240, 0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(mx, my, r * 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = moonVis;
      const disc = ctx.createRadialGradient(mx - r * 0.2, my - r * 0.2, 0, mx, my, r);
      disc.addColorStop(0, "#f4f6fa");
      disc.addColorStop(1, "#c8ccda");
      ctx.fillStyle = disc;
      ctx.beginPath();
      ctx.arc(mx, my, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(120, 124, 140, 0.18)";
      ctx.beginPath();
      ctx.arc(mx + r * 0.3, my + r * 0.1, r * 0.85, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawLightning(ctx, w, h, strength) {
    ctx.save();
    ctx.globalAlpha = clamp(strength, 0, 1);
    ctx.strokeStyle = "rgba(240, 245, 255, 0.95)";
    ctx.lineWidth = 1.5;
    ctx.shadowColor = "rgba(220, 235, 255, 0.9)";
    ctx.shadowBlur = 12;
    let x = w * (0.2 + Math.random() * 0.6);
    let y = 0;
    ctx.beginPath();
    ctx.moveTo(x, y);
    while (y < h * 0.55) {
      x += (Math.random() - 0.5) * 60;
      y += 20 + Math.random() * 40;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  window.addEventListener("resize", resize);
  resize();
  requestAnimationFrame((t) => {
    lastTime = t;
    frame(t);
  });
}
