import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { RuntimeManagerLike } from "../../runtime/runtimeTypes.js";
import type { AppSettingsRepository } from "../../repositories/appSettingsRepository.js";
import { HttpError } from "../../utils/httpErrors.js";
import { buildSettingsSections, getSettingsSection } from "./adminRouteHelpers.js";
import {
  DEFAULT_RUNTIME_STATUS_SETTINGS,
  normalizeRuntimeStatusSettings
} from "../../runtime/runtimeStatus.js";

const runtimeStatusSettingsSchema = z.object({
  error_threshold: z.number().int().min(1).max(1000).optional(),
  rate_limit_backoff_seconds: z.array(z.number().positive()).min(1).optional(),
  permanent_after_final_backoff: z.boolean().optional(),
  clear_counters_on_success: z.boolean().optional(),
  auth_disables_provider: z.boolean().optional()
});

export async function registerAdminSettingsRoutes(
  fastify: FastifyInstance,
  dependencies: {
    runtimeManager: RuntimeManagerLike;
    appSettingsRepository?: AppSettingsRepository;
  }
) {
  fastify.get("/admin/api/settings", async () => {
    const snapshot = dependencies.runtimeManager.getSnapshot();
    const runtimeStatus =
      dependencies.appSettingsRepository?.getRuntimeStatusSettings() ??
      snapshot.runtimeStatusSettings ??
      DEFAULT_RUNTIME_STATUS_SETTINGS;

    return {
      data: [
        ...buildSettingsSections(snapshot.config, snapshot),
        {
          section_id: "runtime_status",
          label: "运行态与熔断",
          description: "Provider/模型运行态：错误阈值、429 退避与鉴权禁用策略。",
          items: [
            {
              key: "error_threshold",
              label: "连续其它错误阈值 N",
              value: String(runtimeStatus.error_threshold)
            },
            {
              key: "rate_limit_backoff_seconds",
              label: "429 退避阶梯(秒)",
              value: runtimeStatus.rate_limit_backoff_seconds.join(", ")
            },
            {
              key: "permanent_after_final_backoff",
              label: "顶阶后再 429 永久限流",
              value: String(runtimeStatus.permanent_after_final_backoff)
            },
            {
              key: "clear_counters_on_success",
              label: "成功后清零计数",
              value: String(runtimeStatus.clear_counters_on_success)
            },
            {
              key: "auth_disables_provider",
              label: "401/403 禁用整个 Provider",
              value: String(runtimeStatus.auth_disables_provider)
            }
          ],
          editable: true,
          values: runtimeStatus
        }
      ]
    };
  });

  fastify.get<{ Params: { sectionId: string } }>("/admin/api/settings/:sectionId", async (request) => {
    if (request.params.sectionId === "runtime_status") {
      const runtimeStatus =
        dependencies.appSettingsRepository?.getRuntimeStatusSettings() ??
        DEFAULT_RUNTIME_STATUS_SETTINGS;
      return {
        section_id: "runtime_status",
        label: "运行态与熔断",
        description: "Provider/模型运行态：错误阈值、429 退避与鉴权禁用策略。",
        items: [],
        editable: true,
        values: runtimeStatus
      };
    }

    const snapshot = dependencies.runtimeManager.getSnapshot();
    const detail = getSettingsSection(snapshot, request.params.sectionId);
    if (!detail) {
      throw new HttpError(404, "settings_section_not_found", "Settings section not found");
    }
    return detail;
  });

  fastify.put<{ Params: { sectionId: string }; Body: unknown }>(
    "/admin/api/settings/:sectionId",
    async (request) => {
      if (request.params.sectionId !== "runtime_status") {
        throw new HttpError(400, "settings_readonly", "This settings section is read-only");
      }
      if (!dependencies.appSettingsRepository) {
        throw new HttpError(500, "settings_unavailable", "Settings repository not configured");
      }
      const body = runtimeStatusSettingsSchema.parse(request.body ?? {});
      const values = dependencies.appSettingsRepository.setRuntimeStatusSettings(body);
      await dependencies.runtimeManager.reload();
      return {
        section_id: "runtime_status",
        label: "运行态与熔断",
        editable: true,
        values: normalizeRuntimeStatusSettings(values)
      };
    }
  );
}
