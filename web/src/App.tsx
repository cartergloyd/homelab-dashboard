import { useEffect, useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  BrowserRouter,
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { api } from "./api";
import { DialogProvider, ToastProvider } from "./components/ui";
import { type IconName } from "./components/icons";
import { StepUpProvider } from "./components/StepUpProvider";
import { useMinecraftUpdates } from "./hooks/useMinecraftUpdates";
import type { AppConfigPayload } from "./types";
import {
  OverviewDesign,
  NetworkDesign,
  AutomationDesign,
  TerminalDesign,
  BusinessAppDesign,
  AccessDesign,
} from "./design/pages";
import { MinecraftDesign, JellyfinDesign } from "./design/operations";
import { StorageDesign } from "./design/storage";
import { Drawer } from "./design/shared";
import { Icon } from "./design/ui";
import { useRead, type Host } from "./design/data";
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
  { to: "/business/crm", label: "Twenty CRM", icon: "user" },
  { to: "/business/files", label: "Business files", icon: "folder" },
  { to: "/business/ai", label: "AI tools", icon: "spark" },
  ...PERSONAL.slice(4).map((item) => ({ ...item, to: "/business" + item.to })),
];
export function useAppConfig() {
  return useQuery({
    queryKey: ["config"],
    queryFn: () => api.get<AppConfigPayload>("/config"),
    staleTime: Infinity,
  });
}
function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("theme") === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("theme", theme);
    } catch {}
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}
function ScrollManager() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) {
      const element = document.getElementById(hash.slice(1));
      if (element) {
        element.scrollIntoView({ block: "start" });
        return;
      }
    }
    window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}
