import { useMemo, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  ScanLine, Boxes, ChevronDown, Wrench, PackageMinus, BarChart3, Users, LogOut, Cpu, FileUp,
  ClipboardList, MoreHorizontal, X
} from "lucide-react";
import { useAuth } from "../lib/AuthProvider";
import InlineLoginForm from "./InlineLoginForm";

// Pilno pločio juosta virš viso puslapio (virš šoninio meniu ir turinio) —
// visada matomas, nuolatinis prisijungimo/atsijungimo taškas nepriklausomai
// nuo to, kuriame puslapyje ar ekrano dydyje esi. Kol prisijungimas
// reikalingas tik daliai funkcijų (priedų modulis), ši juosta veikia kaip
// vienintelis prisijungimo įėjimo taškas visai programai.
function TopBar() {
  const { user, profile, isAdmin, signOut } = useAuth();
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-b border-white/10 bg-ink-950 px-4 py-2">
      {user ? (
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-white/70">
            {profile?.username || "…"}{isAdmin && " · admin"}
          </span>
          <button
            type="button"
            onClick={signOut}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-white/60 hover:bg-white/5 hover:text-white"
          >
            <LogOut size={13} /> Atsijungti
          </button>
        </div>
      ) : (
        <InlineLoginForm variant="bar" />
      )}
    </div>
  );
}

// Meniu punktai sugrupuoti pagal modulį — kai atsiras naujų programos dalių
// (ne tik sandėlis), joms tiesiog reikės naujos grupės su sava antrašte.
const BASE_NAV_GROUPS = [
  {
    label: "Palečių išvežimas",
    items: [
      { to: "/",        label: "Prietaisų registravimas", icon: ScanLine, end: true },
      { to: "/paletes", label: "Paletės",     icon: Boxes }
    ]
  },
  {
    label: "Priedų sandėlis",
    items: [
      { to: "/priedai", label: "Priedai", icon: Wrench }
    ]
  },
  {
    label: "Prietaisų sandėlis",
    items: [
      { to: "/prietaisai", label: "Prietaisai", icon: Cpu }
    ]
  }
];

// Apatiniame mobiliame meniu rodomi TIK šie punktai (šia tvarka) + mygtukas
// "Daugiau" likusiems — visų meniu punktų dabar iki ~10 (priklausomai nuo
// teisių), o sugrūdus juos visus į vieną eilutę telefone ikonos taptų per
// mažos patogiai paspausti pirštu.
const MOBILE_PRIORITY_PATHS = ["/", "/prietaisai", "/prietaisai/atsinesimai", "/priedai"];

