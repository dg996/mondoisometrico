#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import random
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from pyproj import Transformer
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Point, Polygon, box, shape
from shapely.ops import linemerge, transform as shapely_transform, unary_union
from shapely.validation import make_valid

ROOT = Path(__file__).resolve().parents[1]
EXTRACT = ROOT / '.cache' / 'rome-extract'
PUBLIC = ROOT / 'public'
MAP_DIR = PUBLIC / 'map'
DATA_DIR = PUBLIC / 'data'

W, H = 4096, 2560
SS = 2
MARGIN = 118
BBOX = (12.43, 41.87, 12.53, 41.93)
BBOX_PAD = 0.006
COS30 = math.cos(math.radians(30))
SIN30 = math.sin(math.radians(30))
Z_EXAGGERATION = 2.65
SEED = 120519

TRANSFORM_TO_UTM = Transformer.from_crs('EPSG:4326', 'EPSG:32633', always_xy=True).transform
TRANSFORM_TO_LL = Transformer.from_crs('EPSG:32633', 'EPSG:4326', always_xy=True).transform

LANDMARK_META = {
    'colosseum': {
        'name': 'Colosseo', 'italian': 'Amphitheatrum Flavium', 'era': '80 d.C. · ANFITEATRO FLAVIO',
        'match': ['colosseo', 'anfiteatro flavio'], 'lonlat': (12.4922, 41.8902),
        'description': 'Il più grande anfiteatro dell’antichità romana. La forma ellittica e gli ordini sovrapposti emergono dalla vera impronta OpenStreetMap.',
    },
    'pantheon': {
        'name': 'Pantheon', 'italian': 'Templum omnium deorum', 'era': '118–125 d.C. · ROMA ANTICA',
        'match': ['pantheon'], 'lonlat': (12.4768, 41.8986),
        'description': 'Il tempio di tutti gli dèi, ricostruito sotto Adriano. La rotonda e il pronao sono disegnati dalla geometria OSM del monumento.',
    },
    'stpeters': {
        'name': 'Basilica di San Pietro', 'italian': 'Basilica Sancti Petri', 'era': '1506–1626 · CITTÀ DEL VATICANO',
        'match': ['basilica di san pietro'], 'lonlat': (12.4534, 41.9022),
        'description': 'La basilica e il colonnato di piazza San Pietro sono resi con la geometria OSM della Città del Vaticano, oltre il braccio settentrionale del Tevere.',
    },
    'castel': {
        'name': 'Castel Sant’Angelo', 'italian': 'Mausoleum Hadriani', 'era': '139 d.C. · MAUSOLEO E FORTEZZA',
        'match': ['castel sant’angelo', "castel sant'angelo"], 'lonlat': (12.4663, 41.9031),
        'description': 'Nato come mausoleo di Adriano, divenne fortezza e residenza papale. La mole cilindrica presidia il passaggio tra Vaticano e centro storico.',
    },
    'termini': {
        'name': 'Roma Termini', 'italian': 'Stazione di Roma Termini', 'era': '1950 · ARCHITETTURA MODERNA',
        'match': ['roma termini', 'stazione termini'], 'lonlat': (12.5019, 41.9014),
        'description': 'La principale stazione ferroviaria della città. I binari usati dai treni dell’animazione sono le stesse geometrie OSM disegnate nella mappa.',
    },
    'vittoriano': {
        'name': 'Vittoriano', 'italian': 'Monumento a Vittorio Emanuele II', 'era': '1885–1935 · PIAZZA VENEZIA',
        'match': ['altare della patria', 'vittoriano'], 'lonlat': (12.4828, 41.8958),
        'description': 'Il complesso in marmo bianco dedicato al primo re d’Italia collega visivamente piazza Venezia, il Campidoglio e l’area archeologica del Foro.',
    },
    'borghese': {
        'name': 'Villa Borghese', 'italian': 'Villa Borghese Pinciana', 'era': '1605 · PARCO E GALLERIA',
        'match': ['casino nobile di villa borghese', 'galleria borghese'], 'lonlat': (12.4921, 41.9141),
        'description': 'Il grande polmone verde sopra il centro storico: le aree verdi provengono da OSM/Overture e la galleria è ancorata all’edificio OSM.',
    },
}

ROAD_WIDTH_M = {
    'motorway': 18, 'trunk': 17, 'primary': 15, 'secondary': 12, 'tertiary': 9,
    'unclassified': 7, 'residential': 6.5, 'service': 4.2, 'pedestrian': 4.0,
    'motorway_link': 10, 'trunk_link': 10, 'primary_link': 9, 'secondary_link': 7, 'tertiary_link': 6,
}
VEHICLE_HIGHWAYS = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'}
RENDER_HIGHWAYS = VEHICLE_HIGHWAYS | {'pedestrian', 'living_street'}
GREEN_CLASSES = {'park', 'wood', 'forest', 'grass', 'scrub', 'meadow', 'garden', 'nature_reserve', 'tree_row', 'recreation_ground', 'village_green'}
WATER_CLASSES = {'water', 'river', 'basin', 'reservoir', 'lake', 'pond', 'canal', 'reflecting_pool'}


def read_ndjson(name: str):
    path = EXTRACT / name
    if not path.exists():
        return
    with path.open('r', encoding='utf-8') as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def geometry_from(obj):
    try:
        geom = shape(obj['geometry'])
    except Exception:
        return None
    if geom.is_empty:
        return None
    try:
        if not geom.is_valid:
            geom = make_valid(geom)
    except Exception:
        try:
            geom = geom.buffer(0)
        except Exception:
            return None
    return geom if not geom.is_empty else None


def flatten_polygons(geom):
    if geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    if hasattr(geom, 'geoms'):
        return [g for g in geom.geoms if isinstance(g, Polygon)]
    return []


