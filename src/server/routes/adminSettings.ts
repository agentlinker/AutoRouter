import type { FastifyInstance } from "fastify";

import type { RuntimeManagerLike } from "../../runtime/runtimeTypes.js";
import { HttpError } from "../../utils/httpErrors.js";
import { buildSettingsSections, getSettingsSection } from "./adminRouteHelpers.js";

export async function registerAdminSettingsRoutes(
  fastify: FastifyInstance,
  dependencies: {
    runtimeManager: RuntimeManagerLike;
  }
) {
  fastify.get("/admin/api/settings", async () => {
    const snapshot = dependencies.runtimeManager.getSnapshot();

    return {
      data: buildSettingsSections(snapshot.config, snapshot)
    };
  });

  fastify.get<{ Params: { sectionId: string } }>("/admin/api/settings/:sectionId", async (request) => {
    const snapshot = dependencies.runtimeManager.getSnapshot();
    const detail = getSettingsSection(snapshot, request.params.sectionId);

    if (!detail) {
      throw new HttpError(404, "settings_section_not_found", "Settings section not found");
    }

    return detail;
  });
}
