import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { FastifyInstance } from "fastify";

const adminDistDirectory = join(process.cwd(), "dist/admin");

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function readAdminIndex(): string {
  const indexPath = join(adminDistDirectory, "index.html");
  if (existsSync(indexPath)) {
    return readFileSync(indexPath, "utf8");
  }

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>AutoRouter Admin</title>
  </head>
  <body>
    <main style="font-family: sans-serif; max-width: 720px; margin: 48px auto;">
      <h1>AutoRouter Admin</h1>
      <div id="root"></div>
      <p>Admin frontend has not been built yet. Run <code>npm run build:admin</code>.</p>
    </main>
  </body>
</html>`;
}

function resolveAdminAsset(pathname: string): string | null {
  const relativePath = pathname.replace(/^\/admin\/?/, "");
  if (!relativePath || relativePath === "/") {
    return null;
  }

  const safeRelativePath = normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
  return join(adminDistDirectory, safeRelativePath);
}

export async function registerAdminUiRoutes(fastify: FastifyInstance) {
  fastify.get("/admin", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return readAdminIndex();
  });

  fastify.get<{ Params: { "*": string } }>("/admin/*", async (request, reply) => {
    const url = new URL(request.url, "http://localhost");
    const assetPath = resolveAdminAsset(url.pathname);

    if (assetPath && existsSync(assetPath)) {
      reply.type(contentTypes[extname(assetPath)] ?? "application/octet-stream");
      return readFileSync(assetPath);
    }

    reply.type("text/html; charset=utf-8");
    return readAdminIndex();
  });
}
