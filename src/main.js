import "./styles.css";
import {
  predictSky,
  todayDateKey,
  WEATHER_CODE_LABELS,
} from "./sunsetPredictor.js";
import { createSky } from "./sky.js";
import { releaseBirds } from "./birds.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const FALLBACK_LOCATION = {
  latitude: 34.0522,
  longitude: -118.2437,
  label: "Los Angeles",
};

// Preset locations available in the bottom-left location picker.
const PRESET_LOCATIONS = [
  { id: "nyc", label: "New York City", latitude: 40.7128, longitude: -74.0060 },
  { id: "sf",  label: "San Francisco", latitude: 37.7749, longitude: -122.4194 },
];

// Friendly phrasing per score band. Picked to feel human, not clinical.
const SUNSET_ADJECTIVES = [
  { min: 9.0, label: "the whole sky's gonna pop" },
  { min: 8.0, label: "this one'll be a stunner" },
  { min: 7.0, label: "looking pretty great" },
  { min: 6.0, label: "should be nice and warm" },
  { min: 5.0, label: "decent enough" },
  { min: 4.0, label: "we've seen better" },
  { min: 3.0, label: "kinda meh, honestly" },
  { min: 2.0, label: "rough out there" },
  { min: 0,   label: "maybe skip this one" },
];

const SUNRISE_ADJECTIVES = [
  { min: 9.0, label: "set an alarm, seriously" },
  { min: 8.0, label: "worth getting up early" },
  { min: 7.0, label: "should be a beauty" },
  { min: 6.0, label: "soft and warm out" },
  { min: 5.0, label: "perfectly fine morning" },
  { min: 4.0, label: "we've seen better" },
  { min: 3.0, label: "kinda flat today" },
  { min: 2.0, label: "rough morning sky" },
  { min: 0,   label: "stay in bed maybe" },
];

const NO_SUN_MESSAGES = {
  sunset: "the sun's playing hide and seek",
  sunrise: "no sunrise here today",
};

const ERROR_MESSAGES = {
  generic: "couldn't read the sky",
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  mode: "sunset",            // "sunset" | "sunrise"
  dateKey: todayDateKey(),
  location: { ...FALLBACK_LOCATION },
  locationSource: "default", // "default" | "browser" | "preset" | "manual"
  locationShort: "",         // short region label, e.g. "HI", "CA"
  showLocationPopup: false,
  prediction: null,
  loading: false,
  error: null,
  showDetails: false,
  detailsAnim: 0,
  now: new Date(),
};

// Latest in-flight prediction request id so stale responses can be ignored.
let requestSeq = 0;

// ---------------------------------------------------------------------------
// DOM scaffold
// ---------------------------------------------------------------------------

const app = document.querySelector("#app");

app.innerHTML = `
  <canvas id="sky-canvas" aria-hidden="true"></canvas>
  <div id="bird-stage" class="bird-stage" aria-hidden="true"></div>

  <div class="ui-layer">
    <header class="corner top-left" id="corner-date">
      <span class="mono" id="ui-date"></span>
    </header>

    <div class="corner top-center" role="tablist" aria-label="Sky event">
      <div class="pill-toggle" id="mode-toggle">
        <button class="pill-option" data-mode="sunrise" role="tab" aria-selected="false">sunrise</button>
        <button class="pill-option" data-mode="sunset" role="tab" aria-selected="true">sunset</button>
        <span class="pill-indicator" aria-hidden="true"></span>
      </div>
    </div>

    <header class="corner top-right" id="corner-time">
      <span class="mono" id="ui-clock"></span>
      <span class="mono dim" id="ui-countdown"></span>
    </header>

    <main class="hero" aria-live="polite">
      <h1 class="hero-score" id="hero-score">
        <span class="score-num">—</span><span class="score-denom">/10</span>
      </h1>
      <p class="hero-tag" id="hero-tag">checking the sky</p>
      <p class="hero-meta mono dim" id="hero-meta"></p>
    </main>

    <footer class="corner bottom-right" id="corner-hint">
      <p class="mono small dim">
        Navigate with arrow keys,<br/>
        Press <kbd>d</kbd> for details.
      </p>
    </footer>

    <section class="details-sheet" id="details-sheet" aria-hidden="true">
      <div class="details-inner">
        <header class="details-head">
          <p class="mono dim small details-eyebrow">forecast detail</p>
          <button class="details-close" id="details-close" aria-label="Close details">×</button>
        </header>

        <div class="details-title">
          <h2 id="details-title-event">sunset</h2>
          <span class="mono dim details-title-time" id="details-title-time"></span>
        </div>

        <p class="details-reason" id="details-reason"></p>

        <div class="details-rule"></div>

        <dl class="details-grid" id="details-grid"></dl>

        <div class="details-rule"></div>

        <p class="mono dim small details-section-label" id="details-factors-label">what's moving the score</p>
        <div class="details-factors" id="details-factors"></div>
      </div>
    </section>

    <div class="toast" id="toast" role="status" aria-live="polite"></div>
  </div>
`;

