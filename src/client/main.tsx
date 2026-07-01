import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { useSse } from "./hooks/useSse";
import { useAppStore } from "./store/app";
import { fetchSettings } from "./api/settings";
import "./styles/globals.css";

const queryClient = new QueryClient();

function App() {
  useSse();
  const setTheme = useAppStore((s) => s.setTheme);

  // Load persisted theme on startup — settings are fetched globally here,
  // not just when the Settings page is visited.
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: fetchSettings,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (settings?.theme) {
      setTheme(settings.theme);
    }
  }, [settings, setTheme]);

  return <RouterProvider router={router} />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
