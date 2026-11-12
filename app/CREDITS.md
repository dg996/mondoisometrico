# Crediti e provenienza dei dati

## Dati geografici

- **OpenStreetMap contributors** — geometrie di edifici, strade, ferrovie, Tevere, punti di interesse e monumenti, distribuite sotto Open Database License (ODbL 1.0).
- **Humanitarian Data Exchange / HOT Export** — export PMTiles nazionali OSM per Italia e Città del Vaticano, dataset aggiornati a ottobre/novembre 2026: edifici, strade, ferrovie, corsi d’acqua e POI.
- **Overture Maps Foundation** — tema `base`, release tile 2026-10-21, per aree verdi, copertura del suolo e superfici d’acqua. I layer derivano da OpenStreetMap e, per `land_cover`, da ESA WorldCover 2021.
- **Copernicus Sentinel-2 L2A** — anteprima documentaria `S2A_32TQM_20240812_0_L2A`, acquisizione 12 agosto 2024, usata come riferimento territoriale nel pannello fonti. Non è un flusso satellitare live.
- **Open-Meteo** — condizioni correnti per il centro di Roma: temperatura, precipitazioni, copertura nuvolosa, vento e indicatore giorno/notte. Il client aggiorna la richiesta ogni dieci minuti e, se la rete non è disponibile, dichiara quando mostra l’ultimo dato memorizzato.

## Rendering e tecnica

- La base isometrica 4096 × 2560 è generata localmente dalle geometrie vettoriali OSM/Overture: impronte edilizie estruse, strade, binari, Tevere, parchi e monumenti. È una restituzione cartografica illustrata, non una mappa catastale o un rilievo metrico.
- **OpenSeadragon**, licenza BSD-3-Clause — navigazione Deep Zoom della piramide di tile JPEG generata dalla base.
- **Vite** — bundle dei moduli JavaScript e degli asset locali.
- **Canvas 2D** — veicoli e atmosfera animati sopra la base; **HTML/CSS** — controlli, schede e finestre informative.
- **Manrope** e **Cormorant Garamond**, distribuiti localmente tramite i pacchetti Fontsource sotto le rispettive licenze open-font.

## Ispirazione

- **Isometric World** di Dmytro Krasun — https://github.com/krasun/isometricworld — ha ispirato l’architettura a tile, la vista isometrica e gli overlay animati. Nessun codice o asset di quel repository è incluso in questo progetto.

## Interpretazione e limiti

Auto, bus, treni e battelli seguono traiettorie deterministiche simulate sulle stesse geometrie stradali, ferroviarie e fluviali visibili nella mappa: non sono posizioni GPS, dati ATAC o feed di traffico in tempo reale. L’orologio usa il fuso `Europe/Rome`; sole, nuvole, pioggia e oscuramento notturno derivano dai dati Open-Meteo correnti o dall’ultimo dato disponibile esplicitamente indicato.
