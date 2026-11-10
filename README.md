# Mondo Isometrico

Mappa isometrica di **Roma** costruita da open data.

**Sito:** [mondoisometrico.domenicogagliardi.com](https://mondoisometrico.domenicogagliardi.com)

## Cosa c’è

- Regione `roma-centro` (origine: Piazza Venezia, heading 45°)
- Città `/roma` (default) — Pantheon / centro storico
- Area di test `pantheon` (~800 m: Pantheon → Piazza Navona)
- Tile su Cloudflare R2 (`mondoisometricotiles`), sito su Vercel + Worker Cloudflare

## Avvio rapido

Serve Node 24+, Chromium/Chrome (`CHROME_PATH`), e per publish/deploy un account Cloudflare + wrangler.

```sh
cp .env.example .env   # TILES_ORIGIN, CLOUDFLARE_ACCOUNT_ID, SITE_DOMAIN
npm install
npm run dev            # http://localhost:<port>/roma
```

Batch Roma, QA e rilascio unico: **[docs/roma-quality-batch.md](docs/roma-quality-batch.md)**.
Hosting e DNS: **[HOSTING.md](HOSTING.md)**.  
Regole pipeline / agenti: **[AGENTS.md](AGENTS.md)**.

## Pipeline (patch di test)

```sh
npm -w pipeline run boundaries -- roma-centro
npm run fetch -- pantheon
npm run ground -- pantheon
npm run scene -- pantheon
npm run render -- pantheon -j 2
npm run paint -- pantheon --center 41.8986,12.4769   # Codex CLI; rivedere prima di espandere
npm run export -- pantheon
npm run publish -- roma-centro   # solo con conferma esplicita
npx vercel --prod              # solo dopo QA e publish R2 del batch completo
```

## Licenza

Codice: [MIT](LICENSE).  
Immagini della mappa: CC BY 4.0 + crediti dati in [ATTRIBUTION.md](ATTRIBUTION.md).

---

Basato su [Isometric World](https://github.com/krasun/isometricworld) di Dmytro Krasun.
