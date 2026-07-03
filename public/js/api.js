import { API_MUTATION_TOKEN_STORAGE_KEY } from "./constants.js";

function storedApiMutationToken() {
  try {
    return localStorage.getItem(API_MUTATION_TOKEN_STORAGE_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

function saveApiMutationToken(token) {
  try {
    const clean = String(token ?? "").trim();
    if (clean) localStorage.setItem(API_MUTATION_TOKEN_STORAGE_KEY, clean);
    else localStorage.removeItem(API_MUTATION_TOKEN_STORAGE_KEY);
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

function promptApiMutationToken() {
  if (typeof window.prompt !== "function") return "";
  const current = storedApiMutationToken();
  const token = window.prompt("请输入 API_MUTATION_TOKEN 后重试", current);
  if (token === null) return "";
  saveApiMutationToken(token);
  return String(token).trim();
}

function withApiAuthHeaders(options = {}) {
  const init = { ...options };
  const headers = new Headers(options.headers || {});
  const token = storedApiMutationToken();
  if (token && !headers.has("X-API-Mutation-Token")) {
    headers.set("X-API-Mutation-Token", token);
  }
  init.headers = headers;
  return init;
}

export async function api(path, options = {}) {
  let response = await fetch(path, withApiAuthHeaders(options));
  if (response.status === 403 && promptApiMutationToken()) {
    response = await fetch(path, withApiAuthHeaders(options));
  }
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok) {
    let message = `${path} ${response.status}`;
    try {
      const payload = await response.clone().json();
      if (payload?.error) message = payload.error;
    } catch {
      const text = await response.text().catch(() => "");
      if (text.trim().startsWith("<")) {
        message = `${path} 接口未返回 JSON，可能服务未重启或路由不存在`;
      } else if (text) {
        message = text.slice(0, 220);
      }
    }
    throw new Error(message);
  }
  if (!contentType.includes("application/json")) {
    const text = await response.text().catch(() => "");
    if (text.trim().startsWith("<")) {
      throw new Error(`${path} 接口未返回 JSON，可能服务未重启或路由不存在`);
    }
    throw new Error(`${path} 接口返回格式不是 JSON`);
  }
  return response.json();
}
