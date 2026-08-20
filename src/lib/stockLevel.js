// Bendras likučio būsenos ("ok" / "low" / "out") vaizdavimas — naudojamas
// tiek Parts.jsx, tiek Devices.jsx lentelės eilutėse. Pati "level" reikšmė
// apskaičiuojama atskirai kiekviename modulyje (Parts — DB stulpelis
// stock_level, Devices — vietinė stockLevel() f-ja), tik stiliaus/teksto
// atvaizdavimas buvo identiškas abiejuose failuose.
export function stockLevelRowTone(level) {
  if (level === "out") return "bg-signal-red/[0.04] hover:bg-signal-red/[0.07]";
  if (level === "low") return "bg-signal-amber/[0.05] hover:bg-signal-amber/[0.08]";
  return "hover:bg-ink-900/[0.015]";
}

export function stockLevelBorderClass(level) {
  if (level === "out") return "border-signal-red";
  if (level === "low") return "border-signal-amber";
  return "border-transparent";
}

export function stockLevelTitle(level) {
  if (level === "out") return "Baigėsi likutis";
  if (level === "low") return "Mažas likutis";
  return undefined;
}