function isItemActive(item, pathname) {
  return item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`);
}

function NavLinkItem({ to, label, icon: Icon, end, orientation }) {
  return (
    <NavLink
      key={to}
      to={to}
      end={end}
      className={({ isActive }) =>
        orientation === "vertical"
          ? `flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition ${
              isActive
                ? "bg-white/10 text-white"
                : "text-ink-600/70 hover:bg-white/5 hover:text-white"
            }`
          : `flex flex-1 flex-col items-center gap-1 px-1 py-2 text-center text-[11px] font-medium leading-tight transition ${
              isActive ? "text-signal-orange" : "text-ink-600/60"
            }`
      }
    >
      <Icon size={orientation === "vertical" ? 18 : 20} strokeWidth={2.2} />
      {label}
    </NavLink>
  );
}

// Sidebar'e (vertical) grupės iškleidžiamos/suskleidžiamos paspaudus
// antraštę (numatytai — iškleistos); apatiniame mobiliame meniu (horizontal)
// grupės sulieknamos į vieną plokščią eilutę — ten vietos antraštėms nėra.
function NavItems({ orientation, groups }) {
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();

  if (orientation === "horizontal") {
    const allItems = groups.flatMap((g) => g.items);
    const priorityItems = MOBILE_PRIORITY_PATHS
      .map((path) => allItems.find((item) => item.to === path))
      .filter(Boolean);
    const prioritySet = new Set(priorityItems.map((item) => item.to));
    const remainingGroups = groups
      .map((g) => ({ ...g, items: g.items.filter((item) => !prioritySet.has(item.to)) }))
      .filter((g) => g.items.length > 0);

    if (remainingGroups.length === 0) {
      return allItems.map((item) => <NavLinkItem key={item.to} {...item} orientation={orientation} />);
    }

    const remainingActive = remainingGroups.some((g) => g.items.some((item) => isItemActive(item, location.pathname)));

    return (
      <>
        {priorityItems.map((item) => (
          <NavLinkItem key={item.to} {...item} orientation={orientation} />
        ))}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          className={`flex flex-1 flex-col items-center gap-1 px-1 py-2 text-center text-[11px] font-medium leading-tight transition ${
            remainingActive ? "text-signal-orange" : "text-ink-600/60"
          }`}
        >
          <MoreHorizontal size={20} strokeWidth={2.2} />
          Daugiau
        </button>
        {moreOpen && <MoreMenuSheet groups={remainingGroups} onClose={() => setMoreOpen(false)} />}
      </>
    );
  }

  function toggleGroup(label) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  return groups.map((group) => {
    const isCollapsed = collapsed.has(group.label);
    return (
      <div key={group.label} className="mb-1">
        <button
          type="button"
          onClick={() => toggleGroup(group.label)}
          className="mb-1 flex w-full items-center justify-between px-3.5 py-1.5 text-xs font-semibold uppercase tracking-wide text-white/50 hover:text-white/70"
        >
          {group.label}
          <ChevronDown
            size={13}
            strokeWidth={2.5}
            className={`transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
          />
        </button>
        {!isCollapsed && (
          <div className="flex flex-col gap-1">
            {group.items.map((item) => (
              <NavLinkItem key={item.to} {...item} orientation={orientation} />
            ))}
          </div>
        )}
      </div>
    );
  });
}

