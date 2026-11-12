#!/usr/bin/env python3
from pathlib import Path
import json, re, sys
root = Path(__file__).resolve().parents[2]
checks = []

def check(name, ok, detail=''):
    checks.append({'name': name, 'ok': bool(ok), 'detail': detail})

source = root / 'public' / 'data' / 'rome-osm.json'
check('OSM geometry dataset exists', source.exists(), str(source))
if source.exists():
    data = json.loads(source.read_text())
    counts = {k: len(data.get(k, [])) for k in ['buildings','roads','railways','water','green','landmarks']}
    check('OSM geometry counts sufficient', counts['buildings'] >= 500 and counts['roads'] >= 100 and counts['railways'] >= 2 and counts['water'] >= 1 and counts['green'] >= 20 and counts['landmarks'] >= 7, json.dumps(counts))
    lms = {x.get('id') for x in data.get('landmarks', [])}
    required = {'colosseum','pantheon','stpeters','castel','termini','vittoriano','borghese'}
    check('Required landmarks geocoded', required <= lms, json.dumps(sorted(lms)))

map_js = (root / 'src' / 'map.js').read_text()
traffic_js = (root / 'src' / 'traffic.js').read_text()
data_js = (root / 'src' / 'data.js').read_text()
check('Map uses OSM-derived geometry', 'rome-osm.json' in map_js or 'rome-osm.json' in data_js, '')
check('Traffic follows rendered routes', 'geometryRoute' in traffic_js or 'osm' in traffic_js.lower(), '')
check('No decorative vehicle route crossing map', 'ROAD_ROUTES' not in data_js or 'geometry' in data_js, '')

index = (root / 'index.html').read_text()
check('Viewport meta present', '<meta name="viewport"' in index, '')
check('No placeholder href', 'href="#"' not in index, '')
css = (root / 'src' / 'style.css').read_text()
fixed = [line for line in css.splitlines() if re.search(r'(?<![-\w])(?:width|min-width):\s*(?:3[7-9][6-9]|[4-9]\d{2}|\d{4,})px', line) and '@media' not in line]
check('No unscoped fixed mobile widths >375px', not fixed, json.dumps(fixed[:5]))

failed = [c for c in checks if not c['ok']]
print(json.dumps({'checks': checks, 'passed': len(checks)-len(failed), 'failed': len(failed)}, indent=2))
sys.exit(1 if failed else 0)
