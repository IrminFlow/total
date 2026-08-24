import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { applyTheme, initialTheme } from "./state/stores";
import {
  applyAccessibilityPreferences,
  readAccessibilityPreferences,
} from "./lib/accessibilityPrefs";
import "./app.css";

applyTheme(initialTheme());
applyAccessibilityPreferences(readAccessibilityPreferences());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 5_000, refetchOnWindowFocus: false },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
