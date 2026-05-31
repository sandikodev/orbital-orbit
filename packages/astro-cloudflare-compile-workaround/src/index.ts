import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync, cpSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AstroIntegration } from 'astro';

/**
 * Workaround for Astro 6 + @astrojs/cloudflare + imageService: 'compile'.
 *
 * When `preserveBuildClientDir: true` (Cloudflare adapter default), Vite outputs
 * to `dist/client/` instead of `dist/`. But the image optimizer reads source images
 * from `dist/_astro/` via `env.serverRoot = dist/`, which ends up empty.
 *
 * This integration bridges the path gap:
 *
 * 1. **Vite writeBundle hook** — copies source JPGs from prerender output
 *    (`dist/server/.prerender/_astro/`) to `dist/_astro/` before the optimizer runs.
 *
 * 2. **astro:build:done hook** — copies generated .webp/.avif from `dist/_astro/`
 *    to `dist/client/_astro/` so the Worker can serve them.
 *
 * @see https://github.com/withastro/astro/issues/15319
 * @see https://github.com/sandikodev/astro-cloudflare-compile-workaround
 */
export default function cloudflareCompileWorkaround(): AstroIntegration {
  return {
    name: 'cloudflare-compile-workaround',
    hooks: {
      'astro:config:setup': ({ updateConfig }) => {
        updateConfig({
          vite: {
            plugins: [
              {
                name: 'restore-astro-assets',
                enforce: 'post' as const,
                writeBundle() {
                  // @ts-expect-error Vite 6+ environment API
                  const envName = this.environment?.name;
                  if (envName !== 'client') return;

                  const prerenderAstro = join(process.cwd(), 'dist', 'server', '.prerender', '_astro');
                  const rootAstro = join(process.cwd(), 'dist', '_astro');

                  if (!existsSync(prerenderAstro)) return;
                  mkdirSync(rootAstro, { recursive: true });

                  for (const file of readdirSync(prerenderAstro)) {
                    try {
                      cpSync(join(prerenderAstro, file), join(rootAstro, file), {
                        force: true,
                        recursive: false,
                      });
                    } catch {}
                  }
                },
              },
            ],
          },
        });
      },
      'astro:build:done': ({ dir }) => {
        const rootAstro = join(fileURLToPath(dir), '..', '_astro');
        const clientAstro = join(fileURLToPath(dir), '_astro');

        if (!existsSync(rootAstro)) return;
        mkdirSync(clientAstro, { recursive: true });

        for (const file of readdirSync(rootAstro)) {
          if (!file.endsWith('.webp') && !file.endsWith('.avif')) continue;
          try {
            cpSync(join(rootAstro, file), join(clientAstro, file), { force: true });
            } catch {}
        }
      },
    },
  };
}
