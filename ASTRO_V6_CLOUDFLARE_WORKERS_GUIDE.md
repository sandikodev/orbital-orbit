# Migrasi dari Astro v5 + Cloudflare Pages ke Astro v6 + Cloudflare Workers

## Latar Belakang

Astro v6 dengan `@astrojs/cloudflare` adapter mengalami perubahan arsitektur signifikan dibanding versi sebelumnya. Panduan ini mendokumentasikan perjalanan debugging dan solusi untuk issue image optimization yang muncul.

Referensi Issue: https://github.com/withastro/astro/issues/16931

## Perubahan Fundamental

### Astro v5 + Cloudflare Pages (Legacy)

```javascript
// astro.config.mjs v5
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'static',  // atau 'hybrid'
  adapter: cloudflare(),
  // Images otomatis di-optimize saat build
  // Tidak ada konsep "server" runtime di Pages
});
```

**Karakteristik:**
- Deploy ke Cloudflare Pages (static hosting + Functions)
- Image optimization: build-time dengan Sharp
- Tidak ada konsep binding khusus untuk images
- Output: pure static files

### Astro v6 + Cloudflare Workers (Current)

```javascript
// astro.config.mjs v6 - SSR Mode
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',  // atau 'static'
  adapter: cloudflare(),
  // Image service otomatis terdeteksi berdasarkan output mode
});
```

**Karakteristik:**
- Deploy ke Cloudflare Workers (edge computing)
- Image optimization: runtime via Cloudflare Images API (IMAGES binding)
- Ada konsep "server runtime" dengan bindings
- Output: dynamic + static hybrid

## Root Cause Analysis Issue #16931

### Masalah: Image 404 dengan Default Config

Saat menggunakan config default dengan blog template:

```javascript
// astro.config.mjs
export default defineConfig({
  adapter: cloudflare(),  // default: tidak specify imageService
  // output tidak di-set (default: 'static' untuk blog template)
});
```

**Hasil:**
1. Adapter menggunakan `imageService: 'cloudflare-binding'` (default untuk SSR)
2. Tapi output mode adalah 'static'
3. HTML generate: `/_image?href=...&w=...&h=...` URLs
4. Tidak ada Worker runtime untuk handle `/_image` endpoint
5. **Result: 404 untuk semua gambar**

### Kenapa Terjadi?

**Commit PR #15435** mengubah default behavior:

```typescript
// packages/integrations/cloudflare/src/utils/image-config.ts
// SEBELUM v6:
const mode = config ?? 'compile';  // Default: build-time optimization

// SESUDAH v6 (PR #15435):
const mode = config ?? 'cloudflare-binding';  // Default: runtime optimization
```

**Masalah:** PR #15435 fokus pada SSR experience, tapi tidak menangani static output mode.

### Dua Issue Terpisah

**Issue 1: Adapter Default**
- File: `packages/integrations/cloudflare/src/utils/image-config.ts`
- Fungsi: `normalizeImageServiceConfig()`
- Masalah: Default ke `'cloudflare-binding'` tanpa memeriksa output mode

**Issue 2: Core Asset Generation**
- File: `packages/astro/src/assets/build/generate.ts`
- Fungsi: `prepareAssetsGenerationEnv()`
- Masalah: Tidak respect `preserveBuildClientDir` yang di-set oleh adapter

## Solusi dan Workaround

### Solusi 1: Gunakan `imageService: 'compile'` (Workaround)

```javascript
// astro.config.mjs - Static Output dengan Compile Image Service
export default defineConfig({
  output: 'static',
  adapter: cloudflare({ 
    imageService: 'compile'  // Force build-time optimization
  }),
});
```

**Hasil:**
- ✅ Static `.webp` files di-generate saat build
- ✅ HTML: `src="/_astro/image.hash.webp"`
- ✅ Deploy ke Workers: static files, no runtime needed
- ❌ Tidak bisa pakai `wrangler dev` (tidak ada Worker runtime)
- ❌ Tidak ada hot reload untuk images

### Solusi 2: Switch ke SSR Mode (Recommended untuk Dev)

