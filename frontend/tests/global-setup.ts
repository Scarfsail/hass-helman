import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Build the bundles once before the suite so tests run against current source. */
export default function globalSetup(): void {
    // Always rebuild — cheap (~200ms) and guarantees the tests reflect the source.
    execSync("npm run build", { cwd: resolve(__dirname, ".."), stdio: "inherit" });
    for (const name of ["helman-card.js", "helman-config-editor.js"]) {
        const bundle = resolve(
            __dirname,
            `../../custom_components/helman/frontend_compiled/${name}`,
        );
        if (!existsSync(bundle)) {
            throw new Error(`Bundle not found after build: ${bundle}`);
        }
    }
}
