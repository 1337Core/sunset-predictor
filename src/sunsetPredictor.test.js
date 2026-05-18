import { describe, expect, test } from "bun:test";
import { scoreSunsetQuality } from "./sunsetPredictor.js";

describe("scoreSunsetQuality", () => {
  test("keeps an incoming solid deck low even when event-minute mid cloud looks favorable", () => {
    const rated = scoreSunsetQuality({
      temperature_2m: 13.1,
      dew_point_2m: 8.1,
      relative_humidity_2m: 71.6,
      cloud_cover: 64.3,
      cloud_cover_low: 0,
      cloud_cover_mid: 62.1,
      cloud_cover_high: 26.5,
      weather_code: 3,
      aerosol_optical_depth: 0.096,
      pm2_5: 8.4,
      dust: 0,
      civilTwilightMinutes: 35.1,
      cloud_cover_window_avg: 65.7,
      cloud_cover_window_max: 100,
      cloud_cover_critical_window_max: 100,
      cloud_cover_low_window_max: 0,
      cloud_cover_mid_window_avg: 63.7,
      cloud_cover_mid_window_max: 100,
      cloud_cover_high_window_avg: 27.2,
      cloud_cover_high_window_max: 41,
      relative_humidity_2m_window_avg: 71.8,
    });

    expect(rated.score).toBeLessThanOrEqual(3);
    expect(rated.contributions.overcastDeck).toBeLessThan(-2.5);
  });

  test("does not let aerosols turn a cloudless sky into a high score", () => {
    const rated = scoreSunsetQuality({
      temperature_2m: 27,
      dew_point_2m: 13,
      relative_humidity_2m: 42,
      cloud_cover: 0,
      cloud_cover_low: 0,
      cloud_cover_mid: 0,
      cloud_cover_high: 0,
      weather_code: 0,
      aerosol_optical_depth: 0.17,
      pm2_5: 18,
      dust: 2,
      civilTwilightMinutes: 31,
      cloud_cover_window_avg: 0,
      cloud_cover_window_max: 0,
      cloud_cover_critical_window_max: 0,
      cloud_cover_low_window_max: 0,
      cloud_cover_mid_window_avg: 0,
      cloud_cover_mid_window_max: 0,
      cloud_cover_high_window_avg: 0,
      cloud_cover_high_window_max: 0,
      relative_humidity_2m_window_avg: 42,
    });

    expect(rated.score).toBeLessThanOrEqual(4.2);
    expect(rated.contributions.aerosols).toBe(0);
  });

  test("penalizes a Portland grid cell where clouds build through twilight", () => {
    const rated = scoreSunsetQuality({
      temperature_2m: 13.1,
      dew_point_2m: 8.3,
      relative_humidity_2m: 72.9,
      cloud_cover: 36.9,
      cloud_cover_low: 0,
      cloud_cover_mid: 9.3,
      cloud_cover_high: 36.9,
      weather_code: 2,
      aerosol_optical_depth: 0.096,
      pm2_5: 8.4,
      dust: 0,
      civilTwilightMinutes: 35.2,
      cloud_cover_window_avg: 42.5,
      cloud_cover_window_max: 75,
      cloud_cover_critical_window_max: 75,
      cloud_cover_low_window_max: 0,
      cloud_cover_mid_window_avg: 18.9,
      cloud_cover_mid_window_max: 53.8,
      cloud_cover_high_window_avg: 38.2,
      cloud_cover_high_window_max: 57.2,
      relative_humidity_2m_window_avg: 73.3,
    });

    expect(rated.score).toBeLessThanOrEqual(4);
    expect(rated.contributions.cloudWall).toBeLessThan(-1);
  });

  test("still rewards balanced mid and high clouds with an open low horizon", () => {
    const rated = scoreSunsetQuality({
      temperature_2m: 18,
      dew_point_2m: 9,
      relative_humidity_2m: 52,
      cloud_cover: 55,
      cloud_cover_low: 4,
      cloud_cover_mid: 42,
      cloud_cover_high: 28,
      weather_code: 1,
      aerosol_optical_depth: 0.14,
      pm2_5: 8,
      dust: 0,
      civilTwilightMinutes: 32,
      cloud_cover_window_avg: 55,
      cloud_cover_window_max: 62,
      cloud_cover_critical_window_max: 62,
      cloud_cover_low_window_max: 6,
      cloud_cover_mid_window_avg: 42,
      cloud_cover_mid_window_max: 55,
      cloud_cover_high_window_avg: 28,
      cloud_cover_high_window_max: 36,
      relative_humidity_2m_window_avg: 52,
    });

    expect(rated.score).toBeGreaterThanOrEqual(7);
  });
});
