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
I deploy automatici Git sono abilitati (`git.deploymentEnabled: true` in `vercel.json`):
ogni push su un branch collegato crea un deployment Vercel. Le tile restano su R2 e
richiedono comunque `npm run publish` separato.

`npm run deploy` pubblica il sito su **Vercel** in produzione (`vercel deploy --prod`), come il push su
`main`. Il Worker Cloudflare (`worker/`, `wrangler.jsonc`) resta solo come backup e non è più il percorso
di rilascio.

Funzioni Vercel (`api/`), variabili d'ambiente del progetto Vercel:
- `api/p.ts`: proxy statistiche Pirsch su `/p/*` (riscrittura in `vercel.json`), `PIRSCH_ACCESS_KEY`.
- `api/feedback.ts`: il pulsante "Segnala un problema o un'idea" crea una issue su GitHub con etichette
  `feedback` + `bug`/`idea`, `GITHUB_TOKEN` (fine-grained, solo questo repository, Issues: read and write).
  Senza token la pagina apre `issues/new` già compilata.
- `api/traffic.ts`: il pulsante "Traffico in tempo reale" colora le strade con il traffico TomTom
  (tile vettoriali del flusso, zoom 13, 16 tile per aggiornamento), `TOMTOM_API_KEY` (developer.tomtom.com).
  Un aggiornamento ogni 10 minuti per tutto il sito (cache in memoria + CDN Vercel), tetto rigido di
  5.000 richieste di tile al giorno: la quota gratuita TomTom è di 200.000 al mese. Senza chiave il
  pulsante dice "non disponibile al momento". La chiave non va mai nel repository.

## 4. DNS

Il CNAME `mondoisometrico` deve seguire il valore mostrato da **Vercel** per il dominio
collegato; il dominio delle tile segue quello mostrato da **R2**. Non sostituire i
record funzionanti con i vecchi esempi del Worker. Il rilascio del batch non richiede
modifiche DNS.
