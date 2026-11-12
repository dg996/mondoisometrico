# Mondo Isometrico

Mappa isometrica 2D di Roma costruita da dati aperti (OpenStreetMap/HDX, Overture Maps), con traffico simulato vincolato alle geometrie reali, meteo e orario di Roma in tempo reale.

## Layout del repository

- `app/` — **versione corrente**: viewer Vite + OpenSeadragon. La base cartografica è un'immagine Deep Zoom generata da una pipeline Python (Pillow + Shapely) a partire da estratti PMTiles OSM/Overture.
- `pipeline/`, `web/`, `worker/` — codebase precedente (render 3D + paint pipeline), mantenuta per riferimento storico. Non fa più parte del deploy.

## Quickstart (nuova versione)

```bash
cd app
npm install
node scripts/extract-rome-vector.mjs   # scarica estratti PMTiles OSM/Overture in .cache/
python3 scripts/build-rome-map.py      # richiede: pip install shapely pyproj pillow numpy
npm run build                          # produce dist/ con assertion di integrità
npm run dev                            # sviluppo locale
```

Dettagli completi in [HANDOFF.md](HANDOFF.md) e [app/CREDITS.md](app/CREDITS.md).

## Deploy

Vercel builda `app/` (vedi `vercel.json`). Gli asset binari generati (tile Deep Zoom, dataset) **non sono nel repo**: si rigenerano con la pipeline sopra. Una GitHub Action pronta è in `app/ci/build-map-assets.yml` — va spostata in `.github/workflows/` (il token OAuth usato per il push non aveva lo scope `workflow`, quindi non è stato possibile committarla direttamente lì).

## Fonti dati

- © OpenStreetMap contributors (ODbL 1.0), estratti HDX/HOT per Italia e Città del Vaticano
- Overture Maps (base theme, include ESA WorldCover 2021)
- Meteo: Open-Meteo (senza API key)
- Copernicus Sentinel-2 L2A come riferimento documentario
