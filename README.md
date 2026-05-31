# orbital-orbit

Personal blog built with **Astro 6**, deployed on **Cloudflare Workers**.

## Monorepo Structure

```
├── packages/
│   └── astro-cloudflare-compile-workaround/   Reusable integration
├── public/
├── src/
├── astro.config.mjs
└── package.json
```

## Commands

```bash
bun install        # install all workspace deps
bun run build      # build site
bun run dev        # dev server
```

## Deployment

```bash
bun run build
cd dist/client && bunx wrangler deploy --config wrangler.json && cd ../..
```
