import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
    const isProduction = mode === 'production';
    return {
        build: {
            lib: {
                entry: "./src/helman-simple/helman-simple-card.ts",
                formats: ["es"],
                fileName: () => `helman-simple-card-${isProduction ? "prod" : "dev"}.js`,
            },
            codeSplitting: false,
            rollupOptions: {
                external: []
            },
            emptyOutDir: false,
            outDir: './dist',
            assetsDir: "compiled",
            sourcemap: !isProduction,
            minify: isProduction
        },
        define: {
            "process.env.NODE_ENV": JSON.stringify(isProduction ? "production" : "development"),
        }
    }
});
