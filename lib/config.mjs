import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".config", "bc-cli");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const TOKEN_FILE = join(CONFIG_DIR, "tokens.json");

async function ensureDir() {
  await mkdir(CONFIG_DIR, { recursive: true });
}

async function readJson(path) {
  try {
    const data = await readFile(path, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function writeJson(path, data) {
  await ensureDir();
  await writeFile(path, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export async function getConfig() {
  return (await readJson(CONFIG_FILE)) ?? {};
}

export async function setConfig(config) {
  const existing = await getConfig();
  await writeJson(CONFIG_FILE, { ...existing, ...config });
}

export async function getTokens() {
  return (await readJson(TOKEN_FILE)) ?? {};
}

export async function setTokens(tokens) {
  await writeJson(TOKEN_FILE, { ...tokens, savedAt: new Date().toISOString() });
}

export async function clearTokens() {
  await writeJson(TOKEN_FILE, {});
}

export { CONFIG_DIR, CONFIG_FILE, TOKEN_FILE };
