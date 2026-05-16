import {
  Body,
  Observer,
  SearchAltitude,
  SearchRiseSet,
} from "astronomy-engine";

const WEATHER_HOURLY_FIELDS = [
  "temperature_2m",
  "dew_point_2m",
  "relative_humidity_2m",
  "cloud_cover",
  "cloud_cover_low",
  "cloud_cover_mid",
  "cloud_cover_high",
  "weather_code",
];

const AIR_HOURLY_FIELDS = [
  "aerosol_optical_depth",
  "pm2_5",
  "pm10",
  "dust",
  "us_aqi",
];

export const WEATHER_CODE_LABELS = new Map([
  [0, "Clear"],
  [1, "Mainly clear"],
  [2, "Partly cloudy"],
  [3, "Overcast"],
  [45, "Fog"],
  [48, "Depositing rime fog"],
  [51, "Light drizzle"],
  [53, "Moderate drizzle"],
  [55, "Dense drizzle"],
  [56, "Light freezing drizzle"],
  [57, "Dense freezing drizzle"],
  [61, "Slight rain"],
  [63, "Moderate rain"],
  [65, "Heavy rain"],
  [66, "Light freezing rain"],
  [67, "Heavy freezing rain"],
  [71, "Slight snow"],
  [73, "Moderate snow"],
  [75, "Heavy snow"],
  [77, "Snow grains"],
  [80, "Slight rain showers"],
  [81, "Moderate rain showers"],
  [82, "Violent rain showers"],
  [85, "Slight snow showers"],
  [86, "Heavy snow showers"],
  [95, "Thunderstorm"],
  [96, "Thunderstorm with hail"],
  [99, "Thunderstorm with heavy hail"],
]);

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function smoothstep(x, edge0, edge1) {
  if (x == null || Number.isNaN(x)) return 0;
  if (edge0 === edge1) return x >= edge1 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function trapezoidScore(x, a, b, c, d) {
  if (x == null || Number.isNaN(x)) return 0;
  if (x <= a || x >= d) return 0;
  if (x >= b && x <= c) return 1;
  if (x < b) return b === a ? 1 : (x - a) / (b - a);
  return d === c ? 1 : (d - x) / (d - c);
}

export function todayDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) {
    throw new Error(`Invalid date key: ${dateKey}`);
  }
  return { year, month, day };
}

function getZonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const mapped = {};
  for (const part of parts) {
    if (part.type !== "literal") mapped[part.type] = Number(part.value);
  }
  return mapped;
}

export function zonedDateTimeToDate(dateKey, timeZone, hour = 12) {
  const { year, month, day } = parseDateKey(dateKey);
  const intendedUtc = Date.UTC(year, month - 1, day, hour, 0, 0);
  let instant = new Date(intendedUtc);

  for (let i = 0; i < 3; i += 1) {
    const parts = getZonedParts(instant, timeZone);
    const actualUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const delta = actualUtc - intendedUtc;
    if (Math.abs(delta) < 1000) break;
    instant = new Date(instant.getTime() - delta);
  }

  return instant;
}

