import OpenSeadragon from 'openseadragon';
import { IMAGE_WIDTH, VIEWS } from './data.js';

export class RomeMap {
  constructor({ onReady, onError, onViewChange, reducedMotion }) {
    this.onReady = onReady;
    this.onError = onError;
    this.onViewChange = onViewChange;
    this.reducedMotion = reducedMotion;
    this.activeView = 'overview';
    this.pins = [];
    this.tileErrors = 0;
    this.ready = false;
    this.viewer = OpenSeadragon({
      element: document.getElementById('viewer'),
      tileSources: `${import.meta.env.BASE_URL}map/rome.dzi`,
      showNavigationControl: false,
      showZoomControl: false,
      showHomeControl: false,
      showFullPageControl: false,
      showRotationControl: false,
      animationTime: reducedMotion ? 0 : .75,
      springStiffness: 9,
      minZoomLevel: .62,
      maxZoomLevel: 7,
      maxZoomPixelRatio: 2.2,
      visibilityRatio: .55,
      constrainDuringPan: true,
      homeFillsViewer: true,
      preserveImageSizeOnResize: false,
      gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: true, scrollToZoom: true },
      gestureSettingsTouch: { clickToZoom: false, dblClickToZoom: true, pinchToZoom: true, flickEnabled: true },
      gestureSettingsPen: { clickToZoom: false, dblClickToZoom: true },
      gestureSettingsUnknown: { clickToZoom: false, dblClickToZoom: true, scrollToZoom: true },
    });
    this.viewer.addHandler('open', () => {
      this.ready = true;
      document.getElementById('viewer').classList.add('ready');
      document.getElementById('map-poster').classList.add('ready');
      this.setView('overview', true);
      this.updatePins();
      this.onReady();
    });
    this.viewer.addHandler('tile-load-failed', event => {
      this.tileErrors++;
      if (this.tileErrors === 1) this.onError('Una sezione della mappa non è stata caricata. Riprova tra poco.');
      console.warn('Tile non caricata', event?.tile?.url || 'URL sconosciuto');
    });
    this.viewer.addHandler('update-viewport', () => this.updatePins());
    this.viewer.addHandler('resize', () => this.updatePins());
  }

  addLandmarks(landmarks, onSelect) {
    const layer = document.getElementById('landmark-layer');
    landmarks.forEach((landmark, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'landmark-pin';
      button.dataset.landmark = landmark.id;
      button.setAttribute('aria-label', `Apri la scheda di ${landmark.name}`);
      button.innerHTML = `<span class="pin-number">${index + 1}</span><span class="pin-name">${landmark.name}</span>`;
      button.addEventListener('click', () => onSelect(landmark));
      layer.appendChild(button);
      this.pins.push({ landmark, element: button });
    });
  }

  project(x, y) {
    if (!this.ready) return { x: -1000, y: -1000 };
    const viewportPoint = this.viewer.viewport.imageToViewportCoordinates(x, y);
    const drawerPoint = this.viewer.viewport.viewportToViewerElementCoordinates(viewportPoint);
    return { x: drawerPoint.x, y: drawerPoint.y };
  }

  pixelsPerImagePixel() {
    if (!this.ready) return .4;
    const a = this.project(0, 0), b = this.project(1, 0);
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  updatePins() {
    if (!this.ready) return;
    const size = this.viewer.viewport.getContainerSize();
    for (const pin of this.pins) {
      const point = this.project(pin.landmark.x, pin.landmark.y);
      const visible = point.x > -50 && point.y > -50 && point.x < size.x + 50 && point.y < size.y + 50;
      pin.element.style.display = visible ? '' : 'none';
      if (visible) {
        pin.element.style.left = `${point.x}px`;
        pin.element.style.top = `${point.y - 8}px`;
        pin.element.style.opacity = this.pixelsPerImagePixel() < .25 ? '.82' : '1';
      }
    }
  }

  moveTo(target, immediate = false, viewName = null) {
    if (!this.ready) return;
    const center = this.viewer.viewport.imageToViewportCoordinates(target.x, target.y);
    const homeZoom = this.viewer.viewport.getHomeZoom();
    const zoom = homeZoom * IMAGE_WIDTH / target.width;
    const instantly = immediate || this.reducedMotion;
    this.viewer.viewport.zoomTo(zoom, undefined, instantly);
    this.viewer.viewport.panTo(center, instantly);
    if (viewName) {
      this.activeView = viewName;
      this.onViewChange(viewName);
    }
    this.viewer.viewport.applyConstraints(instantly);
    this.updatePins();
  }

  setView(name, immediate = false) {
    const view = VIEWS[name];
    if (view) this.moveTo(view, immediate, name);
  }

  focusLandmark(landmark) {
    this.moveTo({ x: landmark.x, y: landmark.y + 30, width: landmark.width }, false);
  }

  zoomBy(factor) {
    if (!this.ready) return;
    this.viewer.viewport.zoomTo(this.viewer.viewport.getZoom() * factor, undefined, this.reducedMotion);
    this.viewer.viewport.applyConstraints(this.reducedMotion);
  }

  async download() {
    if (!this.ready) throw new Error('La mappa non è ancora pronta');
    const base = this.viewer.drawer.canvas;
    const traffic = document.getElementById('traffic-canvas');
    const weather = document.getElementById('weather-canvas');
    const output = document.createElement('canvas');
    output.width = base.width;
    output.height = base.height;
    const ctx = output.getContext('2d');
    ctx.drawImage(base, 0, 0, output.width, output.height);
    if (document.getElementById('daylight').style.opacity !== '0') {
      ctx.fillStyle = `rgba(29, 46, 67, ${document.getElementById('daylight').style.opacity || 0})`;
      ctx.fillRect(0, 0, output.width, output.height);
    }
    ctx.drawImage(traffic, 0, 0, output.width, output.height);
    ctx.drawImage(weather, 0, 0, output.width, output.height);
    const scale = output.width / this.viewer.viewport.getContainerSize().x;
    ctx.fillStyle = 'rgba(246, 239, 222, .86)';
    ctx.fillRect(0, output.height - 30 * scale, output.width, 30 * scale);
    ctx.fillStyle = '#3c3125';
    ctx.font = `${11 * scale}px Manrope, sans-serif`;
    ctx.fillText('ROMA · illustrazione da dati aperti · © OpenStreetMap contributors · Meteo Open-Meteo', 14 * scale, output.height - 11 * scale);
    const blob = await new Promise(resolve => output.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Esportazione non riuscita');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'Roma-isometrica.png';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  getState() {
    return {
      ready: this.ready,
      activeView: this.activeView,
      zoom: this.ready ? this.viewer.viewport.getZoom(true) : 0,
      homeZoom: this.ready ? this.viewer.viewport.getHomeZoom() : 0,
      tileErrors: this.tileErrors,
      pins: this.pins.length,
    };
  }
}