// ---------------------------------------------------------------------------
// Element handles
// ---------------------------------------------------------------------------

const skyCanvas = document.querySelector("#sky-canvas");
const birdStage = document.querySelector("#bird-stage");
const uiDate = document.querySelector("#ui-date");
const uiClock = document.querySelector("#ui-clock");
const uiCountdown = document.querySelector("#ui-countdown");
const heroScore = document.querySelector("#hero-score");
const heroTag = document.querySelector("#hero-tag");
const heroMeta = document.querySelector("#hero-meta");
const modeToggle = document.querySelector("#mode-toggle");
const pillIndicator = modeToggle.querySelector(".pill-indicator");
const pillOptions = modeToggle.querySelectorAll(".pill-option");
const detailsSheet = document.querySelector("#details-sheet");
const detailsClose = document.querySelector("#details-close");
const detailsTitleEvent = document.querySelector("#details-title-event");
const detailsTitleTime = document.querySelector("#details-title-time");
const detailsReason = document.querySelector("#details-reason");
const detailsGrid = document.querySelector("#details-grid");
const detailsFactors = document.querySelector("#details-factors");
const detailsFactorsLabel = document.querySelector("#details-factors-label");
const toastEl = document.querySelector("#toast");

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function adjective(score, mode) {
  if (score == null) return "—";
  const table = mode === "sunrise" ? SUNRISE_ADJECTIVES : SUNSET_ADJECTIVES;
  return table.find((row) => score >= row.min)?.label ?? "—";
}

