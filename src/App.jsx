import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import RequirePermission from "./components/RequirePermission";
import ScanEntry from "./pages/ScanEntry";
import Pallets from "./pages/Pallets";
import PalletDetail from "./pages/PalletDetail";
import ShipmentsList from "./pages/ShipmentsList";
import ShipmentDetail from "./pages/ShipmentDetail";
import Parts from "./pages/Parts";
import PartsImport from "./pages/PartsImport";
import PartsUsers from "./pages/PartsUsers";
import CatalogImport from "./pages/CatalogImport";
import AdminReset from "./pages/AdminReset";
import Login from "./pages/Login";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Layout />}>
        <Route path="/" element={<ScanEntry />} />
        <Route path="/paletes" element={<Pallets />} />
        <Route path="/paletes/:id" element={<PalletDetail />} />
        <Route path="/siuntos" element={<ShipmentsList />} />
        <Route path="/siuntos/:id" element={<ShipmentDetail />} />
        {/* Priedų modulis — reikalauja prisijungimo + atitinkamos teisės */}
        <Route path="/priedai" element={<RequirePermission permission="view"><Parts /></RequirePermission>} />
        <Route path="/priedai/importas" element={<RequirePermission permission="import"><PartsImport /></RequirePermission>} />
        <Route path="/priedai/vartotojai" element={<RequirePermission permission="admin"><PartsUsers /></RequirePermission>} />
        {/* Administraciniai puslapiai — tik tiesioginiu adresu, be nuorodos navigacijoje */}
        <Route path="/katalogas" element={<CatalogImport />} />
        <Route path="/admin-reset" element={<AdminReset />} />
      </Route>
    </Routes>
  );
}
