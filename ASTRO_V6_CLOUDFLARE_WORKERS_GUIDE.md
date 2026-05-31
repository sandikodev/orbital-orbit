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

## References

- Issue: https://github.com/withastro/astro/issues/16931
- Cloudflare Adapter Docs: https://docs.astro.build/en/guides/integrations-guide/cloudflare/
- Cloudflare Images: https://developers.cloudflare.com/images/
- Astro Assets: https://docs.astro.build/en/guides/images/

## Contributors

- **Reporter**: sandikodev (Rizqy Tridya Sandiko)
- **Fix**: Houston bot (Astro team)
- **Documentation**: Sisyphus AI Agent

---

**Catatan**: Dokumen ini adalah hasil debugging mendalam untuk issue yang muncul saat migrasi dari Astro v5 + Cloudflare Pages ke Astro v6 + Cloudflare Workers. Issue telah di-resolve via upstream fix dari tim Astro.