export function formatClock(date, timeZone, locale = "en-US") {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatDateTime(date, timeZone, locale = "en-US") {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function normalizeOpenMeteoTimes(response, dateKey) {
  const times = response?.hourly?.time ?? [];
  if (!times.length || !response.timezone) return times;

  const expectedFirst = Math.floor(
    zonedDateTimeToDate(dateKey, response.timezone, 0).getTime() / 1000,
  );
  const rawFirst = times[0];

  if (Math.abs(rawFirst - expectedFirst) <= 7200) return times;

  const offset = response.utc_offset_seconds ?? 0;
  const offsetAdjustedFirst = rawFirst - offset;

  if (Math.abs(offsetAdjustedFirst - expectedFirst) <= 7200) {
    return times.map((time) => time - offset);
  }

  return times;
}

export function interpolateSeries(times, values, targetUnix) {
  if (!Array.isArray(times) || !Array.isArray(values) || !times.length) {
    return null;
  }
  if (targetUnix <= times[0]) return values[0] ?? null;

  const last = times.length - 1;
  if (targetUnix >= times[last]) return values[last] ?? null;

  let highIndex = 1;
  while (highIndex < times.length && times[highIndex] < targetUnix) {
    highIndex += 1;
  }

  const lowIndex = highIndex - 1;
  const t0 = times[lowIndex];
  const t1 = times[highIndex];
  const v0 = values[lowIndex];
  const v1 = values[highIndex];

  if (v0 == null && v1 == null) return null;
  if (v0 == null) return v1;
  if (v1 == null) return v0;
  if (t1 === t0) return v0;

  return v0 + ((v1 - v0) * (targetUnix - t0)) / (t1 - t0);
}

function weatherSeverity(code) {
  if (code == null) return 0;
  if (code === 45 || code === 48) return 6;
  if (code >= 95) return 7;
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 5;
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return 4;
  if (code === 3) return 2;
  if (code === 1 || code === 2) return 1;
  return 0;
}

export function worstWeatherCodeNearTarget(
  times,
  codes,
  targetUnix,
  windowSec = 3600,
) {
  if (!Array.isArray(times) || !Array.isArray(codes) || !times.length) {
    return null;
  }

  let chosen = null;
  let bestSeverity = -1;
  let bestDistance = Infinity;

  for (let i = 0; i < times.length; i += 1) {
    const distance = Math.abs(times[i] - targetUnix);
    if (distance > windowSec) continue;

    const severity = weatherSeverity(codes[i]);
    if (
      severity > bestSeverity ||
      (severity === bestSeverity && distance < bestDistance)
    ) {
      chosen = codes[i];
      bestSeverity = severity;
      bestDistance = distance;
    }
  }

  if (chosen != null) return chosen;

  let nearestIndex = 0;
  let nearestDistance = Infinity;
  for (let i = 0; i < times.length; i += 1) {
    const distance = Math.abs(times[i] - targetUnix);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = i;
    }
  }
  return codes[nearestIndex] ?? null;
}

function weatherPenalty(code) {
  if (code == null) return 0;
  if (code === 45 || code === 48) return -4.2;
  if (code >= 95) return -4.5;
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return -3.6;
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return -2.4;
  if (code === 3) return -1.2;
  return 0;
}

export function calculateSunsetTimes({
  latitude,
  longitude,
  dateKey = todayDateKey(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  elevationMeters = 0,
  metersAboveGround = 0,
}) {
  const observer = new Observer(latitude, longitude, elevationMeters);
  const localNoon = zonedDateTimeToDate(dateKey, timeZone, 12);

  const sunsetAstro = SearchRiseSet(
    Body.Sun,
    observer,
    -1,
    localNoon,
    1,
    metersAboveGround,
  );

  if (!sunsetAstro) {
    return {
      status: "no-sunset",
      sunset: null,
      civilDusk: null,
      civilTwilightMinutes: null,
      message: "The Sun does not set on this date at this location.",
    };
  }

  const civilDuskAstro = SearchAltitude(
    Body.Sun,
    observer,
    -1,
    sunsetAstro.date,
    1,
    -6,
  );

  const sunset = sunsetAstro.date;
  const civilDusk = civilDuskAstro ? civilDuskAstro.date : null;

  return {
    status: "ok",
    sunset,
    civilDusk,
    civilTwilightMinutes: civilDusk
      ? (civilDusk.getTime() - sunset.getTime()) / 60000
      : null,
  };
}

export function calculateSunriseTimes({
  latitude,
  longitude,
  dateKey = todayDateKey(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  elevationMeters = 0,
  metersAboveGround = 0,
}) {
  const observer = new Observer(latitude, longitude, elevationMeters);
  // Start search a few hours before local midnight so we catch this calendar
  // day's sunrise even when it falls very early.
  const startInstant = new Date(
    zonedDateTimeToDate(dateKey, timeZone, 0).getTime() - 3 * 60 * 60 * 1000,
  );

  const sunriseAstro = SearchRiseSet(
    Body.Sun,
    observer,
    +1,
    startInstant,
    1,
    metersAboveGround,
  );

  if (!sunriseAstro) {
    return {
      status: "no-sunrise",
      sunrise: null,
      civilDawn: null,
      civilTwilightMinutes: null,
      message: "The Sun does not rise on this date at this location.",
    };
  }

  // Civil dawn = when sun was last at -6° before sunrise. Search backwards.
  const beforeSunrise = new Date(sunriseAstro.date.getTime() - 60 * 60 * 1000);
  const civilDawnAstro = SearchAltitude(
    Body.Sun,
    observer,
    +1,
    beforeSunrise,
    1,
    -6,
  );

  const sunrise = sunriseAstro.date;
  const civilDawn = civilDawnAstro ? civilDawnAstro.date : null;

  return {
    status: "ok",
    sunrise,
    civilDawn,
    civilTwilightMinutes: civilDawn
      ? (sunrise.getTime() - civilDawn.getTime()) / 60000
      : null,
  };
}

async function fetchJson(url, label) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} API failed with HTTP ${response.status}`);
  }
  return response.json();
}

export async function fetchWeatherDay(latitude, longitude, dateKey) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    start_date: dateKey,
    end_date: dateKey,
    timezone: "auto",
    timeformat: "unixtime",
    cell_selection: "land",
    hourly: WEATHER_HOURLY_FIELDS.join(","),
  });

  return fetchJson(
    `https://api.open-meteo.com/v1/forecast?${params.toString()}`,
    "Weather",
  );
}

