import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

const adminUiDirectory = join(process.cwd(), "src/server/admin-ui");

function readAsset(fileName: string): string {
  return readFileSync(join(adminUiDirectory, fileName), "utf8");
}

export async function registerAdminUiRoutes(fastify: FastifyInstance) {
  fastify.get("/admin", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return readAsset("index.html");
  });

  fastify.get("/admin/admin.css", async (_request, reply) => {
    reply.type("text/css; charset=utf-8");
    return readAsset("admin.css");
  });

  fastify.get("/admin/admin.js", async (_request, reply) => {
    reply.type("application/javascript; charset=utf-8");
    return readAsset("admin.js");
  });
}