// Apatinio mobilaus meniu "Daugiau" — likę (ne prioritetiniai) punktai,
// grupuoti taip pat, kaip darbalaukio šoniniame meniu, kad struktūra būtų
// pažįstama. Pasirinkus punktą, lapas užsidaro automatiškai (onClick prie
// kiekvienos NavLink).
function MoreMenuSheet({ groups, onClose }) {
  return (
    <div
      className="fixed inset-0 z-30 flex items-end justify-center bg-ink-950/50 lg:hidden"
      onClick={onClose}
    >
      <div
        className="max-h-[75vh] w-full overflow-y-auto rounded-t-2xl bg-white p-4 shadow-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between px-1">
          <h2 className="text-base font-bold text-ink-900">Daugiau</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-ink-900/5" aria-label="Uždaryti">
            <X size={18} />
          </button>
        </div>
        <div className="space-y-4 pb-[env(safe-area-inset-bottom)]">
          {groups.map((group) => (
            <div key={group.label}>
              <p className="mb-1.5 px-2 text-xs font-semibold uppercase tracking-wide text-ink-600/50">{group.label}</p>
              <div className="flex flex-col gap-1">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.end}
                      onClick={onClose}
                      className={({ isActive }) =>
                        `flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition ${
                          isActive ? "bg-ink-900/5 text-ink-900" : "text-ink-700 hover:bg-ink-900/5"
                        }`
                      }
                    >
                      <Icon size={18} strokeWidth={2.2} />
                      {item.label}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Layout() {
  const { user, profile, isAdmin, signOut, hasPermission, hasDevicePermission } = useAuth();
  const canSeeWriteoffs = hasPermission("delete");
  const canSeeDeviceWriteoffs = hasDevicePermission("delete");
  const canSeeDevicePickups = hasDevicePermission("edit");

  const canSeeStats = canSeeWriteoffs || canSeeDeviceWriteoffs;

  const navGroups = useMemo(() => {
    // "Prietaisai", kaip ir "Priedai", peržiūra dabar VIEŠA — nuoroda visada
    // statiniame BASE_NAV_GROUPS; tik "Nurašymai"/"Atsinešimai" pounoroda lieka
    // pagal atitinkamą teisę. Importas (visų trijų tipų, su pasirinkimu viduje)
    // nebeturi savo pounuorodos čia — jis tik adminams, po "Admin" grupe.
    let groups = BASE_NAV_GROUPS.map((g) => {
      if (g.label === "Priedų sandėlis" && canSeeWriteoffs) {
        return { ...g, items: [...g.items, { to: "/priedai/nurasymai", label: "Nurašymai", icon: PackageMinus }] };
      }
      if (g.label === "Prietaisų sandėlis") {
        const extra = [];
        if (canSeeDevicePickups) extra.push({ to: "/prietaisai/atsinesimai", label: "Atsinešimai", icon: ClipboardList });
        if (canSeeDeviceWriteoffs) extra.push({ to: "/prietaisai/nurasymai", label: "Nurašymai", icon: PackageMinus });
        return extra.length ? { ...g, items: [...g.items, ...extra] } : g;
      }
      return g;
    });

    // Vienas bendras statistikos puslapis visam projektui (priedai + prietaisai,
    // perjungiama pačiame Stats.jsx) — sąmoningai atskira grupė meniu apačioje,
    // prieš "Admin", ne įterpta į konkretaus modulio grupę.
    if (canSeeStats) {
      groups = [...groups, { label: "Statistika", items: [{ to: "/statistika", label: "Statistika", icon: BarChart3 }] }];
    }

    if (!isAdmin) return groups;
    return [...groups, { label: "Admin", items: [
      { to: "/importas", label: "Importas", icon: FileUp },
      { to: "/priedai/vartotojai", label: "Vartotojai", icon: Users }
    ] }];
  }, [isAdmin, canSeeWriteoffs, canSeeDevicePickups, canSeeDeviceWriteoffs, canSeeStats]);

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <TopBar />
      <div className="lg:flex lg:flex-1">
        {/* Desktop / tablet sidebar */}
        <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:gap-1 bg-ink-950 px-4 py-6">
          {/* Šviesi juosta viršuje (ne maža balta dėžutė) — logotipas turi
              tamsų tekstą permatomame fone, todėl jam reikia šviesaus fono
              visame plotyje, ne tik aplink patį paveikslėlį. */}
          <div className="-mx-4 -mt-6 mb-6 flex items-center gap-2.5 bg-white px-4 py-5">
            <img src="/itp-logo.png" alt="IT Partner" className="h-10 w-auto" />
            <p className="text-sm font-semibold text-ink-900">Sandėlio valdymas</p>
          </div>
          <nav className="flex flex-1 flex-col gap-1">
            <NavItems orientation="vertical" groups={navGroups} />
          </nav>
          {user && (
            <div className="mt-auto border-t border-white/10 px-2 pt-4">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium text-white/60">
                  {profile?.username || "…"}{isAdmin && " · admin"}
                </span>
                <button
                  type="button"
                  onClick={signOut}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-white/60 hover:bg-white/5 hover:text-white"
                >
                  <LogOut size={13} /> Atsijungti
                </button>
              </div>
            </div>
          )}
        </aside>

        {/* Content */}
        <div className="flex-1 pb-20 lg:pb-0">
          <header className="flex items-center gap-2.5 border-b border-ink-900/5 bg-white/80 px-4 py-2.5 backdrop-blur lg:hidden">
            <img src="/itp-logo.png" alt="IT Partner" className="h-9 w-auto" />
            <p className="text-sm font-semibold text-ink-900">Sandėlio valdymas</p>
          </header>

          <main className="mx-auto max-w-6xl px-4 py-5 lg:px-8 lg:py-8">
            <Outlet />
          </main>
        </div>

        {/* Mobile bottom nav */}
        <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-ink-900/10 bg-white/95 backdrop-blur lg:hidden">
          <NavItems orientation="horizontal" groups={navGroups} />
        </nav>
      </div>
    </div>
  );
}
