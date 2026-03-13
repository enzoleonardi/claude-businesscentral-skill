#!/usr/bin/env node

import { getConfig, setConfig, getTokens, setTokens } from "../lib/config.mjs";
import { loginWithBrowser, logout, extractTenantFromToken, detectEnvironments, generateAuthUrl, exchangeCodeForTokens, DEFAULT_CLIENT_ID } from "../lib/auth.mjs";
import { getCompanies, query, getById, create, update, remove, queryAll, request } from "../lib/api.mjs";

const args = process.argv.slice(2);
const command = args[0];

function getArg(name) {
  return args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
}

async function promptLogin() {
  const clientId = process.env.BC_CLIENT_ID ?? getArg("client-id") ?? DEFAULT_CLIENT_ID;
  const tenant = process.env.BC_TENANT_ID ?? getArg("tenant") ?? "common";
  const environment = process.env.BC_ENVIRONMENT ?? getArg("environment") ?? "production";

  await setConfig({ clientId, tenant, environment });

  console.log("Authenticating with Business Central...");
  console.log(`  Tenant: ${tenant}`);
  console.log(`  Environment: ${environment}`);
  console.log("");
  console.log("Opening browser for login...");

  const tokenResponse = await loginWithBrowser(clientId, tenant);

  await setTokens({
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token,
    expires_in: tokenResponse.expires_in,
    token_type: tokenResponse.token_type,
  });

  console.log("");
  console.log("Authentication successful!");

  // Auto-detect tenant from token
  const detectedTenant = extractTenantFromToken(tokenResponse.access_token);
  if (detectedTenant && tenant === "common") {
    await setConfig({ tenant: detectedTenant });
    console.log(`  Tenant auto-detected: ${detectedTenant}`);
  }

  const effectiveTenant = detectedTenant ?? tenant;

  // Auto-detect environment
  console.log("  Detecting environments...");
  const envs = await detectEnvironments(tokenResponse.access_token, effectiveTenant);

  if (envs.length === 0) {
    console.log("");
    console.log("No Business Central environments found.");
    console.log("Check that your account has a BC license and access.");
  } else if (envs.length === 1) {
    await setConfig({ environment: envs[0].name });
    console.log(`  Environment auto-detected: ${envs[0].name}`);
    console.log("");
    console.log("Companies:");
    for (const c of envs[0].companies) {
      console.log(`  - ${c.displayName || "(unnamed)"} (${c.id})`);
    }
  } else {
    // Multiple environments — pick the one with most companies, or prefer production
    const best = envs.find((e) => e.name === "production" && e.companies.length > 0)
      ?? envs.find((e) => e.companies.length > 0)
      ?? envs[0];
    await setConfig({ environment: best.name });
    console.log(`  Environment set to: ${best.name}`);
    console.log("");
    console.log("Available environments:");
    for (const e of envs) {
      console.log(`  - ${e.name} (${e.companies.length} companies)`);
    }
    console.log("");
    console.log(`Using: ${best.name}. Change with: bc-cli login --environment=<name>`);
    console.log("");
    console.log("Companies:");
    for (const c of best.companies) {
      console.log(`  - ${c.displayName || "(unnamed)"} (${c.id})`);
    }
  }

  console.log("");
  console.log("Ready! Try: bc-cli test");
}

