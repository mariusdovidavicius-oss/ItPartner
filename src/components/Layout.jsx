import { NavLink, Outlet } from "react-router-dom";
import { ScanLine, Table2, PackageSearch, Boxes } from "lucide-react";

const NAV_ITEMS = [
  { to: "/",        label: "Skenavimas",    icon: ScanLine, end: true },
  { to: "/prekes",  label: "Prekių lentelė", icon: Table2 },
  { to: "/paletes", label: "Paletės",        icon: Boxes }
];

function NavItems({ orientation }) {
  return NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
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
  ));
}

export default function Layout() {
  return (
    <div className="min-h-screen bg-paper lg:flex">
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
        <nav className="flex flex-col gap-1">
          <NavItems orientation="vertical" />
        </nav>
      </aside>

      {/* Content */}
      <div className="flex-1 pb-20 lg:pb-0">
        <header className="flex items-center justify-between border-b border-ink-900/5 bg-white/80 px-4 py-3.5 backdrop-blur lg:hidden">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-signal-orange">
              <PackageSearch size={16} className="text-white" strokeWidth={2.5} />
            </div>
            <p className="text-sm font-semibold text-ink-900">Sandėlio valdymas</p>
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-4 py-5 lg:px-8 lg:py-8">
          <Outlet />
        </main>
      </div>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-ink-900/10 bg-white/95 backdrop-blur lg:hidden">
        <NavItems orientation="horizontal" />
      </nav>
    </div>
  );
}
