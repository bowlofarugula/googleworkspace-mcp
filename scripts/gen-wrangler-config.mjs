// Generates wrangler.generated.jsonc from the tracked wrangler.jsonc, injecting the
// account-specific OAUTH_KV namespace id from `.env` (or the environment). This keeps the
// real id out of version control — the committed wrangler.jsonc carries only the
// `<your-kv-namespace-id>` placeholder. `npm run dev` / `npm run deploy` run this first and
// point wrangler at the generated file via --config.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const PLACEHOLDER = "<your-kv-namespace-id>";

// Minimal .env loader (KEY=VALUE). Existing process env wins.
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const id = process.env.OAUTH_KV_ID;
if (!id || id === PLACEHOLDER) {
  console.error(
    "OAUTH_KV_ID is not set. Put your KV namespace id in .env (see .env.example):\n" +
      "  OAUTH_KV_ID=<id from: npx wrangler kv namespace create OAUTH_KV>",
  );
  process.exit(1);
}

const config = readFileSync("wrangler.jsonc", "utf8");
if (!config.includes(PLACEHOLDER)) {
  console.error(`Expected the ${PLACEHOLDER} placeholder in wrangler.jsonc; not found.`);
  process.exit(1);
}
writeFileSync("wrangler.generated.jsonc", config.replaceAll(PLACEHOLDER, id));
console.log("Wrote wrangler.generated.jsonc (OAUTH_KV id injected).");
