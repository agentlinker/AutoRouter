export type OfficialProviderKind = "official";
export type ModelAvailabilityScope = "shared_by_provider" | "per_account";
export type OfficialEndpointProtocol = "openai" | "anthropic";
export type OfficialEndpointAdapter = "openai_compatible" | "anthropic";

export interface OfficialProviderEndpointTemplate {
  endpoint_key: string;
  protocol: OfficialEndpointProtocol;
  adapter_type: OfficialEndpointAdapter;
  base_url: string;
  enabled?: boolean;
}

/**
 * 官方模版是代码内置常量，不是用户可编辑配置。
 * 同一厂商可按产品线 / 计费方式 / 机房拆成多个 template_id。
 */
export interface OfficialProviderTemplate {
  template_id: string;
  vendor_id: string;
  vendor_name: string;
  product_line: string;
  region?: string;
  display_name: string;
  /** 创建时的推荐 provider_key，用户仍可改 */
  suggested_provider_key: string;
  website_url?: string;
  docs_url?: string;
  provider_kind: OfficialProviderKind;
  model_availability_scope: ModelAvailabilityScope;
  endpoints: OfficialProviderEndpointTemplate[];
  notes?: string;
}

export const OFFICIAL_PROVIDER_TEMPLATES: OfficialProviderTemplate[] = [
  {
    template_id: "bigmodel-paas-cn",
    vendor_id: "bigmodel",
    vendor_name: "智谱 BigModel",
    product_line: "开放平台 PaaS",
    region: "cn",
    display_name: "智谱官方",
    suggested_provider_key: "bigmodel-official-api",
    website_url: "https://bigmodel.cn",
    docs_url: "https://docs.bigmodel.cn",
    provider_kind: "official",
    model_availability_scope: "shared_by_provider",
    endpoints: [
      {
        endpoint_key: "openai",
        protocol: "openai",
        adapter_type: "openai_compatible",
        base_url: "https://open.bigmodel.cn/api/paas/v4/"
      },
      {
        endpoint_key: "anthropic",
        protocol: "anthropic",
        adapter_type: "anthropic",
        base_url: "https://open.bigmodel.cn/api/anthropic"
      }
    ],
    notes: "同一官方源同时提供 OpenAI-compatible 与 Anthropic 协议入口。"
  },
  {
    template_id: "xiaomi-mimo-token-plan-cn",
    vendor_id: "xiaomi-mimo",
    vendor_name: "小米 MiMo",
    product_line: "Token Plan",
    region: "cn",
    display_name: "Xiaomi Token Plan CN",
    suggested_provider_key: "xiaomi-token-plan-cn",
    website_url: "https://token-plan-cn.xiaomimimo.com",
    provider_kind: "official",
    model_availability_scope: "shared_by_provider",
    endpoints: [
      {
        endpoint_key: "openai",
        protocol: "openai",
        adapter_type: "openai_compatible",
        base_url: "https://token-plan-cn.xiaomimimo.com/v1"
      },
      {
        endpoint_key: "anthropic",
        protocol: "anthropic",
        adapter_type: "anthropic",
        base_url: "https://token-plan-cn.xiaomimimo.com/anthropic"
      }
    ],
    notes: "国内机房 Token Plan。与新加坡机房、Pay as you go 分属不同官方模版。"
  },
  {
    template_id: "xiaomi-mimo-token-plan-sgp",
    vendor_id: "xiaomi-mimo",
    vendor_name: "小米 MiMo",
    product_line: "Token Plan",
    region: "sgp",
    display_name: "Xiaomi Token Plan SGP",
    suggested_provider_key: "xiaomi-token-plan-sgp",
    website_url: "https://token-plan-sgp.xiaomimimo.com",
    provider_kind: "official",
    model_availability_scope: "shared_by_provider",
    endpoints: [
      {
        endpoint_key: "openai",
        protocol: "openai",
        adapter_type: "openai_compatible",
        base_url: "https://token-plan-sgp.xiaomimimo.com/v1"
      },
      {
        endpoint_key: "anthropic",
        protocol: "anthropic",
        adapter_type: "anthropic",
        base_url: "https://token-plan-sgp.xiaomimimo.com/anthropic"
      }
    ],
    notes: "新加坡机房 Token Plan。与国内机房分属不同官方模版。"
  },
  {
    template_id: "volcengine-ark-coding-cn-beijing",
    vendor_id: "volcengine",
    vendor_name: "火山引擎",
    product_line: "方舟 Ark Coding",
    region: "cn-beijing",
    display_name: "Volcengine Ark Coding",
    suggested_provider_key: "volcengine-ark-coding",
    website_url: "https://www.volcengine.com/product/ark",
    provider_kind: "official",
    model_availability_scope: "shared_by_provider",
    endpoints: [
      {
        endpoint_key: "openai",
        protocol: "openai",
        adapter_type: "openai_compatible",
        base_url: "https://ark.cn-beijing.volces.com/api/coding/v3"
      },
      {
        endpoint_key: "anthropic",
        protocol: "anthropic",
        adapter_type: "anthropic",
        base_url: "https://ark.cn-beijing.volces.com/api/coding"
      }
    ],
    notes: "北京区域 Coding 入口。其他区域 / 通用 Ark 入口可另建模版。"
  },
  {
    template_id: "longcat-official",
    vendor_id: "longcat",
    vendor_name: "LongCat",
    product_line: "Official API",
    display_name: "LongCat",
    suggested_provider_key: "longcat",
    website_url: "https://longcat.chat",
    provider_kind: "official",
    model_availability_scope: "shared_by_provider",
    endpoints: [
      {
        endpoint_key: "openai",
        protocol: "openai",
        adapter_type: "openai_compatible",
        base_url: "https://api.longcat.chat/openai"
      },
      {
        endpoint_key: "anthropic",
        protocol: "anthropic",
        adapter_type: "anthropic",
        base_url: "https://api.longcat.chat/anthropic"
      }
    ]
  }
];

export function listOfficialProviderTemplates(): OfficialProviderTemplate[] {
  return OFFICIAL_PROVIDER_TEMPLATES.map((template) => structuredClone(template));
}

export function getOfficialProviderTemplate(
  templateId: string
): OfficialProviderTemplate | null {
  const found = OFFICIAL_PROVIDER_TEMPLATES.find((item) => item.template_id === templateId);
  return found ? structuredClone(found) : null;
}

export function listOfficialProviderTemplatesByVendor(
  vendorId: string
): OfficialProviderTemplate[] {
  return OFFICIAL_PROVIDER_TEMPLATES
    .filter((item) => item.vendor_id === vendorId)
    .map((item) => structuredClone(item));
}