def flatten_lines(geom):
    if geom.is_empty:
        return []
    if isinstance(geom, LineString):
        return [geom]
    if isinstance(geom, MultiLineString):
        return list(geom.geoms)
    if hasattr(geom, 'geoms'):
        return [g for g in geom.geoms if isinstance(g, LineString)]
    return []


def merge_grouped(names, wanted_types, predicate=None, key_prefix=''):
    clip = box(BBOX[0] - BBOX_PAD, BBOX[1] - BBOX_PAD, BBOX[2] + BBOX_PAD, BBOX[3] + BBOX_PAD)
    groups = defaultdict(list)
    props_by_id = {}
    layers_by_id = {}
    for name in names:
        for obj in read_ndjson(name):
            geom = geometry_from(obj)
            if geom is None:
                continue
            try:
                geom = geom.intersection(clip)
            except Exception:
                continue
            if geom.is_empty or geom.geom_type not in wanted_types and not any(t in geom.geom_type for t in wanted_types):
                continue
            props = obj.get('properties') or {}
            if predicate and not predicate(props, obj):
                continue
            key = f"{key_prefix}:{obj.get('source')}:{obj.get('layer')}:{obj.get('id') or hash(json.dumps(obj['geometry'], sort_keys=True))}"
            groups[key].append(geom)
            if key not in props_by_id or len(json.dumps(props, sort_keys=True)) > len(json.dumps(props_by_id[key], sort_keys=True)):
                props_by_id[key] = props
                layers_by_id[key] = obj.get('layer')
    merged = []
    for key, geoms in groups.items():
        try:
            geom = unary_union(geoms)
            if any(t in geom.geom_type for t in ['LineString', 'MultiLineString']):
                geom = linemerge(geom)
            geom = make_valid(geom) if not geom.is_valid else geom
        except Exception:
            continue
        if geom.is_empty:
            continue
        merged.append({'id': key, 'geometry': geom, 'properties': props_by_id.get(key, {}), 'layer': layers_by_id.get(key, '')})
    return merged


def to_utm(records):
    out = []
    for rec in records:
        try:
            geom = shapely_transform(TRANSFORM_TO_UTM, rec['geometry'])
        except Exception:
            continue
        if not geom.is_empty:
            rec = dict(rec)
            rec['geometry'] = geom
            out.append(rec)
    return out


def prop_text(props, key):
    value = props.get(key)
    return str(value).lower() if value is not None else ''


def parse_jsonish(value):
    if isinstance(value, dict):
        return value
    if not value:
        return {}
    try:
        return json.loads(value)
    except Exception:
        return {}


def building_height(props, landmark=None):
    if landmark == 'colosseum':
        return 31.0
    if landmark == 'stpeters':
        return 36.0
    if landmark == 'castel':
        return 29.0
    if landmark == 'vittoriano':
        return 27.0
    if landmark == 'pantheon':
        return 23.0
    if landmark == 'termini':
        return 18.0
    raw_height = props.get('height')
    try:
        if raw_height not in (None, ''):
            return max(3.5, min(80.0, float(str(raw_height).replace('m', '').strip())))
    except Exception:
        pass
    try:
        levels = float(str(props.get('building_levels', '')).strip())
        return max(4.0, min(65.0, levels * 3.1))
    except Exception:
        pass
    kind = prop_text(props, 'building')
    if kind in {'church', 'basilica', 'cathedral', 'temple', 'public', 'government'}:
        return 17.0
    if kind in {'train_station', 'university', 'hospital', 'office', 'commercial', 'hotel'}:
        return 18.0
    if kind in {'ruins', 'grandstand'}:
        return 10.0
    if kind in {'garage', 'garages', 'kiosk', 'roof', 'greenhouse'}:
        return 5.5
    return 12.0


def color_tuple(hex_color, alpha=255):
    hex_color = hex_color.lstrip('#')
    return tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4)) + (alpha,)


def shade(hex_color, factor):
    rgb = np.array(color_tuple(hex_color)[:3], dtype=float)
    rgb = np.clip(rgb * factor, 0, 255).astype(int)
    return tuple(rgb.tolist()) + (255,)


class IsoProjector:
    def __init__(self, geometries, building_records):
        iso_boxes = []
        for geom in geometries:
            if geom.is_empty:
                continue
            minx, miny, maxx, maxy = geom.bounds
            points = [(minx, miny, 0), (minx, maxy, 0), (maxx, miny, 0), (maxx, maxy, 0)]
            iso_boxes.extend(self.raw_iso(*p) for p in points)
        for rec in building_records:
            minx, miny, maxx, maxy = rec['geometry'].bounds
            z = rec['height'] * Z_EXAGGERATION
            iso_boxes.extend(self.raw_iso(x, y, z) for x, y in [(minx, miny), (minx, maxy), (maxx, miny), (maxx, maxy)])
        min_ix = min(p[0] for p in iso_boxes)
        max_ix = max(p[0] for p in iso_boxes)
        min_iy = min(p[1] for p in iso_boxes)
        max_iy = max(p[1] for p in iso_boxes)
        self.scale = min((W * SS - 2 * MARGIN * SS) / (max_ix - min_ix), (H * SS - 2 * MARGIN * SS) / (max_iy - min_iy))
        used_w = (max_ix - min_ix) * self.scale
        used_h = (max_iy - min_iy) * self.scale
        self.offset_x = (W * SS - used_w) / 2 - min_ix * self.scale
        self.offset_y = (H * SS - used_h) / 2 - min_iy * self.scale

    @staticmethod
    def raw_iso(x, y, z=0):
        return ((x - y) * COS30, (x + y) * SIN30 - z)

    def point(self, x, y, z=0):
        ix, iy = self.raw_iso(x, y, z * Z_EXAGGERATION)
        return (ix * self.scale + self.offset_x, iy * self.scale + self.offset_y)

    def line(self, geom, z=0, simplify=0.0):
        if simplify:
            try:
                geom = geom.simplify(simplify, preserve_topology=True)
            except Exception:
                pass
        return [self.point(x, y, z) for x, y in geom.coords]

    def polygon(self, geom, z=0, simplify=0.0):
        if simplify:
            try:
                geom = geom.simplify(simplify, preserve_topology=True)
            except Exception:
                pass
        rings = []
        for poly in flatten_polygons(geom):
            exterior = [self.point(x, y, z) for x, y in poly.exterior.coords]
            holes = [[self.point(x, y, z) for x, y in ring.coords] for ring in poly.interiors]
            rings.append((exterior, holes, poly))
        return rings


