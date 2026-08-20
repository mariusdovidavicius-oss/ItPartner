import { useState } from "react";
import { Wrench, Cpu, BookOpen } from "lucide-react";
import PartsImport from "./PartsImport";
import DevicesImport from "./DevicesImport";
import CatalogImport from "./CatalogImport";

// Vienas bendras importo puslapis su pasirinkimu, ką importuoti — pakeičia
// tris atskirus maršrutus (/priedai/importas, /prietaisai/importas,
// /katalogas). Pasirinkti komponentai (PartsImport/DevicesImport/
// CatalogImport) lieka nepakitę — kiekvienas jau turi savo antraštę ir
// pilną importo eigą, čia tik perjungiami.
const TYPES = [
  { key: "parts", label: "Priedai", icon: Wrench, Component: PartsImport },
  { key: "devices", label: "Prietaisai", icon: Cpu, Component: DevicesImport },
  { key: "catalog", label: "Katalogas", icon: BookOpen, Component: CatalogImport }
];

export default function Import() {
  const [type, setType] = useState(TYPES[0].key);
  const active = TYPES.find((t) => t.key === type) || TYPES[0];
  const ActiveComponent = active.Component;

  return (
    <div className="space-y-6">
      <div className="inline-flex rounded-xl border border-ink-700/10 bg-ink-900/[0.02] p-1">
        {TYPES.map((t) => {
          const Icon = t.icon;
          const isActive = t.key === type;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setType(t.key)}
              className={`flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium transition ${
                isActive ? "bg-white text-ink-900 shadow-sm" : "text-ink-600/60 hover:text-ink-900"
              }`}
            >
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>

      <ActiveComponent />
    </div>
  );
}
