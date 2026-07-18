import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  redirect
} from "@tanstack/react-router";
import React from "react";
import { createRoot } from "react-dom/client";

import {
  ApiKeyDetailPage,
  ApiKeysPage,
  PoliciesPage,
  PolicyDetailPage,
  SettingsDetailPage,
  SettingsPage,
  TokensPage,
  TraceDetailPage,
  TraceListPage,
  UsageDetailPage,
  UsagePage
} from "./routes/console.js";
import {
  AdminRoot,
  ProviderDetailPage,
  ProviderEditPage,
  ProviderListPage,
  ProviderNewPage,
  providerTokenStorageKey
} from "./routes/providers.js";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: 10_000
    }
  }
});

const rootRoute = createRootRoute({
  component: AdminRoot
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/providers" });
  }
});

const providersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/providers",
  component: ProviderListPage
});

const providerNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/providers/new",
  component: ProviderNewPage
});

const providerDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/providers/$providerKey",
  component: ProviderDetailPage
});

const providerEditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/providers/$providerKey/edit",
  component: ProviderEditPage
});

const apiKeysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/api-keys",
  component: ApiKeysPage
});

const apiKeyDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/api-keys/$keyScope/$entryId",
  component: ApiKeyDetailPage
});

const usageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/usage",
  component: UsagePage
});

const usageDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/usage/$traceId",
  component: UsageDetailPage
});

const traceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/trace",
  component: TraceListPage
});

const traceDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/trace/$traceId",
  component: TraceDetailPage
});

const tokensRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tokens",
  component: TokensPage
});

const policiesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/policies",
  component: PoliciesPage
});

const policyDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/policies/$policyId",
  component: PolicyDetailPage
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage
});

const settingsDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/$sectionId",
  component: SettingsDetailPage
});

const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    providersRoute,
    providerNewRoute,
    providerDetailRoute,
    providerEditRoute,
    apiKeysRoute,
    apiKeyDetailRoute,
    usageRoute,
    usageDetailRoute,
    traceRoute,
    traceDetailRoute,
    tokensRoute,
    policiesRoute,
    policyDetailRoute,
    settingsRoute,
    settingsDetailRoute
  ]),
  basepath: "/admin",
  context: {
    queryClient,
    getToken: () => localStorage.getItem(providerTokenStorageKey) ?? ""
  }
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>
);
