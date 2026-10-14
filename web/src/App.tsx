import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api";
import { Icons, type IconName } from "./components/icons";
import { DialogProvider, ToastProvider } from "./components/ui";
import type { AppConfigPayload } from "./types";
import { Dashboard } from "./pages/Dashboard";
import { Database } from "./pages/Database";
import { Vpn } from "./pages/Vpn";
import { MediaPage, MinecraftPage, SystemPage } from "./pages/groups";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 2000 } },
});

const NAV: { to: string; label: string; icon: IconName }[] = [
  { to: "/", label: "Dashboard", icon: "home" },
  { to: "/media", label: "Media", icon: "film" },
  { to: "/database", label: "Database", icon: "database" },
  { to: "/minecraft", label: "Minecraft", icon: "cube" },
  { to: "/vpn", label: "VPN", icon: "shield" },
  { to: "/system", label: "System", icon: "pulse" },
];

type Theme = "auto" | "light" | "dark";

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("theme") as Theme) || "auto";
    } catch {
      return "auto";
    }
  });
  useEffect(() => {
    if (theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("theme", theme);
    } catch {
      // ignore
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "auto" ? "dark" : t === "dark" ? "light" : "auto"))];
}

function Nav({ variant }: { variant: "sidebar" | "topbar" }) {
  return (
    <nav className={`nav nav-${variant}`}>
      {NAV.map((item) => {
        const Icon = Icons[item.icon];
        return (
          <NavLink key={item.to} to={item.to} end={item.to === "/"}>
            <Icon />
            {item.label}
          </NavLink>
        );
      })}
    </nav>
  );
}

/** Scrolls to the #section on grouped pages, or to the top on a plain route change. */
function ScrollManager() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) {
      const el = document.getElementById(hash.slice(1));
      if (el) {
        el.scrollIntoView({ block: "start" });
        return;
      }
    }
    window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}

export function useAppConfig() {
  return useQuery({ queryKey: ["config"], queryFn: () => api.get<AppConfigPayload>("/config"), staleTime: Infinity });
}

function Shell() {
  const config = useAppConfig();
  const [theme, cycleTheme] = useTheme();
  const user = config.data?.user;
  const ThemeIcon = theme === "dark" ? Icons.moon : Icons.sun;

  return (
    <div className="shell">
      <ScrollManager />
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" aria-hidden />
          <div>
            <strong>Home server</strong>
            {/* [DEMO] the header badge says "demo mode" while DEMO=1 (see DEMO_INDEX.md) */}
              <small>{config.data?.demo ? "demo mode" : "over Tailscale"}</small>
          </div>
        </div>
        <Nav variant="sidebar" />
        <div className="sidebar-footer">
          <div className="row spread">
            <div className="truncate">
              <strong className="truncate">{user?.name ?? "…"}</strong>
              <span className="muted truncate">{user?.login ?? ""}</span>
            </div>
            <button className="btn sm ghost" title={`Theme: ${theme}`} onClick={cycleTheme} aria-label="Toggle theme">
              <ThemeIcon width={16} height={16} />
            </button>
          </div>
        </div>
      </aside>
      <div className="content">
        <header className="topbar">
          <div className="row spread">
            <div className="brand">
              <span className="brand-dot" aria-hidden />
              <strong>Home server</strong>
            </div>
            <button className="btn sm ghost" onClick={cycleTheme} aria-label="Toggle theme">
              <ThemeIcon width={16} height={16} />
            </button>
          </div>
          <Nav variant="topbar" />
        </header>
        <main className="main">
          {config.isError && <div className="notice error" style={{ marginBottom: 16 }}>Cannot reach the dashboard API: {(config.error as Error).message}</div>}
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/media" element={<MediaPage />} />
            <Route path="/database" element={<Database />} />
            <Route path="/minecraft" element={<MinecraftPage />} />
            <Route path="/vpn" element={<Vpn />} />
            <Route path="/system" element={<SystemPage />} />
            {/* old per-page URLs */}
            <Route path="/jellyfin" element={<Navigate to="/media#jellyfin" replace />} />
            <Route path="/files" element={<Navigate to="/media#files" replace />} />
            <Route path="/maintenance" element={<Navigate to="/minecraft#maintenance" replace />} />
            <Route path="/logs" element={<Navigate to="/system#logs" replace />} />
            <Route path="/status" element={<Navigate to="/system#status" replace />} />
            <Route path="/storage" element={<Navigate to="/system#storage" replace />} />
            <Route path="*" element={<div className="notice">Page not found.</div>} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <DialogProvider>
          <BrowserRouter>
            <Shell />
          </BrowserRouter>
        </DialogProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
