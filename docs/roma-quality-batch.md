# Roma: verifica del batch e rilascio unico

Base della PR: `main@d403cda`. Branch: `fix/roma-quality-batch`.
Il codice è verificabile senza `data/`; le nuove immagini richiedono il Mac. Nessun export di produzione, upload R2 o deploy è stato eseguito da questa PR. Il confronto sotto descrive le correzioni del codice e il risultato da verificare sulle nuove tile, **non** un dopo già pubblicato.

## Prima / dopo

| Punto | Prima | Correzione e risultato atteso | Verifica ancora richiesta |
| --- | --- | --- | --- |
| Auto e bus | Fiancate/cofano/tetto bus usavano quote assolute 0–3 m, mentre la strada era a circa 60 m ENU: poligoni verticali fuori scala. Visibilità verificata al centro e senza convertire la direzione inversa. | Tutti i vertici includono la quota stradale; controllo dell'intero corpo in entrambe le direzioni, anche al cambio strada e respawn. Campioni radi o discontinui vengono rifiutati. | Nuove roads e osservazione dei ponti per almeno 5 minuti. |
| Acqua, tetti, ponti | La quota poteva essere ricavata dalla superficie visibile di un edificio; una depressione poteva essere promossa a ponte; l'impalcato veniva sollevato arbitrariamente. | Export dal terreno ENU del renderer; campioni ogni 2 m; acqua OSM, larghezza della carreggiata e sagoma fino al tetto bus controllate con height pass. Ponti solo con tag OSM e due ancoraggi asciutti; quota interpolata lungo la lunghezza. Mancanza di supporto/occlusione nasconde il tratto. | Il DEM non è un rilievo dell'impalcato: ponti parziali, sopraelevate senza quota affidabile o occlusioni ambigue restano nascosti. La pittura AI può ancora spostare bordi: serve controllo visivo. |
| Pantheon | Hint senza direzione geografica; possibile pronao specchiato e spostamento tra finestre. | Pronao a nord verso Piazza della Rotonda, alto-sinistra sullo schermo; rotunda a sud. Hint anche nelle finestre che tagliano il monumento, senza ricentrarlo. | Rigenerare e controllare cupola/oculo/pronao, soprattutto sulle giunzioni. |
| Trevi | Il bacino poteva diventare un blocco alto 26 m; hint troppo generico e scala piccola. | Bacino basso, Palazzo Poli distinto, facciata sud/sud-est verso il bacino; dimensioni ancorate all'impronta OSM. | Facciata riconoscibile, bacino ampio, niente fontanina isolata. |
| Colosseo | Estrusioni/impronte improprie e hint senza asse esplicito; tile tagliate e vuoti adiacenti nel prima. | Esclusi i percorsi pedonali aperti dalle impronte dei monumenti; asse WNW–ESE, ellisse cava e parete meridionale rotta richieste nel paint. | Arena aperta, archi, assenza di blocchi residenziali e continuità su tutte le tile. |
| Vittoriano | Ali confuse con palazzi ocra; pulizia della piazza troppo ampia poteva cancellare edifici reali. | Fronte N/NO verso Piazza Venezia, marmo bianco; pulizia limitata a piccoli ostacoli anonimi. Altezze OSM esplicite prevalgono sui fallback. | Scalinata, colonnato, quadrighe; palazzi storici circostanti preservati. |
| Colori/copertura | 933 render e 84 dipinti nel manifest osservato; AABB playable di 110 tile: 26 tile non dipinte. L'ultimo tentativo poteva superare QA fallita, e i monumenti avevano una deroga fino a 0,32. | Soglia geometrica 0,45, nessuna deroga sull'ultimo tentativo, errore dopo tre tentativi falliti. Palette romana esplicita. Rettangolo fissabile, elenco dei buchi e blocco dell'export completo se mancano render o paint. | Copertura 110/110 non dimostra nitidezza: confrontare tetti, piazze e cuciture a zoom nativo e durante il toggle Foto. |
| Estensione | Core/inner, nessun piano quantitativo. | Tre proposte inattive in `areas.ts` e conteggio riproducibile in `area-plan.ts`. | Approvare un batch separato dopo avere completato quello attuale. |
| Pubblicazione | Un riferimento immutato poteva essere valido su R2 ma assente dalla cache incrementale locale, causando un blocco errato. | Verifica remota di tutti gli indici/preview dopo gli upload e prima di `world.json`; cache e stato preservati in caso di errore. | Verificare da browser anche le tile nominate dagli indici. |

