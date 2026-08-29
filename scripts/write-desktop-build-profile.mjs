import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const catalog = JSON.parse(readFileSync(resolve("build/desktop-build-profiles.json"), "utf8"));
const name = process.env.TOTAL_DESKTOP_BUILD_PROFILE ?? "production";
const profile = catalog?.schema === 1 ? catalog.profiles?.[name] : null;
if (!profile || profile.name !== name) throw new Error(`Unknown TOTAL_DESKTOP_BUILD_PROFILE: ${name}`);
mkdirSync(resolve("out"), { recursive: true });
writeFileSync(resolve("out/desktop-build-profile.json"), `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
console.log(`Embedded desktop build profile: ${profile.name}`);
