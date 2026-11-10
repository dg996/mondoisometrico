# Roma: geometria, colori e area completata

Base: main `1b09257`, dopo il merge della PR #1. Branch: `fix/roma-map-integrity`.

## Prima / dopo nel codice

| Problema negli screenshot | Correzione | Verifica necessaria sul Mac |
| --- | --- | --- |
| Auto luminose nella zona nera | Maschera delle singole tile dipinte; grafo tagliato ai confini e ai tratti invisibili, margine per carrozzerie e marciapiedi, clip finale. Senza metadati della maschera le animazioni restano disattivate. | Pan verso i bordi e nei buchi; nessun veicolo o gatto oltre la zona pronta. Voli e pappagalli sono sospesi perché avevano percorsi non delimitati. |
| Render incompleto quasi nero | Contesto sfocato a colori attenuati su fondo chiaro. Blur con gutter dei vicini prima del taglio delle web tile. | Nessun bordo nero o cucitura tra le tile di contesto. |
| Tonalità diverse | Tolto CLAHE per finestra. Compensazione RGB limitata, stimata sulle stesse coordinate delle sovrapposizioni; mantiene la media cromatica di ogni componente. Assemblaggio bloccato se il residuo supera 12/255. | Tetti, piazze, parchi e Tevere: nessuna fascia di esposizione/colore. `palette-qa.json` indica i vicini da ridipingere se il controllo fallisce. |
| Ponti deformati / doppia strada | Impalcato 3D nel render e nel pass delle altezze; profilo comune al traffico, da tutta la way OSM, ancorato alle rive. Rimosse le strade SVG sovrapposte al dipinto. | Ponte Garibaldi, Ponte Cestio, Ponte Fabricio e lungotevere. Ponti pedonali senza auto. Nessun arco o pilone inventato: dettagli storici mancanti richiedono ancora controllo della pittura. |
| Monumenti e isolati generici | Import di `building:part`, `min_height`, tetti e colori OSM; cortili interni mantenuti. Una semplice area turistica/archeologica non diventa un palazzo. L'involucro viene sostituito solo da parti con copertura sufficiente. | Pantheon: pronao a nord, cupola dietro. Vittoriano: terrazze e ingresso verso Piazza Venezia, niente appartamenti sulle gradinate. Colosseo: arena aperta. Trevi: Palazzo Poli e bacino nella posizione del render. |
| Etichette spostate | Quote MSL ed ellissoidiche distinte; paint ed export usano lo stesso punto del terreno. `world.landmarks` conserva gli ancoraggi. | Le etichette indicano il punto geografico; se l'immagine è spostata va rigenerata, non si sposta il pin per nascondere l'errore. |
| Area limitata | Attivata `roma-nord`: Flaminio–Ponte Milvio, bbox `[41.925,12.450,41.950,12.510]`. Stessa camera, fonti e pipeline. | L'estensione diventa attiva solo con nuove tile dipinte ed export. 150 tile render, 90 nuove rispetto a core+inner; 242 finestre paint, fino a 160 per la sola parte aggiunta. |