La soluzione per le auto combina **export come fonte della geometria e dell'occlusione** e difesa nel client per interpolazione/disegno. Un solo filtro percentuale in `traffic.ts` non può correggere una quota esportata sbagliata.

## Orientamento: fonti e camera

Non cambiare origine né heading. Con `heading=45°`, `pitch=45°`, `mpp=0,25`, un metro verso nord si proietta in `(-2,828, -2)` pixel: **alto-sinistra**. Est è alto-destra; sud basso-destra. Non bisogna ruotare il Pantheon di 180° solo per mostrarne la facciata alla camera.

| Monumento | Coordinate del riferimento | Evidenza OSM | Orientamento da rispettare |
| --- | --- | --- | --- |
| Pantheon | 41.898616, 12.476833 | [relation 3374342](https://www.openstreetmap.org/relation/3374342); [Piazza della Rotonda, way 1295329514](https://www.openstreetmap.org/way/1295329514) a nord | Pronao N; rotunda S. |
| Trevi | 41.900978, 12.483285 | [relation 13448560](https://www.openstreetmap.org/relation/13448560); [Palazzo Poli, way 131235596](https://www.openstreetmap.org/way/131235596) dietro a nord | Facciata S/SE, bacino davanti verso basso-destra. |
| Colosseo | 41.890210, 12.492231 | [relation 1834818](https://www.openstreetmap.org/relation/1834818), asse principale calcolato sui vertici esterni: circa 115°/295° | WNW–ESE; non un cerchio o un'ellisse girata verso nord. |
| Vittoriano | 41.894687, 12.483066 | [relation 1849830](https://www.openstreetmap.org/relation/1849830); [Piazza Venezia, way 713360712](https://www.openstreetmap.org/way/713360712) a N/NO | Scalinata verso la piazza, retro verso Campidoglio. |

Controllo OSM effettuato il 10 novembre 2026 sui dati API dei quattro riquadri. Le direzioni di Trevi e Vittoriano sono dedotte dalle impronte e dalla posizione delle piazze; l'asse del Colosseo è una stima geometrica, non un rilievo. Conferme descrittive: [UNESCO Astronomy, Pantheon](https://web.astronomicalheritage.net/index.php/show-entity?idunescowhc=91), [Turismo Roma, Palazzo Poli](https://www.turismoroma.it/en/node/1471).

La scena conserva le impronte georeferenziate; le forme dettagliate (cupole, archi, statue) sono ancora affidate alla pittura. Non sono stati aggiunti modelli 3D architettonici completi.

Altri difetti individuati: Castel Sant'Angelo appariva tagliato al limite dipinto; Palazzo Poli poteva essere confuso con il bacino; la vecchia pulizia radiale poteva eliminare costruzioni autentiche attorno ai monumenti. Non c'è evidenza sufficiente per dichiarare San Pietro o altri edifici ruotati male. I pin usano quote approssimate e non sono un riferimento affidabile per misurare lo spostamento dell'arte.

## Proposta di estensione, non attivata

Le bbox sono `sud,ovest,nord,est`. Non sono confini amministrativi. Contano i centri tile nella proiezione corrente, escludendo dalla colonna nuove quelle già coperte dall'unione core/inner (933 tile).

| Area proposta | Bbox | Render totali | Nuove tile | Finestre paint intera area / sole nuove tile |
| --- | --- | ---: | ---: | ---: |
| Flaminio / Ponte Milvio | 41.925,12.450,41.950,12.510 | 150 | 90 | 242 / 160 |
| Garbatella / San Paolo | 41.840,12.455,41.870,12.510 | 164 | 109 | 256 / 181 |
| Pigneto / Torpignattara / Centocelle | 41.865,12.530,41.905,12.580 | 199 | 139 | 307 / 225 |

Ordine consigliato: nord per continuità Flaminio/Tevere, sud per la varietà urbana di Garbatella, poi est. Le nuove tile sono 338, ma aggiungere aree geografiche non rende automaticamente sicura la loro AABB: prima del successivo allargamento playable va coperto tutto il rettangolo scelto, inclusi eventuali angoli intermedi. Le finestre confinanti necessarie all'assemblaggio sono già incluse nei conteggi.

Stime di budget, **non benchmark del Mac**: render 5–20 s/tile, 3 worker e 30% di margine danno circa **5–22 / 6–24 / 7–29 minuti** per le tre aree complete. Esclusi download DEM/OSM, ground, scene ed export AVIF. Pittura a 2–8 minuti/finestra e 3 job: circa **3,5–14 / 3,7–15 / 4,5–18 ore** con lo stesso margine, primo tentativo; fino a tre tentativi, rate limit e finestre sequenziali possono allungare molto il batch. Misurare i primi 20 render e 10 paint sul Mac prima di impegnare l'intera area.

Costi: la pipeline usa Codex CLI con login ChatGPT, non una API a consumo per immagine. Nessun nuovo servizio da attivare; **€0 di acquisti aggiuntivi solo se il batch rientra nelle quote del piano esistente**. Quote/crediti disponibili non sono stati verificati. Elettricità puramente indicativa: assumendo 100 W e €0,30/kWh, €0,03/ora; 12–47 ore di paint iniziale per tutte le aree valgono circa €0,36–1,41, retry esclusi.

R2 Standard: $0,015/GB-mese oltre la quota gratuita; $4,50/milione scritture e $0,36/milione letture, con arrotondamento delle unità fatturabili. Quote mensili incluse: 10 GB, 1M scritture, 10M letture; egress diretto gratuito ([listino ufficiale verificato](https://developers.cloudflare.com/r2/pricing/)). Ipotesi di capacità, non misurazione: 0,3–1 MB esportati per nuova tile considerando entrambi i layer e le piramidi → circa 0,10–0,34 GB per 338 tile, circa 3.600 oggetti prima degli effetti sui bordi. Se l'account resta nelle quote, extra R2 $0; oltre quota calcolare la differenza sulle unità arrotondate e sullo storico già conservato, non promettere una fattura di frazioni di centesimo. Nessuna stima del traffico visitatori o dei costi del piano Vercel senza dati di utilizzo.

Ricalcolo senza dati locali:

```sh
node --import tsx pipeline/src/area-plan.ts
```

## Validazione del codice

24 test passati (`node --import tsx --test pipeline/src/*.test.ts`), compresi 13 casi traffico/terreno, 3 copertura e 8 pubblicazione con rete simulata. TypeScript su pipeline e web e build Astro completati. La build non certifica le nuove immagini.

Limite preesistente: `npm run typecheck` chiama `astro check`, che in questa combinazione di dipendenze rifiuta TypeScript 7.0.2. Non è stato modificato il lockfile per aggirarlo; i comandi sotto usano il compilatore TypeScript direttamente. Il controllo dei template Astro tramite quel comando resta aperto.

## Comandi sul Mac: preparazione locale

Non lanciare questi comandi in parallelo ai vecchi paint/export/watchers. Prima controllare `pgrep -fl 'paint.ts|render.ts|export.ts|publish.ts|paint-parallel|paint-phase2|finish-watcher|final-publish'` e i log in `/tmp/mondo-logs`: lasciare terminare i job utili e impedire che un vecchio watcher esegua un rilascio autonomo. Non cancellare `data/`, cache o `web-state/` per ripartire.

Dopo avere salvato eventuali modifiche locali al codice, selezionare il branch della PR (oppure `main` dopo il merge approvato). Non fare reset forzati. `.env` deve essere quella esistente sul Mac, con `CHROME_PATH`, `TILES_ORIGIN` e autenticazioni già configurate.

```sh
cd /Users/domenicogagliardi/Desktop/mondoisometrico
git fetch origin
git switch fix/roma-quality-batch
git pull --ff-only origin fix/roma-quality-batch
npm ci
node --import tsx pipeline/src/traffictest.ts --fixtures
node --import tsx --test pipeline/src/*.test.ts
npm -w pipeline run typecheck
npx tsc --noEmit -p web
```

Rigenerare le scene e i render con le correzioni, conservando i dati grezzi e il terreno esistenti. Il render ora restituisce un errore se fallisce anche una tile. Se mancano ground/scene input, usare prima `npm run fetch`, `npm run ground` e `npm -w pipeline run boundaries -- roma-centro` come documentato nel README; non sostituire i dati con screenshot di mappe proprietarie.

```sh
set -e
npm run scene -- roma-core
npm run scene -- roma-inner
npm run render -- roma-core --force -j 3
npm run render -- roma-inner --force -j 3
npm run export -- roma-core roma-inner --art-bounds=-6144,-5120,5120,5120 --check-coverage
npm run paint -- roma-inner --art-bounds=-6144,-5120,5120,5120 --plan
```

Il rettangolo attuale è 11×10 tile (110); richiede 156 finestre sovrapposte per un repaint completo. `roma-inner` copre tutto il rettangolo. La versione finale di un layer sovrapposto viene dall'ultima area passata all'export: dipingere solo core lasciando vecchio paint in inner può quindi nascondere le correzioni. Questa procedura aggiorna inner e lo passa per ultimo.

```sh
set -e
npm run paint -- roma-inner --art-bounds=-6144,-5120,5120,5120 --force -j 3
npm run paint -- roma-inner --art-bounds=-6144,-5120,5120,5120 --assemble
npm run export -- roma-core roma-inner --art-bounds=-6144,-5120,5120,5120 --check-coverage --require-painted
npm run export -- roma-core roma-inner --art-bounds=-6144,-5120,5120,5120 --require-painted
npm run build
npm run dev
```

Non procedere se paint/render/export restituiscono errore. Non usare `--data-only` per questo batch: cambiano anche le immagini dei ponti. Il comando `--check-coverage` legge soltanto i file presenti; non attesta la freschezza o la qualità pittorica. Le due liste `missingPaint` e `missingRender` devono essere vuote e il report deve indicare `expected:110, painted:110`.

## Controllo locale e poi dal vivo

Usare la porta stampata da `npm run dev`; gli stessi parametri funzionano su `https://mondoisometrico.vercel.app/`. Per ciascuna vista salvare un prima dal live e un dopo locale con identico `?at=` e viewport. Screenshot richiesti solo sul Mac: qui il dopo grafico non è stato generato.

| Vista | Parametro URL | Criterio di accettazione |
| --- | --- | --- |
| Pantheon | `?at=41.898616,12.476833,0.6` | Pronao verso Piazza della Rotonda a N/alto-sinistra; dome/oculo, nessuno specchio o raddoppio tra tile. |
| Trevi | `?at=41.900978,12.483285,0.5` | Palazzo Poli dietro, facciata e bacino leggibili a scala reale, niente blocco da 26 m nel bacino. |
| Colosseo | `?at=41.890210,12.492231,0.8` | Ellisse asse WNW–ESE, arena aperta, archi, continuità su tutto il perimetro. |
| Vittoriano | `?at=41.894687,12.483066,0.7` | Marmo bianco; scalinata verso Piazza Venezia; nessuna fusione ocra o cancellazione dei palazzi vicini. |
| Ponte Garibaldi / Isola Tiberina | `?at=41.8910,12.4754,0.9` | Per 5 minuti: veicoli solo su asfalto/impalcato, niente acqua, tetti o pareti verticali. |
| Ponte Cavour / Umberto I | `?at=41.9040,12.4711,0.9` | Stesso controllo, entrambe le direzioni, entrata/uscita del ponte e zoom dentro/fuori. |
| Intero playable | panoramica, poi zoom nativo su tutti i bordi | Nessun buco grigio/nero interno, texture nitide, tetti/piazze coerenti, nessuna cucitura evidente nel toggle Foto. |

In un altro terminale, con l'URL effettivo del dev server:

```sh
node --import tsx pipeline/src/traffictest.ts http://localhost:4321/ 5
```

Questo test browser misura traffico/sovrapposizioni; la prova visiva di acqua, allineamento con la pittura e monumenti è separata. Se il server usa una porta diversa, sostituirla.

## Unico rilascio finale, solo dopo QA

Dalla root del repo sul Mac, dopo approvazione delle viste locali e dopo eventuale merge eseguito dall'utente. Il branch della PR e `main` hanno `git.deploymentEnabled:false` per evitare deploy automatici al push/merge: il CLI manuale rimane disponibile. Il progetto Vercel già collegato deve essere `mondoisometrico`, nel team esistente. Non usare il vecchio `npm run deploy`, che pubblica il Worker Cloudflare.

```sh
cd /Users/domenicogagliardi/Desktop/mondoisometrico
npm run publish -- roma-centro --yes && npx vercel --prod
```

Una sola invocazione di publish, poi una sola di deploy. `world.json` è ultimo e i riferimenti R2 vengono verificati prima di inviarlo. Non correggerlo manualmente e non avviare contemporaneamente `/tmp/mondo-final-publish.sh`: scegliere questa procedura o uno script precedentemente revisionato che la esegua una sola volta. Se il guard locale richiede `BATCH_READY`, quel marker va prodotto solo dopo export e QA di **questo** batch, mai riutilizzato da un batch precedente.

Dopo il deploy ripetere le viste sopra, controllare assenza di 404 negli indici e nelle tile, e confrontare il nuovo `world.json` con quello locale. La produzione non è stata verificata con le modifiche di questa PR; finché mancano queste prove, mantenere la PR in draft.