function formatDateLong(dateKey) {
  // Avoid Date timezone surprises by parsing the components directly.
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatClock12(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function shiftDateKey(dateKey, days) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function pad(n) {
  return String(Math.max(0, Math.floor(n))).padStart(2, "0");
}

function formatCountdown(ms) {
  if (ms <= 0) return "now";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${pad(h % 24)}h`;
  }
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function showToast(message, ms = 2200) {
  toastEl.textContent = message;
  toastEl.classList.add("visible");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.remove("visible"), ms);
}

function moodFromScore(score) {
  if (score == null) return "ok";
  if (score >= 7.5) return "great";
  if (score >= 6.0) return "good";
  if (score >= 4.0) return "ok";
  return "poor";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderModeToggle() {
  pillOptions.forEach((btn) => {
    const active = btn.dataset.mode === state.mode;
    btn.setAttribute("aria-selected", active ? "true" : "false");
    btn.classList.toggle("active", active);
  });

  // Position the indicator pill behind the active option.
  const active = modeToggle.querySelector(".pill-option.active");
  if (active) {
    const rect = active.getBoundingClientRect();
    const parentRect = modeToggle.getBoundingClientRect();
    pillIndicator.style.width = `${rect.width}px`;
    pillIndicator.style.transform = `translateX(${rect.left - parentRect.left}px)`;
  }
}

function renderCorners() {
  uiDate.textContent = formatDateLong(state.dateKey);

  const timeZone = state.prediction?.timeZone
    || Intl.DateTimeFormat().resolvedOptions().timeZone;

  uiClock.textContent = state.prediction?.eventTimeLocal
    || (state.loading ? "—:—" : formatClock12(state.now, timeZone));

  // Countdown to the event. Only shows when the displayed date is today and
  // the event is still ahead — otherwise it would be meaningless or stale.
  if (state.prediction?.eventTimeUtc && state.dateKey === todayDateKey()) {
    const diff = new Date(state.prediction.eventTimeUtc).getTime() - state.now.getTime();
    if (diff > 0) {
      uiCountdown.textContent = formatCountdown(diff);
    } else {
      uiCountdown.textContent = "Passed";
    }
  } else if (state.prediction?.eventTimeLocal) {
    // Showing a non-today prediction — surface the event time itself.
    uiCountdown.textContent = state.prediction.eventTimeLocal;
  } else if (state.loading) {
    uiCountdown.textContent = "—:—:—";
  } else {
    uiCountdown.textContent = "";
  }
}

function renderHero() {
  if (state.loading && !state.prediction) {
    heroScore.innerHTML = `<span class="score-num pulse">—</span><span class="score-denom">/10</span>`;
    heroTag.textContent = `reading the ${state.mode} sky…`;
    heroMeta.textContent = "";
    document.body.dataset.mood = "ok";
    return;
  }

  if (state.error) {
    heroScore.innerHTML = `<span class="score-num">?</span><span class="score-denom">/10</span>`;
    heroTag.textContent = ERROR_MESSAGES.generic;
    heroMeta.textContent = state.error;
    document.body.dataset.mood = "poor";
    return;
  }

  const p = state.prediction;
  if (!p) {
    heroScore.innerHTML = `<span class="score-num">—</span><span class="score-denom">/10</span>`;
    heroTag.textContent = "loading";
    heroMeta.textContent = "";
    return;
  }

  if (p.status !== "ok" || p.score == null) {
    heroScore.innerHTML = `<span class="score-num">—</span><span class="score-denom">/10</span>`;
    heroTag.textContent = NO_SUN_MESSAGES[state.mode];
    heroMeta.textContent = p.reason ?? "";
    document.body.dataset.mood = "poor";
    return;
  }

  const score = p.score.toFixed(1);
  const numClass = state.loading ? "score-num pulse" : "score-num";
  heroScore.innerHTML = `<span class="${numClass}">${score}</span><span class="score-denom">/10</span>`;
  heroTag.textContent = adjective(p.score, state.mode);
  const place = state.locationSource === "browser" ? "" : ` · ${FALLBACK_LOCATION.label}`;
  heroMeta.textContent = `${state.mode} at ${p.eventTimeLocal}${place}`;
  document.body.dataset.mood = moodFromScore(p.score);
}

function renderDetails() {
  const p = state.prediction;
  detailsSheet.classList.toggle("open", state.showDetails);
  detailsSheet.setAttribute("aria-hidden", state.showDetails ? "false" : "true");

  const eventName = state.mode === "sunrise" ? "sunrise" : "sunset";
  detailsTitleEvent.textContent = eventName;

  if (!p || p.status !== "ok") {
    detailsGrid.innerHTML = "";
    detailsFactors.innerHTML = "";
    detailsFactorsLabel.style.display = "none";
    detailsReason.textContent = p?.reason || "no detail available";
    detailsTitleTime.textContent = "";
    return;
  }

  detailsTitleTime.textContent = p.eventTimeLocal ? p.eventTimeLocal.toLowerCase() : "";
  detailsReason.textContent = p.reason;
  detailsFactorsLabel.style.display = "";

  const sample = p.debugSample || {};
  const codeLabel = p.weatherCodeLabel ?? WEATHER_CODE_LABELS.get(sample.weather_code) ?? "—";

  const cells = [
    ["weather", String(codeLabel).toLowerCase()],
    ["mid cloud", fmtPct(sample.cloud_cover_mid)],
    ["low cloud", fmtPct(sample.cloud_cover_low)],
    ["high cloud", fmtPct(sample.cloud_cover_high)],
    ["aod", fmtNum(sample.aerosol_optical_depth, 2)],
    ["humidity", fmtPct(sample.relative_humidity_2m)],
    ["pm2.5", fmtNum(sample.pm2_5, 1)],
    ["twilight", fmtNum(p.civilTwilightMinutes, 0, " min")],
  ];

  detailsGrid.innerHTML = cells
    .map(
      ([k, v]) => `
        <div class="cell">
          <dt>${k}</dt>
          <dd>${v}</dd>
        </div>
      `,
    )
    .join("");

  const factors = (p.topFactors ?? []).filter((f) => Math.abs(f.contribution) >= 0.2);
  if (factors.length) {
    detailsFactors.innerHTML = factors
      .map(
        (f) => `
          <div class="factor">
            <span class="factor-label">${factorLabel(f.factor)}</span>
            <span class="factor-msg">${f.message}</span>
            <span class="factor-value ${f.contribution >= 0 ? "pos" : "neg"}">${f.contribution >= 0 ? "+" : ""}${f.contribution.toFixed(2)}</span>
          </div>
        `,
      )
      .join("");
  } else {
    detailsFactors.innerHTML = `
      <div class="factor">
        <span class="factor-label">factors</span>
        <span class="factor-msg">no single signal dominates</span>
        <span class="factor-value dim">·</span>
      </div>
    `;
  }
}

function factorLabel(factor) {
  return {
    midClouds: "mid cloud",
    highClouds: "high cloud",
    lowCloudHorizon: "low horizon",
    aerosols: "aerosols",
    humidity: "humidity",
    weather: "weather",
    solarGeometry: "twilight",
    magicGap: "magic gap",
    marineLayer: "marine layer",
    smoke: "smoke",
    dust: "dust",
  }[factor] ?? factor;
}

function fmtNum(value, digits = 0, suffix = "") {
  if (value == null || Number.isNaN(value)) return "—";
  return `${Number(value).toFixed(digits)}${suffix}`;
}

function fmtPct(value) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${Math.round(value)}%`;
}

function renderAll() {
  renderCorners();
  renderHero();
  renderModeToggle();
  renderDetails();
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function runPrediction({ silent = false } = {}) {
  const id = ++requestSeq;
  state.loading = true;
  state.error = null;
  if (!silent) renderAll();

  try {
    const prediction = await predictSky({
      latitude: state.location.latitude,
      longitude: state.location.longitude,
      dateKey: state.dateKey,
      mode: state.mode,
    });
    if (id !== requestSeq) return; // stale
    state.prediction = prediction;
  } catch (err) {
    if (id !== requestSeq) return;
    state.error = err instanceof Error ? err.message : String(err);
    state.prediction = null;
  } finally {
    if (id === requestSeq) {
      state.loading = false;
      renderAll();
    }
  }
}

function tryBrowserLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.location = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        label: "Current location",
      };
      state.locationSource = "browser";
      runPrediction({ silent: true });
    },
    () => {
      // Stay on fallback location, no toast — geolocation denial is fine.
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
  );
}

