/**
 * Headless renderer page: open-data 3D scene through one orthographic camera.
 * Terrain + ground surface (OSM, drawn per tile onto a canvas texture) + extruded buildings + trees.
 * Driven by src/render.ts via Playwright: window.renderTile(tx, ty) -> PNG data.
 */
import * as THREE from "three";
import { CAMERA, axes, ecefToEnu, llhToEcef, tileCamera, useRegion } from "../src/camera.ts";
import { drawGround, type Feature } from "./ground.ts";

import { bridgeProfile } from "../src/bridge-profile.ts";
import { groundAt, inWater } from "../src/road-safety.ts";
import { roofRise, type SceneBuilding } from "../src/building-shape.ts";
import { bridgeMesh } from "./bridges.ts";

const params = new URLSearchParams(location.search);
useRegion(params.get("region") ?? "roma-centro"); // before any projection below
const SS = Number(params.get("ss") ?? 2); // supersampling
const SIZE = CAMERA.tile * SS;
const HEIGHT_SIZE = 256;
/** Ground texture resolution (m per texel); the render samples ~0.125 m across, 0.18 m in depth. */
const GROUND_MPT = 0.15;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
renderer.setPixelRatio(1);
renderer.setSize(SIZE, SIZE);
renderer.setClearColor(0x000000, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();

// ?markers=lat,lon,h;lat,lon,h  -> red 6 m spheres (alignment debugging)
for (const m of (params.get("markers") ?? "").split(";").filter(Boolean)) {
  const [lat, lon, h] = m.split(",").map(Number);
  const s = new THREE.Mesh(new THREE.SphereGeometry(6), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
  s.position.set(...ecefToEnu(llhToEcef(lat, lon, h)));
  scene.add(s);
}

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 10);

// ---- terrain ---------------------------------------------------------------------------------
const meta: { x0: number; y0: number; nx: number; ny: number; step: number } = await (await fetch("/ground/meta.json")).json();
const terrain = new Float32Array(await (await fetch("/ground/height.bin")).arrayBuffer());
const features: Feature[] = await (await fetch("/ground/features.json")).json();
const fbox = features.map((f) => {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  if (f.j) return [-Infinity, -Infinity, Infinity, Infinity]; // point sets (junctions, zebras): always passed
  for (const ring of f.r ?? [f.l!]) for (const [x, y] of ring) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
  return [a, b, c, d];
});

/** Ground ENU "up" at (x, y), bilinear on the terrain grid. */
function ground(x: number, y: number): number {
  const fx = Math.min(meta.nx - 1.001, Math.max(0, (x - meta.x0) / meta.step));
  const fy = Math.min(meta.ny - 1.001, Math.max(0, (y - meta.y0) / meta.step));
  const ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy, i = iy * meta.nx + ix;
  return (terrain[i] * (1 - ax) + terrain[i + 1] * ax) * (1 - ay) + (terrain[i + meta.nx] * (1 - ax) + terrain[i + meta.nx + 1] * ax) * ay;
}

// Build bridges once from full OSM ways; their altitude matches exported traffic samples.
const waterPolygons = features.filter(f=>["water","sea","pool"].includes(f.k)&&f.r).map(f=>f.r!);
for (const f of features.filter(f=>f.bridge && f.l && f.w)) {
  const profile = bridgeProfile(f.l!, (x,y)=>groundAt(meta,terrain,x,y), (x,y)=>inWater(x,y,waterPolygons));
  if(profile) scene.add(bridgeMesh(profile,f.w!,["path","plaza","cycle"].includes(f.k)));
}

const groundTexture = new THREE.CanvasTexture(document.createElement("canvas"));
groundTexture.colorSpace = THREE.SRGBColorSpace;
groundTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
const groundMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ map: groundTexture }));
scene.add(groundMesh);

