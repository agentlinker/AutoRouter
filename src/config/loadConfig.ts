import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

import { mergeObjects } from "../utils/mergeObjects.js";
import { routerConfigSchema, type RouterConfig } from "./schema.js";

type ConfigSource = Record<string, unknown>;

function expandHome(filePath: string): string {
  if (filePath === "~") {
    return homedir();
  }

  if (filePath.startsWith("~/")) {
    return join(homedir(), filePath.slice(2));
  }

  return filePath;
}

function readConfigFile(filePath: string): ConfigSource {
  const resolvedPath = resolve(expandHome(filePath));
  if (!existsSync(resolvedPath)) {
    return {};
  }

  const fileContent = readFileSync(resolvedPath, "utf8");
  const parsed = YAML.parse(fileContent) as ConfigSource | null;
  return parsed ?? {};
}

export interface LoadConfigOptions {
  cwd?: string;
  override?: ConfigSource;
  globalConfigPath?: string;
  projectConfigPath?: string;
}

export function loadConfig(options: LoadConfigOptions = {}): RouterConfig {
  const cwd = options.cwd ?? process.cwd();
  const globalConfigPath =
    options.globalConfigPath ?? join(cwd, "config/config.yaml");
  const projectConfigPath =
    options.projectConfigPath ?? join(cwd, "config/config.yaml");

  const merged = mergeObjects(
    {},
    readConfigFile(globalConfigPath),
    readConfigFile(projectConfigPath),
    options.override ?? {}
  );

  return routerConfigSchema.parse(merged);
}
