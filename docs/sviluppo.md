# Sviluppo

Note tecniche del progetto (spostate dal README, che ora presenta il progetto).
Regole per chi lavora sul codice: **[AGENTS.md](../AGENTS.md)**. Hosting, DNS e rilascio: **[HOSTING.md](../HOSTING.md)**.
Fonti e licenze dei dati: **[ATTRIBUTION.md](../ATTRIBUTION.md)**.

## Cosa c’è

- Regione `roma-centro` (origine: Piazza Venezia, heading 45°)
- Città `/roma` (default): centro storico
- Area di test `pantheon` (~800 m: Pantheon → Piazza Navona); area principale `roma-inner`
- Tile e dati su Cloudflare R2 (`mondoisometricotiles`); sito su Vercel (funzioni in `api/`)

## Avvio

Serve Node 24+, Chromium/Chrome (`CHROME_PATH`), e per la pubblicazione un account Cloudflare + wrangler e la CLI Vercel.

```sh
cp .env.example .env   # TILES_ORIGIN, CLOUDFLARE_ACCOUNT_ID, SITE_DOMAIN
npm install
npm run dev            # http://localhost:<port>/roma
```

In locale `?ora=21:30` e `?meteo=sereno|nuvoloso|pioggerella|rovesci|pioggia|temporale|nebbia`
forzano luce e meteo (sul sito pubblicato valgono sempre ora e meteo reali di Roma).

Batch Roma, QA e rilascio: **[roma-quality-batch.md](roma-quality-batch.md)**.

## Pipeline (patch di test)

```sh
npm -w pipeline run boundaries -- roma-centro
npm run fetch -- pantheon
npm run ground -- pantheon
npm run scene -- pantheon
npm run render -- pantheon -j 2
npm run paint -- pantheon --center 41.8986,12.4769   # Codex CLI; rivedere prima di espandere
npm run paint -- pantheon --assemble                 # monta le finestre dipinte nelle tessere
npm run export -- pantheon
npm run publish -- roma-centro   # solo con conferma esplicita
npm run deploy                   # Vercel produzione, solo dopo il publish R2
```

Controlli: `node --import tsx pipeline/src/traffic-overlap-audit.ts 15` (traffico e strisce),
`node --import tsx pipeline/src/landmark-audit.ts roma-inner` (monumenti contro OSM e Wikidata).
