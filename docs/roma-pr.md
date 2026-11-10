Il traffico poteva disegnare parti di auto e bus a quota assoluta anziché stradale; l'export poteva usare una superficie di edificio come terreno, promuovere depressioni a ponti e lasciare campioni visibili sull'acqua. Questa PR corregge geometria/disegno, rende conservativa la maschera di sicurezza e prepara il repaint dei monumenti e dell'intero rettangolo giocabile.

Base aggiornata: `main@d403cda`. Nessun merge, export di produzione, upload R2 o deploy eseguito. Nessun `data/` o `.env` incluso. PR in draft fino alla rigenerazione e QA sul Mac.

| Punto | Prima | Dopo nel codice / da verificare sulle nuove tile |
| --- | --- | --- |
| Auto | Fiancate/cofano/tetto bus fuori quota; visibilità controllata solo al centro e nella direzione errata in retromarcia lungo il segmento. | Quota applicata a tutti i vertici; corpo intero controllato in entrambe le direzioni, spawn/percorso/respawn; campioni radi e salti di quota rifiutati. |
| Acqua e ponti | Quote da superfici visibili, ponti indovinati dai dislivelli, controllo scarso su segmenti corti. | Terreno del renderer e acqua OSM; campionamento 2 m, controlli su larghezza e sagoma bus; impalcati solo con bridge OSM e due ancoraggi asciutti. Sopraelevate ambigue nascoste. |
| Monumenti | Orientamento non esplicito; Trevi poteva estrudere il bacino a 26 m; pulizia delle piazze cancellava anche costruzioni reali. | Pantheon N verso Rotonda, Trevi S/SE, Vittoriano N/NO, Colosseo asse 115°/295°; hint nelle finestre adiacenti, bacino basso/Palazzo Poli distinto, preservazione dei palazzi. Camera immutata. |
| Colori | 84 dipinti entro un playable di 110 tile; tentativi finali sotto soglia potevano essere accettati. | QA geometrica ≥0,45 senza deroga finale, palette Roma, errore dopo tre tentativi falliti, bounds espliciti e export bloccabile se mancano render/paint. Repaint non ancora eseguito. |
| Area | Nessun piano oltre core/inner. | Proposte inattive nord/sud/est: 90/109/139 nuove tile; tempi, costi condizionati e calcolo riproducibile documentati. |
| Rilascio | Riferimenti incrementali validi su R2 potevano essere respinti perché assenti localmente. | Verifica remota di tutti gli indici/preview, world ultimo, stato/cache conservati su errore; deploy Git disabilitati per questo branch e main, rilascio manuale unico. |

Validazione: **24 test passati** (traffico, terreno, copertura, publisher con rete simulata); TypeScript pipeline e web passati; build Astro completata. `npm run typecheck` resta limitato da un problema preesistente: `astro check` rifiuta TypeScript 7.0.2. Nessun aggiornamento delle dipendenze in questa PR.

Il dettaglio prima/dopo, le fonti OSM e la proiezione della camera, gli altri difetti osservati, le stime di espansione e tutti i comandi sono in [docs/roma-quality-batch.md](docs/roma-quality-batch.md). HOSTING ora distingue correttamente Vercel dal Worker di backup.

Restano obbligatori prima del rilascio:

- Scene/render/paint/assemble/export sul Mac; 110/110 tile dipinte nel rettangolo corrente e nessuna immagine sfocata/giunzione evidente.
- Screenshot locali con lo stesso viewport del prima live per Pantheon, Trevi, Colosseo, Vittoriano; verifica anche Castel Sant'Angelo al confine dipinto.
- Almeno 5 minuti di osservazione su Ponte Garibaldi/Isola Tiberina e Ponte Cavour/Umberto I, entrambe le direzioni.
- Una sola pubblicazione R2, poi un solo deploy Vercel, quindi ripetere i controlli sul live.

Le nuove immagini non sono presenti in questa PR: i dopo sono descrizioni del comportamento atteso, non screenshot o risultati live già verificati. Il controllo di copertura prova la presenza dei file, non la qualità visiva o l'accuratezza topografica dei ponti.