// ---------------------------------------------------------------------------
// Tick loop for clock + countdown
// ---------------------------------------------------------------------------

function tick() {
  state.now = new Date();
  renderCorners();
  requestAnimationFrame(() => setTimeout(tick, 1000));
}

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

function setMode(mode) {
  if (mode === state.mode) return;
  state.mode = mode;
  renderModeToggle();
  runPrediction();
}

function setDate(dateKey) {
  state.dateKey = dateKey;
  runPrediction();
}

modeToggle.addEventListener("click", (e) => {
  const target = e.target.closest(".pill-option");
  if (!target) return;
  setMode(target.dataset.mode);
});

detailsClose.addEventListener("click", () => {
  state.showDetails = false;
  renderDetails();
});

// Tap anywhere (that isn't an interactive control) to release birds.
document.addEventListener("click", (e) => {
  if (e.target.closest("button, a, .details-sheet, .pill-toggle")) return;
  releaseBirds(birdStage);
});

// Keyboard shortcuts.
window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key) {
    case "ArrowLeft":
      e.preventDefault();
      setDate(shiftDateKey(state.dateKey, -1));
      break;
    case "ArrowRight":
      e.preventDefault();
      setDate(shiftDateKey(state.dateKey, +1));
      break;
    case "ArrowUp":
    case "ArrowDown":
      e.preventDefault();
      setMode(state.mode === "sunset" ? "sunrise" : "sunset");
      break;
    case "d":
    case "D":
      state.showDetails = !state.showDetails;
      renderDetails();
      break;
    case "b":
    case "B":
      releaseBirds(birdStage);
      break;
    case "t":
    case "T":
      // Quick "today" reset.
      state.dateKey = todayDateKey();
      runPrediction();
      showToast("today");
      break;
    case "Escape":
      if (state.showDetails) {
        state.showDetails = false;
        renderDetails();
      }
      break;
  }
});

window.addEventListener("resize", () => renderModeToggle());

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

createSky(skyCanvas, () => ({
  mode: state.mode,
  score: state.prediction?.score ?? null,
  sample: state.prediction?.debugSample ?? null,
  weatherCode: state.prediction?.debugSample?.weather_code ?? null,
}));

renderAll();
tick();
runPrediction();
tryBrowserLocation();
