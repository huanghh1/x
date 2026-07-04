import { config } from "../../config.js";

function isLoopbackAddress(value) {
  const address = String(value ?? "").replace(/^::ffff:/, "");
  return address === "127.0.0.1" || address === "::1" || address === "localhost";
}

export function hasLocalOrTokenAccess(request) {
  const configuredToken = config.app.mutationToken;
  if (configuredToken && request.get("X-API-Mutation-Token") === configuredToken) {
    return true;
  }
  return isLoopbackAddress(request.ip) || isLoopbackAddress(request.socket?.remoteAddress);
}

export function requireLocalMutation(request, response, next) {
  if (hasLocalOrTokenAccess(request)) {
    next();
    return;
  }
  response.status(403).json({ ok: false, error: "mutating API is only available from localhost" });
}

export function requireSensitiveRead(request, response, next) {
  if (hasLocalOrTokenAccess(request)) {
    next();
    return;
  }
  response.status(403).json({ ok: false, error: "sensitive API is only available from localhost" });
}
