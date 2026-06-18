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
