import { config } from "./config.js";

const SERVICE_PORTS = {
  api: config.service.apiPort,
  crawler: config.service.crawlerPort,
  realtime: config.service.realtimePort,
  scheduler: config.service.schedulerPort
};

export function serviceUrl(service, pathname = "/internal/health") {
  const port = SERVICE_PORTS[service];
  if (!port) throw new Error(`Unknown service: ${service}`);
  return `http://${config.service.host}:${port}${pathname}`;
}

export async function requestService(service, pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? config.service.requestTimeoutMs);
  try {
    const response = await fetch(serviceUrl(service, pathname), {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(config.service.internalToken ? { "X-Internal-Service-Token": config.service.internalToken } : {}),
        ...options.headers
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `${service} service HTTP ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export function requireInternalService(request, response, next) {
  if (
    config.service.internalToken &&
    request.get("X-Internal-Service-Token") !== config.service.internalToken
  ) {
    response.status(403).json({ ok: false, error: "forbidden" });
    return;
  }
  next();
}

export async function serviceStates() {
  const services = ["crawler", "realtime", "scheduler"];
  const settled = await Promise.allSettled(services.map((service) => requestService(service, "/internal/health")));
  return Object.fromEntries(
    services.map((service, index) => {
      const result = settled[index];
      return [
        service,
        result.status === "fulfilled"
          ? result.value
          : { ok: false, reachable: false, error: result.reason instanceof Error ? result.reason.message : String(result.reason) }
      ];
    })
  );
}