```javascript
// astro.config.mjs - SSR Mode
export default defineConfig({
  output: 'server',
  adapter: cloudflare(),  // Default: 'cloudflare-binding'
});
```

**Hasil:**
- ✅ Full `wrangler dev` support dengan hot reload
- ✅ Runtime image optimization via Cloudflare Images API
- ✅ HTML: `src="/_image?href=...&w=...&h=..."`
- ✅ Worker handle image transformation on-the-fly
- ✅ Bindings (KV, Images) work di dev mode

**Trade-offs:**
- Cold start lebih tinggi vs pure static
- Butuh Worker runtime (bukan pure static CDN)
- Slightly lebih kompleks

### Solusi 3: Upstream Fix (Dari Tim Astro)

Tim Astro (via Houston bot) membuat fix komprehensif:

```typescript
// Fix 1: Adapter menjadi output-aware
// packages/integrations/cloudflare/src/index.ts
if (!config.imageService && config.output !== 'server') {
  // Auto-default ke 'compile' untuk static output
  imageServiceConfig = { ...imageServiceConfig, type: 'compile' };
}

// Fix 2: Core respect preserveBuildClientDir
// packages/astro/src/assets/build/generate.ts
const serverRoot = config.buildOutput === 'static' && adapter?.adapterFeatures?.preserveBuildClientDir
  ? config.build.client  // Use client directory
  : config.outDir;       // Use default
```

## Struktur Build Output

### Static Mode dengan `imageService: 'compile'`

```
dist/
├── client/              # Static assets (served by Worker)
│   ├── _astro/         # Optimized .webp files
│   ├── blog/
│   ├── index.html
│   └── ...
├── server/             # Tidak di-generate untuk static
└── _astro/             # Temp build dir (deleted after)
```

**Wrangler config:**
```json
{
  "main": "@astrojs/cloudflare/entrypoints/server",
  "assets": { "directory": "./dist/client" }
}
```

### SSR Mode dengan `imageService: 'cloudflare-binding'`

```
dist/
├── client/             # Static assets (served via ASSETS binding)
│   ├── _astro/        # Original images (belum di-optimize)
│   └── ...
└── server/            # Worker runtime code
    ├── chunks/        # SSR modules
    ├── entry.mjs      # Entry point
    └── wrangler.json  # Generated config
```

**Wrangler config:**
```json
{
  "main": "../server/entry.mjs",
  "assets": { "directory": ".", "binding": "ASSETS" },
  "bindings": {
    "IMAGES": { "type": "images" }
  }
}
```

## Workflow Development

### Static Mode

```bash
# Development
pnpm astro dev                    # Astro dev server (Node.js)

# Build
pnpm astro build                  # Generate static files

# Preview (manual HTTP server)
cd dist/client && python3 -m http.server 8080
# atau
npx serve dist/client

# Deploy
wrangler deploy --config dist/client/wrangler.json
```

### SSR Mode

```bash
# Development (full Worker simulation)
wrangler dev

# Build
astro build

# Dev server dengan hot reload
wrangler dev

# Deploy
wrangler deploy --config dist/server/wrangler.json
# atau
wrangler deploy (auto-detect)
```

## Perbandingan Mode

| Aspek | Static + Compile | SSR + Cloudflare Images |
|-------|------------------|-------------------------|
| **Output** | Pre-rendered HTML | Server-rendered |
| **Image URLs** | `/_astro/*.webp` | `/_image?href=...` |
| **Image Processing** | Build-time (Sharp) | Runtime (CF Images) |
| **wrangler dev** | ❌ Tidak support | ✅ Full support |
| **Hot Reload** | Via astro dev | Via wrangler dev |
| **Bindings** | Tidak available | KV, Images, etc. |
| **Cold Start** | N/A (static) | ~10-50ms |
| **Cache** | Browser + CDN | Browser + CDN + Edge |
| **Use Case** | Blog, docs, landing | App, dashboard, dynamic |

## Debugging Tips

### 1. Check Image URLs

