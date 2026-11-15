# Mura Aureliane (issue #10, #11)

## Il difetto

OSM disegna le Mura Aureliane in due modi, e la pipeline li sbagliava entrambi:

- **linee** `barrier=city_wall` (10,6 km dentro `roma-inner`): scaricate ma mai estruse, quindi le mura
  mancavano del tutto, per esempio tra Porta San Giovanni e Santa Croce in Gerusalemme lungo Viale
  Castrense (#11);
- **sagome** `building=city_wall` (9, di cui 6 senza nome, come la relazione 14279973 da Porta Ardeatina a
  Porta San Sebastiano): trattate come edifici, con altezza di ripiego 12-20 m, finestre e tetti, quindi una
  fila di palazzi lungo Viale di Porta Ardeatina (#10).

Porta Ardeatina in OSM è solo un nodo (2018208556): una posterula murata nel Medioevo, oggi poco più di
un'apertura incorniciata in travertino accanto ai fornici di Via Cristoforo Colombo (it.wikipedia).

## La correzione

`pipeline/src/city-walls.ts`, usato da `scene.ts`:

- linee e sagome delle mura diventano un unico muro in mattoni (stile 9 del renderer: corsi di mattoni,
  merli, nessuna finestra, nessun tetto), tagliato in pezzi da 10 m perché il renderer appoggia ogni solido
  sul punto più alto del terreno sotto di esso: un tratto di 400 m in un pezzo solo avrebbe la sommità piatta;
- misure solo da fonti aperte: 13 m di altezza (metà dei "10,50-15 m" dopo Onorio) e 3,5 m di spessore
  (it.wikipedia "Mura aureliane"); il CTRN 2002-2003 non rileva le mura come volumi (3% della lunghezza).
  Un `height`/`width` OSM sulla via vince;
- le sagome e linee senza nome valgono come Mura Aureliane se almeno l'80% dei vertici sta entro 25 m da un
  tratto con nome (6 sagome riconosciute; mura Serviane, Vaticane, Gianicolensi e Passetto restano escluse:
  per loro non c'è un'altezza verificata);
- un varco solo dove una carreggiata attraversa la linea a raso: le porte e i fornici in OSM sono vie
  `tunnel=building_passage` sotto il muro; i marciapiedi che zigzagano sulla linea (20 falsi varchi lungo
  Corso d'Italia e alla Piramide) non contano.

`fetch.ts` scarica le linee in un file a parte, `walls.json`, senza invalidare le altre cache.
`paint.ts` dice al modello che le fasce di mattoni sono mura (niente case, finestre, tetti) nelle finestre
che le contengono; `landmarks.ts` aggiunge Porta Ardeatina e l'Anfiteatro Castrense (etichetta + indicazione
di pittura).

## Rifare le immagini

Scena: rispetto a prima cambiano solo 59 tile (pezzi di muro aggiunti, le 9 sagome-palazzo tolte, gli alberi
che cadevano sulle mura); il resto è identico byte per byte. `render --tiles` e `paint --windows` conservano
render e dipinti sostituiti in `data/derived/roma-inner/render-replaced/` e `windows-replaced/`.

```sh
npm run fetch -- roma-inner     # solo walls.json è nuovo
npm run scene -- roma-inner
npm run render -- roma-inner --tiles=<59 tile> -j 3
npm run paint -- roma-inner --windows=<9 finestre di prova> --skip-assemble -j 3   # rivedere
npm run paint -- roma-inner --windows=<tutte le 75> --skip-assemble -j 3           # anche le 9 di prova
npm run paint -- roma-inner --assemble
npm run export -- roma-nord roma-sud roma-est roma-core roma-inner
npm run publish -- roma-centro  # solo con il via libera
npm run deploy
```

Tile ri-renderizzate (59):
`-1_-7,-2_-6,-2_-7,-3_-4,-3_-5,-3_-6,-3_2,-3_3,-4_-4,-4_-5,-5_-4,-6_-4,-7_-3,-7_-4,0_-7,10_-1,10_-4,10_-5,10_0,10_1,10_2,11_0,11_1,11_2,1_-7,1_-8,2_-7,2_-8,3_-6,3_-7,3_-8,4_-6,4_6,5_-6,5_3,5_4,5_5,5_6,6_-5,6_-6,6_2,6_3,7_-1,7_-5,7_-6,7_0,7_2,8_-1,8_-2,8_-3,8_-5,8_0,8_2,9_-1,9_-3,9_-4,9_-5,9_0,9_2`

Finestre di pittura con mura (75: piede e sommità di ogni pezzo proiettati sul terreno vero, come fa
`paint.ts` per decidere a quali finestre dare l'indicazione sulle mura):
`-1_-8,-2_-7,-2_-8,-3_-6,-3_-7,-3_2,-3_3,-3_4,-4_-4,-4_-5,-4_-6,-5_-4,-5_-5,-6_-4,-6_-5,-7_-4,-7_-5,-8_-3,-8_-4,-8_-5,0_-8,10_-2,10_-3,10_-4,10_-5,10_-6,10_0,10_2,10_3,11_-4,11_-5,11_-6,11_0,11_1,11_2,12_0,12_1,12_2,1_-8,1_-9,2_-9,3_-7,3_-8,3_-9,4_-7,4_6,4_7,5_-7,5_5,5_6,5_7,6_-6,6_-7,6_3,6_4,6_5,6_6,7_-6,7_-7,7_2,7_3,7_4,8_-1,8_-6,8_-7,8_0,8_2,8_3,9_-1,9_-2,9_-3,9_-6,9_0,9_2,9_3`

Patch di prova (9): `11_1,11_2,12_1,12_2` (Porta Ardeatina - Porta San Sebastiano, #10) e
`10_-3,10_-4,10_-5,11_-4,11_-5` (Porta San Giovanni - Anfiteatro Castrense, #11). Il giro completo le
ridipinge di nuovo: ai bordi della patch hanno continuato le strisce di raccordo delle finestre vicine ancora
vecchie (con i palazzi), che resterebbero nelle bande di sovrapposizione. Con tutte le 75 nella stessa
`--windows` ogni finestra continua solo vicine già ridipinte in quel giro (ordine a scacchiera).

Finché le 75 finestre non sono tutte ridipinte non esportare né pubblicare: render e height pass delle 59
tile hanno già le mura (il traffico ci passerebbe dietro), i dipinti vecchi no.
