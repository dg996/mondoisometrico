# Handoff — Roma isometrica 2D (versione OSM/Overture)

Questo documento permette a un altro modello/sviluppatore di riprendere il lavoro senza contesto precedente.

## Cos'è

`app/` è un viewer web statico (Vite + OpenSeadragon 5) che mostra Roma in isometrico 2D.
La mappa NON è un'illustrazione libera: è renderizzata da geometrie vettoriali reali.

- Edifici: 35.888 footprint OSM (HDX/HOT Italia + Città del Vaticano), estrusi in isometrico con muri/tetti/ombre.
- Strade 947, ferrovie 62, acqua 560, aree verdi 79 (OSM + Overture `base`, land cover ESA WorldCover 2021).
- 7 landmark verificati: Colosseo, Pantheon, San Pietro, Castel Sant'Angelo, Termini, Vittoriano, Villa Borghese.
- Traffico: 48 auto, 6 bus, 4 treni, 3 battelli. Le rotte sono generate dalle STESSE geometrie OSM renderizzate (`public/data/rome-osm.json` → `src/data.js`), quindi i veicoli non attraversano edifici/monumenti. **Il traffico è simulato, non un feed ATAC/GPS live** — il dialog "Dati e fonti" nell'app lo dichiara.
- Meteo reale Open-Meteo (cache localStorage, label LIVE / ULTIMO DATO) + orario Europe/Rome; overlay canvas per pioggia/nuvole/sole/notte.

## Pipeline di build della mappa

```bash
cd app
npm install
node scripts/extract-rome-vector.mjs    # PMTiles HDX/Overture -> .cache/rome-extract/*.ndjson
pip install shapely pyproj pillow numpy
python3 scripts/build-rome-map.py       # NDJSON -> public/map/* (Deep Zoom) + public/data/rome-osm.json + src/data.js
npm run build                           # vite build + copia public/ + assertion di integrità -> dist/
```

- `extract-rome-vector.mjs`: scarica tile PMTiles (HDX `hotosm_ita_*` z12/z13, `hotosm_vat_*`, Overture `base` z12) e decodifica MVT (`@mapbox/vector-tile` + `pbf` v5, usare `PbfReader`). Scrive NDJSON via file `.tmp` + rename (il mount FUSE perdeva file con scritture dirette).
- `build-rome-map.py`: unisce feature clippate per ID, proietta EPSG:4326→32633 (PyProj), renderizza supersampled 2× con Pillow, downsampling LANCZOS, genera tile JPEG 256×256 + `rome.dzi`. Costanti chiave: `BBOX = (12.43, 41.87, 12.53, 41.93)`, `Z_EXAGGERATION = 2.65`, proiezione `raw_iso(x,y,z)=((x-y)cos30, (x+y)sin30-z)`. Include `clean_route_backtracks()` per rimuovere i ritorni a "V" delle route estratte da tile MVT clippate.
- Output generati (NON committati, vedi sotto): `public/map/rome_files/*.jpg` (225 tile), `public/map/rome-painted.jpg`, `public/map/preview.jpg`, `public/map/rome.dzi`, `public/data/rome-osm.json` (~4.5MB), `src/data.js`.

## Perché gli asset binari non sono nel repo

Il push è avvenuto via GitHub API (MCP), che accetta solo contenuto testuale: i JPEG delle tile e il dataset da 4.5MB non erano inviabili. Sono però **riproducibili deterministicamente** con i due comandi sopra.

Per rigenerarli in CI è pronta la workflow in `app/ci/build-map-assets.yml`: spostarla in `.github/workflows/build-map-assets.yml` (serve un token con scope `workflow`), poi lanciarla da **Actions → build-map-assets → Run workflow**. La action installa le dipendenze, esegue extract+build e committa `app/public/` su `main`. Dopo il commit, Vercel ri-builda e il sito si aggiorna.

Nota: finché gli asset non sono presenti, `npm run build` fallisce deliberatamente (assertion di integrità) e Vercel mantiene online l'ultimo deploy funzionante.

`public/data/sentinel-rome.jpg` (anteprima Sentinel-2 mostrata nel dialog fonti) non è rigenerata dalla pipeline: se assente, la figura si nasconde da sola (`onerror` in `index.html`) e la build non fallisce per questo file. Per ripristinarla: scaricare un'anteprima Sentinel-2 L2A su Roma dal Copernicus Data Space Browser e salvarla in `app/public/data/sentinel-rome.jpg`.

## Verifica

```bash
cd app
python3 verifier/v1/verify.py    # 9 controlli: dataset, landmark, route, viewport, mobile
```

- Criteri in `verifier/v1/criteria.md`; run registrati (append-only) in `verifier/runs/v1.jsonl`, indice in `verifier/README.md`.
- Ultimo run prima del push: **9/9 passati** (2026-11-12T15:35Z).
- Collaudo browser fatto con Playwright/Chromium (desktop 1440×900, mobile 375×812, fixture meteo pioggia): zero errori console/page/http/tile, nessun overflow mobile, touch target ≥44px, export PNG OK.

## Note oneste / limiti noti

- Rendering interpretato da OSM: NON è carta tecnica/catastale. Dichiarato nel dialog fonti.
- Traffico simulato su geometrie reali, non posizioni reali dei mezzi.
- Copernicus DEM GLO-30 valutato ma NON usato nel rendering (download troppo lento); Sentinel-2 solo come anteprima documentaria. Non dichiarare il DEM come fonte del rendering.
- Su mobile i pin monumenti sono marker da 17px con hitbox 44×44px (accessibilità) — volutamente discreti.

## Fonti e licenze

Vedi `app/CREDITS.md`: © OpenStreetMap contributors (ODbL 1.0), HDX/HOT, Overture Maps, ESA WorldCover 2021, Copernicus Sentinel-2, Open-Meteo, OpenSeadragon, Fontsource.
