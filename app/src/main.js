import { RomeMap } from './map.js';
import { TrafficSimulation } from './traffic.js';
import { Atmosphere } from './atmosphere.js';
import { WeatherService, startRomeClock, describeWeather, weatherIcon } from './weather.js';
import { LANDMARKS } from './data.js';

window.__SCENE_READY__ = false;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const traffic = new TrafficSimulation();
const trafficCanvas = document.getElementById('traffic-canvas');
const trafficContext = trafficCanvas.getContext('2d');
const atmosphere = new Atmosphere(document.getElementById('weather-canvas'), document.getElementById('daylight'), reducedMotion);
let paused = reducedMotion;
let speed = 1;
let activeLandmark = null;
let weatherStatus = 'loading';
let weatherFetchedAt = null;
let currentWeather = null;
let toastTimer = 0;
let frameEma = 16.7;
let previousFrame = performance.now();
let lastDynamicRender = 0;
let canvasWidth = 1;
let canvasHeight = 1;
let canvasDpr = 1;
let map;

function toast(message) {
  const element = document.getElementById('toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => element.classList.remove('show'), 2600);
}

function resizeCanvases() {
  const { width, height } = document.getElementById('map-stage').getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvasWidth = width;
  canvasHeight = height;
  canvasDpr = dpr;
  trafficCanvas.width = Math.round(width * dpr);
  trafficCanvas.height = Math.round(height * dpr);
  trafficCanvas.style.width = `${width}px`;
  trafficCanvas.style.height = `${height}px`;
  atmosphere.resize(width, height, dpr);
}

function updateViewButtons(name) {
  document.querySelectorAll('.district').forEach(button => {
    const active = button.dataset.view === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function showLandmark(landmark) {
  activeLandmark = landmark;
  document.getElementById('landmark-era').textContent = landmark.era;
  document.getElementById('landmark-name').textContent = landmark.name;
  document.getElementById('landmark-italian').textContent = landmark.italian;
  document.getElementById('landmark-description').textContent = landmark.description;
  document.getElementById('landmark-card').hidden = false;
}

function closeLandmark() {
  activeLandmark = null;
  document.getElementById('landmark-card').hidden = true;
}

function updatePlayback() {
  document.getElementById('pause-icon').hidden = paused;
  document.getElementById('play-icon').hidden = !paused;
  document.getElementById('play-button').setAttribute('aria-label', paused ? 'Riprendi il movimento della città' : 'Metti in pausa la città');
  document.getElementById('playback-title').textContent = paused ? 'Roma in pausa' : 'Roma si muove';
  document.getElementById('simulation-state').textContent = paused ? 'IN PAUSA' : 'IN MOVIMENTO';
  document.getElementById('speed-button').textContent = `${speed}×`;
}

function setLayer(button, forcedValue = null) {
  const pressed = forcedValue === null ? button.getAttribute('aria-pressed') !== 'true' : forcedValue;
  button.setAttribute('aria-pressed', String(pressed));
  const layer = button.dataset.layer;
  if (layer === 'traffic' || layer === 'transit') traffic.layers[layer] = pressed;
  if (layer === 'weather') atmosphere.enabled = pressed;
  if (layer === 'labels') document.getElementById('landmark-layer').hidden = !pressed;
}

function setWeatherUI({ current, status, fetchedAt }) {
  weatherStatus = status;
  weatherFetchedAt = fetchedAt || weatherFetchedAt;
  currentWeather = current;
  atmosphere.setWeather(current);
  const dot = document.getElementById('live-dot');
  dot.className = `live-dot ${status === 'live' ? '' : status === 'loading' ? 'loading' : 'error'}`;
  if (!current) {
    document.getElementById('temperature').textContent = '—°';
    document.getElementById('weather-label').textContent = 'Meteo non disponibile';
    document.getElementById('weather-summary').textContent = 'Meteo non raggiungibile';
    document.getElementById('weather-status').textContent = 'OFFLINE';
    document.getElementById('weather-updated').textContent = 'Controlla la connessione. Riproverò automaticamente tra dieci minuti.';
    document.getElementById('weather-icon').innerHTML = weatherIcon(3, 1);
    return;
  }
  const label = describeWeather(current.weather_code);
  document.getElementById('temperature').textContent = `${Math.round(current.temperature_2m)}°`;
  document.getElementById('weather-label').textContent = label;
  document.getElementById('weather-summary').textContent = `${label} a Roma`;
  document.getElementById('weather-status').textContent = status === 'live' ? 'LIVE' : 'ULTIMO DATO';
  document.getElementById('weather-icon').innerHTML = weatherIcon(current.weather_code, current.is_day);
  document.getElementById('feels-like').textContent = `${current.apparent_temperature.toFixed(1)} °C`;
  document.getElementById('humidity').textContent = `${Math.round(current.relative_humidity_2m)}%`;
  document.getElementById('wind').textContent = `${Math.round(current.wind_speed_10m)} km/h · ${Math.round(current.wind_direction_10m)}°`;
  document.getElementById('cloud-cover').textContent = `${Math.round(current.cloud_cover)}%`;
  if (weatherFetchedAt) {
    const updated = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(weatherFetchedAt));
    document.getElementById('weather-updated').textContent = `${status === 'live' ? 'Dato aggiornato' : 'Ultimo dato disponibile'}: ${updated}, ora di Roma. Rilevazione meteo: ${current.time}.`;
  }
}

function bindUI() {
  document.querySelectorAll('.district').forEach(button => button.addEventListener('click', () => map.setView(button.dataset.view)));
  document.querySelectorAll('.layer-toggle').forEach(button => button.addEventListener('click', () => setLayer(button)));
  document.getElementById('play-button').addEventListener('click', () => { paused = !paused; updatePlayback(); });
  document.getElementById('speed-button').addEventListener('click', () => {
    speed = speed === 1 ? 2 : speed === 2 ? 4 : 1;
    updatePlayback();
    toast(`Velocità della simulazione: ${speed}×`);
  });
  document.getElementById('zoom-in').addEventListener('click', () => map.zoomBy(1.55));
  document.getElementById('zoom-out').addEventListener('click', () => map.zoomBy(1 / 1.55));
  document.getElementById('home-view').addEventListener('click', () => map.setView('overview'));
  document.getElementById('close-landmark').addEventListener('click', closeLandmark);
  document.getElementById('focus-landmark').addEventListener('click', () => { if (activeLandmark) map.focusLandmark(activeLandmark); });

  const weatherButton = document.getElementById('weather-button');
  const weatherDetails = document.getElementById('weather-details');
  const closeWeather = () => { weatherDetails.hidden = true; weatherButton.setAttribute('aria-expanded', 'false'); };
  weatherButton.addEventListener('click', () => {
    const open = weatherDetails.hidden;
    weatherDetails.hidden = !open;
    weatherButton.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('pointerdown', event => {
    if (!weatherDetails.hidden && !weatherDetails.contains(event.target) && !weatherButton.contains(event.target)) closeWeather();
  });

  const dialog = document.getElementById('data-dialog');
  document.getElementById('data-button').addEventListener('click', () => dialog.showModal());
  document.getElementById('close-data').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  document.getElementById('open-traffic-info').addEventListener('click', () => {
    dialog.close();
    document.querySelectorAll('.layer-toggle').forEach(button => {
      if (['traffic', 'transit'].includes(button.dataset.layer)) setLayer(button, true);
    });
    map.setView('ancient');
    toast('Traffico e trasporto pubblico sono visibili');
  });
  document.getElementById('capture-button').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await map.download(); toast('Vista di Roma scaricata in PNG'); }
    catch (error) { toast(error.message || 'Non è stato possibile esportare la vista'); }
    finally { button.disabled = false; }
  });
  document.getElementById('fullscreen-button').addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch { toast('Lo schermo intero non è disponibile in questo browser'); }
  });
  document.addEventListener('fullscreenchange', () => {
    document.getElementById('fullscreen-button').setAttribute('aria-label', document.fullscreenElement ? 'Esci dallo schermo intero' : 'Attiva schermo intero');
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { closeWeather(); closeLandmark(); }
    if (dialog.open || /INPUT|TEXTAREA|BUTTON|A/.test(document.activeElement?.tagName)) return;
    if (event.key === '0') map.setView('overview');
    if (event.key.toLowerCase() === 't') setLayer(document.querySelector('[data-layer="traffic"]'));
    if (event.key.toLowerCase() === 'm') setLayer(document.querySelector('[data-layer="weather"]'));
    if (event.key.toLowerCase() === 'l') setLayer(document.querySelector('[data-layer="labels"]'));
    if (event.code === 'Space') { event.preventDefault(); paused = !paused; updatePlayback(); }
  });
}