/** ENU rectangle of ground the tile camera can see (screen rect swept over the terrain's height range). */
function footprint(tx: number, ty: number) {
  const { right: r, up: v, dir: d } = axes();
  const T = CAMERA.tile * CAMERA.mpp, xs: number[] = [], ys: number[] = [];
  for (const sx of [tx * T, (tx + 1) * T]) for (const sy of [ty * T, (ty + 1) * T]) for (const u of [-5, 120]) {
    // p = r*sx - v*sy + d*t with p.z = u
    const t = (u + v[2] * sy) / d[2];
    xs.push(r[0] * sx - v[0] * sy + d[0] * t);
    ys.push(r[1] * sx - v[1] * sy + d[1] * t);
  }
  const m = 15;
  return [Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m];
}

function buildGround(tx: number, ty: number, data?: TileObjects) {
  const [x0, y0, x1, y1] = footprint(tx, ty);
  // texture
  const cv = groundTexture.image as HTMLCanvasElement;
  cv.width = Math.ceil((x1 - x0) / GROUND_MPT);
  cv.height = Math.ceil((y1 - y0) / GROUND_MPT);
  const visible = features.filter((f, i) => !f.bridge && fbox[i][0] < x1 && fbox[i][2] > x0 && fbox[i][1] < y1 && fbox[i][3] > y0);
  drawGround(cv.getContext("2d")!, visible, [x0, y0, x1, y1], GROUND_MPT, data ?? { b: [], t: [] }, ground);
  groundTexture.needsUpdate = true;
  // terrain mesh: 5 m grid draped on the terrain, UVs into the canvas
  const step = 5, nx = Math.ceil((x1 - x0) / step) + 1, ny = Math.ceil((y1 - y0) / step) + 1;
  const pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2), idx: number[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = Math.min(x1, x0 + i * step), y = Math.min(y1, y0 + j * step), k = j * nx + i;
    pos.set([x, y, ground(x, y)], k * 3);
    uv.set([(x - x0) / (x1 - x0), (y - y0) / (y1 - y0)], k * 2);
    if (i && j) idx.push(k - nx - 1, k - nx, k, k - nx - 1, k, k - 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  groundMesh.geometry.dispose();
  groundMesh.geometry = geo;
}

/** Ellipsoid height (cm + 10000, 16 bit in RG) of whatever surface is visible. */
const heightMaterial = new THREE.ShaderMaterial({
  vertexShader: /* glsl */ `
    varying vec3 vEnu;
    void main() {
      #ifdef USE_INSTANCING
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
      #else
        vec4 w = modelMatrix * vec4(position, 1.0);
      #endif
      vEnu = w.xyz;
      gl_Position = projectionMatrix * viewMatrix * w;
    }`,
  depthTest: true,
  depthWrite: true,
  side: THREE.DoubleSide,
  fragmentShader: /* glsl */ `
    varying vec3 vEnu;
    void main() {
      float h = vEnu.z + dot(vEnu.xy, vEnu.xy) / (2.0 * 6371000.0);
      float v = clamp(floor((h + 100.0) * 100.0 + 0.5), 0.0, 65535.0);
      gl_FragColor = vec4(floor(v / 256.0) / 255.0, mod(v, 256.0) / 255.0, 0.0, 1.0);
    }`,
});
const heightTarget = new THREE.WebGLRenderTarget(HEIGHT_SIZE, HEIGHT_SIZE, {
  colorSpace: THREE.NoColorSpace, depthBuffer: true,
  depthTexture: new THREE.DepthTexture(HEIGHT_SIZE, HEIGHT_SIZE, THREE.UnsignedIntType),
});
heightTarget.texture.generateMipmaps = false;

// ---------------------------------------------------------------------------------------------
// Open-data 3D objects.

type P2 = [number, number];
export interface TileObjects {
  b: SceneBuilding[]; // ring, height, style, ground hint (ellipsoid)
  t: Array<[number, number, number, number]>;      // x, y, radius, crown height
}

/** wall, roof colours per style (see scene.ts): bauhaus, residential, public, tower, shed, modern */
const PALETTE: Array<[number[], number[]]> = [
  [[0.97, 0.96, 0.93], [0.88, 0.87, 0.84]],
  [[0.94, 0.88, 0.76], [0.84, 0.82, 0.78]],
  [[0.88, 0.82, 0.69], [0.76, 0.74, 0.70]],
  [[0.66, 0.75, 0.82], [0.70, 0.72, 0.74]],
  [[0.78, 0.76, 0.72], [0.60, 0.60, 0.60]],
  [[0.86, 0.87, 0.88], [0.80, 0.80, 0.80]],
];
const SUN = new THREE.Vector3(-0.55, -0.35, 0.76).normalize();

const buildingMaterial = new THREE.ShaderMaterial({
  vertexShader: /* glsl */ `
    attribute vec3 color;
    attribute vec2 facade;   // (meters along wall, meters above ground); y = -1000: roof / rooftop object
    attribute float kind;    // style index
    varying vec3 vColor; varying vec3 vNormal; varying vec2 vFacade; varying float vKind;
    void main() {
      vColor = color; vNormal = normal; vFacade = facade; vKind = kind;
      gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 sun;
    varying vec3 vColor; varying vec3 vNormal; varying vec2 vFacade; varying float vKind;
    const vec3 GLASS = vec3(0.30, 0.40, 0.50);
    void main() {
      vec3 n = normalize(vNormal);
      float light = min(1.08, 0.80 + 0.32 * max(dot(n, sun), 0.0));
      vec3 c = vColor;
      if (vFacade.y > -100.0) {
        int k = int(vKind + 0.5);
        float fl = fract(vFacade.y / 3.2), x = vFacade.x;
        bool ground = vFacade.y < 3.2;
        if (k == 0) {            // Bauhaus: continuous ribbon windows, white balcony parapets
          bool ribbon = fl > 0.45 && fl < 0.78 && fract(x / 7.0) > 0.08;
          if (ribbon) c = mix(c, GLASS, 0.75);
          else if (fl < 0.12) c *= 0.93;
        } else if (k == 1) {     // 60s-80s residential: windows + recessed balcony band
          float col = fract(x / 3.0);
          if (fl > 0.30 && fl < 0.80 && col > 0.20 && col < 0.80) c = mix(c, GLASS, 0.70);
          if (fl < 0.22) c *= 0.86;
        } else if (k == 3) {     // tower: glass curtain wall, spandrel lines
          c = mix(c, GLASS * 1.1, 0.55);
          if (fl < 0.10 || fract(x / 1.6) < 0.06) c = vec3(0.80, 0.83, 0.86);
        } else if (k == 5) {     // modern: large windows, glass balconies
          float col = fract(x / 4.0);
          if (fl > 0.18 && fl < 0.88 && col > 0.08 && col < 0.92) c = mix(c, GLASS, 0.65);
        } else if (k == 2) {     // public: tall sparse windows
          float col = fract(x / 4.5);
          if (fl > 0.25 && fl < 0.85 && col > 0.35 && col < 0.65) c = mix(c, GLASS, 0.6);
        }
        if (ground && k != 3 && k != 4) c *= 0.84;  // shops / pilotis shade
      }
      gl_FragColor = vec4(c * light, 1.0);
    }`,
  uniforms: { sun: { value: SUN } },
});

/**
 * Tree species of Tel Aviv streets and parks, as placeholder colours and shapes the paint step turns
 * into real trees (style/trees.png). Weights are rough shares; palms only replace small crowns.
 * [name, weight, crown colour, crown scale xy, crown scale z, palm?]
 */
const SPECIES: Array<[string, number, number[], number, number, boolean]> = [
  ["ficus", 22, [0.16, 0.36, 0.14], 1, 0.85, false],
  ["tipuana", 13, [0.42, 0.62, 0.22], 1.05, 0.7, false],
  ["jacaranda", 9, [0.62, 0.5, 0.85], 1, 0.7, false],
  ["poinciana", 7, [0.88, 0.32, 0.16], 1.15, 0.45, false],
  ["olive", 10, [0.6, 0.66, 0.55], 0.8, 0.75, false],
  ["pine", 8, [0.12, 0.3, 0.26], 0.95, 1.1, false],
  ["eucalyptus", 6, [0.38, 0.52, 0.46], 0.85, 1.25, false],
  ["date palm", 14, [0.55, 0.62, 0.2], 0, 0, true],
  ["fan palm", 11, [0.32, 0.5, 0.2], 0, 0, true],
];
const SPECIES_TOTAL = SPECIES.reduce((t, s) => t + s[1], 0);
const rand = (x: number, y: number) => Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
/** Mostly one species per ~40 m patch (streets are planted in runs), every 4th tree a random one. */
function species(x: number, y: number, r: number) {
  const own = rand(x, y) < 0.25;
  let h = (own ? rand(y, x) : rand(Math.floor(x / 40), Math.floor(y / 40))) * SPECIES_TOTAL;
  for (const s of SPECIES) if ((h -= s[1]) < 0) return s[5] && r > 4.5 ? SPECIES[0] : s; // no palm for a big canopy
  return SPECIES[0];
}

const treeMaterial = new THREE.ShaderMaterial({
  vertexShader: /* glsl */ `
    varying vec3 vNormal; varying float vShade; varying vec3 vColor;
    void main() {
      vNormal = normalize(mat3(instanceMatrix) * normal);
      vShade = fract(sin(dot(instanceMatrix[3].xy, vec2(12.9898, 78.233))) * 43758.5453);
      vColor = instanceColor;
      gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 sun;
    varying vec3 vNormal; varying float vShade; varying vec3 vColor;
    void main() {
      float light = 0.55 + 0.45 * max(dot(normalize(vNormal), sun), 0.0);
      vec3 c = vColor * (0.9 + 0.2 * vShade);
      gl_FragColor = vec4(c * light, 1.0);
    }`,
  uniforms: { sun: { value: SUN } },
});

const objects = new THREE.Group();
scene.add(objects);
function pointInRing(x: number, y: number, ring: P2[]) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function buildObjects(data: TileObjects) {
  objects.children.forEach((o: any) => o.geometry?.dispose());
  objects.clear();
  const pos: number[] = [], nor: number[] = [], col: number[] = [], fac: number[] = [], tow: number[] = [];
  /** axis-aligned box on a roof (rooftop clutter), no facade pattern */
  const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number, c: number[]) => {
    const X = [x - sx / 2, x + sx / 2], Y = [y - sy / 2, y + sy / 2], Z = [z, z + sz];
    const faces: Array<[number[][], number[]]> = [
      [[[X[0], Y[0], Z[1]], [X[1], Y[0], Z[1]], [X[1], Y[1], Z[1]], [X[0], Y[1], Z[1]]], [0, 0, 1]],
      [[[X[0], Y[0], Z[0]], [X[1], Y[0], Z[0]], [X[1], Y[0], Z[1]], [X[0], Y[0], Z[1]]], [0, -1, 0]],
      [[[X[1], Y[0], Z[0]], [X[1], Y[1], Z[0]], [X[1], Y[1], Z[1]], [X[1], Y[0], Z[1]]], [1, 0, 0]],
      [[[X[1], Y[1], Z[0]], [X[0], Y[1], Z[0]], [X[0], Y[1], Z[1]], [X[1], Y[1], Z[1]]], [0, 1, 0]],
      [[[X[0], Y[1], Z[0]], [X[0], Y[0], Z[0]], [X[0], Y[0], Z[1]], [X[0], Y[1], Z[1]]], [-1, 0, 0]],
    ];
    for (const [q, nn] of faces) for (const v of [0, 1, 2, 0, 2, 3]) {
      pos.push(...q[v]); nor.push(...nn); col.push(...c); fac.push(0, -1000); tow.push(0);
    }
  };
  const rnd = (seed: number) => () => ((seed = Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9 | 0) >>> 0) / 2 ** 32;
  data.b.forEach(([ring, h, style, _groundHint, detail = {}]) => {
    // sit on the highest ground under the footprint; walls reach 1 m below the lowest so slopes never show a gap
    const gs = ring.map(([x, y]) => ground(x, y));
    const base = Math.max(...gs), roofHeight = Math.min(detail.roofHeight ?? 0,h-(detail.minHeight??0));
    const top = base + h - Math.max(0,roofHeight), g = detail.minHeight ? base+detail.minHeight : Math.min(...gs)-1;
    const palette = PALETTE[style] ?? PALETTE[0];
    const color = (value: string|undefined, fallback:number[]) => value && /^#[0-9a-f]{6}$/i.test(value)
      ? [1,3,5].map(i=>parseInt(value.slice(i,i+2),16)/255) : fallback;
    const wall=color(detail.wallColor,palette[0]), roof=color(detail.roofColor,palette[1]);
    const isTower = style;
    const surface = (p:P2)=>top+(roofHeight>0 ? roofRise(...p,ring,detail.roofShape??"flat",roofHeight,detail.roofDirection,detail.roofAcross) : 0);
    const holes = (detail.holes??[]).map(r=>r.slice().reverse());
    for (const boundary of [ring,...holes]) {
    const outline = roofHeight>0 ? boundary.flatMap((a,i)=>{
      const b=boundary[(i+1)%boundary.length],n=Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/2));
      return Array.from({length:n},(_,j)=>[a[0]+(b[0]-a[0])*j/n,a[1]+(b[1]-a[1])*j/n] as P2);
    }) : boundary;
    let along = 0;
    for (let k = 0; k < outline.length; k++) {
      const [ax, ay] = outline[k], [bx, by] = outline[(k + 1) % outline.length];
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 0.05) continue;
      const nx = (by - ay) / L, ny = -(bx - ax) / L; // outward for CCW
      const za=surface([ax,ay]),zb=surface([bx,by]);
      const quad = [[ax, ay, g, along, -1], [bx, by, g, along + L, -1], [bx, by, zb, along + L, zb - g - 1], [ax, ay, za, along, za - g - 1]];
      for (const q of [0, 1, 2, 0, 2, 3]) {
        pos.push(quad[q][0], quad[q][1], quad[q][2]); nor.push(nx, ny, 0); col.push(...wall);
        fac.push(quad[q][3], detail.part ? -1000 : quad[q][4]); tow.push(isTower);
      }
      along += L;
    }
    }
    const vec = (r:P2[])=>r.map(([x,y])=>new THREE.Vector2(x,y));
    const tris = THREE.ShapeUtils.triangulateShape(vec(ring), holes.map(vec));
    const vertices = [ring,...holes].flat();
    const triangle = (a:P2,b:P2,c:P2,depth:number) => {
      if(roofHeight>0 && depth<4) {
        const mid=(p:P2,q:P2):P2=>[(p[0]+q[0])/2,(p[1]+q[1])/2];
        const ab=mid(a,b),bc=mid(b,c),ca=mid(c,a);
        triangle(a,ab,ca,depth+1);triangle(ab,b,bc,depth+1);triangle(ca,bc,c,depth+1);triangle(ab,bc,ca,depth+1);return;
      }
      const vs=[a,b,c].map(p=>new THREE.Vector3(p[0],p[1],surface(p)));
      const normal=new THREE.Vector3().subVectors(vs[1],vs[0]).cross(new THREE.Vector3().subVectors(vs[2],vs[0])).normalize();
      for(const v of vs) {pos.push(v.x,v.y,v.z);nor.push(normal.x,normal.y,normal.z);col.push(...roof);fac.push(0,-1000);tow.push(0);}
    };
    for(const t of tris) triangle(vertices[t[0]],vertices[t[1]],vertices[t[2]],0);
    // rooftop clutter on flat residential roofs: solar water heaters (panel + tank), AC units
    if (style !== 2 && style !== 3 && style !== 4 && h > 6) {
      const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const area = Math.abs(THREE.ShapeUtils.area(ring.map(([x, y]) => new THREE.Vector2(x, y))));
      const r = rnd(Math.round(x0 * 31 + y0 * 17));
      const n = Math.min(10, Math.floor(area / 70));
      for (let k = 0, tries = 0; k < n && tries < n * 6; tries++) {
        const px = x0 + 1.5 + r() * (x1 - x0 - 3), py = y0 + 1.5 + r() * (y1 - y0 - 3);
        if (!pointInRing(px, py, ring) || holes.some(r=>pointInRing(px,py,r))) continue;
        k++;
        const kind = r();
        if (kind < 0.55) {        // solar water heater: dark panel + white tank
          box(px, py, top, 2.0, 1.1, 0.35, [0.16, 0.22, 0.38]);
          box(px, py + 0.9, top, 1.6, 0.6, 0.7, [0.93, 0.93, 0.92]);
        } else if (kind < 0.85) { // AC unit
          box(px, py, top, 0.9, 0.7, 0.6, [0.74, 0.75, 0.76]);
        } else {                  // stair / lift housing
          box(px, py, top, 2.6, 2.6, 2.6, roof.map((v) => v * 0.95));
        }
      }
    }
  });
  if (pos.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute("facade", new THREE.Float32BufferAttribute(fac, 2));
    geo.setAttribute("kind", new THREE.Float32BufferAttribute(tow, 1));
    objects.add(new THREE.Mesh(geo, buildingMaterial));
  }
  if (data.t.length) {
    const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2), treeMaterial, data.t.length);
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 6).rotateX(Math.PI / 2).translate(0, 0, 0.5), treeMaterial, data.t.length);
    const m = new THREE.Matrix4(), c = new THREE.Color(), bark = new THREE.Color(0.45, 0.36, 0.28);
    data.t.forEach(([x, y, r, ch], i) => {
      const g = ground(x, y), [name, , col, sxy, sz, palm] = species(x, y, r);
      if (palm) {
        // small star crown high on a thin trunk
        const top = g + Math.max(ch, 8) + (name === "fan palm" ? 6 : 0); // Washingtonias tower over the rest
        m.makeScale(2.6, 2.6, 0.9).setPosition(x, y, top);
        crowns.setMatrixAt(i, m);
        m.makeScale(0.4, 0.4, top - g).setPosition(x, y, g);
        trunks.setMatrixAt(i, m);
      } else {
        m.makeScale(r * sxy, r * sxy, r * sz).setPosition(x, y, g + ch);
        crowns.setMatrixAt(i, m);
        m.makeScale(0, 0, 0);
        trunks.setMatrixAt(i, m);
      }
      crowns.setColorAt(i, c.setRGB(col[0], col[1], col[2]));
      trunks.setColorAt(i, bark);
    });
    objects.add(crowns, trunks);
  }
}

