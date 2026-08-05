import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import ScanEntry from "./pages/ScanEntry";
import ItemsTable from "./pages/ItemsTable";
import Pallets from "./pages/Pallets";
import PalletDetail from "./pages/PalletDetail";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<ScanEntry />} />
        <Route path="/prekes" element={<ItemsTable />} />
        <Route path="/paletes" element={<Pallets />} />
        <Route path="/paletes/:id" element={<PalletDetail />} />
      </Route>
    </Routes>
  );
}
