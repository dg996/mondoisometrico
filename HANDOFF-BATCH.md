# Mondoisometrico handoff — resume paint elsewhere

## Stopped (2026-11-11 ~09:52 CET)
Paint on Mac was **stopped on purpose** so work can continue from another machine/session.

Repo: `https://github.com/dg996/mondoisometrico` · branch `main`

## Code pushed with this handoff
`pipeline/src/paint.ts`:
- soft-fail per window mid-ring (siblings keep painting)
- mid-ring assemble with soft palette QA; final assemble still strict
- `paint-skip.json` support (skip windows without `--force`)
- `MONDO_SOFT_PALETTE=1` for preview `--assemble` only (not for publish)

## Local progress (NOT in git — must copy or re-paint)
On Mac at `/Users/domenicogagliardi/Desktop/mondoisometrico`:

| Path | Status |
|------|--------|
| `data/derived/roma-inner/windows/` | **452** accepted windows |
| `data/derived/roma-inner/paint-skip.json` | `["-4_-1"]` |
| `data/derived/roma-inner/paint/` | partial tiles from soft assemble |
| `data/derived/roma-inner/render` + `height` | complete for area |
| Total windows planned | ~1321 |

**Git ignores `data/`.** To resume without redoing Codex hours, copy the whole tree:

```bash
# from Mac → other machine (rsync / cloud drive / USB)
rsync -a --info=progress2 \
  /Users/domenicogagliardi/Desktop/mondoisometrico/data/derived/roma-inner/ \
  OTHER:/path/to/mondoisometrico/data/derived/roma-inner/
```

Also need region scene/raw inputs if the other box never ran fetch/ground/scene/render.

## Resume paint
```bash
cd /path/to/mondoisometrico
npm ci
# ensure Codex CLI is logged in (ChatGPT image gen; not API key)
printf '%s\n' '["-4_-1"]' > data/derived/roma-inner/paint-skip.json
npm run paint -- roma-inner -j 3
# already-painted windows are skipped; only missing ones run
```

Retry the hard window later:
```bash
npm run paint -- roma-inner --window=-4,-1 --force
```

Preview assemble (seams allowed):
```bash
MONDO_SOFT_PALETTE=1 npm run paint -- roma-inner --assemble
```

## Do not yet
- `npm run publish` / `npm run deploy` until paint + strict assemble + export pass
- Mid-batch R2 upload of partial tiles

## After paint completes
```bash
npm run paint -- roma-inner --assemble   # must pass palette QA (no MONDO_SOFT_PALETTE)
npm run export -- roma-inner
# then with explicit go-ahead:
npm run publish -- roma-centro   # or region name in places.ts
npm run deploy
```

## Live site note
Production still serves older R2 tiles until that one publish. Local `data/web` is unpublished cache only.