export async function fetchAirDay(latitude, longitude, dateKey) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    start_date: dateKey,
    end_date: dateKey,
    timezone: "auto",
    timeformat: "unixtime",
    cell_selection: "land",
    hourly: AIR_HOURLY_FIELDS.join(","),
  });

  return fetchJson(
    `https://air-quality-api.open-meteo.com/v1/air-quality?${params.toString()}`,
    "Air quality",
  );
}

function contributionMessage(name, value, sample) {
  switch (name) {
    case "midClouds":
      return value >= 0
        ? "scattered mid-level clouds should catch warm light"
        : "mid-level cloud cover is outside the best range";
    case "highClouds":
      return value >= 0
        ? "thin high cloud should hold pink and purple afterglow"
        : "high cloud is not adding much color";
    case "lowCloudHorizon":
      return value >= 0
        ? "the low horizon looks relatively open"
        : "low cloud may block the horizon";
    case "aerosols":
      return value >= 0
        ? "moderate aerosols can deepen oranges and reds"
        : "heavy haze may mute contrast";
    case "humidity":
      return value >= 0
        ? "low boundary-layer humidity should keep colors crisp"
        : "high low-level humidity may wash out color";
    case "weather":
      if (sample.weather_code === 45 || sample.weather_code === 48) {
        return "fog near sunset is a strong negative";
      }
      if (sample.weather_code != null && sample.weather_code >= 95) {
        return "thunderstorms usually suppress sunset color";
      }
      return "precipitation near sunset is a strong negative";
    case "solarGeometry":
      return "the civil-twilight color window is long enough to help";
    case "magicGap":
      return "a possible clear strip under higher cloud could light up";
    case "marineLayer":
      return "a low marine-layer pattern may mute the show";
    case "smoke":
      return value >= 0
        ? "smoke may deepen reds"
        : "wildfire smoke may deepen reds but reduce clarity";
    case "dust":
      return "dust may warm the palette slightly";
    default:
      return "mixed atmospheric signals";
  }
}

function buildReason(contributions, sample, score) {
  const ranked = Object.entries(contributions)
    .filter(([, value]) => Math.abs(value) >= 0.35)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 2);

  if (!ranked.length) {
    if (score >= 7) return "Overall setup looks favorable for a colorful sunset.";
    if (score <= 3) return "Overall setup looks poor for sunset color.";
    return "Mixed signals suggest an average sunset.";
  }

  const parts = ranked.map(([name, value]) =>
    contributionMessage(name, value, sample),
  );
  const joiner =
    ranked.length === 2 && Math.sign(ranked[0][1]) === Math.sign(ranked[1][1])
      ? " and "
      : " but ";

  let ending = "expect an average sunset.";
  if (score >= 8) ending = "expect vivid color.";
  else if (score >= 6) ending = "expect a decent show.";
  else if (score <= 3) ending = "sunset likely muted.";

  return `${parts.join(joiner)} — ${ending}`;
}