def draw_ring(draw, points, fill, outline=None, width=1):
    if len(points) < 3:
        return
    draw.polygon(points, fill=fill)
    if outline and width > 0:
        draw.line(points + [points[0]], fill=outline, width=max(1, int(width)), joint='curve')


def draw_projected_polygon(draw, projector, geom, z, fill, outline=None, width=1, simplify=0.0, hole_fill=None):
    for exterior, holes, _poly in projector.polygon(geom, z=z, simplify=simplify):
        draw_ring(draw, exterior, fill, outline, width)
        if hole_fill:
            for hole in holes:
                draw_ring(draw, hole, hole_fill, outline, max(1, width // 2))


def draw_poly_shadow(draw, projector, geom, z, offset, alpha=42, simplify=0.4):
    for exterior, _holes, _poly in projector.polygon(geom, z=z, simplify=simplify):
        shifted = [(x + offset[0], y + offset[1]) for x, y in exterior]
        draw.polygon(shifted, fill=(67, 52, 35, alpha))


def draw_line(draw, points, fill, width):
    if len(points) < 2:
        return
    draw.line(points, fill=fill, width=max(1, int(round(width))), joint='curve')


def dashed_line(draw, points, fill, width, dash=10, gap=8):
    if len(points) < 2:
        return
    distances = [0]
    for i in range(1, len(points)):
        distances.append(distances[-1] + math.hypot(points[i][0] - points[i-1][0], points[i][1] - points[i-1][1]))
    total = distances[-1]
    d = 0.0
    while d < total:
        d2 = min(total, d + dash)
        segment = []
        for target in (d, d2):
            idx = 0
            while idx < len(distances) - 2 and distances[idx + 1] < target:
                idx += 1
            a, b = points[idx], points[idx + 1]
            span = max(0.001, distances[idx + 1] - distances[idx])
            f = (target - distances[idx]) / span
            segment.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
        draw.line(segment, fill=fill, width=max(1, int(width)))
        d += dash + gap


def add_background(image):
    w, h = image.size
    y = np.linspace(0, 1, h, dtype=np.float32)[:, None]
    x = np.linspace(0, 1, w, dtype=np.float32)[None, :]
    top = np.array([238, 231, 211], dtype=np.float32)
    bottom = np.array([218, 207, 181], dtype=np.float32)
    base = top * (1 - y[..., None]) + bottom * y[..., None]
    base = np.broadcast_to(base, (h, w, 3)).copy()
    vignette = ((x - .52) ** 2 * .55 + (y - .48) ** 2 * .75)
    base -= vignette[..., None] * 22
    noise = np.random.default_rng(SEED).normal(0, 1.15, (h, w, 1))
    base += noise
    arr = np.clip(base, 0, 255).astype(np.uint8)
    bg = Image.fromarray(arr, 'RGB').convert('RGBA')
    image.alpha_composite(bg)


def feature_name(props):
    return str(props.get('name') or props.get('@name') or props.get('name_latin') or '').strip()


def find_landmark_key(props, geom):
    name = feature_name(props).lower()
    centroid = geom.centroid
    lon, lat = TRANSFORM_TO_LL(centroid.x, centroid.y)
    for key, meta in LANDMARK_META.items():
        if any(token in name for token in meta['match']):
            return key
        mlon, mlat = meta['lonlat']
        if math.hypot((lon - mlon) * 82.0, (lat - mlat) * 111.0) < 0.10:
            return key
    return None


def building_palette(props, landmark):
    if landmark == 'colosseum':
        return '#b88962', '#d7c39d', '#8f6648'
    if landmark == 'pantheon':
        return '#c7aa83', '#d9d0bd', '#9a7c60'
    if landmark == 'stpeters':
        return '#e5dcc8', '#c7c0af', '#b1a48c'
    if landmark == 'castel':
        return '#b88b69', '#c9aa7c', '#8d674f'
    if landmark == 'termini':
        return '#d8d0bf', '#b9c0bb', '#a49b8c'
    if landmark == 'vittoriano':
        return '#eee8da', '#f4efe4', '#bcb3a2'
    if landmark == 'borghese':
        return '#eadfc5', '#c99767', '#b49d79'
    kind = prop_text(props, 'building')
    if kind in {'church', 'basilica', 'cathedral', 'chapel', 'temple'}:
        return '#ded1b7', '#c7bca7', '#ad9d84'
    if kind in {'ruins', 'grandstand'}:
        return '#b88463', '#c8a77f', '#8f654c'
    if kind in {'train_station', 'office', 'commercial', 'industrial'}:
        return '#cec6b3', '#b9b5a8', '#9f9788'
    if kind in {'school', 'university', 'hospital', 'government', 'public'}:
        return '#ddcaa7', '#c68d64', '#a58b6b'
    if kind in {'garage', 'garages', 'kiosk', 'roof', 'greenhouse'}:
        return '#c9b99e', '#b9855d', '#9a8267'
    palettes = [
        ('#e0c49c', '#c9825f', '#ac8764'),
        ('#e6cda8', '#bd7659', '#b08c68'),
        ('#d9b98e', '#ad745c', '#9d7b5d'),
        ('#e8cfa9', '#cf9865', '#af8b66'),
        ('#d6bd99', '#bf7f60', '#a28365'),
    ]
    idx = hash(feature_name(props) + prop_text(props, 'id')) % len(palettes)
    return palettes[idx]


def draw_building(draw, projector, rec, fonts):
    geom = rec['geometry']
    height = rec['height']
    landmark = rec.get('landmark')
    wall, roof, dark = building_palette(rec['properties'], landmark)
    polys = flatten_polygons(geom)
    if not polys:
        return
    shadow_offset = (height * projector.scale * .38, height * projector.scale * .23)
    for poly in polys:
        exterior, holes, _ = projector.polygon(poly, z=0, simplify=.55)[0]
        shifted = [(x + shadow_offset[0], y + shadow_offset[1]) for x, y in exterior]
        draw.polygon(shifted, fill=(70, 48, 31, 36))
    for poly in polys:
        exterior, holes, _ = projector.polygon(poly, z=0, simplify=.55)[0]
        roof_rings = projector.polygon(poly, z=height, simplify=.55)[0]
        roof_points, roof_holes, _ = roof_rings
        coords = list(poly.exterior.coords)
        if len(coords) > 2:
            for i in range(len(coords) - 1):
                x1, y1 = coords[i]
                x2, y2 = coords[i + 1]
                if math.hypot(x2 - x1, y2 - y1) < .7:
                    continue
                p1 = projector.point(x1, y1, 0)
                p2 = projector.point(x2, y2, 0)
                p3 = projector.point(x2, y2, height)
                p4 = projector.point(x1, y1, height)
                orient = ((x2 - x1) - (y2 - y1))
                face = dark if orient > 0 else wall
                if not landmark and height < 6:
                    face = shade(face, .93)
                draw.polygon([p1, p2, p3, p4], fill=face)
        draw_ring(draw, roof_points, roof, shade(dark, .82), max(1, projector.scale * SS * .28))
        for hole in roof_holes:
            courtyard = '#9f8c6d' if landmark == 'colosseum' else '#b8aa88'
            draw_ring(draw, hole, courtyard, shade(dark, .78), max(1, projector.scale * SS * .22))
        if landmark == 'colosseum':
            cx, cy = projector.point(poly.centroid.x, poly.centroid.y, height + .8)
            rx = max(6, (poly.bounds[2] - poly.bounds[0]) * projector.scale * .25)
            ry = max(4, (poly.bounds[3] - poly.bounds[1]) * projector.scale * .30)
            draw.ellipse((cx-rx, cy-ry, cx+rx, cy+ry), outline='#8d674f', width=max(2, int(2.2*SS)))
            draw.ellipse((cx-rx*.55, cy-ry*.50, cx+rx*.55, cy+ry*.50), outline='#e3d2aa', width=max(1, int(1.5*SS)))
        elif landmark == 'stpeters':
            cx, cy = projector.point(poly.centroid.x, poly.centroid.y, height + 2)
            rx = max(12, 18 * projector.scale * SS)
            ry = rx * .72
            draw.ellipse((cx-rx*1.05, cy-ry*.72, cx+rx*1.05, cy+ry*.72), fill='#d8d0bf', outline='#9f947e', width=2*SS)
            draw.pieslice((cx-rx, cy-ry*1.25, cx+rx, cy+ry*.75), 180, 360, fill='#b8c0b9', outline='#8f8776', width=2*SS)
            draw.line((cx, cy-ry*1.20, cx, cy-ry*1.72), fill='#8f8776', width=2*SS)
        elif landmark == 'pantheon':
            cx, cy = projector.point(poly.centroid.x, poly.centroid.y, height + .5)
            r = max(8, 13 * projector.scale * SS)
            draw.ellipse((cx-r, cy-r*.72, cx+r, cy+r*.72), fill='#c9c2b1', outline='#958875', width=2*SS)
            draw.ellipse((cx-r*.18, cy-r*.13, cx+r*.18, cy+r*.13), fill='#786f61')
        elif landmark == 'castel':
            cx, cy = projector.point(poly.centroid.x, poly.centroid.y, height + 1)
            r = max(10, 14 * projector.scale * SS)
            draw.ellipse((cx-r, cy-r*.70, cx+r, cy+r*.70), fill='#caa372', outline='#8a6248', width=2*SS)
            draw.ellipse((cx-r*.24, cy-r*.18, cx+r*.24, cy+r*.18), fill='#e0c99a')


def tree_points_for_polygon(poly, rng, max_count):
    minx, miny, maxx, maxy = poly.bounds
    area = poly.area
    count = min(max_count, max(2, int(area / 5200)))
    points = []
    attempts = count * 16
    for _ in range(attempts):
        if len(points) >= count:
            break
        p = Point(rng.uniform(minx, maxx), rng.uniform(miny, maxy))
        if poly.contains(p):
            points.append(p)
    return points


def draw_trees(draw, projector, green_records, building_geoms):
    rng = random.Random(SEED)
    candidates = []
    for rec in green_records:
        for poly in flatten_polygons(rec['geometry']):
            if poly.area > 3500:
                candidates.append(poly)
    candidates.sort(key=lambda p: p.area, reverse=True)
    building_union = unary_union([g for g in building_geoms if not g.is_empty]) if building_geoms else None
    budget = 520
    for poly in candidates:
        if budget <= 0:
            break
        points = tree_points_for_polygon(poly, rng, min(42, budget))
        budget -= len(points)
        for p in points:
            if building_union and building_union.contains(p):
                continue
            x, y = projector.point(p.x, p.y, 0)
            crown = rng.uniform(2.8, 5.8) * SS
            trunk_h = crown * rng.uniform(.75, 1.25)
            draw.ellipse((x+crown*.30, y+crown*.20, x+crown*1.15, y+crown*.65), fill=(67, 71, 45, 38))
            draw.line((x, y, x, y-trunk_h), fill='#6f5c3f', width=max(1, int(.7*SS)))
            color = rng.choice(['#6f8f5c', '#7d9863', '#8aa06a', '#668857'])
            draw.ellipse((x-crown, y-trunk_h-crown*.72, x+crown, y-trunk_h+crown*.72), fill=color, outline=(72, 104, 62, 150), width=max(1, SS // 2))


def label_landmarks(draw, projector, landmarks):
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf', 19 * SS)
        small = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 10 * SS)
    except Exception:
        font = ImageFont.load_default()
        small = font
    label_offsets = {
        'pantheon': (-120, -26), 'vittoriano': (-38, -18), 'colosseum': (104, -22),
        'stpeters': (-72, -20), 'castel': (108, -12), 'termini': (72, -18), 'borghese': (0, -8),
    }
    for lm in landmarks:
        dx, dy = label_offsets.get(lm['id'], (0, 0))
        x, y = (lm['x'] + dx) * SS, (lm['y'] + dy) * SS
        label = lm['name'].upper()
        if lm['id'] == 'borghese':
            label = 'VILLA BORGHESE'
        bbox = draw.textbbox((0, 0), label, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        y -= (lm.get('height', 15) * projector.scale * SS * Z_EXAGGERATION + 48 * SS)
        draw.rounded_rectangle((x-tw/2-11*SS, y-6*SS, x+tw/2+11*SS, y+th+9*SS), radius=7*SS, fill=(250, 246, 232, 210), outline=(139, 101, 70, 130), width=SS)
        draw.text((x-tw/2, y), label, font=font, fill='#5a3c2b')


def geometry_length(geom):
    return sum(line.length for line in flatten_lines(geom))


def clean_route_backtracks(points):
    points = list(points)
    changed = True
    while changed and len(points) >= 3:
        changed = False
        for i in range(1, len(points) - 1):
            ax, ay = points[i][0]-points[i-1][0], points[i][1]-points[i-1][1]
            bx, by = points[i+1][0]-points[i][0], points[i+1][1]-points[i][1]
            al = math.hypot(ax, ay)
            bl = math.hypot(bx, by)
            if al and bl and (ax*bx + ay*by) / (al*bl) < -.90:
                del points[i:i+2]
                changed = True
                break
    dedup = []
    for p in points:
        if not dedup or math.hypot(p[0]-dedup[-1][0], p[1]-dedup[-1][1]) > 1.5:
            dedup.append(p)
    return dedup


def route_points(projector, geom, simplify=1.2):
    best = None
    for line in flatten_lines(geom):
        pts = projector.line(line, z=0, simplify=simplify)
        pts = [(round(x / SS, 1), round(y / SS, 1)) for x, y in pts]
        dedup = []
        for p in pts:
            if not dedup or math.hypot(p[0]-dedup[-1][0], p[1]-dedup[-1][1]) > 1.5:
                dedup.append(p)
        dedup = clean_route_backtracks(dedup)
        if len(dedup) < 2:
            continue
        length = sum(math.hypot(dedup[i][0]-dedup[i-1][0], dedup[i][1]-dedup[i-1][1]) for i in range(1, len(dedup)))
        reversal = 0
        for i in range(1, len(dedup)-1):
            ax, ay = dedup[i][0]-dedup[i-1][0], dedup[i][1]-dedup[i-1][1]
            bx, by = dedup[i+1][0]-dedup[i][0], dedup[i+1][1]-dedup[i][1]
            al = math.hypot(ax, ay)
            bl = math.hypot(bx, by)
            if al and bl and (ax*bx + ay*by) / (al*bl) < -.72:
                reversal += 1
        score = length - reversal * 260
        if best is None or score > best[0]:
            best = (score, length, reversal, dedup)
    return best[3] if best else []


def choose_road_routes(road_records, projector):
    center = shapely_transform(TRANSFORM_TO_UTM, Point(12.4832, 41.8995))
    candidates = []
    for rec in road_records:
        highway = prop_text(rec['properties'], 'highway')
        if highway not in VEHICLE_HIGHWAYS:
            continue
        length = geometry_length(rec['geometry'])
        if length < 220:
            continue
        points = route_points(projector, rec['geometry'])
        if len(points) < 2:
            continue
        pixel_length = sum(math.hypot(points[i][0]-points[i-1][0], points[i][1]-points[i-1][1]) for i in range(1, len(points)))
        if pixel_length < 95:
            continue
        name = feature_name(rec['properties'])
        distance_to_center = rec['geometry'].centroid.distance(center)
        central_bonus = max(0, 3200 - distance_to_center) / 9
        score = pixel_length + central_bonus + (55 if name else 0) + {'trunk': 55, 'primary': 50, 'secondary': 35, 'tertiary': 18}.get(highway, 0)
        candidates.append((score, pixel_length, name, rec, points))
    candidates.sort(key=lambda item: item[0], reverse=True)
    routes = []
    used_names = set()
    for _score, _pixel_length, name, _rec, points in candidates:
        key = name.lower() if name else ''
        if key and key in used_names:
            continue
        routes.append(points)
        if key:
            used_names.add(key)
        if len(routes) >= 14:
            break
    if len(routes) < 10:
        for _score, _pixel_length, _name, _rec, points in candidates:
            if points not in routes:
                routes.append(points)
            if len(routes) >= 14:
                break
    return routes[:14]


def choose_rail_routes(rail_records, projector):
    candidates = []
    for rec in rail_records:
        if prop_text(rec['properties'], 'railway') != 'rail':
            continue
        length = geometry_length(rec['geometry'])
        if length > 450:
            candidates.append((length, rec))
    candidates.sort(key=lambda item: item[0], reverse=True)
    routes = []
    for _length, rec in candidates[:8]:
        points = route_points(projector, rec['geometry'], simplify=1.0)
        if len(points) >= 2:
            routes.append(points)
        if len(routes) >= 4:
            break
    return routes


def choose_river_route(water_records, projector):
    candidates = []
    for rec in water_records:
        if 'tevere' in feature_name(rec['properties']).lower() or prop_text(rec['properties'], 'waterway') == 'river':
            length = geometry_length(rec['geometry'])
            if length:
                candidates.append((length, rec))
    if not candidates:
        return []
    candidates.sort(key=lambda item: item[0], reverse=True)
    return route_points(projector, candidates[0][1]['geometry'], simplify=1.0)


def load_data():
    started = time.time()
    print('load buildings')
    buildings = merge_grouped(['buildings.ndjson', 'buildings_vat.ndjson'], ['Polygon', 'MultiPolygon'], key_prefix='building')
    print('buildings merged', len(buildings), f'{time.time()-started:.1f}s')
    buildings = to_utm(buildings)
    for rec in buildings:
        rec['landmark'] = find_landmark_key(rec['properties'], rec['geometry'])
        rec['height'] = building_height(rec['properties'], rec['landmark'])
        rec['area'] = rec['geometry'].area
    buildings = [rec for rec in buildings if rec['area'] > 10 or rec['landmark']]
    buildings.sort(key=lambda rec: rec['geometry'].centroid.x + rec['geometry'].centroid.y)
    print('buildings projected', len(buildings))

    print('load roads')
    roads = merge_grouped(
        ['roads.ndjson', 'roads_vat.ndjson'], ['LineString', 'MultiLineString'],
        lambda props, _obj: prop_text(props, 'highway') in RENDER_HIGHWAYS,
        key_prefix='road'
    )
    roads = to_utm(roads)
    roads.sort(key=lambda rec: list(RENDER_HIGHWAYS).index(prop_text(rec['properties'], 'highway')) if prop_text(rec['properties'], 'highway') in RENDER_HIGHWAYS else 99)
    print('roads merged/projected', len(roads))

    print('load rail/water/green')
    rails = to_utm(merge_grouped(['rail.ndjson'], ['LineString', 'MultiLineString'], lambda p, _o: prop_text(p, 'railway') in {'rail', 'tram', 'subway'}, key_prefix='rail'))
    water_lines = to_utm(merge_grouped(['waterways.ndjson'], ['LineString', 'MultiLineString'], key_prefix='waterline'))
    water_polys = to_utm(merge_grouped(['waterways.ndjson', 'base.ndjson'], ['Polygon', 'MultiPolygon'], lambda p, o: (o.get('layer') == 'water' and prop_text(p, 'class') in WATER_CLASSES) or prop_text(p, 'natural_class') == 'water', key_prefix='water'))
    green = to_utm(merge_grouped(['base.ndjson'], ['Polygon', 'MultiPolygon'], lambda p, _o: prop_text(p, 'class') in GREEN_CLASSES or prop_text(p, 'subtype') in GREEN_CLASSES or prop_text(p, 'class') in {'forest', 'wood'} or prop_text(p, 'subtype') in {'forest', 'grass', 'shrub'}, key_prefix='green'))
    print('rails', len(rails), 'water lines', len(water_lines), 'water polygons', len(water_polys), 'green', len(green))
    return buildings, roads, rails, water_lines, water_polys, green


def make_landmarks(buildings, green, projector):
    found = {}
    for rec in buildings:
        key = rec.get('landmark')
        if key and key not in found:
            found[key] = rec['geometry'].centroid
    # Se Villa Borghese non ha ancora un edificio associato, usa il parco più vicino alle coordinate OSM canoniche.
    if 'borghese' not in found and green:
        target_ll = LANDMARK_META['borghese']['lonlat']
        target = shapely_transform(TRANSFORM_TO_UTM, Point(*target_ll))
        nearest = min((g['geometry'] for g in green), key=lambda geom: geom.distance(target), default=None)
        if nearest is not None:
            found['borghese'] = nearest.centroid
    landmarks = []
    for key, meta in LANDMARK_META.items():
        point = found.get(key)
        if point is None:
            point = shapely_transform(TRANSFORM_TO_UTM, Point(*meta['lonlat']))
        x, y = projector.point(point.x, point.y, 0)
        x /= SS
        y /= SS
        height = building_height({}, key)
        landmarks.append({
            'id': key, 'name': meta['name'], 'italian': meta['italian'], 'era': meta['era'],
            'x': round(x, 1), 'y': round(y, 1), 'width': 1120 if key in {'ancient'} else 980,
            'height': height, 'description': meta['description'],
            'lonlat': [round(meta['lonlat'][0], 6), round(meta['lonlat'][1], 6)],
        })
    return landmarks


def render(buildings, roads, rails, water_lines, water_polys, green, projector, landmarks):
    print('render canvas')
    image = Image.new('RGBA', (W * SS, H * SS), (0, 0, 0, 0))
    add_background(image)
    draw = ImageDraw.Draw(image, 'RGBA')

    # Ombra morbida territoriale e trama di fondo.
    texture = Image.effect_noise((W * SS // 2, H * SS // 2), 12).resize((W * SS, H * SS), Image.Resampling.BILINEAR)
    texture = texture.point(lambda p: 118 + int((p - 128) * .08)).convert('L')
    overlay = Image.new('RGBA', image.size, (255, 249, 230, 0))
    overlay.putalpha(texture.point(lambda p: max(0, p - 112)))
    image.alpha_composite(overlay)
    draw = ImageDraw.Draw(image, 'RGBA')

    # Verde prima della rete varia.
    green_order = sorted(green, key=lambda rec: rec['geometry'].area)
    for rec in green_order:
        cls = prop_text(rec['properties'], 'class') or prop_text(rec['properties'], 'subtype')
        fill = {
            'forest': '#8fa878', 'wood': '#93aa78', 'grass': '#b2c58d', 'park': '#a6bd82',
            'garden': '#aec589', 'scrub': '#aab47f', 'shrub': '#acb37f', 'nature_reserve': '#9ab57c',
        }.get(cls, '#a8ba84')
        draw_projected_polygon(draw, projector, rec['geometry'], 0, fill, '#7e9a66', max(1, .6*projector.scale*SS), simplify=1.0)

    # Acqua: poligoni + centerline del Tevere e corsi minori.
    for rec in water_polys:
        cls = prop_text(rec['properties'], 'class')
        if cls == 'swimming_pool':
            continue
        draw_projected_polygon(draw, projector, rec['geometry'], 0, '#6d9aa5', '#527d88', max(1, .8*projector.scale*SS), simplify=.9)
    for rec in water_lines:
        waterway = prop_text(rec['properties'], 'waterway')
        width_m = {'river': 32, 'canal': 9, 'stream': 5, 'drain': 2.5}.get(waterway, 2.5)
        for line in flatten_lines(rec['geometry']):
            pts = projector.line(line, simplify=1.0)
            draw_line(draw, pts, '#4f7b85', width_m * projector.scale * SS * 1.18)
            draw_line(draw, pts, '#78a8af', width_m * projector.scale * SS)
            if waterway == 'river':
                draw_line(draw, pts, (215, 238, 232, 108), max(1, width_m * projector.scale * SS * .22))

    # Strade: prima i percorsi minori, poi quelli maggiori.
    order = {'pedestrian': 0, 'living_street': 0, 'service': 1, 'residential': 2, 'unclassified': 2, 'tertiary': 3, 'tertiary_link': 2, 'secondary': 4, 'secondary_link': 3, 'primary': 5, 'primary_link': 4, 'trunk': 6, 'trunk_link': 5, 'motorway': 7, 'motorway_link': 6}
    for rec in sorted(roads, key=lambda rec: order.get(prop_text(rec['properties'], 'highway'), 1)):
        highway = prop_text(rec['properties'], 'highway')
        width_m = ROAD_WIDTH_M.get(highway, 4)
        casing = '#837461' if highway not in {'pedestrian', 'living_street'} else '#a3937f'
        fill = '#eee4d1' if highway not in {'pedestrian', 'living_street'} else '#dfd4bd'
        if highway in {'primary', 'trunk', 'motorway'}:
            fill = '#eadfc8'
        for line in flatten_lines(rec['geometry']):
            pts = projector.line(line, simplify=.85)
            width = max(1.5 * SS, width_m * projector.scale * SS)
            draw_line(draw, pts, casing, width * 1.25)
            draw_line(draw, pts, fill, width)
            if highway in {'primary', 'secondary', 'tertiary', 'trunk'} and line.length > 120:
                dashed_line(draw, pts, (255, 255, 255, 128), max(1, .42*SS), dash=9*SS, gap=13*SS)

    # Ferrovie e tranvie sopra il terreno, sotto gli edifici alti.
    for rec in rails:
        for line in flatten_lines(rec['geometry']):
            pts = projector.line(line, simplify=.8)
            draw_line(draw, pts, '#4d514d', max(2.2 * SS, 3.0 * projector.scale * SS))
            draw_line(draw, pts, '#d7d1bd', max(1.1 * SS, 1.3 * projector.scale * SS))
            if line.length > 100:
                dashed_line(draw, pts, '#4d514d', max(1, .75*SS), dash=2*SS, gap=8*SS)

    # Edifici ordinati per profondità isometrica.
    fonts = None
    for rec in buildings:
        draw_building(draw, projector, rec, fonts)

    # Chiome sopra i tetti bassi dei parchi.
    draw_trees(draw, projector, green, [rec['geometry'] for rec in buildings])

    # Piccole targhe cartografiche, con alone leggibile.
    label_landmarks(draw, projector, landmarks)

    # Firma in basso, disegnata nella base ma non invasiva.
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 10 * SS)
    except Exception:
        font = ImageFont.load_default()
    draw.text((W*SS-330*SS, H*SS-34*SS), 'OSM · Overture Maps · Copernicus Sentinel-2 · Open-Meteo', font=font, fill=(91, 74, 55, 150))

    print('downsample')
    image = image.resize((W, H), Image.Resampling.LANCZOS).convert('RGB')
    return image


def save_dzi(image):
    MAP_DIR.mkdir(parents=True, exist_ok=True)
    image.save(MAP_DIR / 'rome-painted.jpg', quality=93, subsampling=0, optimize=True, progressive=True)
    image.resize((1280, 800), Image.Resampling.LANCZOS).save(MAP_DIR / 'preview.jpg', quality=88, optimize=True, progressive=True)
    dzi = f'''<?xml version="1.0" encoding="UTF-8"?>\n<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008"><Size Width="{W}" Height="{H}"/></Image>\n'''
    (MAP_DIR / 'rome.dzi').write_text(dzi)
    files_dir = MAP_DIR / 'rome_files'
    files_dir.mkdir(exist_ok=True)
    max_level = math.ceil(math.log2(max(W, H)))
    tile_count = 0
    for level in range(max_level + 1):
        scale = 2 ** (max_level - level)
        lw = max(1, math.ceil(W / scale))
        lh = max(1, math.ceil(H / scale))
        level_image = image.resize((lw, lh), Image.Resampling.LANCZOS) if scale != 1 else image
        level_dir = files_dir / str(level)
        level_dir.mkdir(exist_ok=True)
        for tx in range(math.ceil(lw / 256)):
            for ty in range(math.ceil(lh / 256)):
                tile = level_image.crop((tx*256, ty*256, min(lw, (tx+1)*256), min(lh, (ty+1)*256)))
                tile.save(level_dir / f'{tx}_{ty}.jpg', quality=90, optimize=True)
                tile_count += 1
    return tile_count


def write_outputs(buildings, roads, rails, water_lines, water_polys, green, landmarks, road_routes, rail_routes, river_route, tile_count):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    generated = {
        'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'bbox': BBOX,
        'dimensions': {'width': W, 'height': H, 'tileSize': 256, 'tiles': tile_count},
        'sources': [
            {'name': 'OpenStreetMap contributors via HOT Export/HDX', 'license': 'ODbL-1.0', 'layers': ['buildings ITA/VAT', 'roads ITA/VAT', 'railways', 'waterways', 'POI']},
            {'name': 'Overture Maps Foundation base theme', 'license': 'ODbL-1.0 / ESA WorldCover CC-BY-4.0 for land_cover', 'layers': ['land', 'land_cover', 'water']},
            {'name': 'Copernicus Sentinel-2 L2A', 'use': 'reference preview only, acquisition 2024-08-12'},
        ],
        'buildings': [
            {'id': rec['id'], 'name': feature_name(rec['properties']), 'type': prop_text(rec['properties'], 'building'), 'height': round(rec['height'], 1), 'area': round(rec['area'], 1), 'landmark': rec.get('landmark')}
            for rec in buildings
        ],
        'roads': [
            {'id': rec['id'], 'name': feature_name(rec['properties']), 'highway': prop_text(rec['properties'], 'highway'), 'length': round(geometry_length(rec['geometry']), 1)}
            for rec in roads
        ],
        'railways': [
            {'id': rec['id'], 'name': feature_name(rec['properties']), 'railway': prop_text(rec['properties'], 'railway'), 'length': round(geometry_length(rec['geometry']), 1)}
            for rec in rails
        ],
        'water': [
            {'id': rec['id'], 'name': feature_name(rec['properties']), 'class': prop_text(rec['properties'], 'class') or prop_text(rec['properties'], 'natural_class'), 'area': round(rec['geometry'].area, 1)}
            for rec in water_polys
        ] + [
            {'id': rec['id'], 'name': feature_name(rec['properties']), 'waterway': prop_text(rec['properties'], 'waterway'), 'length': round(geometry_length(rec['geometry']), 1)}
            for rec in water_lines
        ],
        'green': [
            {'id': rec['id'], 'name': feature_name(rec['properties']), 'class': prop_text(rec['properties'], 'class') or prop_text(rec['properties'], 'subtype'), 'area': round(rec['geometry'].area, 1)}
            for rec in green
        ],
        'landmarks': landmarks,
        'routes': {
            'roads': road_routes,
            'railways': rail_routes,
            'river': river_route,
            'note': 'Le coordinate sono nello spazio immagine della base isometrica e derivano dalle geometrie OSM/HDX renderizzate.',
        },
    }
    (DATA_DIR / 'rome-osm.json').write_text(json.dumps(generated, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')

    views = {
        'overview': {'x': W/2, 'y': H/2, 'width': W*.84},
        'ancient': {'x': next(l['x'] for l in landmarks if l['id'] == 'colosseum'), 'y': next(l['y'] for l in landmarks if l['id'] == 'colosseum'), 'width': 1180},
        'vatican': {'x': next(l['x'] for l in landmarks if l['id'] == 'stpeters'), 'y': next(l['y'] for l in landmarks if l['id'] == 'stpeters'), 'width': 1080},
        'termini': {'x': next(l['x'] for l in landmarks if l['id'] == 'termini'), 'y': next(l['y'] for l in landmarks if l['id'] == 'termini'), 'width': 1080},
        'borghese': {'x': next(l['x'] for l in landmarks if l['id'] == 'borghese'), 'y': next(l['y'] for l in landmarks if l['id'] == 'borghese'), 'width': 1120},
    }
    js = [
        '// Generated from public/data/rome-osm.json. Le rotte sono geometryRoute OSM renderizzate sulla stessa base.',
        f'export const GEOMETRY_SOURCE = "./data/rome-osm.json";',
        f'export const IMAGE_WIDTH = {W};',
        f'export const IMAGE_HEIGHT = {H};',
        '',
        f'export const VIEWS = {json.dumps(views, ensure_ascii=False, indent=2)};',
        '',
        f'export const LANDMARKS = {json.dumps([{k: v for k, v in lm.items() if k not in {"height", "lonlat"}} for lm in landmarks], ensure_ascii=False, indent=2)};',
        '',
        f'export const ROAD_ROUTES = {json.dumps(road_routes, separators=(",", ":"))};',
        '',
        f'export const RAIL_ROUTES = {json.dumps(rail_routes, separators=(",", ":"))};',
        '',
        f'export const RIVER_ROUTE = {json.dumps(river_route, separators=(",", ":"))};',
        '',
        "export const VEHICLE_COLORS = ['#d9d1bd', '#a64732', '#dbad42', '#476778', '#778367', '#eee9dc', '#744d43'];",
        '',
    ]
    (ROOT / 'src' / 'data.js').write_text('\n'.join(js), encoding='utf-8')
    return generated


def main():
    started = time.time()
    buildings, roads, rails, water_lines, water_polys, green = load_data()
    projector_geometries = [rec['geometry'] for rec in buildings + roads + rails + water_lines + water_polys + green]
    projector = IsoProjector(projector_geometries, buildings)
    print('projection scale', projector.scale, 'offsets', projector.offset_x, projector.offset_y)
    landmarks = make_landmarks(buildings, green, projector)
    road_routes = choose_road_routes(roads, projector)
    rail_routes = choose_rail_routes(rails, projector)
    river_route = choose_river_route(water_lines, projector)
    print('routes', len(road_routes), len(rail_routes), len(river_route))
    if len(road_routes) < 8 or len(rail_routes) < 2 or len(river_route) < 2:
        raise RuntimeError(f'Route generation insufficient: roads={len(road_routes)} rails={len(rail_routes)} river={len(river_route)}')
    image = render(buildings, roads, rails, water_lines, water_polys, green, projector, landmarks)
    tile_count = save_dzi(image)
    generated = write_outputs(buildings, roads, rails, water_lines, water_polys, green, landmarks, road_routes, rail_routes, river_route, tile_count)
    print(json.dumps({
        'buildings': len(buildings), 'roads': len(roads), 'rails': len(rails), 'water': len(generated['water']),
        'green': len(green), 'landmarks': len(landmarks), 'routes': [len(road_routes), len(rail_routes), len(river_route)],
        'tiles': tile_count, 'seconds': round(time.time() - started, 1),
    }, indent=2))


if __name__ == '__main__':
    main()
