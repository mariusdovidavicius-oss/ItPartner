import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import { Loader2 } from "lucide-react";
import Layout from "./components/Layout";
import RequirePermission from "./components/RequirePermission";
import ScanEntry from "./pages/ScanEntry";

// Viskas, išskyrus "/" (pirmas puslapis, kurį mato kiekvienas atidaręs
// programą), kraunama lazy — kiekvienas puslapis tampa savo JS gabalu,
// atsiunčiamu tik atidarius tą konkretų maršrutą. Svarbiausia dėl to, kad
// exceljs (eksportas) ir ypač pdfjs-dist (~1.3 MB, tik DevicePickups.jsx
// transportų PDF nuskaitymui) nebesikrautų telefone kiekvieną kartą
// atidarius pagrindinį skenavimo puslapį.
const Pallets = lazy(() => import("./pages/Pallets"));
const PalletDetail = lazy(() => import("./pages/PalletDetail"));
const ShipmentsList = lazy(() => import("./pages/ShipmentsList"));
const ShipmentDetail = lazy(() => import("./pages/ShipmentDetail"));
const Parts = lazy(() => import("./pages/Parts"));
const PartsWriteoffs = lazy(() => import("./pages/PartsWriteoffs"));
const PartsUsers = lazy(() => import("./pages/PartsUsers"));
const AdminReset = lazy(() => import("./pages/AdminReset"));
const Devices = lazy(() => import("./pages/Devices"));
const DeviceWriteoffs = lazy(() => import("./pages/DeviceWriteoffs"));
const DevicePickups = lazy(() => import("./pages/DevicePickups"));
const Stats = lazy(() => import("./pages/Stats"));
const Import = lazy(() => import("./pages/Import"));

function RouteFallback() {
  return (
    <div className="flex justify-center py-20 text-ink-600/40">
      <Loader2 className="animate-spin" size={22} />
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<ScanEntry />} />
          <Route path="/paletes" element={<Pallets />} />
          <Route path="/paletes/:id" element={<PalletDetail />} />
          <Route path="/siuntos" element={<ShipmentsList />} />
          <Route path="/siuntos/:id" element={<ShipmentDetail />} />
          {/* Priedai — peržiūra vieša visiems, redagavimas/trynimas gated Parts.jsx viduje pagal teisę */}
          <Route path="/priedai" element={<Parts />} />
          {/* Prisijungimo forma rodoma tiesiog šiuose puslapiuose (RequirePermission), ne atskirame /login maršrute */}
          <Route path="/priedai/nurasymai" element={<RequirePermission permission="delete"><PartsWriteoffs /></RequirePermission>} />
          <Route path="/priedai/vartotojai" element={<RequirePermission permission="admin"><PartsUsers /></RequirePermission>} />
          {/* Prietaisai — peržiūra vieša visiems (kaip priedai), redagavimas/trynimas/nurašymas gated Devices.jsx viduje pagal teisę */}
          <Route path="/prietaisai" element={<Devices />} />
          <Route path="/prietaisai/nurasymai" element={<RequirePermission devicePermission="delete"><DeviceWriteoffs /></RequirePermission>} />
          <Route path="/prietaisai/atsinesimai" element={<RequirePermission devicePermission="edit"><DevicePickups /></RequirePermission>} />
          {/* Bendras statistikos puslapis visam projektui (priedai + prietaisai, perjungiama viduje) — reikia
              bent vieno modulio "delete" teisės, tikrinama pačiame Stats.jsx, ne čia (RequirePermission be
              "permission"/"devicePermission" prop'o čia reikalauja tik prisijungimo). */}
          <Route path="/statistika" element={<RequirePermission><Stats /></RequirePermission>} />
          {/* Administraciniai puslapiai — tik tiesioginiu adresu (arba per Admin meniu grupę), be atskiros
              nuorodos kiekvieno modulio meniu. Bendras importas (priedai/prietaisai/katalogas su pasirinkimu
              viduje) — tik adminams, žr. src/pages/Import.jsx. */}
          <Route path="/importas" element={<RequirePermission permission="admin"><Import /></RequirePermission>} />
          <Route path="/admin-reset" element={<RequirePermission permission="admin"><AdminReset /></RequirePermission>} />
        </Route>
      </Routes>
    </Suspense>
  );
}
