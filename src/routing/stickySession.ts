export interface StickyRoute {
  endpointId: string;
  accountId: string;
  model: string;
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
