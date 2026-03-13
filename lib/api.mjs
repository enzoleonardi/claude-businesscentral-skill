import { execSync, spawnSync } from "node:child_process";
import { getValidToken } from "./auth.mjs";
import { getConfig } from "./config.mjs";

function buildBaseUrl(environment, tenant) {
  const env = environment ?? "production";
  if (tenant) {
    return `https://api.businesscentral.dynamics.com/v2.0/${tenant}/${env}/api/v2.0`;
  }
  return `https://api.businesscentral.dynamics.com/v2.0/${env}/api/v2.0`;
}

function shellEscape(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

const ALLOWED_METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD"]);

function curlRequest(url, method, headers, body) {
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`Invalid HTTP method: ${method}`);
  }
  const safeUrl = url.replace(/ /g, "%20");
  const curlArgs = ["-s", "-w", "\n%{http_code}", "-X", method, safeUrl];
  for (const [k, v] of Object.entries(headers)) {
    curlArgs.push("-H", `${k}: ${v}`);
  }
  if (body) {
    curlArgs.push("-d", body);
  }

  const result = spawnSync("curl", curlArgs, { encoding: "utf-8", timeout: 60000 });
  if (result.error) throw result.error;
  const output = result.stdout.trimEnd();
  const lines = output.split("\n");
  const statusCode = parseInt(lines.pop());
  const responseBody = lines.join("\n");

  if (statusCode === 204) return null;
  const data = responseBody ? JSON.parse(responseBody) : null;
  if (statusCode >= 400) {
    const message = data?.error?.message ?? data?.message ?? `HTTP ${statusCode}`;
    throw new Error(`BC API error (${statusCode}): ${message}`);
  }
  return data;
}

async function request(path, options = {}) {
  const config = await getConfig();
  const token = await getValidToken();
  const environment = config.environment ?? process.env.BC_ENVIRONMENT ?? "production";
  const tenant = config.tenant ?? process.env.BC_TENANT_ID;

  const baseUrl = buildBaseUrl(environment, tenant);
  const url = path.startsWith("http") ? path : `${baseUrl}${path}`;
  const method = options.method ?? "GET";

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...options.headers,
  };

  if (method === "GET") {
    headers["Data-Access-Intent"] = "ReadOnly";
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(url, { ...options, method, headers, signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      const message = error.error?.message ?? error.message ?? res.statusText;
      throw new Error(`BC API error (${res.status}): ${message}`);
    }

    if (res.status === 204) return null;
    return res.json();
  } catch (fetchErr) {
    // Fallback to curl (needed in sandboxed environments like Cowork)
    if (fetchErr.message?.startsWith("BC API error")) throw fetchErr;
    try {
      return curlRequest(url, method, headers, options.body);
    } catch (curlErr) {
      // Redact Bearer tokens from error messages
      const msg = curlErr.message?.replace(/Bearer [A-Za-z0-9._-]+/g, "Bearer [REDACTED]") ?? "Unknown error";
      throw new Error(msg);
    }
  }
}

export async function getCompanies() {
  return request("/companies");
}

export async function query(companyId, entity, params = "") {
  const qs = params ? `?${params}` : "";
  return request(`/companies(${companyId})/${entity}${qs}`);
}

export async function getById(companyId, entity, id) {
  return request(`/companies(${companyId})/${entity}(${id})`);
}

export async function create(companyId, entity, data) {
  return request(`/companies(${companyId})/${entity}`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function update(companyId, entity, id, data, etag) {
  const headers = {};
  if (etag) {
    headers["If-Match"] = etag;
  } else {
    headers["If-Match"] = "*";
  }

  return request(`/companies(${companyId})/${entity}(${id})`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(data),
  });
}

export async function remove(companyId, entity, id, etag) {
  const headers = {};
  if (etag) {
    headers["If-Match"] = etag;
  } else {
    headers["If-Match"] = "*";
  }

  return request(`/companies(${companyId})/${entity}(${id})`, {
    method: "DELETE",
    headers,
  });
}

const MAX_PAGES = 500;

export async function queryAll(companyId, entity, params = "") {
  const records = [];
  const qs = params ? `?${params}` : "";
  let data = await request(`/companies(${companyId})/${entity}${qs}`);

  records.push(...(data.value ?? []));

  let pages = 1;
  while (data["@odata.nextLink"] && pages < MAX_PAGES) {
    data = await request(data["@odata.nextLink"]);
    records.push(...(data.value ?? []));
    pages++;
  }

  return { value: records, count: records.length };
}

export { request, buildBaseUrl };
