import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
    const isProduction = mode === 'production';
    return {
        build: {
            lib: {
                entry: "./config-editor/index.ts",
                formats: ["es"],
                fileName: () => "helman-config-editor.js",
            },
            rollupOptions: {
                output: {
                    assetFileNames: "assets/[name][extname]",
                },
            },
            emptyOutDir: false,
            outDir: "../custom_components/helman/frontend_compiled",
            sourcemap: !isProduction,
            minify: isProduction
        },
        define: {
            "process.env.NODE_ENV": JSON.stringify(isProduction ? "production" : "development"),
        }
    }
});
