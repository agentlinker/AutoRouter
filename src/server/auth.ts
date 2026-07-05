import type { FastifyReply, FastifyRequest } from "fastify";

import { HttpError } from "../utils/httpErrors.js";

function extractBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) {
    return null;
  }

  const [scheme, token] = headerValue.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token;
}

function extractQueryToken(request: FastifyRequest, key: string): string | null {
  const url = new URL(request.url, "http://localhost");
  const value = url.searchParams.get(key);
  return value && value.length > 0 ? value : null;
}

export function requireGatewayToken(
  request: FastifyRequest,
  _reply: FastifyReply,
  expectedToken: string | undefined
) {
  if (!expectedToken) {
    return;
  }

  const token = extractBearerToken(request.headers.authorization);
  if (token !== expectedToken) {
    throw new HttpError(401, "unauthorized", "Missing or invalid gateway token");
  }
}

export function requireAdminToken(
  request: FastifyRequest,
  _reply: FastifyReply,
  expectedToken: string | undefined
) {
  if (!expectedToken) {
    return;
  }

  const bearerToken = extractBearerToken(request.headers.authorization);
  const queryToken = extractQueryToken(request, "admin_token");
  const token = bearerToken ?? queryToken;

  if (token !== expectedToken) {
    throw new HttpError(401, "unauthorized", "Missing or invalid admin token");
  }
}
