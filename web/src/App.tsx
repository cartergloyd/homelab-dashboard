import { useEffect, useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  BrowserRouter,
  Navigate,
  Link,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { api } from "./api";
import { Icons, type IconName } from "./components/icons";
import { DialogProvider, ToastProvider, Modal } from "./components/ui";
import { useMinecraftUpdates } from "./hooks/useMinecraftUpdates";
import type { AppConfigPayload } from "./types";
import {
  LiveOverview,
  FilesStorage,
  NetworkPage,
  AutomationPage,
  AiTools,
  CrmPage,
  HostTerminal,
  MediaWorkspace,
  useHost,
} from "./pages/LiveDash";
import { Minecraft } from "./pages/Minecraft";
import { Maintenance } from "./pages/Maintenance";
import { RepositoryUpdates } from "./components/RepositoryUpdates";
import { ReportsCard } from "./components/ReportsCard";
import { fmtBytes } from "./format";

import { Database } from "./pages/Database";
import { Vpn } from "./pages/Vpn";
import { MediaPage, MinecraftPage, SystemPage } from "./pages/groups";
import { Security } from "./pages/Security";
import { StepUpProvider } from "./components/StepUpProvider";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 2000 },
  },
});

const PERSONAL: { to: string; label: string; icon: IconName }[] = [
  { to: "/", label: "Overview", icon: "home" },
  { to: "/minecraft", label: "Minecraft", icon: "cube" },
  { to: "/jellyfin", label: "Jellyfin", icon: "film" },
  { to: "/files", label: "Files & storage", icon: "folder" },
  { to: "/network", label: "Network", icon: "pulse" },
  { to: "/terminal", label: "Terminal", icon: "terminal" },
  { to: "/automation", label: "Automation", icon: "clock" },
  { to: "/access", label: "Access", icon: "shield" },
];
const BUSINESS: typeof PERSONAL = [
  { to: "/business", label: "Overview", icon: "home" },
  { to: "/business/crm", label: "Twenty CRM", icon: "database" },
  { to: "/business/files", label: "Business files", icon: "folder" },
  { to: "/business/ai", label: "AI tools", icon: "spark" },
  ...PERSONAL.slice(4).map((item) => ({ ...item, to: `/business${item.to}` })),
];

type Theme = "auto" | "light" | "dark";

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return ["light", "dark", "auto"].includes(
        localStorage.getItem("theme") || "",
      )
        ? (localStorage.getItem("theme") as Theme)
        : "light";
    } catch {
      return "light";
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
  return [
    theme,
    () =>
      setTheme((t) =>
        t === "dark" ? "light" : "dark",
      ),
  ];
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
  return useQuery({
    queryKey: ["config"],
    queryFn: () => api.get<AppConfigPayload>("/config"),
    staleTime: Infinity,
  });
}

