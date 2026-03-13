import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import { getConfig, getTokens, setTokens, clearTokens } from "./config.mjs";

async function postForm(url, params) {
  const body = new URLSearchParams(params);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error_description ?? data.error ?? res.statusText);
    }
    return data;
  } catch (fetchErr) {
    // Fallback to curl (needed in sandboxed environments like Cowork)
    const curlArgs = ["-s", "-X", "POST", url, "-H", "Content-Type: application/x-www-form-urlencoded"];
    for (const [k, v] of Object.entries(params)) {
      curlArgs.push("-d", `${k}=${v}`);
    }
    try {
      const result = spawnSync("curl", curlArgs, { encoding: "utf-8", timeout: 30000 });
      if (result.error) throw result.error;
      const data = JSON.parse(result.stdout);
      if (data.error) {
        throw new Error(data.error_description ?? data.error);
      }
      return data;
    } catch (curlErr) {
      if (curlErr.message?.includes("error_description") || curlErr.message?.includes("invalid_grant")) {
        throw curlErr;
      }
      throw new Error(`Network request failed (fetch: ${fetchErr.message}, curl: ${curlErr.message})`);
    }
  }
}

const DEFAULT_CLIENT_ID = "0bac98ef-7d93-4eae-85af-2dc429a4e6ef";

const AUTHORIZE_URL_TEMPLATE =
  "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize";
const TOKEN_URL_TEMPLATE =
  "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token";

const BC_SCOPE =
  "https://api.businesscentral.dynamics.com/Financials.ReadWrite.All offline_access";

function buildUrl(template, tenant) {
  return template.replace("{tenant}", tenant);
}

function base64url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generatePkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>Authentication Successful</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         display: flex; justify-content: center; align-items: center; height: 100vh;
         margin: 0; background: #f0f2f5; }
  .card { background: white; padding: 48px; border-radius: 12px;
          box-shadow: 0 2px 12px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
  h1 { color: #0078d4; margin: 0 0 16px; }
  p { color: #555; margin: 0; }
</style></head>
<body><div class="card">
  <h1>Authenticated!</h1>
  <p>You can close this window and return to the terminal.</p>
</div></body></html>`;

const ERROR_HTML = (msg) => `<!DOCTYPE html>
<html><head><title>Authentication Failed</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         display: flex; justify-content: center; align-items: center; height: 100vh;
         margin: 0; background: #f0f2f5; }
  .card { background: white; padding: 48px; border-radius: 12px;
          box-shadow: 0 2px 12px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
  h1 { color: #d32f2f; margin: 0 0 16px; }
  p { color: #555; margin: 0; }
</style></head>
<body><div class="card">
  <h1>Authentication Failed</h1>
  <p>${escapeHtml(msg)}</p>
</div></body></html>`;

export async function loginWithBrowser(clientId, tenant) {
  const effectiveClientId = clientId ?? DEFAULT_CLIENT_ID;
  const port = await findFreePort();
  const redirectUri = `http://localhost:${port}`;
  const { verifier, challenge } = generatePkce();
  const state = base64url(randomBytes(16));

  const authParams = new URLSearchParams({
    client_id: effectiveClientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: BC_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });

  const authorizeUrl = `${buildUrl(AUTHORIZE_URL_TEMPLATE, tenant)}?${authParams}`;

  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Login timed out after 5 minutes"));
    }, 5 * 60 * 1000);

    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);

      if (url.pathname !== "/" || !url.searchParams.has("code") && !url.searchParams.has("error")) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      if (error) {
        const desc = url.searchParams.get("error_description") ?? error;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(ERROR_HTML(desc));
        clearTimeout(timeout);
        server.close();
        reject(new Error(`Authentication denied: ${desc}`));
        return;
      }

      const returnedState = url.searchParams.get("state");
      if (returnedState !== state) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(ERROR_HTML("State mismatch — possible CSRF attack"));
        clearTimeout(timeout);
        server.close();
        reject(new Error("State mismatch"));
        return;
      }

      const authCode = url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(SUCCESS_HTML);
      clearTimeout(timeout);
      server.close();
      resolve(authCode);
    });

    server.listen(port, "127.0.0.1", () => {
      // Open browser
      const openCmd =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "start"
            : "xdg-open";
      try {
        execSync(`${openCmd} "${authorizeUrl}"`, { stdio: "ignore" });
      } catch {
        console.log(`Open this URL in your browser:\n${authorizeUrl}`);
      }
    });
  });

  // Exchange code for tokens
  const tokenUrl = buildUrl(TOKEN_URL_TEMPLATE, tenant);
  return postForm(tokenUrl, {
    client_id: effectiveClientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    scope: BC_SCOPE,
  });
}