export function scoreSunsetQuality(sample) {
  const contributions = {};

  const totalCloud = sample.cloud_cover ?? null;
  const mid = sample.cloud_cover_mid ?? null;
  const high = sample.cloud_cover_high ?? null;
  const low = sample.cloud_cover_low ?? null;
  const humidity = sample.relative_humidity_2m ?? null;
  const aod = sample.aerosol_optical_depth ?? null;

  contributions.midClouds = 2.8 * trapezoidScore(mid, 10, 25, 55, 80);

  contributions.highClouds = 1.3 * trapezoidScore(high, 2, 8, 28, 45);

  contributions.lowCloudHorizon =
    0.7 * (1 - smoothstep(low, 18, 45)) - 3.2 * smoothstep(low, 35, 85);

  contributions.aerosols =
    1.2 * trapezoidScore(aod, 0.05, 0.1, 0.25, 0.35) -
    1.6 * smoothstep(aod, 0.35, 0.75);

  contributions.humidity =
    0.6 * trapezoidScore(humidity, 15, 25, 55, 70) -
    1.6 * smoothstep(humidity, 75, 95);

  contributions.weather = weatherPenalty(sample.weather_code);

  contributions.solarGeometry =
    0.5 * trapezoidScore(sample.civilTwilightMinutes, 18, 24, 38, 60);

  const magicGapStrength =
    clamp(((totalCloud ?? 0) - 65) / 25, 0, 1) *
    clamp((35 - (low ?? 100)) / 20, 0, 1) *
    clamp((Math.max(mid ?? 0, high ?? 0) - 45) / 30, 0, 1) *
    (sample.weather_code === 45 ||
    sample.weather_code === 48 ||
    (sample.weather_code ?? 0) >= 51
      ? 0
      : 1);

  contributions.magicGap = 0.9 * magicGapStrength;

  const dewPointDepression =
    sample.temperature_2m != null && sample.dew_point_2m != null
      ? sample.temperature_2m - sample.dew_point_2m
      : null;

  const marineLayerLikely =
    (low ?? 0) >= 70 &&
    (mid ?? 100) <= 25 &&
    (high ?? 100) <= 25 &&
    (humidity ?? 0) >= 85 &&
    (dewPointDepression ?? 10) <= 2.5 &&
    [3, 45, 48].includes(sample.weather_code);

  if (marineLayerLikely) {
    const lowDrop =
      sample.cloud_cover_low_prev2h != null && low != null
        ? sample.cloud_cover_low_prev2h - low
        : 0;
    const clearingRelief = clamp(lowDrop / 40, 0, 1);
    contributions.marineLayer = -(2.2 - 1.2 * clearingRelief);
  } else {
    contributions.marineLayer = 0;
  }

  const smokeLikely =
    (aod ?? 0) >= 0.35 && (sample.pm2_5 ?? 0) >= 20 && (sample.dust ?? 0) < 20;

  if (smokeLikely) {
    contributions.smoke =
      0.6 * trapezoidScore(aod, 0.3, 0.38, 0.55, 0.8) -
      2.0 * smoothstep(sample.pm2_5 ?? 0, 20, 60);
  } else {
    contributions.smoke = 0;
  }

  if (!smokeLikely && (sample.dust ?? 0) >= 20 && (sample.pm2_5 ?? 0) < 20) {
    contributions.dust = 0.3 * trapezoidScore(sample.dust, 10, 20, 80, 150);
  } else {
    contributions.dust = 0;
  }

  let raw =
    3.6 + Object.values(contributions).reduce((sum, value) => sum + value, 0);

  raw = clamp(raw, 1, 10);

  if (sample.weather_code === 45 || sample.weather_code === 48) {
    raw = Math.min(raw, 2.0);
  } else if ((sample.weather_code ?? 0) >= 95) {
    raw = Math.min(raw, 1.5);
  } else if (
    ((sample.weather_code ?? 0) >= 51 && (sample.weather_code ?? 0) <= 67) ||
    ((sample.weather_code ?? 0) >= 80 && (sample.weather_code ?? 0) <= 82)
  ) {
    raw = Math.min(raw, 3.0);
  } else if (
    ((sample.weather_code ?? 0) >= 71 && (sample.weather_code ?? 0) <= 77) ||
    ((sample.weather_code ?? 0) >= 85 && (sample.weather_code ?? 0) <= 86)
  ) {
    raw = Math.min(raw, 4.0);
  } else if (sample.weather_code === 3 && magicGapStrength < 0.35) {
    raw = Math.min(raw, 6.0);
  }

  const score = Math.round(raw * 10) / 10;
  const reason = buildReason(contributions, sample, score);

  const topFactors = Object.entries(contributions)
    .filter(([, value]) => Math.abs(value) >= 0.35)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 2)
    .map(([name, value]) => ({
      factor: name,
      contribution: Math.round(value * 100) / 100,
      message: contributionMessage(name, value, sample),
    }));

  return {
    score,
    reason,
    topFactors,
    flags: {
      magicGapLikely: magicGapStrength >= 0.45,
      marineLayerLikely,
      smokeLikely,
    },
    contributions,
  };
}