async function handleSaveToken() {
  const fileArg = getArg("file");
  const tenant = getArg("tenant");
  const environment = getArg("environment");

  let jsonInput;

  if (fileArg) {
    // Read from file
    const { readFileSync } = await import("node:fs");
    jsonInput = readFileSync(fileArg, "utf-8");
  } else if (args[1] && !args[1].startsWith("--")) {
    // From argument
    jsonInput = args[1];
  } else {
    // Read from stdin
    const chunks = [];
    const { stdin } = process;
    if (stdin.isTTY) {
      console.error("Usage: bc-cli save-token '<json>' [--tenant=<ID>] [--environment=<ENV>]");
      console.error("       bc-cli save-token --file=token.json [--environment=<ENV>]");
      console.error("       echo '$TOKEN_JSON' | bc-cli save-token - [--environment=<ENV>]");
      console.error("");
      console.error("Save a token response JSON directly (no network calls).");
      process.exit(1);
    }
    for await (const chunk of stdin) {
      chunks.push(chunk);
    }
    jsonInput = Buffer.concat(chunks).toString("utf-8");
  }

  let tokenData;
  try {
    tokenData = JSON.parse(jsonInput.trim());
  } catch {
    console.error("Error: Invalid JSON input.");
    console.error("Tip: Save token to a file first, then use --file=token.json");
    process.exit(1);
  }

  if (!tokenData.access_token) {
    console.error("Error: JSON must contain 'access_token' field.");
    process.exit(1);
  }

  await setTokens({
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_in: tokenData.expires_in,
    token_type: tokenData.token_type ?? "Bearer",
  });

  // Auto-detect tenant from token if not provided
  const detectedTenant = extractTenantFromToken(tokenData.access_token);
  const effectiveTenant = tenant ?? detectedTenant;
  const configUpdate = {};
  if (effectiveTenant) configUpdate.tenant = effectiveTenant;
  if (environment) configUpdate.environment = environment;
  if (Object.keys(configUpdate).length > 0) {
    await setConfig(configUpdate);
  }

  console.log("Token saved successfully.");
  if (effectiveTenant) console.log(`  Tenant: ${effectiveTenant}`);
  if (environment) console.log(`  Environment: ${environment}`);

  // Try to detect environments if not specified
  if (!environment && effectiveTenant) {
    console.log("  Detecting environments...");
    const envs = await detectEnvironments(tokenData.access_token, effectiveTenant);
    if (envs.length > 0) {
      const best = envs.find((e) => e.name === "production" && e.companies.length > 0)
        ?? envs.find((e) => e.companies.length > 0)
        ?? envs[0];
      await setConfig({ environment: best.name });
      console.log(`  Environment: ${best.name}`);
      console.log("");
      console.log("Companies:");
      for (const c of best.companies) {
        console.log(`  - ${c.displayName || "(unnamed)"} (${c.id})`);
      }
    }
  }

  console.log("");
  console.log("Ready! Try: bc-cli test");
}

async function handleLoginExchange() {
  const code = getArg("code");
  const verifier = getArg("verifier");
  const environment = getArg("environment");
  const port = getArg("port") ?? "33333";
  const redirectUri = getArg("redirect-uri") ?? `http://localhost:${port}`;
  const tenant = getArg("tenant") ?? (await getConfig()).tenant ?? "common";
  const clientId = getArg("client-id") ?? (await getConfig()).clientId ?? DEFAULT_CLIENT_ID;

  if (!code || !verifier) {
    console.error("Usage: bc-cli login-exchange --code=<CODE> --verifier=<VERIFIER> [--environment=<ENV>]");
    console.error("");
    console.error("Atomic code exchange + token save. Use after login-url.");
    console.error("The code can be the full callback URL or just the code value.");
    process.exit(1);
  }

  // Extract code from URL if needed
  let authCode = code;
  try {
    const url = new URL(code);
    authCode = url.searchParams.get("code") ?? code;
  } catch {
    // Not a URL, use as-is
  }

  console.log("Exchanging code for tokens...");

  const tokenResponse = await exchangeCodeForTokens(clientId, tenant, authCode, redirectUri, verifier);

  await setTokens({
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token,
    expires_in: tokenResponse.expires_in,
    token_type: tokenResponse.token_type,
  });

  console.log("Authentication successful!");

  const detectedTenant = extractTenantFromToken(tokenResponse.access_token);
  const effectiveTenant = detectedTenant ?? tenant;
  const configUpdate = { clientId, tenant: effectiveTenant };
  if (environment) configUpdate.environment = environment;
  await setConfig(configUpdate);

  if (detectedTenant) console.log(`  Tenant: ${detectedTenant}`);

  if (!environment) {
    console.log("  Detecting environments...");
    const envs = await detectEnvironments(tokenResponse.access_token, effectiveTenant);
    if (envs.length > 0) {
      const best = envs.find((e) => e.name === "production" && e.companies.length > 0)
        ?? envs.find((e) => e.companies.length > 0)
        ?? envs[0];
      await setConfig({ environment: best.name });
      console.log(`  Environment: ${best.name}`);
      console.log("");
      console.log("Companies:");
      for (const c of best.companies) {
        console.log(`  - ${c.displayName || "(unnamed)"} (${c.id})`);
      }
    }
  } else {
    console.log(`  Environment: ${environment}`);
  }

  console.log("");
  console.log("Ready! Try: bc-cli test");
}

