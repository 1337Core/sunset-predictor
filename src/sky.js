// Animated sky background: smooth gradient + soft drifting cloud blobs.
// The mood is driven by the predicted score and mode (sunrise/sunset).

import { clamp } from "./sunsetPredictor.js";

// Palette stops for the gradient at different score buckets.
// Each preset has [top, upper, mid, lower, bottom] color stops.
const SUNSET_PALETTES = {
  great: ["#3a4f7a", "#8a6f8d", "#df8d6b", "#f5b97a", "#ffd9a3"],
  good:  ["#5c6e8c", "#a08aa0", "#d7967b", "#e9b48b", "#f3cfa6"],
  ok:    ["#9aa4ae", "#b5b3b6", "#c8b4ad", "#d8c4b4", "#e2d2bf"],
  poor:  ["#aab0b5", "#b8bcc0", "#c2c4c5", "#cccccb", "#d6d4cf"],
};

const SUNRISE_PALETTES = {
  great: ["#26334a", "#5a4e7a", "#c47480", "#f0b7a3", "#ffe7c8"],
  good:  ["#3f4d6a", "#7c6c8c", "#c08c8c", "#e5b9a3", "#f2dabd"],
  ok:    ["#7e8896", "#a09ea4", "#b8a9a3", "#c9bcae", "#d8ccba"],
  poor:  ["#9aa0a6", "#aaaeb1", "#b8b8b6", "#c5c2bd", "#d0ccc4"],
};

function moodFromScore(score) {
  if (score == null) return "ok";
  if (score >= 7.5) return "great";
  if (score >= 6.0) return "good";
  if (score >= 4.0) return "ok";
  return "poor";
}

// Smoothly interpolate two 5-stop palettes.
function lerpColor(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ar = (pa >> 16) & 0xff, ag = (pa >> 8) & 0xff, ab = pa & 0xff;
  const br = (pb >> 16) & 0xff, bg = (pb >> 8) & 0xff, bb = pb & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const b2 = Math.round(ab + (bb - ab) * t);
  return `rgb(${r}, ${g}, ${b2})`;
}

function lerpPalette(a, b, t) {
  return a.map((c, i) => lerpColor(c, b[i], t));
}

// Generate a stable set of cloud blobs that will drift across the sky.
function generateClouds(seed = 1) {
  const clouds = [];
  let s = seed;
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };

  // 3 layers: high, mid, low. Each layer has different speed and y range.
  const layers = [
    { count: 4, yMin: 0.10, yMax: 0.30, speed: 0.006, scale: 1.3, alpha: 0.55 },
    { count: 5, yMin: 0.32, yMax: 0.55, speed: 0.010, scale: 1.6, alpha: 0.75 },
    { count: 4, yMin: 0.55, yMax: 0.80, speed: 0.014, scale: 1.9, alpha: 0.85 },
  ];

  layers.forEach((layer, li) => {
    for (let i = 0; i < layer.count; i++) {
      clouds.push({
        layer: li,
        x: rand(),                            // 0..1 of width
        y: layer.yMin + rand() * (layer.yMax - layer.yMin),
        scale: layer.scale * (0.7 + rand() * 0.7),
        speed: layer.speed * (0.7 + rand() * 0.6),
        alpha: layer.alpha * (0.55 + rand() * 0.5),
        puffs: 4 + Math.floor(rand() * 4),
        seed: rand() * 1000,
      });
    }
  });

  return clouds;
}

