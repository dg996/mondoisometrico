function mulberry32(seed) {
  return function random() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export class Atmosphere {
  constructor(canvas, daylight, reducedMotion = false) {
    this.canvas = canvas;
    this.daylight = daylight;
    this.ctx = canvas.getContext('2d');
    this.reducedMotion = reducedMotion;
    this.enabled = true;
    this.weather = null;
    this.cloudSprites = new Map();
    this.sunSprite = null;
    this.lastOpacity = '';
    this.pixelRatio = 1;
    this.hasDrawn = false;
    const rand = mulberry32(41012);
    this.drops = Array.from({ length: 220 }, () => {
      const alpha = .16 + rand() * .34;
      return {
        x: rand(), y: rand(), speed: 430 + rand() * 410, length: 11 + rand() * 18,
        alpha, bucket: Math.min(3, Math.floor((alpha - .16) / .34 * 4)),
      };
    });
    this.clouds = Array.from({ length: 8 }, (_, i) => ({ id: i, x: rand(), y: .02 + rand() * .38, size: 150 + rand() * 260, speed: 3 + rand() * 7, alpha: .08 + rand() * .14, phase: i * .7 }));
    this.width = 1;
    this.height = 1;
  }

  resize(width, height, dpr) {
    this.width = width;
    this.height = height;
    // Soft atmospheric gradients do not need a full-resolution backing store.
    // CSS upscaling preserves their appearance while substantially reducing fill cost.
    const resolution = dpr * .75;
    this.canvas.width = Math.round(width * resolution);
    this.canvas.height = Math.round(height * resolution);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.pixelRatio = this.canvas.width / Math.max(1, width);
    this.ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    this.sunSprite = this.createSunSprite();
    this.hasDrawn = false;
  }

  setWeather(weather) { this.weather = weather; }

  setDaylight(value) {
    const opacity = String(value);
    if (opacity !== this.lastOpacity) {
      this.daylight.style.opacity = opacity;
      this.lastOpacity = opacity;
    }
  }

  render(seconds) {
    const ctx = this.ctx;
    const weather = this.weather;
    if (!weather) {
      this.setDaylight(0);
      this.clear();
      return;
    }
    const isDay = Boolean(weather.is_day);
    const cloudCover = Math.max(0, Math.min(100, weather.cloud_cover || 0));
    const rainCode = (weather.weather_code >= 51 && weather.weather_code <= 67) || (weather.weather_code >= 80 && weather.weather_code <= 82) || weather.weather_code >= 95;
    const nightOpacity = isDay
      ? Math.max(rainCode ? .16 + Math.min(.08, (weather.precipitation || 0) * .02) : 0, Math.max(0, (cloudCover - 55) / 100 * .32))
      : .57;
    this.setDaylight(this.enabled ? nightOpacity : 0);
    if (!this.enabled) {
      this.clear();
      return;
    }
    ctx.clearRect(0, 0, this.width, this.height);
    this.hasDrawn = true;
    const time = this.reducedMotion ? 0 : seconds;
    if (isDay && cloudCover < 90) this.drawSun(ctx, 1 - cloudCover / 115);
    if (cloudCover > 22) this.drawClouds(ctx, time, cloudCover, isDay);
    if (rainCode) this.drawRain(ctx, time, weather);
  }

  clear() {
    if (!this.hasDrawn) return;
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.hasDrawn = false;
  }

  createSunSprite() {
    const sprite = document.createElement('canvas');
    sprite.width = Math.max(1, this.canvas.width);
    sprite.height = Math.max(1, this.canvas.height);
    const ctx = sprite.getContext('2d');
    const x = sprite.width * .82, y = sprite.height * .08;
    const radius = Math.min(sprite.width, sprite.height) * .55;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, 'rgba(255, 224, 153, .24)');
    gradient.addColorStop(.45, 'rgba(255, 224, 153, .105)');
    gradient.addColorStop(1, 'rgba(255, 224, 153, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, sprite.width, sprite.height);
    return sprite;
  }

  drawSun(ctx, strength) {
    if (!this.sunSprite) return;
    ctx.globalAlpha = strength;
    ctx.drawImage(this.sunSprite, 0, 0, this.width, this.height);
    ctx.globalAlpha = 1;
  }

  cloudSprite(cloud, isDay) {
    const key = `${cloud.id}-${isDay ? 'day' : 'night'}`;
    if (this.cloudSprites.has(key)) return this.cloudSprites.get(key);
    const radius = Math.ceil(cloud.size);
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = radius * 2;
    const ctx = sprite.getContext('2d');
    const gradient = ctx.createRadialGradient(radius, radius, cloud.size * .05, radius, radius, cloud.size);
    const tone = isDay ? '235, 235, 220' : '112, 132, 151';
    gradient.addColorStop(0, `rgba(${tone}, 1)`);
    gradient.addColorStop(.55, `rgba(${tone}, .6)`);
    gradient.addColorStop(1, `rgba(${tone}, 0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, radius * 2, radius * 2);
    this.cloudSprites.set(key, sprite);
    return sprite;
  }

  drawClouds(ctx, time, cover, isDay) {
    const coverage = cover / 100;
    for (const cloud of this.clouds) {
      const span = this.width + cloud.size * 2;
      const x = ((cloud.x * span + time * cloud.speed) % span) - cloud.size;
      const y = cloud.y * this.height + Math.sin(time * .03 + cloud.phase) * 12;
      const sprite = this.cloudSprite(cloud, isDay);
      ctx.globalAlpha = cloud.alpha * coverage;
      ctx.drawImage(sprite, x - cloud.size, y - cloud.size, sprite.width, sprite.height);
    }
    ctx.globalAlpha = 1;
  }

  drawRain(ctx, time, weather) {
    const intensity = Math.max(.35, Math.min(1, (weather.precipitation || .4) / 3 + .35));
    const count = Math.floor(this.drops.length * intensity);
    const wind = Math.max(-80, Math.min(80, (weather.wind_speed_10m || 10) * 1.4));
    const paths = Array.from({ length: 4 }, () => new Path2D());
    for (let i = 0; i < count; i++) {
      const drop = this.drops[i];
      const x = ((drop.x * (this.width + 160) + time * wind) % (this.width + 160) + (this.width + 160)) % (this.width + 160) - 80;
      const y = ((drop.y * (this.height + 120) + time * drop.speed) % (this.height + 120)) - 60;
      const path = paths[drop.bucket];
      path.moveTo(x, y);
      path.lineTo(x - wind * .025, y + drop.length);
    }
    const alphas = [.38, .5, .62, .75];
    ctx.lineWidth = 1.35;
    ctx.lineCap = 'round';
    for (let i = 0; i < paths.length; i++) {
      ctx.strokeStyle = `rgba(208, 226, 231, ${alphas[i]})`;
      ctx.stroke(paths[i]);
    }
  }
}
