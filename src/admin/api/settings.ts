import { requestJson } from "./client.js";

export interface SettingsItem {
  key: string;
  label: string;
  value: string;
}

export interface SettingsSection {
  section_id: string;
  label: string;
  description: string;
  items: SettingsItem[];
}

export interface SettingsListResponse {
  data: SettingsSection[];
}

export function listSettings(token: string): Promise<SettingsListResponse> {
  return requestJson<SettingsListResponse>("/admin/api/settings", token);
}

export function getSettingsSectionDetail(token: string, sectionId: string): Promise<SettingsSection> {
  return requestJson<SettingsSection>(`/admin/api/settings/${sectionId}`, token);
}