async function handleLoginUrl() {
  const clientId = process.env.BC_CLIENT_ID ?? getArg("client-id") ?? DEFAULT_CLIENT_ID;
  const tenant = process.env.BC_TENANT_ID ?? getArg("tenant") ?? "common";
  const port = getArg("port") ?? "33333";

  const { authorizeUrl, verifier, redirectUri, state, effectiveClientId } = generateAuthUrl(clientId, tenant, parseInt(port));

  await setConfig({ clientId: effectiveClientId, tenant });

  // Output as JSON so the calling process can parse verifier + redirectUri
  console.log(JSON.stringify({
    authorizeUrl,
    verifier,
    redirectUri,
    state,
    port,
    clientId: effectiveClientId,
    tenant,
  }, null, 2));
}

async function handleLoginCode() {
  // Accepts either:
  // 1. A full callback URL: http://localhost:33333/?code=...&state=...
  // 2. Just the code value
  const input = args[1];
  const verifier = getArg("verifier");
  const redirectUri = getArg("redirect-uri") ?? "http://localhost:33333";
  const tenant = getArg("tenant") ?? (await getConfig()).tenant ?? "common";
  const clientId = getArg("client-id") ?? (await getConfig()).clientId ?? DEFAULT_CLIENT_ID;

  if (!input) {
    console.error("Usage: bc-cli login-code <url-or-code> --verifier=<PKCE_VERIFIER> [--redirect-uri=<URI>]");
    console.error("");
    console.error("  <url-or-code>   Full callback URL (http://localhost:33333/?code=...) or just the code");
    console.error("  --verifier      PKCE code verifier from login-url output");
    console.error("  --redirect-uri  Redirect URI (default: http://localhost:33333)");
    process.exit(1);
  }

  if (!verifier) {
    console.error("Error: --verifier is required. Get it from the login-url output.");
    process.exit(1);
  }

  // Extract code from URL or use as-is
  let code = input;
  try {
    const url = new URL(input);
    code = url.searchParams.get("code") ?? input;
  } catch {
    // Not a URL, use as-is
  }

  console.log("Exchanging code for tokens...");

  const tokenResponse = await exchangeCodeForTokens(clientId, tenant, code, redirectUri, verifier);

  await setTokens({
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token,
    expires_in: tokenResponse.expires_in,
    token_type: tokenResponse.token_type,
  });

  console.log("Authentication successful!");

  // Auto-detect tenant
  const detectedTenant = extractTenantFromToken(tokenResponse.access_token);
  if (detectedTenant) {
    await setConfig({ tenant: detectedTenant });
    console.log(`  Tenant: ${detectedTenant}`);
  }

  // Auto-detect environment
  const effectiveTenant = detectedTenant ?? tenant;
  console.log("  Detecting environments...");
  const envs = await detectEnvironments(tokenResponse.access_token, effectiveTenant);

  if (envs.length === 0) {
    console.log("  No environments found. Set manually: bc-cli login --environment=<name>");
  } else if (envs.length === 1) {
    await setConfig({ environment: envs[0].name });
    console.log(`  Environment: ${envs[0].name}`);
    console.log("");
    console.log("Companies:");
    for (const c of envs[0].companies) {
      console.log(`  - ${c.displayName || "(unnamed)"} (${c.id})`);
    }
  } else {
    const best = envs.find((e) => e.name === "production" && e.companies.length > 0)
      ?? envs.find((e) => e.companies.length > 0)
      ?? envs[0];
    await setConfig({ environment: best.name });
    console.log(`  Environment: ${best.name}`);
    console.log("");
    console.log("Available environments:");
    for (const e of envs) {
      console.log(`  - ${e.name} (${e.companies.length} companies)`);
    }
    console.log("");
    console.log("Companies:");
    for (const c of best.companies) {
      console.log(`  - ${c.displayName || "(unnamed)"} (${c.id})`);
    }
  }

  console.log("");
  console.log("Ready! Try: bc-cli test");
}

