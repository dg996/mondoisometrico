# Hosting · Mondo Isometrico

**Perché Cloudflare + Vercel:** le migliaia di tile deep-zoom stanno su **R2** (Cloudflare);
il sito statico Astro è su **Vercel** al dominio custom. `npm run publish` carica le tile su R2.

**Sito:** https://mondoisometrico.domenicogagliardi.com  
**Worker (backup):** https://mondoisometrico.mondoisometrico.workers.dev  
Tile: bucket R2 `mondoisometricotiles` (origine pubblica in `TILES_ORIGIN`)

Account ID: `b82ec99b9bba59f1cec4aaa790a9c635`

## 1. Cloudflare account

1. Create / log into Cloudflare.
2. Note **Account ID** (Workers & Pages → Overview → Account ID) → `CLOUDFLARE_ACCOUNT_ID` in `.env`.
3. Install and log in: `npx wrangler login`.

## 2. R2 bucket for tiles

```sh
npx wrangler r2 bucket create mondoisometricotiles
```

- Enable a **public custom domain** on the bucket, e.g. `tiles.mondoisometrico.domenicogagliardi.com`
  (Cloudflare → R2 → bucket → Settings → Public access → Custom Domains).
- CORS: allow any origin, methods `GET` and `HEAD`.
- Put the public HTTPS origin (no trailing slash) in `.env` as `TILES_ORIGIN`.

## 3. Site Worker

`.env`:

```
SITE_DOMAIN=mondoisometrico.domenicogagliardi.com
TILES_ORIGIN=https://tiles.mondoisometrico.domenicogagliardi.com
CLOUDFLARE_ACCOUNT_ID=…
# optional: CLOUDFLARE_API_TOKEN=…  (R2 Object Read & Write)
```

Worker name in `wrangler.jsonc`: `mondoisometrico`.

Deploy (after a local `npm run build` has produced `web/dist`):

```sh
npm run deploy
```

That runs `wrangler deploy --domain mondoisometrico.domenicogagliardi.com`.

Optional analytics: `npx wrangler secret put PIRSCH_ACCESS_KEY`.

## 4. DNS on GoDaddy (`domenicogagliardi.com`)

Add these records (TTL 600 or default):

| Type | Name | Value | Notes |
|------|------|-------|--------|
| CNAME | `mondoisometrico` | target shown by Cloudflare after attaching the Worker custom domain (often `mondoisometrico.<account>.workers.dev` or Cloudflare’s domain instructions) | Site |
| CNAME | `tiles.mondoisometrico` | target from R2 custom domain setup | Tile CDN |

If GoDaddy refuses a CNAME on a name that already has records, remove conflicts first.
After DNS propagates, Cloudflare will issue TLS certificates automatically.

**Do not** point this subdomain at Vercel — the stack is Cloudflare only.

## 5. First map publish (after pipeline)

```sh
npm run fetch -- pantheon
npm run ground -- pantheon
npm run scene -- pantheon
npm run render -- pantheon -j 2
# paint only when ready (Codex CLI): npm run paint -- pantheon --center 41.8986,12.4769
npm run export -- pantheon
npm run publish -- roma-centro    # asks [y/N]; uploads to R2
npm run deploy                    # rebuild site against new world.json
```

Never run `publish` / `deploy` without an explicit go-ahead for production.
