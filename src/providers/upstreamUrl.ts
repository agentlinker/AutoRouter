export type UpstreamOperation = "chat_completions" | "responses" | "messages";

const operationPaths: Record<UpstreamOperation, string> = {
  chat_completions: "/chat/completions",
  responses: "/responses",
  messages: "/messages"
};

const completeOperationPaths = Object.values(operationPaths);

export function resolveUpstreamUrl(
  configuredUrl: string,
  operation: UpstreamOperation
): string {
  const url = new URL(configuredUrl.trim());
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  const configuredOperationPath = completeOperationPaths.find((path) =>
    pathname.endsWith(path)
  );
  if (configuredOperationPath) {
    const prefix = pathname
      .slice(0, -configuredOperationPath.length)
      .replace(/\/+$/, "");
    url.pathname = `${prefix}${operationPaths[operation]}`;
    return url.toString();
  }

  const versionRoot = pathname === "/" ? "" : pathname;
  url.pathname = versionRoot.endsWith("/v1")
    ? `${versionRoot}${operationPaths[operation]}`
    : `${versionRoot}/v1${operationPaths[operation]}`;
  return url.toString();
}
