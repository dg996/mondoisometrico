# Roma: verifica di monumenti ed edifici (12 novembre 2026)

Obiettivo: ogni edificio della mappa nel punto reale, con forma e altezza da fonti aperte verificabili.
Nessuna fonte proprietaria.

## Fonti

| Fonte | Cosa dà | Licenza | Uso |
| --- | --- | --- | --- |
| OpenStreetMap | dove sta ogni edificio oggi (impronte, cortili), parti 3D dei grandi monumenti, materiali e colori | ODbL | posizione e forma di tutti gli edifici; massa dei monumenti con parti 3D |
| Regione Lazio, CTRN 2002-2003 1:5000, layer 06V | 261.000 volumi edilizi misurati su tutta Roma, ognuno con la sua altezza | CC BY 4.0 | altezza di ogni parte di ogni edificio, ritagliata sull'impronta OSM |
| Wikidata, proprietà P2048 | altezze pubblicate dei monumenti principali | CC0 | solo controllo incrociato |
| Copernicus Urban Atlas Building Height 2012 | raster 10 m | Copernicus, libera | valutata e scartata: al Pantheon dà 8 m |

Allineamento CTRN/OSM, misurato per correlazione delle impronte sull'area pantheon: scarto di circa 1 m
dopo la conversione ufficiale Gauss-Boaga -> WGS84; sovrapposizione degli edifici 87%.

## Regola applicata (pipeline/src/scene.ts)

1. OSM decide **dove** c'è un edificio oggi. Un volume CTRN senza edificio OSM non viene disegnato
   (potrebbe essere demolito dal 2002).
2. Se almeno metà dell'impronta OSM è coperta da volumi CTRN, l'edificio viene ricostruito dai volumi
   ritagliati sull'impronta, ognuno alla sua altezza misurata. Esempi: palazzi a gradoni, navate,
   campanili, tamburi e cupole. Nel centro sono circa 4 edifici su 5 (roma-core: 9.879 su 12.486).
3. Per i palazzi l'altezza CTRN è la linea di gronda; sopra va il tetto in coppi. Nelle chiese il volume
   più alto e compatto, ben sopra la navata, diventa tamburo con cupola grigio piombo.
