import { ROAD_ROUTES, RAIL_ROUTES, RIVER_ROUTE, VEHICLE_COLORS } from './data.js';

// Le route importate sono geometryRoute generate dalle geometrie OSM/HDX effettivamente disegnate nella base.

function mulberry32(seed) {
  return function random() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

class Route {
  constructor(points) {
    this.points = points;
    this.lengths = [0];
    for (let i = 1; i < points.length; i++) {
      this.lengths.push(this.lengths[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
    }
    this.total = this.lengths.at(-1);
  }

  sample(distance) {
    const cycle = this.total * 2;
    let d = ((distance % cycle) + cycle) % cycle;
    const reverse = d > this.total;
    if (reverse) d = cycle - d;
    let index = 0;
    while (index < this.lengths.length - 2 && this.lengths[index + 1] < d) index++;
    const a = this.points[index];
    const b = this.points[index + 1];
    const span = Math.max(.001, this.lengths[index + 1] - this.lengths[index]);
    const f = (d - this.lengths[index]) / span;
    const dx = (b[0] - a[0]) / span * (reverse ? -1 : 1);
    const dy = (b[1] - a[1]) / span * (reverse ? -1 : 1);
    return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, dx, dy, angle: Math.atan2(dy, dx) };
  }
}

function vehicle(kind, route, distance, speed, extra = {}) {
  return { kind, route, distance, speed, ...extra };
}

export class TrafficSimulation {
  constructor() {
    const rand = mulberry32(120519);
    const roads = ROAD_ROUTES.map(points => new Route(points));
    const rails = RAIL_ROUTES.map(points => new Route(points));
    const river = new Route(RIVER_ROUTE);
    this.vehicles = [];
    for (let i = 0; i < 48; i++) {
      const route = roads[(i * 7) % roads.length];
      this.vehicles.push(vehicle('car', route, (i * 173 + rand() * 90) % (route.total * 2), 13 + rand() * 9, {
        color: VEHICLE_COLORS[i % VEHICLE_COLORS.length], lane: i % 2 ? 2.1 : -2.1,
      }));
    }
    for (let i = 0; i < 6; i++) {
      const route = roads[(i * 2 + 1) % roads.length];
      this.vehicles.push(vehicle('bus', route, route.total * (.18 + i * .23), 10 + i * .55, { color: i % 2 ? '#b64b32' : '#d6c49d', lane: -2.6 }));
    }
    rails.forEach((route, i) => this.vehicles.push(vehicle('train', route, route.total * (.2 + i * .23), 19 + i * 1.5, { color: '#883d32', lane: 0 })));
    for (let i = 0; i < 3; i++) this.vehicles.push(vehicle('boat', river, river.total * (.22 + i * .31), 6.5 + i * .8, { color: '#e4dcc7', lane: i ? 4 : -4 }));
    this.layers = { traffic: true, transit: true };
  }

  update(delta, speed = 1) {
    for (const item of this.vehicles) item.distance += delta * speed * item.speed;
  }

  draw(context, project, pixelsPerImagePixel, width = context.canvas.width, height = context.canvas.height) {
    const ordered = this.vehicles.filter(item => this.layers[item.kind === 'car' ? 'traffic' : 'transit']);
    const ratio = Math.max(.62, Math.min(3.2, pixelsPerImagePixel));
    for (const item of ordered) {
      const point = item.route.sample(item.distance);
      const laneX = -point.dy * item.lane;
      const laneY = point.dx * item.lane;
      const screen = project(point.x + laneX, point.y + laneY);
      if (screen.x < -60 || screen.y < -60 || screen.x > width + 60 || screen.y > height + 60) continue;
      this.drawVehicle(context, item.kind, screen.x, screen.y, point.angle, ratio, item.color);
    }
  }

  drawVehicle(ctx, kind, x, y, angle, scale, color) {
    const dimensions = {
      car: [14, 6.4], bus: [25, 7.6], train: [48, 8.2], boat: [25, 8.8],
    }[kind];
    const length = dimensions[0] * scale;
    const width = dimensions[1] * scale;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = 'rgba(44, 38, 27, .24)';
    ctx.beginPath();
    ctx.ellipse(1.5 * scale, 2.2 * scale, length * .53, width * .62, 0, 0, Math.PI * 2);
    ctx.fill();
    if (kind === 'boat') {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(length * .55, 0);
      ctx.lineTo(length * .3, -width * .5);
      ctx.lineTo(-length * .48, -width * .42);
      ctx.lineTo(-length * .55, 0);
      ctx.lineTo(-length * .48, width * .42);
      ctx.lineTo(length * .3, width * .5);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#53717a';
      ctx.fillRect(-length * .17, -width * .29, length * .35, width * .58);
      ctx.restore();
      return;
    }
    ctx.fillStyle = '#2f312c';
    ctx.fillRect(-length * .35, -width * .62, length * .18, width * .18);
    ctx.fillRect(length * .18, -width * .62, length * .18, width * .18);
    ctx.fillRect(-length * .35, width * .44, length * .18, width * .18);
    ctx.fillRect(length * .18, width * .44, length * .18, width * .18);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(-length / 2, -width / 2, length, width, Math.max(1, width * .18));
    ctx.fill();
    ctx.fillStyle = kind === 'train' ? '#c8b98f' : '#334c55';
    if (kind === 'car') {
      ctx.beginPath();
      ctx.roundRect(-length * .2, -width * .39, length * .43, width * .78, width * .13);
      ctx.fill();
      ctx.fillStyle = 'rgba(220, 232, 224, .65)';
      ctx.fillRect(length * .03, -width * .34, 1 * scale, width * .68);
    } else {
      const windows = kind === 'train' ? 8 : 5;
      const start = -length * .4;
      const windowWidth = length * .8 / windows;
      for (let i = 0; i < windows; i++) {
        ctx.fillRect(start + i * windowWidth + windowWidth * .14, -width * .34, windowWidth * .65, width * .68);
      }
      ctx.fillStyle = '#e5d9b8';
      ctx.fillRect(length * .37, -width * .36, length * .07, width * .72);
    }
    ctx.fillStyle = '#f4df9d';
    ctx.fillRect(length * .46, -width * .31, Math.max(1, scale), Math.max(1, scale));
    ctx.fillRect(length * .46, width * .12, Math.max(1, scale), Math.max(1, scale));
    ctx.restore();
  }

  getState() {
    return {
      counts: { cars: 48, buses: 6, trains: this.vehicles.filter(item => item.kind === 'train').length, boats: 3 },
      layers: { ...this.layers },
      firstVehicleDistance: this.vehicles[0].distance,
    };
  }
}
