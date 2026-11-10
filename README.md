# Mondo Isometrico

Isometric map of **Rome** from open data. Fork of
[Isometric World](https://github.com/krasun/isometricworld) by Dmytro Krasun.

**Site (planned):** [mondoisometrico.domenicogagliardi.com](https://mondoisometrico.domenicogagliardi.com)

## What’s in this fork

- Region `roma-centro` (origin: Piazza Venezia, heading 45°)
- City `/roma` (default) — Pantheon / centro storico
- Test area `pantheon` (~800 m: Pantheon → Piazza Navona) — paint this first
- Branding, R2 bucket `mondoisometricotiles`, Worker `mondoisometrico`
- OSM + Copernicus only for now (Tel Aviv GIS skipped); see [ATTRIBUTION.md](ATTRIBUTION.md)

## Quick start

Needs Node 24+, Chromium/Chrome (`CHROME_PATH`), and for publish/deploy a Cloudflare account + wrangler.

```sh
cp .env.example .env   # fill TILES_ORIGIN, CLOUDFLARE_ACCOUNT_ID, SITE_DOMAIN
npm install
npm run dev            # http://localhost:<port>/roma
```

Hosting and GoDaddy DNS: **[HOSTING.md](HOSTING.md)**.  
Adding cities / pipeline rules: **[AGENTS.md](AGENTS.md)**.

## Pipeline (test patch)

```sh
npm -w pipeline run boundaries -- roma-centro
npm run fetch -- pantheon
npm run ground -- pantheon
npm run scene -- pantheon
npm run render -- pantheon -j 2
npm run paint -- pantheon --center 41.8986,12.4769   # Codex CLI; review before expanding
npm run export -- pantheon
npm run publish -- roma-centro   # only with go-ahead
npm run deploy
```

## Licence

Code: [MIT](LICENSE) (upstream © Dmytro Krasun; this fork © Domenico Gagliardi).  
Map imagery: CC BY 4.0 + data credits in [ATTRIBUTION.md](ATTRIBUTION.md).
