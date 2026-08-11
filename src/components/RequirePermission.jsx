import { Navigate, useLocation } from "react-router-dom";
import { Loader2, ShieldAlert } from "lucide-react";
import { useAuth } from "../lib/AuthProvider";

// Apsaugo maršrutą — reikalauja prisijungimo, o jei nurodyta "permission",
// dar ir konkrečios teisės (view/edit/delete/import/admin). Kadangi
// "admin" nėra galiojama user_permissions reikšmė (žr. migraciją), tikrinant
// permission="admin" hasPermission() faktiškai patikrina tik is_admin.
export default function RequirePermission({ permission, children }) {
  const { user, loading, hasPermission } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex justify-center py-20 text-ink-600/40">
        <Loader2 className="animate-spin" size={22} />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (permission && !hasPermission(permission)) {
    return (
      <div className="flex flex-col items-center gap-2 py-20 text-center text-ink-600/60">
        <ShieldAlert size={22} className="text-ink-600/30" />
        <p className="text-sm font-medium">Neturite teisės pasiekti šį puslapį.</p>
      </div>
    );
  }

  return children;
}
