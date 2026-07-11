import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Build the card bundle once before the suite so tests run against current source. */
export default function globalSetup(): void {
    const bundle = resolve(
        __dirname,
        "../../custom_components/helman/frontend_compiled/helman-card.js",
    );
    // Always rebuild — cheap (~100ms) and guarantees the tests reflect the source.
    execSync("npm run build:card", { cwd: resolve(__dirname, ".."), stdio: "inherit" });
    if (!existsSync(bundle)) {
        throw new Error(`Card bundle not found after build: ${bundle}`);
    }
}
