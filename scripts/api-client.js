const MODULE_ID = "wi-core-foundry";

function baseUrl() {
  return (game.settings.get(MODULE_ID, "apiBaseUrl") || "http://127.0.0.1:8000").replace(/\/$/, "");
}

function apiKey() {
  return (game.settings.get(MODULE_ID, "apiKey") || "").trim();
}

export async function apiRequest(path, options = {}) {
  const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
  const key = apiKey();
  if (key) headers["X-API-Key"] = key;
  const response = await fetch(`${baseUrl()}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API ${path} failed (${response.status}): ${text}`);
  }
  return response.json();
}
