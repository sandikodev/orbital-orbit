# astro-cloudflare-compile-workaround

Workaround for **Astro 6 + `@astrojs/cloudflare` + `imageService: 'compile'`** build failure.

## The Problem

When `preserveBuildClientDir: true` (Cloudflare adapter default), Vite outputs
build artifacts to `dist/client/` instead of `dist/`. But Astro's image optimizer
(`imageService: 'compile'`) reads source images from `dist/_astro/` via
`env.serverRoot = dist/`, which ends up empty — causing **ENOENT** errors at
build time.

Even when the build succeeds, generated `.webp`/`.avif` files land in
`dist/_astro/`, but the Cloudflare Worker serves from `dist/client/` — resulting
in **404** on optimized images.

**Upstream issue:** https://github.com/withastro/astro/issues/15319

## How It Works

This integration bridges the path gap with two hooks:

1. **Vite `writeBundle` (prerender env)** — copies source JPGs from the prerender
   output (`dist/server/.prerender/_astro/`) to `dist/_astro/` **before** the
   image optimizer runs.
2. **`astro:build:done`** — copies generated `.webp`/`.avif` files from
   `dist/_astro/` to `dist/client/_astro/` **after** the build finishes.

## Usage

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import cloudflareCompileWorkaround from 'astro-cloudflare-compile-workaround';

export default defineConfig({
  adapter: cloudflare({
    imageService: 'compile',
  }),
  integrations: [
    cloudflareCompileWorkaround(),
  ],
});
```

## Installation (not published to npm)

```bash
# GitHub dependency
npm install sandikodev/astro-cloudflare-compile-workaround
# or locally
npm install /path/to/astro-cloudflare-compile-workaround
```

Alternatively, copy-paste the two hooks directly into your `astro.config.mjs`
(see [source](./src/index.ts) or [docs](./docs/) for the inline version).

## License

MIT
