import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import React from "react";
import { createRoot } from "react-dom/client";

import { AdminApp } from "./routes/providers.js";
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
  component: AdminApp
});

const providersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => null
});

const router = createRouter({
  routeTree: rootRoute.addChildren([providersRoute]),
  basepath: "/admin"
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