export function generateAuthUrl(clientId, tenant, port) {
  const effectiveClientId = clientId ?? DEFAULT_CLIENT_ID;
  const redirectUri = `http://localhost:${port}`;
  const { verifier, challenge } = generatePkce();
  const state = base64url(randomBytes(16));

  const authParams = new URLSearchParams({
    client_id: effectiveClientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: BC_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });

  const authorizeUrl = `${buildUrl(AUTHORIZE_URL_TEMPLATE, tenant)}?${authParams}`;

  return { authorizeUrl, verifier, redirectUri, state, effectiveClientId };
}

export async function exchangeCodeForTokens(clientId, tenant, code, redirectUri, codeVerifier) {
  const effectiveClientId = clientId ?? DEFAULT_CLIENT_ID;
  const tokenUrl = buildUrl(TOKEN_URL_TEMPLATE, tenant);

  return postForm(tokenUrl, {
    client_id: effectiveClientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    scope: BC_SCOPE,
  });
}

export async function refreshAccessToken(clientId, tenant, refreshToken) {
  const effectiveClientId = clientId ?? DEFAULT_CLIENT_ID;
  const url = buildUrl(TOKEN_URL_TEMPLATE, tenant);

  return postForm(url, {
    grant_type: "refresh_token",
    client_id: effectiveClientId,
    refresh_token: refreshToken,
    scope: BC_SCOPE,
  });
}

export async function getValidToken() {
  const config = await getConfig();
  const tokens = await getTokens();

  if (!tokens.access_token) {
    throw new Error("Not authenticated. Run: bc-cli login");
  }

  const savedAt = new Date(tokens.savedAt).getTime();
  const expiresIn = (tokens.expires_in ?? 3600) * 1000;
  const now = Date.now();
  const bufferMs = 5 * 60 * 1000;

  if (now > savedAt + expiresIn - bufferMs) {
    if (!tokens.refresh_token) {
      throw new Error("Token expired and no refresh token. Run: bc-cli login");
    }

    const clientId = config.clientId ?? process.env.BC_CLIENT_ID ?? DEFAULT_CLIENT_ID;
    const tenant = config.tenant ?? process.env.BC_TENANT_ID ?? "common";

    const newTokens = await refreshAccessToken(clientId, tenant, tokens.refresh_token);
    await setTokens({
      access_token: newTokens.access_token,
      refresh_token: newTokens.refresh_token ?? tokens.refresh_token,
      expires_in: newTokens.expires_in,
      token_type: newTokens.token_type,
    });

    return newTokens.access_token;
  }

  return tokens.access_token;
}

export function extractTenantFromToken(accessToken) {
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split(".")[1], "base64").toString()
    );
    return payload.tid ?? null;
  } catch {
    return null;
  }
}

async function fetchGetJson(url, accessToken) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return res.json();
  } catch {
    // Fallback to curl
    try {
      const result = spawnSync("curl", [
        "-s", "-w", "\n%{http_code}",
        "-H", `Authorization: Bearer ${accessToken}`,
        "-H", "Accept: application/json",
        url
      ], { encoding: "utf-8", timeout: 15000 });
      if (result.error) return null;
      const lines = result.stdout.trimEnd().split("\n");
      const statusCode = parseInt(lines.pop());
      if (statusCode >= 400) return null;
      return JSON.parse(lines.join("\n"));
    } catch {
      return null;
    }
  }
}

export async function detectEnvironments(accessToken, tenant) {
  const environments = [];
  for (const env of ["production", "prod", "sandbox"]) {
    try {
      const url = `https://api.businesscentral.dynamics.com/v2.0/${tenant}/${env}/api/v2.0/companies`;
      const data = await fetchGetJson(url, accessToken);
      if (data) {
        environments.push({ name: env, companies: data.value ?? [] });
      }
    } catch {
      // skip
    }
  }
  return environments;
}

export async function logout() {
  await clearTokens();
}

export { DEFAULT_CLIENT_ID };
