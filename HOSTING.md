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

## 3. Sito Vercel e rilascio manuale

Produzione: https://mondoisometrico.vercel.app e dominio custom indicato sopra.
La root del progetto usa `vercel.json`: build `npm run build`, output `web/dist`.
`TILES_ORIGIN` deve essere configurato anche nell'ambiente di build Vercel.

Per il batch Roma seguire **[docs/roma-quality-batch.md](docs/roma-quality-batch.md)**:
scene/render/paint/export locali, controllo completo, poi **un solo** publish R2
seguito da **un solo** `npx vercel --prod` dalla root.

`world.json` viene inviato per ultimo e solo dopo il controllo dei riferimenti su R2.
Non modificare il manifest a mano. Nessun deploy a metà batch.
I deploy automatici Git sono disabilitati per `main` e per il branch della PR del batch,
così push e merge non anticipano la pubblicazione manuale.

Il Worker Cloudflare resta un backup: `npm run deploy` pubblica quel Worker,
**non** il sito Vercel, e non va usato nel rilascio Roma descritto qui.

## 4. DNS

Il CNAME `mondoisometrico` deve seguire il valore mostrato da **Vercel** per il dominio
collegato; il dominio delle tile segue quello mostrato da **R2**. Non sostituire i
record funzionanti con i vecchi esempi del Worker. Il rilascio del batch non richiede
modifiche DNS.