export async function predictSky({
  latitude,
  longitude,
  dateKey = todayDateKey(),
  elevationMeters = null,
  metersAboveGround = 0,
  locale = "en-US",
  mode = "sunset",
}) {
  return mode === "sunrise"
    ? predictSunrise({ latitude, longitude, dateKey, elevationMeters, metersAboveGround, locale })
    : predictSunset({ latitude, longitude, dateKey, elevationMeters, metersAboveGround, locale });
}

export async function predictSunrise({
  latitude,
  longitude,
  dateKey = todayDateKey(),
  elevationMeters = null,
  metersAboveGround = 0,
  locale = "en-US",
}) {
  const [weather, air] = await Promise.all([
    fetchWeatherDay(latitude, longitude, dateKey),
    fetchAirDay(latitude, longitude, dateKey),
  ]);

  const timeZone =
    weather.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const observerElevation = elevationMeters ?? weather.elevation ?? 0;

  const sun = calculateSunriseTimes({
    latitude,
    longitude,
    dateKey,
    timeZone,
    elevationMeters: observerElevation,
    metersAboveGround,
  });

  if (sun.status !== "ok") {
    return {
      status: sun.status,
      mode: "sunrise",
      latitude,
      longitude,
      timeZone,
      eventTimeLocal: null,
      score: null,
      reason: sun.message,
    };
  }

  const sunriseUnix = Math.floor(sun.sunrise.getTime() / 1000);
  const weatherTimes = normalizeOpenMeteoTimes(weather, dateKey);
  const airTimes = normalizeOpenMeteoTimes(air, dateKey);

  const sample = {
    temperature_2m: interpolateSeries(weatherTimes, weather.hourly.temperature_2m, sunriseUnix),
    dew_point_2m: interpolateSeries(weatherTimes, weather.hourly.dew_point_2m, sunriseUnix),
    relative_humidity_2m: interpolateSeries(weatherTimes, weather.hourly.relative_humidity_2m, sunriseUnix),
    cloud_cover: interpolateSeries(weatherTimes, weather.hourly.cloud_cover, sunriseUnix),
    cloud_cover_low: interpolateSeries(weatherTimes, weather.hourly.cloud_cover_low, sunriseUnix),
    cloud_cover_mid: interpolateSeries(weatherTimes, weather.hourly.cloud_cover_mid, sunriseUnix),
    cloud_cover_high: interpolateSeries(weatherTimes, weather.hourly.cloud_cover_high, sunriseUnix),
    cloud_cover_low_prev2h: interpolateSeries(weatherTimes, weather.hourly.cloud_cover_low, sunriseUnix - 7200),
    weather_code: worstWeatherCodeNearTarget(weatherTimes, weather.hourly.weather_code, sunriseUnix, 3600),
    aerosol_optical_depth: interpolateSeries(airTimes, air.hourly.aerosol_optical_depth, sunriseUnix),
    pm2_5: interpolateSeries(airTimes, air.hourly.pm2_5, sunriseUnix),
    pm10: interpolateSeries(airTimes, air.hourly.pm10, sunriseUnix),
    dust: interpolateSeries(airTimes, air.hourly.dust, sunriseUnix),
    us_aqi: interpolateSeries(airTimes, air.hourly.us_aqi, sunriseUnix),
    civilTwilightMinutes: sun.civilTwilightMinutes,
  };

  const rated = scoreSunsetQuality(sample);

  return {
    status: "ok",
    mode: "sunrise",
    latitude,
    longitude,
    timeZone,
    timezoneAbbreviation: weather.timezone_abbreviation,
    elevationMeters: observerElevation,
    eventTimeUtc: sun.sunrise.toISOString(),
    eventTimeLocal: formatClock(sun.sunrise, timeZone, locale),
    eventDateTimeLocal: formatDateTime(sun.sunrise, timeZone, locale),
    sunriseTimeUtc: sun.sunrise.toISOString(),
    sunriseTimeLocal: formatClock(sun.sunrise, timeZone, locale),
    civilDawnUtc: sun.civilDawn ? sun.civilDawn.toISOString() : null,
    civilDawnLocal: sun.civilDawn ? formatClock(sun.civilDawn, timeZone, locale) : null,
    civilTwilightMinutes: sun.civilTwilightMinutes,
    score: rated.score,
    reason: rated.reason,
    topFactors: rated.topFactors,
    flags: rated.flags,
    weatherCodeLabel:
      WEATHER_CODE_LABELS.get(sample.weather_code) ?? `Code ${sample.weather_code}`,
    debugSample: sample,
    debugContributions: rated.contributions,
  };
}

