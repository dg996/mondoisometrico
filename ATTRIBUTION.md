# Licenze, fonti dati e attribution

Tutto sulla mappa è costruito da open data. Non si usano Google, Apple, Bing o altri contenuti
proprietari (immagini, tile 3D, geometrie), nemmeno come riferimento.

## Questo repository

| Cosa | Licenza |
|---|---|
| Codice sorgente (`pipeline/`, `web/`, script) | [MIT](LICENSE) |
| Immagini della mappa (tile pubblicati), `video/`, `pipeline/style/` | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) di Domenico Gagliardi, **più i crediti dati sotto**, da mantenere con ogni copia |

Le immagini e i video sono *Produced Works* sotto ODbL (vedi OpenStreetMap): la loro licenza è
libera, ma l’avviso OpenStreetMap deve restare. Le immagini dipinte con AI possono non essere
protette da copyright ovunque; dove lo sono, si applica CC BY 4.0.

## Riga di credito

Mostrata in mappa (footer), in modalità video e su ogni clip; usarla su repost, caption e end card:

> Map data © OpenStreetMap contributors · Terrain: Copernicus DEM © DLR, Airbus DS · Painted with AI

Ogni regione elenca le proprie righe in `pipeline/src/places.ts` (`credits`).

## Fonti dati

| Fonte | Uso | Licenza | Obblighi |
|---|---|---|---|
| [OpenStreetMap](https://www.openstreetmap.org/copyright) (via Overpass API) | suolo (strade, marciapiedi, parchi, acqua, ferrovia, landuse), edifici e alberi a Roma (attuale), confini comunali, strade per il traffico simulato | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) | "© OpenStreetMap contributors" visibile con mappa e video. Immagini e video sono Produced Works. Il database derivato non è redistribuito: `pipeline/` è il metodo pubblicato per ricrearlo. |
| [Copernicus DEM GLO-30](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM) (AWS Open Data) | altezza del terreno | Licenza Copernicus DEM: libera, anche uso commerciale | "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved". |

### Previsti (non ancora collegati)

| Fonte | Uso previsto | Licenza | Note |
|---|---|---|---|
| [Regione Lazio DBT 2014](https://geoportale.regione.lazio.it/) | footprint edifici + altezze | CC BY 4.0 | Migliori delle altezze OSM; citare quando aggiunti a `fetch.ts` / `scene.ts`. |
| [Roma Capitale GeoRoma](https://geoportale.comune.roma.it/) (WFS/WMS) | layer comunali | [CC BY 4.0](https://dati.comune.roma.it/od/it/legal.page) | Controllare i metadati del layer; citare Roma Capitale. |

Nessuno di questi dati è nel repository: `npm run fetch` li scarica in `data/` (ignorato da git).

## Dipingere con AI

I tile del render vengono ripittati dal modello immagini di OpenAI tramite Codex CLI (account ChatGPT)
oppure, con `PAINT_BACKEND=agentgw`, dal servizio di generazione immagini agent-gw (Kimi).
I termini OpenAI assegnano i diritti sull’output all’utente. Nessun credito obbligatorio; mappa e clip
dicono "Painted with AI" perché le piattaforme sociali chiedono di etichettare i contenuti AI.

I file in `pipeline/style/` sono stati dipinti allo stesso modo nel progetto a monte: `reference.png`,
`trees.png` e `sea.png`.

## Software

[three.js](https://threejs.org) (MIT), [OpenSeadragon](https://openseadragon.github.io) (BSD-3-Clause),
[Astro](https://astro.build) (MIT), [sharp](https://sharp.pixelplumbing.com) (Apache-2.0),
[Playwright](https://playwright.dev) (Apache-2.0), [esbuild](https://esbuild.github.io) (MIT),
[tsx](https://tsx.is) (MIT), [FFmpeg](https://ffmpeg.org) (LGPL/GPL, solo strumento esterno),
[gifsicle](https://www.lcdf.org/gifsicle/) (GPL-2.0, solo strumento esterno).

Questo non è un parere legale.

---

Basato su [Isometric World](https://github.com/krasun/isometricworld) di Dmytro Krasun.
