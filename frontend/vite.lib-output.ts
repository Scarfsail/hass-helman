import { gzipSync, brotliCompressSync, constants as zlibConstants } from "node:zlib";

import type { Plugin } from "vite";

/**
 * Full minification for our ES library builds.
 *
 * Vite 8 (rolldown) deliberately weakens minification for `build.lib` ES output.
 * `build.minify: true` normalises to `"oxc"`, and for a lib+es target vite then
 * passes rolldown `output.minify = { compress: true, mangle: true, codegen: false }`
 * (see `resolveRolldownOptions` in `vite/dist/node/chunks/node.js`). With
 * `codegen: false` the bundle is compressed and mangled but still *pretty-printed*:
 * tab indentation, blank lines, `//#region` markers and retained annotation
 * comments. That is a sensible default for a library a downstream bundler will
 * minify again, but we ship these files straight to the browser, so we opt back
 * into codegen. Vite spreads the user `output` last in `buildOutputOptions`, so
 * setting `rolldownOptions.output.minify` here wins over the lib default.
 */
export const libMinifyOptions = {
    minify: {
        compress: true,
        mangle: { toplevel: true },
        codegen: true,
    },
    comments: false,
} as const;

/**
 * Write `.gz` and `.br` siblings next to every emitted JS/CSS file.
 *
 * The integration serves `frontend_compiled/` through `StaticPathConfig`, which
 * ends up in aiohttp's `FileResponse`. That looks for a pre-compressed sibling
 * (`<file>.br`, then `<file>.gz`) whenever the request carries a matching
 * `Accept-Encoding`, and serves it with the right `Content-Encoding`. Without
 * the siblings HA hands the browser the raw file uncompressed — measured at
 * 716 kB on the wire for `helman-card.js` against 139 kB for the brotli
 * sibling. Nothing here is load-bearing: if a sibling is missing, or a future
 * aiohttp stops looking for one, the plain file is served exactly as before.
 *
 * `build.emptyOutDir` is false for these configs, so the siblings are rewritten
 * on every build rather than left to go stale against a newer bundle.
 */
export function precompressAssets(isProduction: boolean): Plugin {
    return {
        name: "helman-precompress-assets",
        apply: "build",
        enforce: "post",
        generateBundle(_options, bundle) {
            for (const [fileName, chunk] of Object.entries(bundle)) {
                if (!/\.(js|css)$/.test(fileName)) continue;
                const source = chunk.type === "chunk" ? chunk.code : chunk.source;
                const raw = Buffer.from(source as string | Uint8Array);
                this.emitFile({
                    type: "asset",
                    fileName: `${fileName}.gz`,
                    source: gzipSync(raw, { level: isProduction ? 9 : 6 }),
                });
                this.emitFile({
                    type: "asset",
                    fileName: `${fileName}.br`,
                    source: brotliCompressSync(raw, {
                        params: {
                            [zlibConstants.BROTLI_PARAM_QUALITY]: isProduction ? 11 : 5,
                            [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
                        },
                    }),
                });
            }
        },
    };
}