function drawCloud(ctx, cloud, w, h, tintRGB, opacity) {
  const cx = cloud.x * w;
  const cy = cloud.y * h;
  const baseR = Math.min(w, h) * 0.06 * cloud.scale;

  // Build a soft cloud out of overlapping radial gradients (no clipping needed
  // because the gradients fade to transparent edges).
  ctx.save();
  ctx.globalAlpha = clamp(cloud.alpha * opacity, 0, 1);
  ctx.globalCompositeOperation = "source-over";

  // Slight drop shadow for depth (darker tint underneath).
  for (let i = 0; i < cloud.puffs; i++) {
    const offsetX = (Math.sin(i * 1.7 + cloud.seed) * baseR * 1.6);
    const offsetY = (Math.cos(i * 2.3 + cloud.seed) * baseR * 0.5);
    const r = baseR * (0.7 + (i % 3) * 0.25);
    const g = ctx.createRadialGradient(
      cx + offsetX,
      cy + offsetY + r * 0.25,
      0,
      cx + offsetX,
      cy + offsetY + r * 0.25,
      r * 1.4,
    );
    g.addColorStop(0, `rgba(${tintRGB.shadow.join(",")}, 0.35)`);
    g.addColorStop(1, `rgba(${tintRGB.shadow.join(",")}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx + offsetX, cy + offsetY + r * 0.25, r * 1.4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Highlight puffs (white-ish).
  for (let i = 0; i < cloud.puffs; i++) {
    const offsetX = (Math.sin(i * 1.7 + cloud.seed) * baseR * 1.6);
    const offsetY = (Math.cos(i * 2.3 + cloud.seed) * baseR * 0.5);
    const r = baseR * (0.7 + (i % 3) * 0.25);
    const g = ctx.createRadialGradient(
      cx + offsetX,
      cy + offsetY,
      0,
      cx + offsetX,
      cy + offsetY,
      r * 1.1,
    );
    g.addColorStop(0, `rgba(${tintRGB.highlight.join(",")}, 0.95)`);
    g.addColorStop(0.55, `rgba(${tintRGB.highlight.join(",")}, 0.55)`);
    g.addColorStop(1, `rgba(${tintRGB.highlight.join(",")}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx + offsetX, cy + offsetY, r * 1.1, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function tintForMood(mood, mode) {
  // tint = { highlight: [r,g,b], shadow: [r,g,b] }
  if (mood === "great") {
    return mode === "sunrise"
      ? { highlight: [255, 226, 200], shadow: [120, 90, 100] }
      : { highlight: [255, 220, 180], shadow: [120, 80, 70] };
  }
  if (mood === "good") {
    return { highlight: [250, 232, 215], shadow: [110, 100, 105] };
  }
  if (mood === "ok") {
    return { highlight: [245, 244, 240], shadow: [130, 132, 134] };
  }
  return { highlight: [240, 240, 238], shadow: [150, 152, 154] };
}

export function createSky(canvas, getState) {
  const ctx = canvas.getContext("2d");
  const clouds = generateClouds(7);
  let lastTime = performance.now();
  let cloudOffset = 0;
  // Smooth transition state so palette changes don't snap.
  let renderedMood = null;
  let blend = 0;
  let prevPalette = null;
  let nextPalette = null;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { innerWidth: w, innerHeight: h } = window;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function paletteFor(state) {
    const set = state.mode === "sunrise" ? SUNRISE_PALETTES : SUNSET_PALETTES;
    return set[moodFromScore(state.score)];
  }

  function frame(now) {
    const dt = Math.min(100, now - lastTime) / 1000;
    lastTime = now;
    const state = getState();
    const w = window.innerWidth;
    const h = window.innerHeight;

    // Handle mood transitions.
    const currentMood = `${state.mode}-${moodFromScore(state.score)}`;
    if (currentMood !== renderedMood) {
      prevPalette = nextPalette || paletteFor(state);
      nextPalette = paletteFor(state);
      renderedMood = currentMood;
      blend = 0;
    }
    blend = Math.min(1, blend + dt * 0.6);
    const palette = lerpPalette(prevPalette || nextPalette, nextPalette, blend);

    // Draw sky gradient.
    const g = ctx.createLinearGradient(0, 0, 0, h);
    palette.forEach((c, i) => g.addColorStop(i / (palette.length - 1), c));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // Update cloud positions.
    cloudOffset += dt;

    const tint = tintForMood(moodFromScore(state.score), state.mode);

    // Draw clouds back to front.
    const sorted = [...clouds].sort((a, b) => a.layer - b.layer);
    sorted.forEach((c) => {
      const drift = (cloudOffset * c.speed) % 1.4 - 0.2;
      const draw = { ...c, x: (c.x + drift) % 1.2 - 0.1 };
      drawCloud(ctx, draw, w, h, tint, 1);
    });

    // Subtle vignette to focus eyes on the center.
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.10)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);

    requestAnimationFrame(frame);
  }

  window.addEventListener("resize", resize);
  resize();
  requestAnimationFrame((t) => {
    lastTime = t;
    frame(t);
  });
}
