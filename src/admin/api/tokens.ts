import { requestJson } from "./client.js";

export interface TokensResponse {
  totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  providers: Array<{
    provider_key: string;
    request_count: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  }>;
  models: Array<{
    provider_key: string | null;
    model: string;
    request_count: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  }>;
}

export function getTokensOverview(token: string): Promise<TokensResponse> {
  return requestJson<TokensResponse>("/admin/api/tokens", token);
}
