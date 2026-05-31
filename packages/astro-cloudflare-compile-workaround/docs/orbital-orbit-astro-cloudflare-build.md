# orbital-orbit — Astro 6 + @astrojs/cloudflare Image Compile Fix
# Last updated: 2026-05-31

---

## Problem

Build failed at Astro's "generating optimized images" step with ENOENT errors.
The `@astrojs/cloudflare` adapter enables `preserveBuildClientDir: true`, which
makes Vite write output to `dist/client/` instead of `dist/`. But Astro's image
optimizer (`astro/dist/assets/build/generate.js`) reads source images from
`dist/_astro/` via `env.serverRoot = dist/`, which ends up empty.

### Root Cause

Three path mismatches:

1. **Source JPGs**: Vite outputs source images to `dist/client/_astro/` but the
   image optimizer reads from `dist/_astro/` → ENOENT
2. **Generated .webp**: Optimizer writes to `dist/_astro/` but the Cloudflare
   Worker serves from `dist/client/` → 404 on deploy
3. **Prerender assets**: Astro's `ssrMoveAssets` moves prerender output from
   `dist/server/.prerender/` to `dist/client/`, never touching `dist/_astro/`

### Additional Detail: `emptyDir`

Astro calls `emptyDir(dist/)` in `static-build.js` before the build. This
destroys any symlinks placed inside `dist/` at config evaluation time, so
symlink-based workarounds must be recreated during the Vite build lifecycle
(`buildStart` hook), not in astro.config.mjs at module evaluation time.

---

## Solution

Two hooks in `astro.config.mjs`:

### 1. Vite Plugin: `restore-astro-assets`

Hook: `writeBundle` (client environment)

Copies source JPGs from prerender output to `dist/_astro/` **after** the
prerender build completes but **before** the image optimizer runs. The
prerender output (`dist/server/.prerender/_astro/`) is the only reliable source
of original images at that point.

### 2. Astro Integration: `copy-optimized-assets`

Hook: `astro:build:done`

Copies generated `.webp` files from `dist/_astro/` to `dist/client/_astro/`
**after** the entire build finishes. This ensures the Worker (which serves
from `dist/client/`) can serve the optimized images.

---

## Key Commands

```bash
# Build
bun run build

# Deploy (from dist/client/)
cd dist/client && bunx wrangler deploy --config wrangler.json && cd ../..
```

---

## Files Modified

- `astro.config.mjs` — added both workaround hooks

## Files Created

- `wrangler.jsonc` — KV namespace binding for session storage

---

## Related Astro Internals

- `node_modules/astro/dist/core/build/static-build.js` — `ssrMoveAssets`, `emptyDir`
- `node_modules/astro/dist/assets/build/generate.js` — `generateImagesForPath`, `getFullImagePath`
- `node_modules/astro/dist/prerender/utils.js` — `getClientOutputDirectory`
- `node_modules/@astrojs/cloudflare` adapter v13.6.0

---

## URLs

- Site: https://orbital-orbit.asib.workers.dev
- GitHub: sandikodev/orbital-orbit (private)

---

## Status

✅ Build exits 0 with all images optimized.
✅ All 12 variants (JPG + webp) generated.
✅ Images serve without 404 on deployed Workers site.