function Shell() {
  useMinecraftUpdates();
  const navigate = useNavigate(),
    location = useLocation(),
    config = useAppConfig(),
    host = useRead<Host>("host", "/host", 15000);
  const [theme, cycleTheme] = useTheme(),
    [menu, setMenu] = useState(false),
    [workspacePicker, setWorkspacePicker] = useState(false),
    [search, setSearch] = useState<string | null>(null),
    [about, setAbout] = useState(false);
  const workspace = location.pathname.startsWith("/business")
      ? "business"
      : "personal",
    business = workspace === "business",
    nav = business ? BUSINESS : PERSONAL,
    active = nav.find((item) => item.to === location.pathname),
    user = config.data?.user;
  useEffect(() => {
    setMenu(false);
  }, [location.pathname]);
  useEffect(() => {
    document.body.dataset.workspace = workspace;
  }, [workspace]);
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
    <div className={`dash-design ${menu ? "menu-open" : ""}`}>
      <ScrollManager />
      <a className="skip" href="#content">
        Skip to content
      </a>
      <div className="app">
        <aside className="sidebar" aria-label="Main navigation">
          <Link className="brand" to={business ? "/business" : "/"}>
            <span className="brand-mark" aria-hidden>
              <i />
              <i />
              <i />
              <i />
            </span>
            <span>
              dash<span className="brand-period">.</span>
            </span>
            <span className="brand-tag" />
          </Link>
          <button
            className="workspace"
            onClick={() => setWorkspacePicker(true)}
            aria-label="Choose workspace"
          >
            <span className="server-avatar">
              <Icon name={business ? "spark" : "drive"} />
            </span>
            <span>
              <strong>{business ? "xGold AI" : "Gold Server"}</strong>
              <small>{business ? "Business" : "Personal"} workspace</small>
            </span>
            <span className="workspace-chevron">
              <Icon name="chevron" />
            </span>
          </button>
          <span className="nav-caption">WORKSPACE</span>
          <nav>
            {nav.map((item) => (
              <NavLink key={item.to} className="nav-link" to={item.to} end>
                <Icon
                  name={
                    item.label === "Overview"
                      ? "grid"
                      : item.label === "Network"
                        ? "network"
                        : item.label === "Automation"
                          ? "automation"
                          : item.icon
                  }
                />
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <button className="help-button" onClick={() => setAbout(true)}>
              <Icon name="help" />
              About
              <span className="tiny-dot" />
            </button>
            <div className="profile">
              <span className="avatar">
                {(user?.name || "Owner")
                  .split(/\s+/)
                  .map((w) => w[0])
                  .slice(0, 2)
                  .join("")}
              </span>
              <span>
                <strong>{user?.name ?? "Connecting…"}</strong>
                <small>Workspace owner</small>
              </span>
              <button
                className="icon-button theme-button"
                title={`Theme: ${theme}`}
                aria-label="Switch color theme"
                onClick={cycleTheme}
              >
                <Icon name={theme === "dark" ? "sun" : "moon"} />
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
        <div className="main-shell">
          <header className="topbar">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              <Icon name="menu" />
            </button>
            <div className="breadcrumb">
              <span className="breadcrumb-home">
                <Icon name="home" />
              </span>
              <span className="breadcrumb-root">Workspace</span>
              <span className="slash">/</span>
              <strong>{active?.label ?? "Server"}</strong>
            </div>
            <div className="topbar-tools">
              <button
                className="search-button"
                aria-label="Search pages and services"
                onClick={() => setSearch("")}
              >
                <Icon name="search" />
                <span>Search</span>
                <kbd>⌘ K</kbd>
              </button>
              <Link
                className="icon-button notification-button"
                aria-label="View notifications"
                to={`${business ? "/business" : ""}/automation#activity`}
              >
                <Icon name="bell" />
              </Link>
            </div>
          </header>
          <main id="content" tabIndex={-1}>
            {config.isError && (
              <p className="connection-error">
                Cannot reach the dashboard: {(config.error as Error).message}
              </p>
            )}
            {/* [DEMO] Development installations must explicitly identify simulated data. */}
            {config.data?.demo && (
              <p className="connection-error">
                DEMO MODE · Development data and simulated controls.
              </p>
            )}
            <Routes>
              <Route
                path="/"
                element={<OverviewDesign workspace="personal" />}
              />
              <Route
                path="/business"
                element={<OverviewDesign workspace="business" />}
              />
              <Route path="/minecraft" element={<MinecraftDesign />} />
              <Route path="/jellyfin" element={<JellyfinDesign />} />
              <Route
                path="/files"
                element={<StorageDesign workspace="personal" />}
              />
              <Route
                path="/business/files"
                element={<StorageDesign workspace="business" />}
              />
              <Route
                path="/business/crm"
                element={<BusinessAppDesign kind="crm" />}
              />
              <Route
                path="/business/ai"
                element={<BusinessAppDesign kind="ai" />}
              />
              {["", "/business"].map((base) => (
                <Route key={base} path={base || "/"}>
                  <Route path="network" element={<NetworkDesign />} />
                  <Route
                    path="terminal"
                    element={
                      <TerminalDesign
                        workspace={base ? "business" : "personal"}
                      />
                    }
                  />
                  <Route
                    path="automation"
                    element={
                      <AutomationDesign
                        workspace={base ? "business" : "personal"}
                      />
                    }
                  />
                  <Route path="access" element={<AccessDesign />} />
                </Route>
              ))}
              <Route
                path="/media"
                element={<Navigate to="/jellyfin" replace />}
              />
              <Route
                path="/database"
                element={<Navigate to="/files" replace />}
              />
              <Route
                path="/storage"
                element={<Navigate to="/files" replace />}
              />
              <Route
                path="/security"
                element={<Navigate to="/access" replace />}
              />
              <Route
                path="/maintenance"
                element={<Navigate to="/automation" replace />}
              />
              <Route path="/vpn" element={<Navigate to="/network" replace />} />
              <Route
                path="/system"
                element={
                  <Navigate
                    to={
                      location.hash === "#storage"
                        ? "/files"
                        : location.hash === "#logs"
                          ? "/terminal"
                          : "/network"
                    }
                    replace
                  />
                }
              />
              <Route
                path="/logs"
                element={<Navigate to="/terminal" replace />}
              />
              <Route
                path="/status"
                element={<Navigate to="/network" replace />}
              />
              <Route
                path="*"
                element={
                  <p>
                    Page not found. <Link to="/">Return to overview</Link>
                  </p>
                }
              />
            </Routes>
          </main>
          <footer className="page-footer">
            <span>
              <span className="footer-dot" />
              {host.data?.hostname ?? "Connecting to host"} · Live server data
            </span>
            <button onClick={() => setAbout(true)}>
              About <Icon name="external" />
            </button>
          </footer>
        </div>
      </div>
      {workspacePicker && (
        <Drawer
          title="Choose your workspace"
          onClose={() => setWorkspacePicker(false)}
        >
          <div className="workspace-options">
            {(["personal", "business"] as const).map((value) => (
              <button
                key={value}
                className={`workspace-option ${workspace === value ? "selected" : ""}`}
                onClick={() => {
                  navigate(value === "business" ? "/business" : "/");
                  setWorkspacePicker(false);
                }}
              >
                <span className="app-icon">
                  <Icon name={value === "personal" ? "drive" : "spark"} />
                </span>
                <span>
                  <strong>
                    {value === "personal" ? "Gold Server" : "xGold AI"}
                  </strong>
                  <small>
                    {value === "personal"
                      ? "Personal · media & games"
                      : "Business · Twenty CRM, clients & files"}
                  </small>
                </span>
                <Icon name={workspace === value ? "shield" : "external"} />
              </button>
            ))}
          </div>
        </Drawer>
      )}
      {about && (
        <Drawer title="Dash" onClose={() => setAbout(false)}>
          <p className="inline-note">
            Gold Server and xGold AI · your server dashboard.
          </p>
          <p>
            Host: {host.data?.hostname ?? "Checking"} ·{" "}
            {host.data?.cpuCount ?? "—"} CPU cores
          </p>
          <p>Timezone: {config.data?.timezone}</p>
          <p>
            Connected to live server APIs. Workspaces share the same physical
            host.
          </p>
        </Drawer>
      )}
      {search !== null && (
        <Drawer title="Search" onClose={() => setSearch(null)}>
          <input
            className="search-input"
            aria-label="Search pages"
            autoFocus
            placeholder="Search pages and services"
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
                  <span className="tag">
                    {item.to.startsWith("/business")
                      ? "xGold AI"
                      : "Gold Server"}
                  </span>
                </Link>
              ))}
          </div>
        </Drawer>
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
