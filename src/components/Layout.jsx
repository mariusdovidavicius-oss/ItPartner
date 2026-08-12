import { useMemo, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { ScanLine, PackageSearch, Boxes, ChevronDown, Wrench, PackageMinus, Users, LogOut } from "lucide-react";
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
  }
];

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
          : `flex flex-1 flex-col items-center gap-1 py-2 text-[11px] font-medium transition ${
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

  if (orientation === "horizontal") {
    return groups.flatMap((g) => g.items).map((item) => (
      <NavLinkItem key={item.to} {...item} orientation={orientation} />
    ));
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

export default function Layout() {
  const { user, profile, isAdmin, signOut, hasPermission } = useAuth();
  const canSeeWriteoffs = hasPermission("delete");

  const navGroups = useMemo(() => {
    const extra = [];
    if (canSeeWriteoffs) extra.push({ to: "/priedai/nurasymai", label: "Nurašymai", icon: PackageMinus });
    if (isAdmin) extra.push({ to: "/priedai/vartotojai", label: "Vartotojai", icon: Users });
    if (extra.length === 0) return BASE_NAV_GROUPS;
    return BASE_NAV_GROUPS.map((g) =>
      g.label === "Priedų sandėlis" ? { ...g, items: [...g.items, ...extra] } : g
    );
  }, [isAdmin, canSeeWriteoffs]);

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <TopBar />
      <div className="lg:flex lg:flex-1">
        {/* Desktop / tablet sidebar */}
        <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:gap-1 bg-ink-950 px-4 py-6">
          <div className="mb-6 flex items-center gap-2 px-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-signal-orange">
              <PackageSearch size={18} className="text-white" strokeWidth={2.5} />
            </div>
            <div>
              <p className="font-mono text-[11px] uppercase tracking-widest text-signal-orange">
                IAN sistema
              </p>
              <p className="text-sm font-semibold text-white">Sandėlio valdymas</p>
            </div>
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
          <header className="flex items-center gap-2 border-b border-ink-900/5 bg-white/80 px-4 py-3.5 backdrop-blur lg:hidden">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-signal-orange">
              <PackageSearch size={16} className="text-white" strokeWidth={2.5} />
            </div>
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
