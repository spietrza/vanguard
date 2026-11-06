import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { type Theme } from '@/ui';
import { open } from '@tauri-apps/plugin-dialog';
import { TopBar, type Crumb } from './TopBar';
import { Rail, type Screen } from './Rail';
import { CommandPalette } from './CommandPalette';
import { RepoPicker } from './RepoPicker';
import { TailwindDebugScreens } from './components/TailwindDebugScreens';
import { Dashboard } from './features/dashboard/Dashboard';
import { Inspector } from './features/inspector/Inspector';
import { listProjects, addProject, cloneProject, removeProject, listActive } from './ipc';
import { projectColor, contrastColor } from './color';
import { createNavGuardRegistry, NavGuardContext } from './navGuard';
import { ProjectCombobox } from './ProjectCombobox';
import { isHubMode, onHubRestart, onHubConnectionIssue } from './transport';
import type { Project, ActiveRun } from './vanguard-output';

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>('dashboard');
  const [railRunning, setRailRunning] = useState<ActiveRun[]>([]);
  const [focusRunning, setFocusRunning] = useState<ActiveRun | null>(null);
  const [crumb, setCrumb] = useState<string | null>(null);
  // The task screen's trailing breadcrumb: the open conversation's name, click-to-rename
  // (dogfood r3). Published by TaskDraftScreen, cleared on its unmount.
  const [taskCrumb, setTaskCrumb] = useState<{ name: string; onRename: (v: string) => void } | null>(null);
  const [clearNonce, setClearNonce] = useState(0);
  // Bumped on every New Task click (S10): the task screen resets to a fresh draft only on an
  // unconsumed nonce, so returning to the screen by other paths restores the last-open draft.
  const [newTaskNonce, setNewTaskNonce] = useState(0);
  const [palette, setPalette] = useState(false);
  const [hubRestarted, setHubRestarted] = useState(false);
  const [hubConnectionIssue, setHubConnectionIssue] = useState(false);
  // Navigation guard (S8, #339): a dirty screen registers a confirm; ALL App-owned navigation
  // routes through navigate(), because a project switch REMOUNTS Inspector (key below) and a
  // screen switch unmounts the editor — component-local confirms never fire for either.
  // Lazy init (review #343 r4 nit): useRef(create()) would re-run the factory every render and
  // discard the result — harmless here, but the idiom avoids the per-render allocation.
  const navGuardRef = useRef<ReturnType<typeof createNavGuardRegistry> | null>(null);
  navGuardRef.current ??= createNavGuardRegistry();
  const navGuard = navGuardRef as { current: ReturnType<typeof createNavGuardRegistry> };
  const navigate = (fn: () => void): void => {
    if (!navGuard.current.confirm()) return;
    fn();
  };
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('vg-theme');
    const initial: Theme =
      saved === 'dark' || saved === 'light'
        ? saved
        : window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
    applyTheme(initial);
    return initial;
  });

  useEffect(() => {
    let alive = true;
    const tick = (): void => {
      listProjects()
        .then((p) => {
          if (alive) setProjects(p);
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Default the current project to the first once projects load.
  useEffect(() => {
    if (!activeProject && projects.length) setActiveProject(projects[0].path);
  }, [projects, activeProject]);

  // Poll the current project's in-flight runs for the rail's Running section.
  useEffect(() => {
    if (!activeProject) {
      setRailRunning([]);
      return;
    }
    let alive = true;
    const tick = (): void => {
      listActive(activeProject)
        .then((a) => {
          if (alive) setRailRunning(a);
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [activeProject]);

  // Window close is the third discard path. Tauri/WKWebView does not reliably fire beforeunload
  // on native close, so onCloseRequested is the primary hook (beforeunload kept as a belt) — and
  // the only hook at all in hub mode, where there is no Tauri window to close.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (navGuard.current.guarded()) {
        e.preventDefault();
        e.returnValue = ''; // some WebKit/Chromium builds need returnValue, not just preventDefault
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    const un = getCurrentWindow().onCloseRequested(async (event) => {
      if (!navGuard.current.confirm()) {
        event.preventDefault();
        return;
      }
      // S10: a screen with debounced writes registered a flush — a fire-and-forget invoke would
      // race webview teardown, so hold the close, await the flush (bounded), then close for real.
      // destroy() skips this handler, so there is no re-entry loop.
      if (navGuard.current.hasFlush()) {
        event.preventDefault();
        await navGuard.current.flush(2000);
        void getCurrentWindow().destroy();
      }
    });
    return () => void un.then((f) => f());
  }, []);

  // A restarted hub invalidates this page's per-launch token: every RPC 401s and the SSE stream
  // stays closed, so point at the launch URL instead of letting the UI go silently stale.
  useEffect(() => {
    const un = onHubRestart(() => setHubRestarted(true));
    return () => void un.then((f) => f());
  }, []);

  // Anything else that kills the SSE stream for good — a 403 from the Host check, a reverse proxy's
  // 502 — is not fixed by reloading, so it gets its own neutral banner instead of "the hub restarted".
  useEffect(() => {
    const un = onHubConnectionIssue(() => setHubConnectionIssue(true));
    return () => void un.then((f) => f());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const [showRepoPicker, setShowRepoPicker] = useState(false);

  const add = async (): Promise<void> => {
    // Hub mode has no native OS file dialog (no Tauri plugin in a browser) — RepoPicker (over
    // browse_dirs) stands in for it.
    if (isHubMode()) {
      setShowRepoPicker(true);
      return;
    }
    try {
      const dir = await open({ directory: true, title: 'Add a repo (contains .vanguard/)' });
      if (typeof dir === 'string') setProjects(await addProject(dir));
    } catch {
      /* ignore */
    }
  };

  const remove = async (path: string): Promise<void> => {
    // Removing the ACTIVE project unmounts Inspector — guard like any navigation.
    if (activeProject === path && !navGuard.current.confirm()) return;
    try {
      setProjects(await removeProject(path));
      if (activeProject === path) setActiveProject(null);
    } catch {
      /* ignore */
    }
  };

  const toggleTheme = (): void => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
    localStorage.setItem('vg-theme', next);
  };

  const enterProject = (path: string): void => {
    navigate(() => {
      setActiveProject(path);
      setScreen('runs');
    });
  };

  const active = projects.find((p) => p.path === activeProject) ?? null;
  const showDashboard = screen === 'dashboard' || !active;
  const titleBar = !showDashboard && active ? projectColor(active) : null;

  const SCREEN_LABEL: Record<Screen, string> = {
    dashboard: 'Home',
    runs: 'Runs',
    board: 'Task board',
    task: 'New Task',
    fleet: 'Fleet',
    remote: 'Remote',
    workflow: 'Workflow',
    settings: 'Settings',
  };
  // Home lives on the logo now; the project lives in the switcher — so the breadcrumb is just the screen.
  const crumbs: Crumb[] = [];
  if (active && screen === 'task' && taskCrumb) {
    crumbs.push({ label: SCREEN_LABEL[screen] });
    crumbs.push({
      label: taskCrumb.name,
      edit: { placeholder: 'Name this conversation…', ariaLabel: 'rename conversation', onCommit: taskCrumb.onRename },
    });
  } else if (active && screen !== 'dashboard') {
    if (crumb) {
      crumbs.push({ label: SCREEN_LABEL[screen], onClick: () => setClearNonce((n) => n + 1) });
      crumbs.push({ label: crumb });
    } else {
      crumbs.push({ label: SCREEN_LABEL[screen] });
    }
  }
  const projectSwitcher =
    active && screen !== 'dashboard' ? (
      <ProjectCombobox projects={projects} active={active} onSelect={(path) => navigate(() => setActiveProject(path))} />
    ) : null;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Custom titlebar (native decorations overlaid, macOS): the app/project identity. In a project
          it takes that project's color so the working context is unmistakable; generic on the dashboard. */}
      <div
        data-tauri-drag-region
        className="flex h-8 shrink-0 select-none items-center pl-20 pr-4 text-[13px] font-semibold text-foreground"
        style={titleBar ? { backgroundColor: titleBar, color: contrastColor(titleBar) } : undefined}
      >
        Vanguard Inspector
      </div>
      {hubRestarted && (
        <div
          role="alert"
          className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive"
        >
          This tab has no valid hub token (the hub restarted, or the page was opened without its launch
          URL) — open the URL `vanguard hub` printed to reconnect.
        </div>
      )}
      {!hubRestarted && hubConnectionIssue && (
        <div role="alert" className="shrink-0 border-b border-border bg-muted px-4 py-2 text-sm text-muted-foreground">
          Lost connection to the hub — check your network and reload if it doesn't come back.
        </div>
      )}
      <TopBar
        crumbs={crumbs}
        projectSwitcher={projectSwitcher}
        onHome={() => navigate(() => setScreen('dashboard'))}
        onCommandK={() => setPalette(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <div className="flex min-h-0 flex-1">
        {/* The rail is project-context navigation; the dashboard is generic and stays sidebar-less. */}
        {!showDashboard && (
          <Rail
            projects={projects}
            activePath={activeProject}
            screen={screen}
            running={railRunning}
            onScreen={(sc) => navigate(() => setScreen(sc))}
            onOpenRunning={(r) => {
              // The sixth navigation path (review round 1) — also discards a dirty editor.
              navigate(() => {
                setScreen('runs');
                setFocusRunning(r);
              });
            }}
          />
        )}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {showDashboard ? (
            <Dashboard
              projects={projects}
              onOpen={(p) => enterProject(p.path)}
              onAdd={add}
              onRemove={remove}
            />
          ) : (
            <NavGuardContext.Provider value={navGuard.current}>
              <Inspector
                key={active.path}
                project={active.path}
                screen={screen}
                focusRunning={focusRunning}
                clearNonce={clearNonce}
                newTaskNonce={newTaskNonce}
                onCrumb={setCrumb}
                onTaskCrumb={setTaskCrumb}
                onNewTask={() =>
                  navigate(() => {
                    setScreen('task');
                    setNewTaskNonce((n) => n + 1);
                  })
                }
                onOpenBoard={() => navigate(() => setScreen('board'))}
              />
            </NavGuardContext.Provider>
          )}
        </main>
      </div>
      {palette && (
        <CommandPalette
          projects={projects}
          onOpenProject={(p) => enterProject(p.path)}
          onHome={() => navigate(() => setScreen('dashboard'))}
          onAddProject={add}
          onToggleTheme={toggleTheme}
          onClose={() => setPalette(false)}
        />
      )}
      {showRepoPicker && (
        <RepoPicker
          onAdd={async (path) => {
            setProjects(await addProject(path));
            setShowRepoPicker(false);
          }}
          onClone={async (url, parentDir, name) => {
            const project = await cloneProject(url, parentDir, name);
            setProjects((prev) => [...prev, project]);
            setShowRepoPicker(false);
          }}
          onClose={() => setShowRepoPicker(false)}
        />
      )}
      <TailwindDebugScreens />
    </div>
  );
}