```bash
# Cek apakah HTML pakai static atau runtime URLs
grep -o 'src="[^"]*"' dist/client/blog/index.html | grep -E '(blog-placeholder|_image)'

# Static (compile mode):
# src="/_astro/blog-placeholder-1.Bx0Zcyzv_Z2gJUt1.webp"

# Runtime (cloudflare-binding mode):
# src="/_image?href=%2F_astro%2Fblog-placeholder-1.Bx0Zcyzv.jpg&amp;w=960&amp;h=480&amp;f=webp"
```

### 2. Check Wrangler Bindings

```bash
# Cek apakah IMAGES binding ada
cat dist/client/wrangler.json | grep -A5 'images'

# SSR mode:
# "images": {"binding": "IMAGES"}

# Static mode:
# (tidak ada images binding)
```

### 3. Test Endpoints

```bash
# Test image endpoint (SSR mode)
curl -I "https://yoursite.workers.dev/_image?href=%2F_astro%2Fimage.jpg&w=960&h=480&f=webp"

# Response (SSR):
# HTTP/2 200
# content-type: image/webp
# cf-cache-status: HIT

# Response (Static tanpa handler):
# HTTP/2 404
```

## Perubahan Konfigurasi Selama Debugging

### Iterasi 1: Default (Broken)

```javascript
// astro.config.mjs
export default defineConfig({
  adapter: cloudflare(),
});
// Result: 404 images
```

### Iterasi 2: Dengan Workaround

```javascript
// packages/astro-cloudflare-compile-workaround/src/index.ts
export default function workaround() {
  return {
    name: 'cloudflare-compile-workaround',
    hooks: {
      'astro:config:setup': ({ updateConfig }) => {
        updateConfig({
          vite: {
            plugins: [{
              name: 'restore-assets',
              writeBundle() {
                // Copy dari prerender ke dist/_astro/
              }
            }]
          }
        });
      },
      'astro:build:done': ({ dir }) => {
        // Copy .webp dari dist/_astro/ ke dist/client/_astro/
      }
    }
  };
}

// astro.config.mjs
export default defineConfig({
  output: 'static',
  adapter: cloudflare({ imageService: 'compile' }),
  integrations: [workaround()],
});
```

### Iterasi 3: SSR Mode (Final)

```javascript
// astro.config.mjs
export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
  integrations: [mdx(), sitemap()],
});
```

## Lessons Learned

### 1. Adapter Behavior Changes

Astro v6 adapter lebih "smart" tapi juga lebih kompleks:
- Auto-detect image service berdasarkan output mode
- `preserveBuildClientDir` mempengaruhi asset pipeline
- Integration dengan Wrangler lebih tight

### 2. Image Service Types

| Service | Mode | Processing | When to Use |
|---------|------|------------|-------------|
| `compile` | Static | Sharp at build | Pure static sites |
| `cloudflare-binding` | SSR | CF Images API | Dynamic sites, full wrangler dev |
| `passthrough` | - | No optimization | Debug, disable optimization |
| `external` | - | Third-party | Custom CDN |

### 3. Output Mode Matters

```javascript
// output: 'static'
// - Semua halaman pre-rendered
// - Tidak ada server runtime
// - imageService: 'compile' (manual) atau auto-detect

// output: 'server'
// - Halaman di-render on-demand
// - Ada server runtime
// - imageService: 'cloudflare-binding' (default)
```

### 4. Development Workflow

**Static mode:**
- `astro dev` → Node.js dev server
- Build → `dist/client/` static files
- Preview → HTTP server manual atau `astro preview`

**SSR mode:**
- `wrangler dev` → Full Worker simulation dengan bindings
- Build → `dist/client/` + `dist/server/` Worker code
- Preview → `wrangler dev` atau deploy langsung

## Kritik & Refleksi: Masalah Fundamental Astro v6

### 1. Hybrid Mode Sudah Di-Drop Dengan Dokumentasi Yang Belum Mature

**Fakta:** Astro v6 menghapus `output: 'hybrid'` — fitur yang banyak dipakai user untuk mix static + dynamic pages.