async function showStatus() {
  const config = await getConfig();
  const tokens = await getTokens();

  console.log("Configuration:");
  console.log(`  Client ID: ${config.clientId ? config.clientId.substring(0, 8) + "..." : "(default)"}`);
  console.log(`  Tenant: ${config.tenant ?? "(not set)"}`);
  console.log(`  Environment: ${config.environment ?? "(not set)"}`);
  console.log("");

  if (tokens.access_token) {
    const savedAt = tokens.savedAt ? new Date(tokens.savedAt) : null;
    const expiresIn = tokens.expires_in ?? 0;
    const expiresAt = savedAt ? new Date(savedAt.getTime() + expiresIn * 1000) : null;
    const isExpired = expiresAt ? Date.now() > expiresAt.getTime() : true;
    const hasRefresh = !!tokens.refresh_token;

    console.log("Authentication:");
    console.log(`  Status: ${isExpired ? (hasRefresh ? "Expired (will auto-refresh)" : "Expired") : "Active"}`);
    console.log(`  Token saved: ${savedAt?.toLocaleString() ?? "unknown"}`);
    console.log(`  Expires: ${expiresAt?.toLocaleString() ?? "unknown"}`);
    console.log(`  Refresh token: ${hasRefresh ? "Yes" : "No"}`);
  } else {
    console.log("Authentication: Not logged in");
  }
}

async function testConnection() {
  try {
    const companies = await getCompanies();
    console.log("Connection successful!");
    console.log("");
    console.log("Companies:");
    const companyList = companies.value ?? [];
    if (companyList.length === 0) {
      console.log("  (no companies found)");
      return;
    }
    for (const c of companyList) {
      console.log(`  - ${c.displayName}`);
      console.log(`    ID: ${c.id}`);
      console.log(`    Business Profile: ${c.businessProfileId || "(none)"}`);
    }
    console.log("");
    console.log(`Total: ${companyList.length} company(ies)`);
  } catch (err) {
    console.error("Connection failed:", err.message);
    process.exit(1);
  }
}

async function handleQuery() {
  const companyId = args[1];
  const entity = args[2];

  if (!companyId || !entity) {
    console.error("Usage: bc-cli query <companyId> <entity> [odata-params] [--top=N] [--orderby=...] [--select=...] [--filter=...] [--expand=...] [--all]");
    process.exit(1);
  }

  // Build OData params from convenience flags + raw params
  const parts = [];
  const top = getArg("top");
  const orderby = getArg("orderby");
  const select = getArg("select");
  const filter = getArg("filter");
  const expand = getArg("expand");

  if (top) parts.push(`$top=${top}`);
  if (orderby) parts.push(`$orderby=${orderby}`);
  if (select) parts.push(`$select=${select}`);
  if (filter) parts.push(`$filter=${filter}`);
  if (expand) parts.push(`$expand=${expand}`);

  // Also include any raw positional OData params (legacy)
  const rawParams = args.slice(3).filter((a) => !a.startsWith("--")).join(" ").trim();
  if (rawParams) parts.push(rawParams);

  const params = parts.join("&");
  const fetchAll = args.includes("--all");

  const data = fetchAll
    ? await queryAll(companyId, entity, params)
    : await query(companyId, entity, params);

  console.log(JSON.stringify(data, null, 2));
}

async function handleGet() {
  const companyId = args[1];
  const entity = args[2];
  const id = args[3];

  if (!companyId || !entity || !id) {
    console.error("Usage: bc-cli get <companyId> <entity> <id>");
    process.exit(1);
  }

  const data = await getById(companyId, entity, id);
  console.log(JSON.stringify(data, null, 2));
}

async function handleCreate() {
  const companyId = args[1];
  const entity = args[2];
  const jsonData = args[3];

  if (!companyId || !entity || !jsonData) {
    console.error("Usage: bc-cli create <companyId> <entity> '<json>'");
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonData);
  } catch {
    console.error("Error: Invalid JSON data.");
    process.exit(1);
  }
  const data = await create(companyId, entity, parsed);
  console.log(JSON.stringify(data, null, 2));
}

async function handleUpdate() {
  const companyId = args[1];
  const entity = args[2];
  const id = args[3];
  const jsonData = args[4];
  const etag = getArg("etag");

  if (!companyId || !entity || !id || !jsonData) {
    console.error("Usage: bc-cli update <companyId> <entity> <id> '<json>' [--etag=<etag>]");
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonData);
  } catch {
    console.error("Error: Invalid JSON data.");
    process.exit(1);
  }
  const data = await update(companyId, entity, id, parsed, etag);
  console.log(JSON.stringify(data, null, 2));
}

async function handleDelete() {
  const companyId = args[1];
  const entity = args[2];
  const id = args[3];
  const etag = getArg("etag");

  if (!companyId || !entity || !id) {
    console.error("Usage: bc-cli delete <companyId> <entity> <id> [--etag=<etag>]");
    process.exit(1);
  }

  await remove(companyId, entity, id, etag);
  console.log("Deleted successfully.");
}

