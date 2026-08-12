import { Loader2, ShieldAlert } from "lucide-react";
import { useAuth } from "../lib/AuthProvider";
import InlineLoginForm from "./InlineLoginForm";

// Apsaugo maršrutą — reikalauja prisijungimo, o jei nurodyta "permission",
// dar ir konkrečios teisės (view/edit/delete/import/admin). Kadangi
// "admin" nėra galiojama user_permissions reikšmė (žr. migraciją), tikrinant
// permission="admin" hasPermission() faktiškai patikrina tik is_admin.
// Neprisijungusiam vartotojui rodoma prisijungimo forma tiesiog čia, tame
// pačiame puslapyje — be peradresavimo į atskirą /login maršrutą.
export default function RequirePermission({ permission, children }) {
  const { user, loading, hasPermission } = useAuth();

  if (loading) {
    return (
      <div className="flex justify-center py-20 text-ink-600/40">
        <Loader2 className="animate-spin" size={22} />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="mx-auto max-w-md py-10">
        <InlineLoginForm message="Šis puslapis pasiekiamas tik prisijungusiems vartotojams." />
      </div>
    );
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
