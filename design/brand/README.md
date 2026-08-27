# Brand source files

Drop the original PACHKA logo artwork here and commit it.

Preferred, in order:
1. `logo-mark.svg` / `logo-wordmark.svg` — a real vector export from the designer.
2. `.ai`, `.eps`, or a vector `.pdf` — I can convert these.
3. `logo-mark.png` — a raster render, as large as you have. This gets traced,
   which picks up some of the paper texture and is the least faithful route.

## Why these live in the repo

The source artwork is committed so anyone who clones the project can
re-generate the logo components, and so we are never again dependent on a file
sitting on one person's laptop.

These files are **sources, not assets**. Nothing in `src/` imports them and they
are not served to the browser. They are traced once into React components under
`src/assets/`, and it is those components the application renders — inline SVG
using `currentColor`, so the mark recolors with the theme and costs no network
request.

## Re-tracing after replacing a source

```bash
brew install potrace          # once
scripts/trace-logo.sh design/brand/logo-mark.png
```