function Shell() {
  useMinecraftUpdates();
  const navigate = useNavigate();
  const config = useAppConfig(),
    location = useLocation(),
    host = useHost();
  const [theme, cycleTheme] = useTheme();
  const [menu, setMenu] = useState(false),
    [search, setSearch] = useState<string | null>(null);
  const business = location.pathname.startsWith("/business"),
    nav = business ? BUSINESS : PERSONAL;
  const active = nav.find((item) => item.to === location.pathname);
  const user = config.data?.user,
    ThemeIcon = theme === "dark" ? Icons.moon : Icons.sun;
  useEffect(() => {
    setMenu(false);
  }, [location.pathname]);
  useEffect(() => {
    document.body.dataset.workspace = business ? "business" : "personal";
  }, [business]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearch((s) => (s === null ? "" : null));
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return (
    <div className={`shell dash-shell${menu ? " menu-open" : ""}`}>
      <ScrollManager />
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Main navigation">
        <Link className="dash-brand" to={business ? "/business" : "/"}>
          <span className="brand-mark" aria-hidden>
            <i />
            <i />
            <i />
            <i />
          </span>
          dash<span>.</span>
        </Link>
        <label className="workspace-picker">
          <Icons.drive width={25} height={25} />
          <select
            aria-label="Workspace"
            value={business ? "business" : "personal"}
            onChange={(event) => {
              navigate(
                event.target.value === "business" ? "/business" : "/",
              );
            }}
          >
            <option value="personal">Gold Server · Personal</option>
            <option value="business">xGold AI · Business</option>
          </select>
        </label>
        <span className="nav-caption">WORKSPACE</span>
        <nav className="dash-nav">
          {nav.map((item) => {
            const Icon = Icons[item.icon];
            return (
              <NavLink key={item.to} to={item.to} end>
                <Icon width={18} height={18} />
                {item.label}
              </NavLink>
            );
          })}
        </nav>
        <div className="dash-sidebar-bottom">
          <span className="sidebar-host">
            <span className="dot" />
            {host.data?.hostname ?? "Connecting to host"}
          </span>
          <div className="profile">
            <span className="avatar">
              {(user?.name || "Owner")
                .split(/\s+/)
                .map((w) => w[0])
                .slice(0, 2)
                .join("")}
            </span>
            <div className="truncate">
              <strong>{user?.name ?? "Connecting…"}</strong>
              <small>
                {user?.via === "cloudflare"
                  ? "Cloudflare Access"
                  : user?.via === "tailscale"
                    ? "Tailscale"
                    : (user?.via ?? "")}
              </small>
            </div>
            <button
              className="btn ghost sm"
              onClick={cycleTheme}
              title={`Theme: ${theme}`}
              aria-label="Toggle theme"
            >
              <ThemeIcon width={17} height={17} />
            </button>
          </div>
        </div>
      </aside>
      {menu && (
        <button
          className="mobile-scrim"
          aria-label="Close navigation"
          onClick={() => setMenu(false)}
        />
      )}
      <div className="content">
        <header className="dash-topbar">
          <button
            className="btn mobile-menu"
            aria-label="Open navigation"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            ☰
          </button>
          <div className="breadcrumb">
            <Icons.home width={15} height={15} />
            <span>{business ? "xGold AI" : "Gold Server"}</span>
            <span className="muted">/</span>
            <strong>{active?.label ?? "Server"}</strong>
          </div>
          <div className="row">
            <button className="search-button" onClick={() => setSearch("")}>
              Search <kbd>⌘ K</kbd>
            </button>
            <Link
              className="btn sm ghost"
              to={`${business ? "/business" : ""}/automation#activity`}
              aria-label="View server activity"
            >
              <Icons.pulse width={17} height={17} />
            </Link>
          </div>
        </header>
        <main className="main" id="main-content" tabIndex={-1}>
          {config.isError && (
            <div className="notice error">
              Cannot reach the dashboard API: {(config.error as Error).message}
            </div>
          )}
          {/* [DEMO] Explicit banner on development installations; production never enables DEMO. */}
          {config.data?.demo && (
            <div className="notice error" role="alert">
              DEMO MODE · All displayed sample data and simulated controls are
              for development only.
            </div>
          )}
          {business && (
            <div className="workspace-scope">
              Business workspace{" "}
              <span>Shared host: {host.data?.hostname ?? "checking…"}</span>
            </div>
          )}
          <Routes>
            <Route path="/" element={<LiveOverview />} />
            <Route path="/business" element={<LiveOverview business />} />
            <Route
              path="/minecraft"
              element={
                <div className="section-stack">
                  <Minecraft />
                  <RepositoryUpdates workspace="personal" />
                  <details
                    id="maintenance"
                    className="dash-details"
                    open={location.hash === "#maintenance"}
                  >
                    <summary>Backups & scheduled maintenance</summary>
                    <Maintenance />
                  </details>
                  <ReportsCard />
                </div>
              }
            />
            <Route path="/jellyfin" element={<MediaWorkspace />} />
            <Route path="/files" element={<FilesStorage />} />
            <Route path="/business/files" element={<FilesStorage />} />
            <Route path="/business/crm" element={<CrmPage />} />
            <Route path="/business/ai" element={<AiTools />} />
            {["", "/business"].map((base) => (
              <Route key={base} path={base || "/"}>
                {/* Separate addresses preserve the workspace while sharing host controls. */}
                <Route path="network" element={<NetworkPage />} />
                <Route path="terminal" element={<HostTerminal />} />
                <Route
                  path="automation"
                  element={<AutomationPage business={base === "/business"} />}
                />
                <Route path="access" element={<Security />} />
              </Route>
            ))}
            <Route path="/database" element={<Database />} />
            <Route
              path="/media"
              element={
                <Navigate
                  to={location.hash === "#files" ? "/files" : "/jellyfin"}
                  replace
                />
              }
            />
            <Route path="/system" element={<SystemPage />} />
            <Route path="/vpn" element={<Vpn />} />
            <Route
              path="/security"
              element={<Navigate to="/access" replace />}
            />
            <Route
              path="/maintenance"
              element={<Navigate to="/automation" replace />}
            />
            <Route path="/logs" element={<Navigate to="/terminal" replace />} />
            <Route
              path="/status"
              element={<Navigate to="/network" replace />}
            />
            <Route path="/storage" element={<Navigate to="/files" replace />} />
            <Route
              path="*"
              element={
                <div className="notice">
                  Page not found. <Link to="/">Return to overview</Link>
                </div>
              }
            />
          </Routes>
        </main>
        <footer className="dash-footer">
          <span>
            <span className="dot" />
            {host.data
              ? `${host.data.hostname} · ${host.data.cpuCount} CPUs · ${fmtBytes(host.data.memoryTotal)} RAM`
              : "Connecting to server"}
          </span>
          <span>{config.data?.timezone}</span>
        </footer>
      </div>
      {search !== null && (
        <Modal title="Find a page" onClose={() => setSearch(null)}>
          <input
            aria-label="Search pages"
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="search-results">
            {[...PERSONAL, ...BUSINESS]
              .filter((item) =>
                item.label.toLowerCase().includes(search.toLowerCase()),
              )
              .map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={() => setSearch(null)}
                >
                  {item.label}
                  <span className="muted small">
                    {item.to.startsWith("/business")
                      ? "xGold AI"
                      : "Gold Server"}
                  </span>
                </Link>
              ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <DialogProvider>
          <BrowserRouter>
            <StepUpProvider>
              <Shell />
            </StepUpProvider>
          </BrowserRouter>
        </DialogProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