4. I monumenti con parti 3D in OSM (Pantheon, San Pietro, Vittoriano, Castel Sant'Angelo, Colosseo)
   usano le parti OSM, che sono più dettagliate della CTRN. Seguendo lo standard Simple 3D Buildings, il
   perimetro che ha parti sopraelevate diventa solo il corpo di base su cui poggiano.
5. I colori OSM scritti per nome (`sand`, `lightcoral`, `lightyellow`) vengono convertiti. Prima
   finivano sul colore di ripiego (coppi) e il Colosseo era arancione.

## Monumenti controllati

| Monumento | Prima | Ora | Fonte altezza | Riferimento |
| --- | --- | --- | --- | --- |
| Pantheon | rotonda con finestre da palazzo, cupola in terracotta | pronao a nord con colonne, rotonda, cupola grigia con oculo | parti OSM (43,3 m) | Wikidata 43,3 m |
| San Pietro | blocco unico di 136 m su tutta la pianta, senza cupola | basilica sulla base delle parti (47 m), tamburo, cupola e lanterna fino a 136,5 m | parti OSM | Wikidata 136,6 m |
| Colosseo | gradinate color coppo | ellisse in travertino, arena aperta, sommità in pietra | OSM / tabella interna 48,5 m | Wikidata 48 m |
| Vittoriano | corretto | marmo bianco, quadrighe in bronzo | parti OSM | Wikidata 81 m (quadrighe) |
| Sant'Agnese in Agone | blocco piatto | tamburo e cupola 61,2 m, due campanili 47 m, facciata a est su Piazza Navona | CTRN | indicazione per la pittura |
| Chiesa del Gesù | blocco piatto | navata e cupola 59,2 m, facciata a ovest | CTRN | indicazione per la pittura |
| Castel Sant'Angelo | corretto | mausoleo cilindrico e bastioni, 47,5 m | CTRN / OSM | tabella interna 48 m |
| Santa Maria Maggiore | stima | volumi fino a 64,1 m | CTRN | Wikidata 75 m (campanile con cuspide) |
| Teatro di Marcello | 32 m stimati | 28,2 m | CTRN | |
| Santa Francesca Romana | 14 m (tag OSM) | campanile 37,9 m | CTRN | |
| Palazzo Farnese | stima | 30,5 m | CTRN | Wikidata 29 m |
| Palazzo della Cancelleria | stima | 27,1 m | CTRN | Wikidata 25 m |

Elenco completo (491 monumenti, 367 con volumi CTRN): `node pipeline/src/monument-audit.mjs out.json`.

## Limiti noti

- Il Vaticano non è nella CTRN: lì valgono solo OSM e le parti 3D.
- La CTRN è del 2002-2003. Gli edifici costruiti dopo hanno l'altezza OSM o quella di ripiego.
- Cupole senza parti OSM e senza volume CTRN distinto (per esempio Sant'Andrea della Valle) restano
  affidate all'indicazione per la pittura.
- Le statue, le colonne sottili e le decorazioni non sono geometria: le disegna la pittura, che
  ricalca il render senza poter spostare edifici o strade.

## Posizioni dei monumenti (etichette e ancore per la pittura)

Controllo: `node --import tsx pipeline/src/landmark-audit.ts roma-inner` (centroide OSM dell'impronta
con lo stesso nome, coordinata Wikidata P625, quota del terreno).

| Punto | Prima | Ora | Scarto corretto |
| --- | --- | --- | --- |
| San Pietro | 41.901854, 12.455760 (verso la piazza) | 41.902161, 12.453373, cupola OSM way 117968816 | circa 200 m: la pittura poteva mettere la cupola sulla piazza |
| Altare della Patria | 41.894687, 12.483066 | 41.894425, 12.482765, centroide OSM | 38 m |
| Foro Romano | 41.891641, 12.486730 | 41.8922, 12.4852, Wikidata Q180212 | circa 140 m |
| Isola Tiberina | 41.890470, 12.477765 | 41.890833, 12.477222, Wikidata Q545404 | circa 60 m |
| Termini | 41.900582, 12.502527 | 41.901184, 12.501666, edificio della stazione | circa 100 m |
| Fontana di Trevi | 41.900978, 12.483285 | 41.900879, 12.483256, fontana OSM | 11 m |
| Colosseo, Pantheon, Castel Sant'Angelo | | centroidi OSM | sotto 10 m |

Etichette e indicazioni per la pittura usano il terreno esportato. La quota scritta a mano (`groundMsl`)
serve solo come ripiego, ed è stata allineata al terreno (per esempio Termini: da 10 a 55 m).

## Strade

Controllo: `node --import tsx pipeline/src/road-audit.ts` (edifici CTRN entro 1,4 km da Piazza Venezia).

| Classe OSM | Distanza tra facciate (CTRN) | Disegnata prima | Scarto della mezzeria | Tratti dentro un edificio |
| --- | --- | --- | --- | --- |
| primary | 28,1 m | 12,0 m | 0,3 m | 0,0% |
| secondary | 32,1 m | 12,0 m | 2,9 m | 0,0% |
| tertiary | 19,2 m | 12,0 m | 1,6 m | 0,0% |
| residential | 10,9 m | 8,7 m | 1,2 m | 0,5% |
| service | 9,7 m | 4,0 m | 1,9 m | 3,6% |

- Il tracciato OSM è affidabile: la mezzeria sta in media a 1-3 m dal centro tra le facciate e quasi mai
  dentro un edificio. Gli scarti residui sono vicoli larghi 4-5 m, con circa 1 m di differenza.
- La larghezza invece era sbagliata sulle strade principali, perché OSM conta solo le corsie di marcia.
  Ora `ground.ts` porta la carreggiata fino alle facciate rilevate meno i marciapiedi, solo dove ci sono
  edifici su entrambi i lati, mai sotto la larghezza OSM e mai oltre 2,2 volte. Nell'area pantheon sono
  220 strade. Il traffico resta sulle corsie OSM.
- Gallerie, metro, sottopassi e corridoi indoor non sono più disegnati in superficie. Gli archi
  (`building_passage`) sì, perché l'edificio sopra li copre.
- La viabilità CTRN (layer 05) non è usata: la legenda dei codici sul portale regionale non si scarica,
  e i poligoni 050500 si sono rivelati piazzali, non ponti. I ponti restano quelli OSM, con impalcato in
  piano e due appoggi asciutti (`bridge-profile.ts`).

## Rete stradale disegnata: controllo su tutte le aree

Controllo: `node --import tsx pipeline/src/ground-audit.ts [area ...]`, sulle linee effettivamente
disegnate (`data/derived/<area>/ground/features.json`).

| Problema | Prima | Ora | Correzione |
| --- | --- | --- | --- |
| Binari sul Tevere senza ponte | 6–9 tratti per area, dipinti piatti sull'acqua | 0 | i ponti ferroviari hanno un impalcato con massicciata e una coppia di rotaie per binario |
| Strade spezzate agli archi | 333 estremità staccate nell'area pantheon | 7 | a Roma molti archi sono mappati come `covered=yes` o come pochi metri di `tunnel=yes` con `layer=-1` (Vicolo dei Granari, Via dell'Arco de' Cenci, Vicolo de' Catinari, Via di Sant'Agostino). Un tratto corto (sotto i 40 m) di strada carrabile o pedonale è un arco in superficie |
| Metro, gallerie, sottopassi, corridoi indoor in superficie | centinaia di linee | 0 | `belowSurface()` in `roadspec.ts`. Restano esclusi i sottopassaggi pedonali e i sottopassi lunghi |
| Strade non-ponte sull'acqua | binari | 3 vialetti OSM di 6–28 m | imprecisioni di OSM, non del disegno |
| Ponti senza niente sotto | 11 | 11 | tutti reali: rampe autostradali al bordo dell'area, passerelle in legno a Caracalla, una passerella pedonale |

Le estremità staccate rimaste (51 su 27.500 linee in roma-core) sono vicoli ciechi reali che finiscono
contro scalinate o marciapiedi, come in OSM. Il traffico non passa né sotto gli archi né nelle gallerie.

## Alberi e superficie delle strade (12 novembre 2026, sera)

**Alberi.** Roma Capitale non pubblica un censimento completo degli alberi in open data (solo il
Municipio VIII, licenza non indicata). I punti 030108 della CTRN sono simboli di area verde, non alberi
singoli: sovrapposti al render cadono anche su strade e piazze, quindi non sono usati. Le chiome vengono
da ESA WorldCover 2021 (10 m, CC BY 4.0), con questi filtri:

| Luogo | Copertura arborea WorldCover | Atteso |
| --- | --- | --- |
| Villa Pamphili (pineta) | 69% | bosco |
| Colle Oppio | 63% | bosco |
| Lungotevere Marzio (platani) | 61% | filare |
| Piazza Navona, Piazza del Popolo, Circo Massimo | 0% | nessun albero |

- Si usano solo gruppi compatti di pixel (almeno 5 su 9): il pixel isolato è rumore.
- Mai su edifici, carreggiate (più 1,2 m), piazze lastricate, acqua, campi sportivi.
- Restano gli alberi singoli (`natural=tree`) e i filari (`tree_row`) di OSM. Il riempimento casuale dei
  parchi è stato tolto.
- Le chiome del render hanno lobi di fogliame e sono ruotate a caso, invece di essere sfere lisce.

**Strade** (OSM, roma-core: 3.137 strade in sampietrini, 4.394 attraversamenti mappati):
- `surface=sett/cobblestone/paving_stones` → colore sampietrini, senza segnaletica di corsia.
- Marciapiedi solo dove servono: niente marciapiede se `sidewalk=no/separate` (i marciapiedi mappati a
  parte sono disegnati come percorsi), né nei vicoli in sampietrini senza tag.
- Strisce pedonali: quelle reali di OSM (`footway=crossing`, escluse `unmarked`). Prima venivano
  indovinate dove un vialetto tocca una strada, e quelle vere finivano sotto l'asfalto.
