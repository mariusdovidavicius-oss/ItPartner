import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import ScanEntry from "./pages/ScanEntry";
import Pallets from "./pages/Pallets";
import PalletDetail from "./pages/PalletDetail";
import ShipmentsList from "./pages/ShipmentsList";
import ShipmentDetail from "./pages/ShipmentDetail";
import CatalogImport from "./pages/CatalogImport";
import AdminReset from "./pages/AdminReset";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<ScanEntry />} />
        <Route path="/paletes" element={<Pallets />} />
        <Route path="/paletes/:id" element={<PalletDetail />} />
        <Route path="/siuntos" element={<ShipmentsList />} />
        <Route path="/siuntos/:id" element={<ShipmentDetail />} />
        {/* Administraciniai puslapiai — tik tiesioginiu adresu, be nuorodos navigacijoje */}
        <Route path="/katalogas" element={<CatalogImport />} />
        <Route path="/admin-reset" element={<AdminReset />} />
      </Route>
    </Routes>
  );
}