export async function predictSunset({
  latitude,
  longitude,
  dateKey = todayDateKey(),
  elevationMeters = null,
  metersAboveGround = 0,
  locale = "en-US",
}) {
  const [weather, air] = await Promise.all([
    fetchWeatherDay(latitude, longitude, dateKey),
    fetchAirDay(latitude, longitude, dateKey),
  ]);

  const timeZone =
    weather.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const observerElevation = elevationMeters ?? weather.elevation ?? 0;

  const sun = calculateSunsetTimes({
    latitude,
    longitude,
    dateKey,
    timeZone,
    elevationMeters: observerElevation,
    metersAboveGround,
  });

  if (sun.status !== "ok") {
    return {
      status: sun.status,
      mode: "sunset",
      latitude,
      longitude,
      timeZone,
      sunsetTimeLocal: null,
      eventTimeLocal: null,
      score: null,
      reason: sun.message,
    };
  }

  const sunsetUnix = Math.floor(sun.sunset.getTime() / 1000);
  const weatherTimes = normalizeOpenMeteoTimes(weather, dateKey);
  const airTimes = normalizeOpenMeteoTimes(air, dateKey);

  const sample = {
    temperature_2m: interpolateSeries(
      weatherTimes,
      weather.hourly.temperature_2m,
      sunsetUnix,
    ),
    dew_point_2m: interpolateSeries(
      weatherTimes,
      weather.hourly.dew_point_2m,
      sunsetUnix,
    ),
    relative_humidity_2m: interpolateSeries(
      weatherTimes,
      weather.hourly.relative_humidity_2m,
      sunsetUnix,
    ),
    cloud_cover: interpolateSeries(
      weatherTimes,
      weather.hourly.cloud_cover,
      sunsetUnix,
    ),
    cloud_cover_low: interpolateSeries(
      weatherTimes,
      weather.hourly.cloud_cover_low,
      sunsetUnix,
    ),
    cloud_cover_mid: interpolateSeries(
      weatherTimes,
      weather.hourly.cloud_cover_mid,
      sunsetUnix,
    ),
    cloud_cover_high: interpolateSeries(
      weatherTimes,
      weather.hourly.cloud_cover_high,
      sunsetUnix,
    ),
    cloud_cover_low_prev2h: interpolateSeries(
      weatherTimes,
      weather.hourly.cloud_cover_low,
      sunsetUnix - 7200,
    ),
    weather_code: worstWeatherCodeNearTarget(
      weatherTimes,
      weather.hourly.weather_code,
      sunsetUnix,
      3600,
    ),
    aerosol_optical_depth: interpolateSeries(
      airTimes,
      air.hourly.aerosol_optical_depth,
      sunsetUnix,
    ),
    pm2_5: interpolateSeries(airTimes, air.hourly.pm2_5, sunsetUnix),
    pm10: interpolateSeries(airTimes, air.hourly.pm10, sunsetUnix),
    dust: interpolateSeries(airTimes, air.hourly.dust, sunsetUnix),
    us_aqi: interpolateSeries(airTimes, air.hourly.us_aqi, sunsetUnix),
    civilTwilightMinutes: sun.civilTwilightMinutes,
  };

  const rated = scoreSunsetQuality(sample);

  return {
    status: "ok",
    mode: "sunset",
    latitude,
    longitude,
    timeZone,
    timezoneAbbreviation: weather.timezone_abbreviation,
    elevationMeters: observerElevation,
    sunsetTimeUtc: sun.sunset.toISOString(),
    sunsetTimeLocal: formatClock(sun.sunset, timeZone, locale),
    sunsetDateTimeLocal: formatDateTime(sun.sunset, timeZone, locale),
    eventTimeUtc: sun.sunset.toISOString(),
    eventTimeLocal: formatClock(sun.sunset, timeZone, locale),
    eventDateTimeLocal: formatDateTime(sun.sunset, timeZone, locale),
    civilDuskUtc: sun.civilDusk ? sun.civilDusk.toISOString() : null,
    civilDuskLocal: sun.civilDusk ? formatClock(sun.civilDusk, timeZone, locale) : null,
    civilTwilightMinutes: sun.civilTwilightMinutes,
    score: rated.score,
    reason: rated.reason,
    topFactors: rated.topFactors,
    flags: rated.flags,
    weatherCodeLabel:
      WEATHER_CODE_LABELS.get(sample.weather_code) ?? `Code ${sample.weather_code}`,
    debugSample: sample,
    debugContributions: rated.contributions,
  };
}