function frame(now) {
  const delta = Math.min((now - previousFrame) / 1000, .06);
  frameEma = frameEma * .95 + Math.min(now - previousFrame, 100) * .05;
  previousFrame = now;
  const dynamicFrame = !map?.ready || now - lastDynamicRender >= 31.5;
  if (dynamicFrame) {
    lastDynamicRender = now;
    if (!paused) traffic.update(delta, speed);
    if (map?.ready) {
      trafficContext.setTransform(canvasDpr, 0, 0, canvasDpr, 0, 0);
      trafficContext.clearRect(0, 0, canvasWidth, canvasHeight);
      traffic.draw(trafficContext, (x, y) => map.project(x, y), map.pixelsPerImagePixel(), canvasWidth, canvasHeight);
    }
    atmosphere.render(now / 1000);
  }
  requestAnimationFrame(frame);
}

async function init() {
  document.getElementById('loading-progress').style.width = '28%';
  map = new RomeMap({
    reducedMotion,
    onReady: () => {
      document.getElementById('loading-progress').style.width = '100%';
      document.getElementById('loading-status').textContent = 'Roma è pronta';
      window.setTimeout(() => document.getElementById('loading').classList.add('done'), 220);
      window.__SCENE_READY__ = true;
    },
    onError: toast,
    onViewChange: updateViewButtons,
  });
  map.addLandmarks(LANDMARKS, showLandmark);
  bindUI();
  updatePlayback();
  resizeCanvases();
  new ResizeObserver(resizeCanvases).observe(document.getElementById('map-stage'));
  startRomeClock(({ time, date, now }) => {
    const clock = document.getElementById('rome-clock');
    clock.textContent = time;
    clock.dateTime = now.toISOString();
    document.getElementById('rome-date').textContent = date;
  });
  new WeatherService(setWeatherUI).start();
  requestAnimationFrame(frame);
  window.__ROME__ = {
    getState: () => ({
      ready: window.__SCENE_READY__,
      paused, speed, weatherStatus, weather: currentWeather, weatherFetchedAt,
      clock: document.getElementById('rome-clock').textContent,
      map: map.getState(), traffic: traffic.getState(),
      atmosphere: { enabled: atmosphere.enabled, nightOpacity: document.getElementById('daylight').style.opacity },
      render: { frameEma, trafficCanvas: [trafficCanvas.width, trafficCanvas.height] },
    }),
    setView: name => map.setView(name, true),
    showLandmark: id => { const landmark = LANDMARKS.find(item => item.id === id); if (landmark) showLandmark(landmark); },
  };
  window.setTimeout(() => {
    if (!map.ready) {
      document.getElementById('loading').classList.add('done');
      document.getElementById('map-poster').classList.remove('ready');
      toast('La mappa dettagliata non risponde: resta disponibile l’anteprima.');
    }
  }, 20000);
}

init().catch(error => {
  console.error(error);
  document.getElementById('loading').classList.add('done');
  toast('Roma non è stata caricata correttamente. Ricarica la pagina.');
});