Fonti geometriche: [OSM Pantheon](https://www.openstreetmap.org/relation/3374342), [Vittoriano](https://www.openstreetmap.org/relation/1849830), [Colosseo](https://www.openstreetmap.org/relation/1834818), [Trevi](https://www.openstreetmap.org/relation/13448560), ODbL, attribuzione già inclusa nel progetto. Nessuna immagine proprietaria usata. [UNESCO Heritage of Astronomy](https://web.astronomicalheritage.net/index.php/show-entity?identity=28&tmpl=system) conferma ingresso nord e diametro interno della cupola del Pantheon di 43,3 m; il tetto viene separato dal tamburo. [VIVE](https://vive.cultura.gov.it/it/vittoriano/cosa-vedere/ingresso-principale) descrive il Vittoriano sul versante nord del Campidoglio con ingresso su Piazza Venezia. Gli azimut dei prompt sono indicativi; le geometrie OSM non vengono ruotate.

## Verifiche effettuate e limiti

- TypeScript pipeline e web; build Astro con il public tile origin configurato.
- Test deterministici: cinque minuti di traffico, buchi della maschera, ponti/quote, colori, blur tra tile, parti/cortili nella CLI scene, indici R2 e world-last.
- Prova locale isolata con estratti OSM reali: conservate parti e cortili nei bin di Pantheon, Colosseo e Vittoriano; nessun dato di produzione modificato.
- Test Chromium aggiunto, ma **non eseguito con successo qui**: il sandbox nega `socket()` all'avvio del browser. Richiede `MONDO_BROWSER_TESTS=1` sul Mac.
- **Nessuna rigenerazione AI, pubblicazione R2, deploy Vercel o verifica live di questa revisione.** I dati del Mac e le tile dipinte non sono disponibili in questo ambiente. Il codice non corregge retroattivamente i PNG già pubblicati. Altri monumenti (San Pietro, Castel Sant'Angelo, Teatro di Marcello e archi) restano da controllare visivamente dopo la rigenerazione; non sono certificati da questa revisione.

## Batch sul Mac: preparazione locale

Prima controllare i job esistenti; non avviare contemporaneamente un secondo render/paint/export o un watcher che pubblica. Conservare `data/`, `.env` e `data/web-state/`; non aggiungerli a Git.

```sh
cd /Users/domenicogagliardi/Desktop/mondoisometrico
git fetch origin
git switch fix/roma-map-integrity
git pull --ff-only
npm ci
node --import tsx --test pipeline/src/*.test.ts
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" MONDO_BROWSER_TESTS=1 node --import tsx --test pipeline/src/map-browser.test.ts
```

Usare `roma-inner` come fonte canonica, perché comprende `roma-core`. Questo evita di ridipingere il centro due volte con palette diverse. `fetch` aggiunge `building-parts.json` anche a una cache OSM vecchia, senza cancellare `osm.json`. Il render va rifatto perché include nuovi impalcati e parti degli edifici.

```sh
npm run fetch -- roma-inner
npm run ground -- roma-inner
npm run scene -- roma-inner
npm run render -- roma-inner --force -j 2
npm run paint -- roma-inner --force -j 2

npm run fetch -- roma-nord
npm run ground -- roma-nord
npm run scene -- roma-nord
npm run render -- roma-nord --force -j 2
npm run paint -- roma-nord --context roma-inner -j 2

# Identico grafo cromatico per entrambe le aree, finestre condivise ai confini.
npm run paint -- roma-inner --context roma-nord --assemble
npm run paint -- roma-nord --context roma-inner --assemble
npm run export -- roma-inner roma-nord --require-painted --check-coverage
npm run export -- roma-inner roma-nord --require-painted
npm run dev
```

Se l'assemblaggio segnala finestre duplicate discordanti, conservarle entrambe e scegliere una versione canonica prima di riprendere: non vengono sovrascritte automaticamente. Se la QA cromatica fallisce, correggere le finestre elencate nel report; non abbassare la soglia per pubblicare. Le stime temporali richiedono un campione sul Mac: `finestre × secondi medi / parallelismo`, più retry e rate limit. Il modello resta quello del Codex CLI con account ChatGPT; nessuna nuova API a pagamento viene configurata. Il completamento dell'intero inner richiede molte più finestre delle sole 90 tile nuove.

Aprire il server locale sui quattro monumenti e sui ponti, guardare anche i confini a più zoom. Le finestre devono rimanere nitide e allineate. Controllare `data/derived/{roma-inner,roma-nord}/palette-qa.json`. Eseguire `node --import tsx pipeline/src/traffictest.ts URL_LOCALE 5` quando l'export nuovo è caricato. Solo dopo questa verifica creare un **nuovo** `/tmp/mondo-logs/BATCH_READY`; un marker rimasto da un batch precedente non vale.

## Un solo rilascio finale

Il push di questo branch non deve avviare deploy automatici; `vercel.json` mantiene il blocco anche per `main`. Il merge resta al proprietario. Dopo merge, sincronizzare `main` e ripetere i controlli locali se sono arrivati altri cambiamenti. Solo con batch verificato:

```sh
cd /Users/domenicogagliardi/Desktop/mondoisometrico
test -f /tmp/mondo-logs/BATCH_READY && npm run publish -- roma-centro --yes && npx vercel --prod
```

Questo è un solo publish R2 seguito da un solo deploy; non eseguirlo anche tramite il vecchio `/tmp/mondo-final-publish.sh`. `publish.ts` continua a caricare `world.json` per ultimo e a verificare tutti gli indici/preview su R2. Non modificare world.json manualmente. Verificare gli stessi luoghi su produzione dopo il rilascio.
