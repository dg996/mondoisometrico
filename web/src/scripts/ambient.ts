/**
 * Ambient light and weather over the painted map, without repainting a tile:
 *  - day cycle: the real sun elevation over Rome, now, drives a light grade (night, blue hour, golden
 *    hour, day) laid over the tiles; visitors cannot change the time
 *  - live weather: current conditions over Rome from Open-Meteo (CC BY 4.0, free for non-commercial
 *    use, cached 15 min): overcast greys the light, rain and drizzle draw falling streaks, fog a veil
 * Film captures (pipeline/src/film.ts sets window.__film) stay neutral daylight: clips are deterministic.
 * Local development only (astro dev): ?ora=21:30 and ?meteo=pioggia|nuvoloso|nebbia|sereno override the
 * live values for testing; the published site ignores them.
 */

export interface Weather { code: number; cloud: number; rain: number; temp: number; wind: number; at: number }

const LAT = 41.8955, LON = 12.4823;
const CACHE_KEY = "mi-weather-v1", CACHE_MS = 15 * 60_000;
const API = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,weather_code,cloud_cover,precipitation,wind_speed_10m&timezone=Europe%2FRome`;

/** WMO weather code -> Italian label. */
export function weatherLabel(code: number): string {
  if (code === 0) return "sereno";
  if (code <= 2) return "poco nuvoloso";
  if (code === 3) return "coperto";
  if (code === 45 || code === 48) return "nebbia";
  if (code >= 51 && code <= 57) return "pioggerella";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "pioggia";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "neve";
  if (code >= 95) return "temporale";
  return "variabile";
}

const PRESETS: Record<string, Weather> = {
  sereno: { code: 0, cloud: 5, rain: 0, temp: 22, wind: 6, at: 0 },
  nuvoloso: { code: 3, cloud: 95, rain: 0, temp: 14, wind: 10, at: 0 },
  pioggia: { code: 63, cloud: 100, rain: 3, temp: 12, wind: 18, at: 0 },
  nebbia: { code: 45, cloud: 100, rain: 0, temp: 8, wind: 2, at: 0 },
};

/** Test overrides (?ora, ?meteo) work only on the dev server, never on the published map. */
const testParam = (name: string) => ((import.meta as { env?: { DEV?: boolean } }).env?.DEV ? new URLSearchParams(location.search).get(name) : null);

export async function fetchWeather(): Promise<Weather | null> {
  const q = testParam("meteo");
  if (q && PRESETS[q]) return { ...PRESETS[q], at: Date.now() };
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as Weather | null;
    if (cached && Date.now() - cached.at < CACHE_MS) return cached;
  } catch { /* storage blocked: fetch */ }
  try {
    const r = await fetch(API);
    if (!r.ok) return null;
    const c = (await r.json()).current;
    const w: Weather = { code: c.weather_code, cloud: c.cloud_cover, rain: c.precipitation, temp: c.temperature_2m, wind: c.wind_speed_10m, at: Date.now() };
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(w)); } catch { /* ignore */ }
    return w;
  } catch { return null; }
}

/** Sun elevation (degrees) over Rome at a given UTC time (NOAA approximation, ~0.5° accurate). */
export function sunElevation(date: Date, lat = LAT, lon = LON): number {
  const rad = Math.PI / 180, day = (date.getTime() / 86400000) + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * day) * rad, q = 280.459 + 0.98564736 * day;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad, e = (23.439 - 0.00000036 * day) * rad;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const gmst = (18.697374558 + 24.06570982441908 * day) % 24;
  const ha = ((gmst * 15 + lon) * rad - ra);
  return Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha)) / rad;
}

/** Light grade for a sun elevation and cloud cover: a multiply tint and a soft warm/cool wash. */
export function grade(elev: number, cloud: number) {
  const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.min(1, Math.max(0, t));
  // night (< -8°) deep blue multiply; blue hour (-8..0) lighter; golden hour (0..12) warm; day neutral
  let mult: [number, number, number] = [255, 255, 255], wash: [number, number, number, number] = [0, 0, 0, 0];
  if (elev < -8) mult = [104, 116, 162];
  else if (elev < 0) { const t = (elev + 8) / 8; mult = [lerp(104, 210, t), lerp(116, 200, t), lerp(162, 218, t)]; wash = [90, 110, 190, lerp(0.10, 0.06, t)]; }
  else if (elev < 12) { const t = elev / 12; mult = [255, lerp(214, 252, t), lerp(170, 245, t)]; wash = [255, 170, 90, lerp(0.16, 0, t)]; }
  // overcast: flatter, greyer light (never as dark as night)
  const c = Math.min(1, Math.max(0, (cloud - 40) / 60)) * (elev > -4 ? 1 : 0.3);
  mult = mult.map((v) => lerp(v, v * 0.86 + 20, c)) as [number, number, number];
  return { mult, wash, desat: c * 0.35 };
}

export interface Ambient {
  /** draw rain / fog on the overlay canvas for this frame */
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, dt: number): void;
  /** Rome's clock (minutes since midnight): transit runs by it */
  minutes(): number;
}

/**
 * Panel (#ambient: Rome's clock and weather, read only) + tint layer (#ambient-tint). The time is always
 * Rome's real time; the light follows it minute by minute.
 */
export function startAmbient(): Ambient {
  const film = () => Boolean((window as { __film?: unknown }).__film);
  const tint = document.getElementById("ambient-tint") as HTMLDivElement;
  const wash = document.getElementById("ambient-wash") as HTMLDivElement;
  const clock = document.getElementById("ambient-clock")!;
  const meteo = document.getElementById("ambient-weather")!;
  const map = document.getElementById("map")!;

  const fixed = testParam("ora")?.match(/^(\d{1,2}):(\d{2})$/);
  const minutes: number | null = fixed ? Number(fixed[1]) * 60 + Number(fixed[2]) : null; // null = live
  let weather: Weather | null = null;

  const romeNow = () => {
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
    return Number(p.find((x) => x.type === "hour")!.value) * 60 + Number(p.find((x) => x.type === "minute")!.value);
  };
  /** the instant whose Rome wall-clock time is `m` minutes today (for the sun position) */
  const dateAt = (m: number) => new Date(Date.now() + (m - romeNow()) * 60_000);
  const show = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(Math.floor(m % 60)).padStart(2, "0")}`;

  const apply = () => {
    const m = minutes ?? romeNow();
    clock.textContent = show(m);
    if (film()) { tint.style.opacity = "0"; wash.style.opacity = "0"; map.style.filter = ""; return; }
    const g = grade(sunElevation(dateAt(m)), weather?.cloud ?? 0);
    tint.style.backgroundColor = `rgb(${g.mult.map(Math.round).join(",")})`;
    tint.style.opacity = "1";
    wash.style.backgroundColor = `rgba(${g.wash.slice(0, 3).map(Math.round).join(",")},${g.wash[3].toFixed(3)})`;
    wash.style.opacity = "1";
    map.style.filter = g.desat > 0.01 ? `saturate(${(1 - g.desat).toFixed(2)})` : "";
  };
  setInterval(apply, 20_000);

  const refresh = async () => {
    weather = await fetchWeather();
    meteo.textContent = weather ? `${Math.round(weather.temp)}° · ${weatherLabel(weather.code)}` : "meteo non disponibile";
    apply();
  };
  refresh();
  setInterval(refresh, CACHE_MS);
  apply();

  // rain streaks and fog veil (screen space, deterministic per frame)
  const drops: Array<[number, number, number]> = [];
  let fog = 0;
  return {
    minutes: () => minutes ?? romeNow(),
    draw(ctx, w, h, dt) {
      if (film() || !weather) return;
      // rain stays a light veil of streaks: streets, cars and monuments must read through it at any zoom
      const rainy = weather.rain > 0.05 || (weather.code >= 51 && weather.code <= 67) || (weather.code >= 80 && weather.code <= 99);
      const want = rainy ? Math.min(420, 110 + weather.rain * 70) * (w * h) / (1600 * 900) : 0;
      while (drops.length < want) drops.push([Math.random() * w, Math.random() * h, 0.6 + Math.random() * 0.8]);
      drops.length = Math.min(drops.length, Math.ceil(want));
      if (drops.length) {
        const slant = Math.min(0.5, weather.wind / 60), fall = 900 * dt;
        ctx.save();
        ctx.strokeStyle = "rgba(228,235,244,0.32)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const d of drops) {
          d[1] += fall * d[2]; d[0] += fall * d[2] * slant;
          if (d[1] > h) { d[1] -= h + 20; d[0] = Math.random() * w; }
          if (d[0] > w) d[0] -= w;
          ctx.moveTo(d[0], d[1]); ctx.lineTo(d[0] - 14 * d[2] * slant, d[1] - 14 * d[2]);
        }
        ctx.stroke();
        ctx.restore();
      }
      const foggy = weather.code === 45 || weather.code === 48;
      fog += ((foggy ? 0.18 : 0) - fog) * Math.min(1, dt);
      if (fog > 0.01) { ctx.fillStyle = `rgba(236,236,234,${fog.toFixed(3)})`; ctx.fillRect(0, 0, w, h); }
    },
  };
}
