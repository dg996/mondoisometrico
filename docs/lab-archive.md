# Archivio del laboratorio su Cloudflare R2

Bucket privato `mondoisometrico-lab` (account Cloudflare del progetto, nessun URL pubblico), separato
da `mondoisometricotiles` (le tile pubblicate).

| Oggetto | Contenuto | Verifica |
| --- | --- | --- |
| `backups/2026-11-12/backup-2026-11-12.tar.part-aa…al` + `SHA256SUMS` | copia del 12/11/2026 di `roma-core` e `roma-inner`: finestre dipinte (PNG) e render prima di stile romano / CTRN (2,4 GB) | ogni parte riscaricata e confrontata con sha256: 12/12 identiche |

Ripristino:

```sh
mkdir restore && cd restore
for p in aa ab ac ad ae af ag ah ai aj ak al; do
  npx wrangler r2 object get mondoisometrico-lab/backups/2026-11-12/backup-2026-11-12.tar.part-$p --file part-$p --remote
done
cat part-* | tar -xf -        # ricrea roma-core/backup-2026-11-12 e roma-inner/backup-2026-11-12
```

Le finestre dipinte locali sono in WebP senza perdita (`pipeline/src/migrate-windows.ts`, pixel verificati).

## Sincronizzazione continua (dal 12/11/2026)

R2 è la base del laboratorio. `pipeline/src/lab-sync.ts --loop 30` gira mentre si dipinge: ogni 30 minuti
raccoglie i file nuovi o cambiati di `data/derived/<area>/` (`windows`, `render`, `height`, `paint`,
manifest e report QA) in pacchetti tar da circa 200 MB e li carica in `mondoisometrico-lab/lab/`.
Ogni pacchetto viene riscaricato e confrontato con sha256 prima di essere registrato in
`data/lab-sync.json`. `lab/index.json` dice, per ogni file, il pacchetto con la sua ultima versione.

Ripristino completo (i pacchetti in ordine: i più recenti sovrascrivono i vecchi):

```sh
npx wrangler r2 object get mondoisometrico-lab/lab/index.json --file index.json --remote
for b in $(node -e 'console.log(require("./index.json").batches.join(" "))'); do
  npx wrangler r2 object get mondoisometrico-lab/lab/$b --file $b --remote && tar -xf $b -C data && rm $b
done
```

Un'area finita e verificata su R2 può essere tolta dal Mac e riscaricata quando serve. Non succede
in automatico: solo su decisione esplicita.
