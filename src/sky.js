// Animated sky background — fully dynamic atmospheric simulator.
//
// Reads predicted weather (cloud-cover layers, weather code, humidity,
// aerosols) and the time relative to the sun event, then composes:
//   • Time-of-day base gradient driven by approximate solar altitude.
//   • Sun/moon disc, with halo and horizon glow.
//   • Stars (when the sun is below the horizon).
//   • Three cloud layers whose density tracks cloud_cover_low/mid/high.
//   • Weather effects: rain, snow, thunder flashes, fog, haze/smoke tint.
//   • Vignette + film grain.
//
// Designed to be cheap enough for 60fps on a phone (single canvas, particle
// counts capped, no per-pixel work).

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

function lerpRgb(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function smoothstep(x, e0, e1) {
  if (e0 === e1) return x >= e1 ? 1 : 0;
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

function relLum(rgb) {
  // Perceptual brightness (Rec. 601 ish) on 0..255.
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
}

// ---------------------------------------------------------------------------
// Base sky palette by solar altitude.
// Each entry is a 5-stop top→bottom gradient (rgb triples).
// Altitudes (degrees) span deep night (-18) to high noon (+60).
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

function paletteForAltitude(alt) {
  const list = SKY_BY_ALT;
  if (alt >= list[0].alt) return list[0].stops.map(hexToRgb);
  if (alt <= list[list.length - 1].alt) return list[list.length - 1].stops.map(hexToRgb);
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i], b = list[i + 1];
    if (alt <= a.alt && alt >= b.alt) {
      const t = (a.alt - alt) / (a.alt - b.alt);
      return a.stops.map((c, idx) => lerpRgb(hexToRgb(c), hexToRgb(b.stops[idx]), t));
    }
  }
  return list[0].stops.map(hexToRgb);
}

// ---------------------------------------------------------------------------
// Solar altitude for the *recreation* of the predicted event.
// The sky always renders the sunrise/sunset moment itself — never the current
// time of day. Higher-scoring events settle a bit deeper into civil twilight
// (alt ≈ -2° to -3°), where pink/orange/magenta peak. Poor scores stay closer
// to the horizon (alt ≈ +0.5°). A gentle sinusoidal drift adds subtle motion.
// ---------------------------------------------------------------------------

function eventSolarAltitude({ score, time }) {
  const s = clamp(((score ?? 5) - 3) / 6, 0, 1); // 0 at poor, 1 at great
  const center = lerp(0.8, -2.8, s);
  const drift = Math.sin(time * 0.06) * 0.7;
  return center + drift;
}

// ---------------------------------------------------------------------------
// Weather code → conditions
// ---------------------------------------------------------------------------