function placeCamera(tx: number, ty: number) {
  const c = tileCamera(tx, ty);
  camera.left = -c.half; camera.right = c.half;
  camera.top = c.half; camera.bottom = -c.half;
  camera.near = c.near; camera.far = c.far;
  camera.position.set(...c.pos);
  camera.up.set(...c.up);
  camera.lookAt(c.pos[0] + c.dir[0], c.pos[1] + c.dir[1], c.pos[2] + c.dir[2]);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

async function renderTile(tx: number, ty: number, data?: TileObjects) {
  placeCamera(tx, ty);
  buildObjects(data ?? { b: [], t: [] });
  buildGround(tx, ty, data);
  renderer.setRenderTarget(null);
  renderer.render(scene, camera);
  const color = renderer.domElement.toDataURL("image/png");

  scene.overrideMaterial = heightMaterial;
  renderer.setRenderTarget(heightTarget);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(scene, camera);
  renderer.setClearColor(0x000000, 1);
  const buf = new Uint8Array(HEIGHT_SIZE * HEIGHT_SIZE * 4);
  renderer.readRenderTargetPixels(heightTarget, 0, 0, HEIGHT_SIZE, HEIGHT_SIZE, buf);
  renderer.setRenderTarget(null);
  scene.overrideMaterial = null;
  return { color, height: bufToB64(buf) };
}

function bufToB64(buf: Uint8Array) {
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

declare global {
  interface Window {
    renderTile: typeof renderTile;
    ready: boolean;
  }
}
window.renderTile = renderTile;
window.ready = true;

