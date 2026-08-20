import { defineConfig } from "vite";
import { libMinifyOptions, precompressAssets } from "./vite.lib-output";

export default defineConfig(({ mode }) => {
    const isProduction = mode === 'production';
    return {
        build: {
            lib: {
                entry: "./config-editor/index.ts",
                formats: ["es"],
                fileName: () => "helman-config-editor.js",
            },
            rolldownOptions: {
                output: {
                    assetFileNames: "assets/[name][extname]",
                    ...(isProduction ? libMinifyOptions : {}),
                },
            },
            emptyOutDir: false,
            outDir: "../custom_components/helman/frontend_compiled",
            // Only current browsers are supported (HA's own frontend requires one),
            // so emit the newest syntax and skip all down-transpilation.
            target: "esnext",
            sourcemap: !isProduction,
            minify: isProduction
        },
        plugins: [precompressAssets(isProduction)],
        define: {
            "process.env.NODE_ENV": JSON.stringify(isProduction ? "production" : "development"),
        }
    }
});
