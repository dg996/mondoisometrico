# Verifier v1 — Roma isometrica da dati aperti

Criteri di accettazione:

1. La base cartografica deve essere generata da geometrie OpenStreetMap reali per edifici, strade, ferrovie, acqua, verde e punti di interesse, non da un'illustrazione libera non controllata.
2. I veicoli devono usare le stesse geometrie stradali, ferroviarie e fluviali renderizzate; non devono attraversare edifici o monumenti nel bounding box operativo.
3. Il rendering deve avere stile isometrico curato: edifici estrusi con tetti/lati, ombra coerente, strade leggibili, acqua e verde distinti, monumenti riconoscibili.
4. Le coordinate dei landmark principali devono essere coerenti con OSM e con la loro posizione visiva: Colosseo, Pantheon, San Pietro, Castel Sant'Angelo, Termini, Vittoriano, Villa Borghese.
5. Devono restare attivi meteo Open-Meteo, orario Europe/Rome, layer, pausa/ripresa, schede, export e responsive mobile.
6. Collaudo browser: zero errori console, zero errori HTTP, zero tile error, nessun overflow orizzontale a 375px, controlli touch >=44px.
7. Il bundle deve caricare la mappa dettagliata e preservare prestazioni accettabili su viewport desktop.

Misurazioni implementate in verifier/v1/verify.py.