**Warning memang ada di CLI saat build:**
```bash
$ astro build
[config] Astro found issue(s) with your configuration:

! The output: "hybrid" option has been removed. Use output: "static" 
  (the default) instead, which now behaves the same way.
```

**Masalah:**
- Warning CLI ada, tapi dokumentasi belum mature/update secara komprehensif
- Tidak ada migration guide yang menjelaskan perbedaan perilaku antara hybrid vs static/server
- User mendapat warning tapi tidak tahu cara migrate dengan benar
- Astro v6 mungkin belum fully stabilized atau dokumentasinya yang belum update

**Impact:** Developer harus refactor seluruh architecture ke `output: 'server'` atau `output: 'static'`, tanpa panduan yang jelas tentang trade-offs masing-masing.

### 2. Auto-Detect Magic yang Confusing

**Masalah fundamental:** Astro v6 mencoba "smart defaults" untuk image service:

```typescript
// packages/integrations/cloudflare/src/utils/image-config.ts
// PR #15435 mengubah ini:
const mode = config ?? 'compile';        // v5: explicit, predictable
// menjadi:
const mode = config ?? 'cloudflare-binding';  // v6: magic, ambiguous
```

**Kenapa ini problematic:**

| Output Mode | imageService Default | Hasil HTML | Works di Static Deploy? |
|-------------|---------------------|------------|-------------------------|
| `'static'` | `'cloudflare-binding'` | `/_image?href=...` | ❌ **404** (no Worker) |
| `'server'` | `'cloudflare-binding'` | `/_image?href=...` | ✅ Worker handle |
| `'static'` + explicit `'compile'` | `'compile'` | `/_astro/*.webp` | ✅ Static files |

**User harus tau:**
- Default image service untuk static = broken
- Harus explicit set `imageService: 'compile'` untuk static
- Atau switch ke `output: 'server'` untuk menggunakan runtime optimization

**Ini adalah behavioral change yang dokumentasinya belum mature** — warning ada di CLI, tapi tidak ada:
- Dokumentasi yang menjelaskan perbedaan `cloudflare-binding` vs `compile`
- Matrix compatibility antara `output` mode dan `imageService`
- Troubleshooting guide untuk "404 on images"

### 3. Perbandingan: Astro v6 vs SvelteKit

SvelteKit lebih superior untuk Cloudflare Workers deployment:

| Aspek | SvelteKit | Astro v6 |
|-------|-----------|----------|
| **Adapter Config** | Explicit, predictable | Auto-magic, ambiguous |
| **Output Mode** | `prerender` per-route (granular) | Global `output` saja (all-or-nothing) |
| **Image Pipeline** | Clear (vite-imagetools, unpic) | Auto-detect yang confusing |
| **Dev Experience** | `wrangler dev` works consistently | Depends on output + imageService combo |
| **Documentation** | Up-to-date, examples work | Often outdated, behavior changes not documented |
| **Migration Path** | Clear deprecation warnings | Breaking changes tanpa announcement |

**Contoh SvelteKit (Clean):**

```javascript
// svelte.config.js
import adapter from '@sveltejs/adapter-cloudflare';

export default {
  kit: {
    adapter: adapter({
      // Explicit, no magic
      routes: {
        include: ['/*'],
        exclude: ['<all>']
      }
    })
  }
};
```

```svelte
<!-- src/routes/blog/+page.svelte -->
<script>
  // Per-page prerender control
  export const prerender = true;  // atau false
</script>

<img src="/images/photo.jpg" alt="Static" />
<!-- Atau pakai vite-imagetools untuk optimization -->
```

### 4. Dampak ke Developer Experience

**Issue #16931 adalah symptom dari masalah lebih besar:**

1. **Dokumentasi tidak setegas SvelteKit** — Astro mendokumentasikan "works with Cloudflare" tapi tidak jelaskan caveat-caveat penting

2. **Konvensi berubah tanpa warning** — v5 hybrid → v6 server/static adalah perubahan architectural yang drastis