async function handleRaw() {
  const method = (args[1] ?? "GET").toUpperCase();
  const path = args[2];

  if (!path) {
    console.error("Usage: bc-cli raw <METHOD> <path> [body-json]");
    console.error("Example: bc-cli raw GET /companies");
    process.exit(1);
  }

  let body;
  if (args[3]) {
    try {
      body = JSON.parse(args[3]);
    } catch {
      console.error("Error: Invalid JSON body.");
      process.exit(1);
    }
  }
  const options = { method };
  if (body) options.body = JSON.stringify(body);

  const data = await request(path, options);
  console.log(JSON.stringify(data, null, 2));
}

function showHelp() {
  console.log("bc-cli - Business Central CLI for Claude Code");
  console.log("");
  console.log("Authentication:");
  console.log("  login       Open browser to authenticate (no setup needed)");
  console.log("              --tenant=<ID>        Tenant ID (default: common)");
  console.log("              --environment=<ENV>  BC environment (default: production)");
  console.log("              --client-id=<ID>     Custom Azure AD app (optional)");
  console.log("  login-url       Generate auth URL for manual/Cowork login (outputs JSON)");
  console.log("                  --port=<PORT>        Localhost port (default: 33333)");
  console.log("  login-exchange  Exchange code + save token in one step (recommended for Cowork)");
  console.log("                  --code=<CODE_OR_URL> Authorization code or full callback URL");
  console.log("                  --verifier=<V>       PKCE verifier from login-url");
  console.log("                  --environment=<ENV>  Environment name");
  console.log("  login-code  Exchange auth code for tokens (legacy)");
  console.log("              <url-or-code>        Callback URL or authorization code");
  console.log("              --verifier=<V>       PKCE verifier from login-url");
  console.log("              --redirect-uri=<URI> Redirect URI (default: http://localhost:33333)");
  console.log("  save-token  Save a token JSON directly (no network calls)");
  console.log("              '<json>'             Token JSON as argument");
  console.log("              --file=<path>        Read token JSON from file");
  console.log("              -                    Read token JSON from stdin (pipe)");
  console.log("              --tenant=<ID>        Tenant ID (optional, auto-detected)");
  console.log("              --environment=<ENV>  Environment name (optional, auto-detected)");
  console.log("  logout      Clear saved tokens");
  console.log("  status      Show auth status and config");
  console.log("  test        Test connection and list companies");
  console.log("");
  console.log("Data operations:");
  console.log("  query     <companyId> <entity> [--top=N] [--orderby=...] [--select=...] [--filter=...] [--expand=...] [--all]");
  console.log("  get       <companyId> <entity> <id>");
  console.log("  create    <companyId> <entity> '<json>'");
  console.log("  update    <companyId> <entity> <id> '<json>' [--etag=<etag>]");
  console.log("  delete    <companyId> <entity> <id> [--etag=<etag>]");
  console.log("  raw       <METHOD> <path> [body-json]");
  console.log("");
  console.log("Environment variables (all optional):");
  console.log("  BC_TENANT_ID      Azure AD tenant ID");
  console.log("  BC_ENVIRONMENT    BC environment name");
  console.log("  BC_CLIENT_ID      Custom Azure AD client ID");
}

try {
  switch (command) {
    case "login":
      await promptLogin();
      break;
    case "login-url":
      await handleLoginUrl();
      break;
    case "login-exchange":
      await handleLoginExchange();
      break;
    case "login-code":
      await handleLoginCode();
      break;
    case "save-token":
      await handleSaveToken();
      break;
    case "logout":
      await logout();
      console.log("Logged out. Tokens cleared.");
      break;
    case "status":
      await showStatus();
      break;
    case "test":
      await testConnection();
      break;
    case "query":
      await handleQuery();
      break;
    case "get":
      await handleGet();
      break;
    case "create":
      await handleCreate();
      break;
    case "update":
      await handleUpdate();
      break;
    case "delete":
      await handleDelete();
      break;
    case "raw":
      await handleRaw();
      break;
    case "help":
    case "--help":
    case "-h":
      showHelp();
      break;
    default:
      if (command) {
        console.error(`Unknown command: ${command}`);
        console.error("");
      }
      showHelp();
      break;
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
