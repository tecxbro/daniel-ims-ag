import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.PHOTON_LLMS_URL?.trim();
if (!url) {
  throw new Error("PHOTON_LLMS_URL is not set.");
}

const res = await fetch(url);
if (!res.ok) {
  throw new Error(`Failed to fetch Photon docs: HTTP ${res.status}`);
}

const target = fileURLToPath(new URL("../references/photon-llms.md", import.meta.url));
await mkdir(dirname(target), { recursive: true });
await writeFile(target, await res.text());

console.log(`Cached Photon docs at ${target}`);
