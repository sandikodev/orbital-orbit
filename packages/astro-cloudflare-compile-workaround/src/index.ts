import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync, cpSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AstroIntegration } from 'astro';

/**
 * Workaround for Astro 6 + @astrojs/cloudflare + imageService: 'compile'.
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
								enforce: 'post',
								writeBundle() {
									if (this.environment?.name !== 'prerender') return;

									const prerenderAstro = join(
										process.cwd(),
										'dist',
										'server',
										'.prerender',
										'_astro',
									);
									const rootAstro = join(process.cwd(), 'dist', '_astro');

									if (!existsSync(prerenderAstro)) return;
									mkdirSync(rootAstro, { recursive: true });

									for (const file of readdirSync(prerenderAstro)) {
										const src = join(prerenderAstro, file);
										const dst = join(rootAstro, file);
										if (existsSync(src) && !existsSync(dst)) {
											try {
												cpSync(src, dst, { force: true, recursive: false });
											} catch {}
										}
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
