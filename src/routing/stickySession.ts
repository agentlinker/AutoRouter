export interface StickyRoute {
  routeId: string;
  platformId: string;
  providerId: string;
  endpointId: string;
  accountId: string;
  modelId: string;
}

export class StickySessionStore {
  private readonly routes = new Map<string, StickyRoute>();

  public get(sessionId: string): StickyRoute | null {
    return this.routes.get(sessionId) ?? null;
  }

  public set(sessionId: string, route: StickyRoute) {
    this.routes.set(sessionId, route);
  }
}
