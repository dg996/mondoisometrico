const ENDPOINT = 'https://api.open-meteo.com/v1/forecast?latitude=41.9028&longitude=12.4964&current=temperature_2m,apparent_temperature,relative_humidity_2m,is_day,precipitation,rain,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m&timezone=Europe%2FRome';
const CACHE_KEY = 'roma-weather-v1';

export function describeWeather(code) {
  if (code === 0) return 'Sereno';
  if (code === 1) return 'Quasi sereno';
  if (code === 2) return 'Parzialmente nuvoloso';
  if (code === 3) return 'Coperto';
  if ([45, 48].includes(code)) return 'Nebbia';
  if ([51, 53, 55, 56, 57].includes(code)) return 'Pioggerella';
  if (code === 61) return 'Pioggia leggera';
  if (code === 63) return 'Pioggia';
  if (code === 65) return 'Pioggia intensa';
  if ([66, 67].includes(code)) return 'Pioggia gelata';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'Neve';
  if ([80, 81, 82].includes(code)) return 'Rovesci';
  if (code === 95) return 'Temporale';
  if ([96, 99].includes(code)) return 'Temporale con grandine';
  return 'Meteo variabile';
}

export function weatherIcon(code, isDay = 1) {
  const rainy = (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;
  const cloudy = code >= 2 || rainy;
  const sun = isDay
    ? '<circle cx="17" cy="8" r="4"/><path d="M17 1v2m0 10v2M10 8H8m15 0h2m-13-5 1.5 1.5M20.5 12.5 22 14M22 3l-1.5 1.5"/>'
    : '<path d="M19 3a7 7 0 0 0 3 12 8 8 0 1 1-3-12Z"/>';
  const cloud = '<path d="M7 18a4 4 0 1 1 1.2-7.8A5.5 5.5 0 0 1 19 13a3 3 0 0 1-1 5H8"/>';
  const rain = '<path d="m9 20-1 3m5-3-1 3m5-3-1 3"/>';
  const lightning = '<path d="m13 18-2 4h3l-1 3 5-6h-3l2-3"/>';
  return `<svg viewBox="0 0 28 28" aria-hidden="true">${cloudy ? sun : (isDay ? '<circle cx="14" cy="14" r="6"/><path d="M14 1v3m0 20v3M1 14h3m20 0h3M4.8 4.8 7 7m14 14 2.2 2.2m0-18.4L21 7M7 21l-2.2 2.2"/>' : sun)}${cloudy ? cloud : ''}${rainy ? (code >= 95 ? lightning : rain) : ''}</svg>`;
}

function validCurrent(current) {
  return current && Number.isFinite(current.temperature_2m) && Number.isFinite(current.weather_code) && Number.isFinite(current.cloud_cover);
}

export class WeatherService {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.current = null;
    this.timer = null;
    this.controller = null;
  }

  start() {
    const cached = this.readCache();
    if (cached) this.emit(cached, 'cached');
    this.refresh();
    this.timer = window.setInterval(() => this.refresh(), 10 * 60 * 1000);
  }

  readCache() {
    try {
      const value = JSON.parse(localStorage.getItem(CACHE_KEY));
      return validCurrent(value?.current) ? value : null;
    } catch { return null; }
  }

  async refresh() {
    this.controller?.abort();
    this.controller = new AbortController();
    const timeout = window.setTimeout(() => this.controller.abort(), 12000);
    try {
      const response = await fetch(ENDPOINT, { signal: this.controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`Meteo HTTP ${response.status}`);
      const data = await response.json();
      if (!validCurrent(data.current)) throw new Error('Formato meteo non valido');
      const value = { current: data.current, fetchedAt: new Date().toISOString() };
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(value)); } catch { /* storage opzionale */ }
      this.emit(value, 'live');
    } catch (error) {
      if (error.name !== 'AbortError' || !this.current) this.emit(this.readCache(), this.current ? 'cached' : 'error');
    } finally {
      window.clearTimeout(timeout);
    }
  }

  emit(value, status) {
    if (value?.current) this.current = value.current;
    this.onUpdate({ current: this.current, status, fetchedAt: value?.fetchedAt || null });
  }
}

export function startRomeClock(onTick) {
  const timeFormatter = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const dateFormatter = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', day: '2-digit', month: 'long', year: 'numeric' });
  const tick = () => {
    const now = new Date();
    onTick({ time: timeFormatter.format(now), date: dateFormatter.format(now), now });
  };
  tick();
  return window.setInterval(tick, 1000);
}
