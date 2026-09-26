import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gatewayEnabled = ["1", "true", "yes", "on"].includes(
  String(process.env.ENABLE_GATEWAY ?? "").toLowerCase(),
);
const entry = gatewayEnabled
  ? path.join(root, "gateway", "gateway.js")
  : path.join(root, "backend", "src", "index.js");

await import(pathToFileURL(entry).href);
