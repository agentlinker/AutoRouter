import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";

import {
  providerTemplatesFileSchema,
  type ProviderTemplate
} from "./providerTemplateSchema.js";

export interface ProviderTemplateLoadResult {
  templates: ProviderTemplate[];
  errors: string[];
}

let cachedResult: ProviderTemplateLoadResult | undefined;

function readTemplateFile(path: string): ProviderTemplateLoadResult {
  if (!existsSync(path)) {
    return { templates: [], errors: [] };
  }

  try {
    const parsed = providerTemplatesFileSchema.parse(
      YAML.parse(readFileSync(path, "utf8")) ?? {}
    );
    return { templates: parsed.templates, errors: [] };
  } catch (error) {
    return {
      templates: [],
      errors: [`${path}: ${error instanceof Error ? error.message : "invalid template file"}`]
    };
  }
}

export function loadProviderTemplates(cwd = process.cwd()): ProviderTemplateLoadResult {
  const bundled = readTemplateFile(resolve(join(cwd, "config/provider-templates.yaml")));
  const user = readTemplateFile(resolve(join(cwd, "config/provider-templates.user.yaml")));
  const byId = new Map<string, ProviderTemplate>();

  for (const template of bundled.templates) {
    byId.set(template.template_id, template);
  }
  for (const template of user.templates) {
    byId.set(template.template_id, template);
  }

  return {
    templates: Array.from(byId.values()).map((template) => structuredClone(template)),
    errors: [...bundled.errors, ...user.errors]
  };
}

export function getProviderTemplateLoadResult(): ProviderTemplateLoadResult {
  cachedResult ??= loadProviderTemplates();
  return {
    templates: cachedResult.templates.map((template) => structuredClone(template)),
    errors: [...cachedResult.errors]
  };
}

export function reloadProviderTemplates(): ProviderTemplateLoadResult {
  cachedResult = loadProviderTemplates();
  return getProviderTemplateLoadResult();
}

export function listProviderTemplates(): ProviderTemplate[] {
  return getProviderTemplateLoadResult().templates;
}

export function getProviderTemplate(templateId: string): ProviderTemplate | null {
  return listProviderTemplates().find((template) => template.template_id === templateId) ?? null;
}

export function listProviderTemplatesByVendor(vendorId: string): ProviderTemplate[] {
  return listProviderTemplates().filter((template) => template.vendor_id === vendorId);
}