function classifyWeather(code) {
  if (code == null) return { kind: "clear", intensity: 0 };
  if (code === 0) return { kind: "clear", intensity: 0 };
  if (code === 1) return { kind: "clear", intensity: 0 };
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

function generateClouds(seed = 7) {
  let s = seed;
  const rand = () => ((s = (s * 9301 + 49297) % 233280), s / 233280);

  const layers = [
    // High clouds (cirrus): thin, fast, near top.
    { tier: "high", count: 14, yMin: 0.06, yMax: 0.24, speed: 0.004, scale: 1.2, fluff: 0.35 },
    // Mid clouds (altocumulus): chunky, mid sky.
    { tier: "mid",  count: 12, yMin: 0.22, yMax: 0.50, speed: 0.008, scale: 1.7, fluff: 0.7 },
    // Low clouds (stratus/cumulus): big, heavy, near horizon.
    { tier: "low",  count: 10, yMin: 0.50, yMax: 0.85, speed: 0.012, scale: 2.2, fluff: 1 },
  ];

  const clouds = [];
  layers.forEach((layer) => {
    for (let i = 0; i < layer.count; i++) {
      clouds.push({
        tier: layer.tier,
        x: rand(),
        y: layer.yMin + rand() * (layer.yMax - layer.yMin),
        scale: layer.scale * (0.6 + rand() * 0.8),
        speed: layer.speed * (0.7 + rand() * 0.7),
        puffs: 4 + Math.floor(rand() * 5),
        seed: rand() * 1000,
        fluff: layer.fluff,
      });
    }
  });

  return clouds;
}

// Cloud lighting: pick highlight (top-lit) and shadow (under-lit) tints
// based on the sky palette at this moment.
function cloudTints(palette, alt, sunsetMix) {
  // top of cloud lit by sky top; underside by lower part of sky (more orange
  // near sunset). When the sun is up, white highlights; near sunset push warm.
  const topSky = palette[0];
  const lowSky = palette[3];
  const horizon = palette[4];

  // Warm sunset light reaching cloud bases.
  const warm = lerpRgb([180, 180, 175], [255, 170, 120], sunsetMix);

  // Highlight: brighter, leaning warm at sunset, leaning white in day, dim at night.
  const dayMix = clamp((alt + 6) / 20, 0, 1); // 0 below -6°, 1 at +14°
  const dayBright = [240, 244, 248];
  const dimNight = [70, 78, 96];
  let highlight = lerpRgb(dimNight, dayBright, dayMix);
  highlight = lerpRgb(highlight, warm, sunsetMix * 0.7);

  // Shadow: tinted toward lower-sky color, darker.
  const shadow = lerpRgb(
    [lowSky[0] * 0.5, lowSky[1] * 0.5, lowSky[2] * 0.55],
    [horizon[0] * 0.55, horizon[1] * 0.45, horizon[2] * 0.42],
    sunsetMix,
  );

  return { highlight, shadow };
}

function drawCloud(ctx, cloud, w, h, tint, opacity) {
  const cx = cloud.x * w;
  const cy = cloud.y * h;
  const baseR = Math.min(w, h) * 0.055 * cloud.scale;
  const fluff = cloud.fluff;

  ctx.save();
  ctx.globalAlpha = clamp(opacity, 0, 1);

  // Shadow puffs (underside).
  for (let i = 0; i < cloud.puffs; i++) {
    const ox = Math.sin(i * 1.7 + cloud.seed) * baseR * 1.6;
    const oy = Math.cos(i * 2.3 + cloud.seed) * baseR * 0.5;
    const r = baseR * (0.7 + (i % 3) * 0.25);
    const g = ctx.createRadialGradient(cx + ox, cy + oy + r * 0.3, 0, cx + ox, cy + oy + r * 0.3, r * 1.4);
    g.addColorStop(0, rgbToCss(tint.shadow, 0.35 * fluff));
    g.addColorStop(1, rgbToCss(tint.shadow, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx + ox, cy + oy + r * 0.3, r * 1.4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Highlight puffs (top of cloud).
  for (let i = 0; i < cloud.puffs; i++) {
    const ox = Math.sin(i * 1.7 + cloud.seed) * baseR * 1.6;
    const oy = Math.cos(i * 2.3 + cloud.seed) * baseR * 0.5;
    const r = baseR * (0.7 + (i % 3) * 0.25);
    const g = ctx.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, r * 1.1);
    g.addColorStop(0, rgbToCss(tint.highlight, 0.9 * fluff));
    g.addColorStop(0.55, rgbToCss(tint.highlight, 0.5 * fluff));
    g.addColorStop(1, rgbToCss(tint.highlight, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx + ox, cy + oy, r * 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Stars
// ---------------------------------------------------------------------------

function generateStars(count = 220) {
  let s = 13;
  const rand = () => ((s = (s * 9301 + 49297) % 233280), s / 233280);
  const stars = [];
  for (let i = 0; i < count; i++) {
    stars.push({
      x: rand(),
      y: rand() * 0.7, // stars in upper part mostly
      r: 0.4 + rand() * 1.4,
      twinkleSpeed: 0.5 + rand() * 2,
      phase: rand() * Math.PI * 2,
      brightness: 0.4 + rand() * 0.6,
    });
  }
  return stars;
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
  const stars = generateStars(260);

  // Rain/snow particle pools, sized once for max conditions.
  const rainParticles = makeParticles(420, "rain");
  const snowParticles = makeParticles(220, "snow");

  let lastTime = performance.now();
  let timeAccum = 0;
  let cloudOffset = 0;

  // Smooth blending between scene snapshots, so condition changes don't snap.
  const smoothed = {
    alt: 30,
    low: 0,
    mid: 0,
    high: 0,
    humidity: 50,
    aod: 0.1,
    pm25: 0,
    rain: 0,
    snow: 0,
    storm: 0,
    fog: 0,
    haze: 0,
    score: 5,
  };

  // Thunder timing.
  let nextFlashAt = 3 + Math.random() * 4;
  let flashStrength = 0;
  let flashTimer = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { innerWidth: w, innerHeight: h } = window;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function approachAll(state, dt) {
    // Approach rate per second. Higher = snappier.
    const rate = 0.8;
    const a = 1 - Math.exp(-rate * dt);
    smoothed.alt = lerp(smoothed.alt, state.alt, a);
    smoothed.low = lerp(smoothed.low, state.low, a);
    smoothed.mid = lerp(smoothed.mid, state.mid, a);
    smoothed.high = lerp(smoothed.high, state.high, a);
    smoothed.humidity = lerp(smoothed.humidity, state.humidity, a);
    smoothed.aod = lerp(smoothed.aod, state.aod, a);
    smoothed.pm25 = lerp(smoothed.pm25, state.pm25, a);
    smoothed.rain = lerp(smoothed.rain, state.rain, a);
    smoothed.snow = lerp(smoothed.snow, state.snow, a);
    smoothed.storm = lerp(smoothed.storm, state.storm, a);
    smoothed.fog = lerp(smoothed.fog, state.fog, a);
    smoothed.haze = lerp(smoothed.haze, state.haze, a);
    smoothed.score = lerp(smoothed.score, state.score, a);
  }

  function frame(now) {
    const dt = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    timeAccum += dt;

    const w = window.innerWidth;
    const h = window.innerHeight;

    const raw = getState();
    canvas.dataset.mode = raw.mode || "sunset";
    const sample = raw.sample || {};
    const code = raw.weatherCode ?? sample.weather_code ?? null;
    const cls = classifyWeather(code);

    // Solar altitude is anchored to the event moment itself (sun at horizon).
    // The sky is a recreation of the predicted sunrise/sunset — not "now".
    const alt = eventSolarAltitude({
      score: raw.score,
      time: timeAccum,
    });

    // Smoke / haze from aerosols + PM2.5.
    const haze = clamp(((sample.aerosol_optical_depth ?? 0) - 0.15) / 0.45, 0, 1)
      + clamp(((sample.pm2_5 ?? 0) - 20) / 60, 0, 1) * 0.6;

    const target = {
      alt,
      low: sample.cloud_cover_low ?? 0,
      mid: sample.cloud_cover_mid ?? 0,
      high: sample.cloud_cover_high ?? 0,
      humidity: sample.relative_humidity_2m ?? 50,
      aod: sample.aerosol_optical_depth ?? 0.1,
      pm25: sample.pm2_5 ?? 0,
      rain: cls.kind === "rain" ? cls.intensity : 0,
      snow: cls.kind === "snow" ? cls.intensity : 0,
      storm: cls.kind === "storm" ? cls.intensity : 0,
      fog: cls.kind === "fog" ? cls.intensity : 0,
      haze: clamp(haze, 0, 1),
      score: raw.score ?? 5,
    };
    approachAll(target, dt);

    // Storms get rain too.
    const effectiveRain = clamp(smoothed.rain + smoothed.storm * 0.8, 0, 1);

    // Sunset / sunrise warmth strength — peaks around alt ≈ 0°, fades by ±8°.
    const sunsetMix = clamp(1 - Math.abs(smoothed.alt) / 8, 0, 1);
    // Score modulates the intensity of the sunset boost (great = saturated).
    const scoreBoost = clamp((smoothed.score - 4) / 5, 0, 1);

    // ---- Base sky gradient ----
    let palette = paletteForAltitude(smoothed.alt);

    // Sunset color boost: lower stops get pushed warmer/saturated when score is high.
    if (sunsetMix > 0.05) {
      const boost = sunsetMix * (0.4 + scoreBoost * 0.7);
      const warmA = [255, 110, 70];   // lower-mid push toward red-orange
      const warmB = [255, 190, 110];  // horizon push toward pink-gold
      palette = palette.map((c, i) => {
        if (i === 2) return lerpRgb(c, warmA, boost * 0.55);
        if (i === 3) return lerpRgb(c, warmA, boost * 0.7);
        if (i === 4) return lerpRgb(c, warmB, boost * 0.85);
        if (i === 1) return lerpRgb(c, [180, 110, 140], boost * 0.3);
        return c;
      });
    }

    // Overcast desaturation: heavy clouds drain warmth.
    const overcast = clamp((smoothed.low * 0.6 + smoothed.mid * 0.4) / 100, 0, 1);
    if (overcast > 0.1) {
      palette = palette.map((c) => {
        const grayMix = overcast * 0.55;
        const gray = (c[0] + c[1] + c[2]) / 3;
        return [
          lerp(c[0], gray * 0.9, grayMix),
          lerp(c[1], gray * 0.9, grayMix),
          lerp(c[2], gray * 0.95, grayMix),
        ];
      });
    }

    // Stormy / rainy darkening.
    const stormDark = clamp(smoothed.storm * 0.6 + effectiveRain * 0.35, 0, 0.7);
    if (stormDark > 0.02) {
      palette = palette.map((c) => [
        c[0] * (1 - stormDark * 0.5),
        c[1] * (1 - stormDark * 0.5),
        c[2] * (1 - stormDark * 0.45),
      ]);
    }

    // Haze / smoke: shift toward dusty orange-brown.
    if (smoothed.haze > 0.05) {
      const smoke = [200, 130, 90];
      palette = palette.map((c, i) => lerpRgb(c, smoke, smoothed.haze * (i >= 3 ? 0.55 : 0.3)));
    }

    // Lightning flash brightens everything briefly.
    if (flashStrength > 0.01) {
      palette = palette.map((c) => [
        clamp(c[0] + 220 * flashStrength, 0, 255),
        clamp(c[1] + 230 * flashStrength, 0, 255),
        clamp(c[2] + 255 * flashStrength, 0, 255),
      ]);
    }

    // Fill base gradient.
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    palette.forEach((c, i) => grad.addColorStop(i / (palette.length - 1), rgbToCss(c)));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // ---- Stars (when sun is below horizon, less if cloudy/hazy) ----
    if (smoothed.alt < -2) {
      const visibility = clamp((-smoothed.alt - 2) / 8, 0, 1)
        * (1 - overcast * 0.85)
        * (1 - smoothed.fog * 0.9)
        * (1 - smoothed.haze * 0.5)
        * (1 - effectiveRain * 0.7);
      if (visibility > 0.01) {
        ctx.save();
        for (const star of stars) {
          const flicker = 0.6 + 0.4 * Math.sin(timeAccum * star.twinkleSpeed + star.phase);
          const a = clamp(star.brightness * flicker * visibility, 0, 1);
          ctx.globalAlpha = a;
          ctx.fillStyle = "#f0f4ff";
          ctx.beginPath();
          ctx.arc(star.x * w, star.y * h, star.r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    // ---- Sun or moon disc ----
    drawCelestial(ctx, w, h, smoothed, sunsetMix, scoreBoost, overcast);

    // ---- Cloud layers driven by cloud_cover_high/mid/low ----
    cloudOffset += dt;
    const tint = cloudTints(palette, smoothed.alt, sunsetMix);

    // Convert percentage cover to (visible count, per-cloud opacity).
    const layerOpacity = (cover) => clamp(cover / 100, 0, 1);
    const layerCount = (cover, max) => Math.round(clamp(cover / 100, 0, 1) * max);

    const highCount = layerCount(smoothed.high, 14);
    const midCount = layerCount(smoothed.mid, 12);
    const lowCount = layerCount(smoothed.low + smoothed.storm * 80, 10);

    const drawList = [];
    let used = { high: 0, mid: 0, low: 0 };
    for (const c of clouds) {
      const cap = c.tier === "high" ? highCount : c.tier === "mid" ? midCount : lowCount;
      if (used[c.tier] >= cap) continue;
      used[c.tier]++;
      const drift = (cloudOffset * c.speed) % 1.4 - 0.2;
      const x = (c.x + drift) % 1.2 - 0.1;
      const opacity = c.tier === "high"
        ? layerOpacity(smoothed.high) * 0.85
        : c.tier === "mid"
          ? layerOpacity(smoothed.mid) * 0.95
          : Math.max(layerOpacity(smoothed.low), smoothed.storm * 0.95);
      drawList.push({ ...c, x, opacity });
    }
    // Back-to-front: high (deep) first, low (foreground) last.
    drawList.sort((a, b) => {
      const order = { high: 0, mid: 1, low: 2 };
      return order[a.tier] - order[b.tier];
    });
    for (const c of drawList) drawCloud(ctx, c, w, h, tint, c.opacity);

    // ---- Fog overlay ----
    if (smoothed.fog > 0.02) {
      const fogG = ctx.createLinearGradient(0, h * 0.2, 0, h);
      const fogColor = lerp(smoothed.alt, 0, 0.5) > 0 ? [230, 232, 234] : [120, 130, 140];
      const top = `rgba(${fogColor[0]},${fogColor[1]},${fogColor[2]},${0.15 * smoothed.fog})`;
      const bot = `rgba(${fogColor[0]},${fogColor[1]},${fogColor[2]},${0.85 * smoothed.fog})`;
      fogG.addColorStop(0, top);
      fogG.addColorStop(1, bot);
      ctx.fillStyle = fogG;
      ctx.fillRect(0, 0, w, h);
    }

    // ---- Rain ----
    if (effectiveRain > 0.02) {
      ctx.save();
      const len = 12 + effectiveRain * 18;
      ctx.strokeStyle = `rgba(190, 210, 230, ${0.35 + effectiveRain * 0.4})`;
      ctx.lineWidth = 1;
      const visibleCount = Math.floor(rainParticles.length * effectiveRain);
      for (let i = 0; i < visibleCount; i++) {
        const p = rainParticles[i];
        p.y += p.v * dt * (1.5 + effectiveRain);
        p.x += 0.04 * dt;
        if (p.y > 1.05) { p.y = -0.05; p.x = Math.random(); }
        if (p.x > 1.05) p.x = -0.05;
        const x = p.x * w;
        const y = p.y * h;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - len * 0.15, y - len);
        ctx.stroke();
      }
      ctx.restore();
    }

    // ---- Snow ----
    if (smoothed.snow > 0.02) {
      ctx.save();
      ctx.fillStyle = `rgba(245, 248, 255, ${0.55 + smoothed.snow * 0.4})`;
      const visibleCount = Math.floor(snowParticles.length * smoothed.snow);
      for (let i = 0; i < visibleCount; i++) {
        const p = snowParticles[i];
        p.y += p.v * dt * (0.6 + smoothed.snow * 0.4);
        p.x += Math.sin(timeAccum * 0.6 + p.phase) * 0.0008 + p.drift * dt;
        if (p.y > 1.05) { p.y = -0.05; p.x = Math.random(); }
        if (p.x > 1.05) p.x = -0.05;
        if (p.x < -0.05) p.x = 1.05;
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // ---- Lightning flash logic ----
    if (smoothed.storm > 0.1) {
      nextFlashAt -= dt;
      if (nextFlashAt <= 0) {
        flashStrength = 0.5 + Math.random() * 0.5;
        flashTimer = 0.12 + Math.random() * 0.15;
        nextFlashAt = 2 + Math.random() * 6 * (1 - smoothed.storm);
        // Draw a quick bolt streak.
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
      w / 2, h / 2, Math.min(w, h) * 0.32,
      w / 2, h / 2, Math.max(w, h) * 0.78,
    );
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, `rgba(0,0,0,${0.10 + stormDark * 0.25})`);
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);

    // ---- Tell the page whether to use light text (dark sky) ----
    // Average perceived brightness across the gradient.
    const avgLum = palette.reduce((acc, c) => acc + relLum(c), 0) / palette.length;
    const nightMode = avgLum < 90;
    if (document.body.dataset.night !== (nightMode ? "1" : "0")) {
      document.body.dataset.night = nightMode ? "1" : "0";
    }

    requestAnimationFrame(frame);
  }

  function drawCelestial(ctx, w, h, smoothed, sunsetMix, scoreBoost, overcast) {
    // Place the disc according to time-of-event horizontally (left for sunrise,
    // right for sunset), vertically by altitude.
    const alt = smoothed.alt;
    if (alt > 60 || alt < -20) return;

    // Visibility falls off with cloud cover (esp. high) and fog/rain.
    const visibility = clamp(
      (1 - smoothed.fog * 0.95)
      * (1 - clamp(smoothed.high / 130, 0, 1))
      * (1 - clamp(smoothed.mid / 220, 0, 1))
      * (1 - smoothed.storm * 0.7),
      0,
      1,
    );

    // Position: x based on mode (read from getState via closure not possible here, so we sample again)
    // Instead place horizontally by altitude: high alt = center, near horizon = right (sunset) or left (sunrise).
    // We can't read mode here without changing signature, so we use timeAccum hint stored on smoothed? Simpler:
    // place the disc near the right when descending (alt going negative), near the left when rising.
    // Heuristic: use velocity sign — but we don't store last alt. Accept: always slightly right for now.
    // Better: store mode via a hidden global. Pull from canvas dataset.
    const mode = canvas.dataset.mode || "sunset";
    const sideX = mode === "sunrise" ? 0.22 : 0.78;
    // Center near horizon, drift toward center high in sky.
    const altT = clamp(alt / 60, -0.3, 1);
    const x = lerp(sideX, 0.5, clamp(altT, 0, 1));
    const yT = 1 - clamp((alt + 8) / 50, 0, 1); // 0 at high noon, 1 at horizon
    const y = lerp(0.12, 0.82, yT);

    const radius = Math.min(w, h) * 0.06;

    if (alt > -3) {
      // Sun disc.
      const sunColor = sunsetMix > 0.2
        ? lerpRgb([255, 245, 220], [255, 130, 70], sunsetMix * (0.5 + scoreBoost * 0.5))
        : [255, 250, 230];
      // Glow halo
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const haloR = radius * (3 + sunsetMix * 2.5);
      const halo = ctx.createRadialGradient(x * w, y * h, radius * 0.4, x * w, y * h, haloR);
      halo.addColorStop(0, rgbToCss(sunColor, 0.55 * visibility));
      halo.addColorStop(0.4, rgbToCss(sunColor, 0.18 * visibility));
      halo.addColorStop(1, rgbToCss(sunColor, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(x * w, y * h, haloR, 0, Math.PI * 2);
      ctx.fill();

      // Disc itself
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = clamp(visibility * (0.85 + scoreBoost * 0.15), 0, 1);
      const disc = ctx.createRadialGradient(x * w, y * h, 0, x * w, y * h, radius);
      disc.addColorStop(0, rgbToCss([255, 252, 240], 1));
      disc.addColorStop(0.7, rgbToCss(sunColor, 1));
      disc.addColorStop(1, rgbToCss(sunColor, 0.4));
      ctx.fillStyle = disc;
      ctx.beginPath();
      ctx.arc(x * w, y * h, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (alt < -6) {
      // Moon — only show clearly when night is established.
      const nightDepth = clamp((-alt - 6) / 12, 0, 1);
      const moonVis = visibility * nightDepth;
      if (moonVis < 0.05) return;
      // Moon location independent of mode: float upper third.
      const mx = 0.72 * w;
      const my = 0.22 * h;
      const r = Math.min(w, h) * 0.045;
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
      // Subtle crater shading.
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
    const startX = w * (0.2 + Math.random() * 0.6);
    let x = startX;
    let y = 0;
    ctx.beginPath();
    ctx.moveTo(x, y);
    while (y < h * 0.55) {
      const dx = (Math.random() - 0.5) * 60;
      const dy = 20 + Math.random() * 40;
      x += dx;
      y += dy;
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
