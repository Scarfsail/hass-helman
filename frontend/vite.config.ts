import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
    const isProduction = mode === 'production';
    return {
        build: {
            lib: {
                entry: "./cards/app.ts",
                formats: ["es"],
                fileName: () => "helman-card.js",
            },
            rollupOptions: {
                external: []
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
