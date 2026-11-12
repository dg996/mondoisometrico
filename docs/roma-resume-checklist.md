# Roma — ripresa sicura e checklist QA

Baseline di lavoro: `main` del repository. Non assumere progressi locali o archivi non presenti: se `data/derived/roma-inner/` manca, il batch va estratto da un handoff valido oppure ricostruito da open data con `--bootstrap`.

## Comandi sicuri

```sh
npm run qa:roma                         # preflight, nessuna scrittura pesante
npm run resume:roma-inner -- --bootstrap # solo se mancano input: fetch/ground/scene/render
npm run resume:roma-inner -- --paint     # riprende il paint; le finestre esistenti vengono saltate
npm run resume:roma-inner -- --assemble  # assemble STRICT; MONDO_SOFT_PALETTE viene ignorato
npm run resume:roma-inner -- --export    # coverage preflight + export cache; NON pubblica
```

`pipeline` ha anche `prepublish`: prima di `npm run publish`, il guard rifiuta cache rotte (`world.json` senza `activity`, `landmarks`, file dati mancanti, crediti assenti, o assemble soft).

## Gate prima di publish/deploy

- [ ] `npm run resume:roma-inner -- --check` senza missing.
- [ ] `npm run resume:roma-inner -- --assemble` strict passa; niente `MONDO_SOFT_PALETTE=1`.
- [ ] `npm run resume:roma-inner -- --export` completa e lascia cache coerente.
- [ ] `npm run dev`: niente errori console/404; playable senza void/grigio interno.
- [ ] Tevere/ponti `?at=41.8910,12.4754,0.9`: per 5 minuti auto solo su asfalto/impalcato; niente acqua/tetti/vuoto.
- [ ] Pantheon `?at=41.898616,12.476833,0.6`: pronao nord verso Piazza della Rotonda, cupola/oculo, niente specchi.
- [ ] Colosseo `?at=41.890210,12.492231,0.8`: ellisse WNW–ESE, arena aperta, niente blocchi residenziali attaccati.
- [ ] Trevi `?at=41.900978,12.483285,0.5`: Palazzo Poli dietro, bacino davanti, scala reale.
- [ ] Vittoriano `?at=41.894687,12.483066,0.7`: bianco, scalinata verso Piazza Venezia, palazzi vicini preservati.
- [ ] Crediti visibili: OSM + Copernicus + Painted with AI; `ATTRIBUTION.md` aggiornato se entrano nuove fonti.

## Divieti operativi

- Non cancellare `data/derived/` o `data/web-state/`.
- Non cambiare `origin` / `headingDeg` di `roma-centro`.
- Non pubblicare a metà batch; un solo `npm run publish -- roma-centro` e un solo deploy dopo QA.
- Non committare `data/` o `.env`; non incollare token in chat, issue o documenti.