3. **Debugging nightmare** — untuk tahu kenapa image 404, developer harus:
   - Trace ke `normalizeImageServiceConfig()`
   - Paham `preserveBuildClientDir`
   - Mengerti bedanya `cloudflare-binding` vs `compile`
   - Tau bahwa default untuk static = broken

4. **No clear best practice** — Dokumentasi tidak menjawab: "Kalau mau blog static tapi wrangler dev, gimana?"

### 5. Rekomendasi untuk Astro Team

Dari pengalaman debugging ini, berikut yang harus di-improve:

**A. Dokumentasi yang Explicit**
```markdown
## Deployment Modes

### Static Sites (Blog, Docs)
```js
output: 'static',
adapter: cloudflare({ imageService: 'compile' })
```
⚠️ **Required:** Explicit set imageService ke 'compile'
❌ Default akan generate /_image URLs yang 404
```

### Dynamic Sites (Apps, Dashboards)
```js
output: 'server',
adapter: cloudflare()
```
✅ Default works, image optimization via Cloudflare Images API
```
```

**B. Warning saat Build**
```bash
$ astro build
⚠️  [WARN] output: 'static' dengan default imageService akan 
    generate /_image URLs. Untuk static deployment, set:
    adapter: cloudflare({ imageService: 'compile' })
```

**C. Clear Migration Guide**
- Hybrid → Static: Cara handle routes yang tadinya dynamic
- Hybrid → Server: Performance impact, cold start considerations
- Pages → Workers: Architectural differences

### 6. Refleksi: Maturity vs Documentation

**Astro v6 adalah release yang promising tapi butuh investigasi lebih dalam:**

1. **Warning CLI memang ada** — tapi dokumentasi belum mature/catch up
2. **Magic behavior membutuhkan pemahaman lebih dalam** — bukan bug, tapi konvensi yang perlu dipelajari
3. **Dokumentasi tidak se-eksplisit SvelteKit** — Astro v6 mungkin belum fully stabilized atau dokumentasinya yang belum update
4. **"Works with Cloudflare" adalah simplification** — yang sebenarnya butuh pemahaman arsitektur Workers

**Rekomendasi untuk Astro:**
- Perlu dokumentasi yang lebih presisi dan matang
- Matrix compatibility yang jelas antara output mode dan image service
- Migration guide yang komprehensif

**SvelteKit adalah alternatif yang lebih mature** untuk developer yang membutuhkan:
- Explicit configuration
- Predictable behavior
- Documentation yang sudah mature
- Consistent dev experience dengan Wrangler

## Solusi Sementara (Workaround)

Untuk developer yang stuck dengan Astro v6:

**Pilihan 1: Explicit Config (Recommended)**
```javascript
// astro.config.mjs
export default defineConfig({
  // Selalu explicit, jangan rely on defaults
  output: 'server',
  adapter: cloudflare({
    // Explicit set imageService
    imageService: 'cloudflare-binding'
  }),
});
```

**Pilihan 2: Consider Migration ke SvelteKit**
Jika project baru atau refactoring besar, SvelteKit + Cloudflare Workers lebih predictable.

## References

- Issue: https://github.com/withastro/astro/issues/16931
- Cloudflare Adapter Docs: https://docs.astro.build/en/guides/integrations-guide/cloudflare/
- Cloudflare Images: https://developers.cloudflare.com/images/
- Astro Assets: https://docs.astro.build/en/guides/images/
- SvelteKit Cloudflare Adapter: https://kit.svelte.dev/docs/adapter-cloudflare

## Contributors

- **Reporter**: sandikodev (Rizqy Tridya Sandiko)
- **Fix**: Houston bot (Astro team)
- **Documentation**: Sisyphus AI Agent

---

**Catatan**: Dokumen ini adalah hasil debugging mendalam untuk issue yang muncul saat migrasi dari Astro v5 + Cloudflare Pages ke Astro v6 + Cloudflare Workers. Issue telah di-resolve via upstream fix dari tim Astro, tapi masalah fundamental dengan documentation dan developer experience tetap relevan.
