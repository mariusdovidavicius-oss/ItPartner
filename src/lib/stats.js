// /statistika duomenų paruošimas. DB funkcijos parts_stats() / device_stats()
// (žr. supabase/migrate_add_stats_functions.sql) grąžina JSON, čia jis
// paverčiamas į formą, kurią renderina skydeliai.

// Nurašymo priežastys, kurioms rodomos plytelės, moduliui.
export const PART_REASON_KEYS = ["parduota", "remontui", "kita"];
export const DEVICE_REASON_KEYS = ["parduota", "remontui", "garantija", "kita"];

// "sub" — smulkesnis tekstas šalia TOP įrašo pavadinimo (priedams — modelis,
// prietaisams — IAN), padeda atskirti to paties pavadinimo skirtingų modelių įrašus.
export function normalizeWriteoffStats(json, reasonKeys, subOf) {
  const w = json?.writeoffs ?? {};
  const byReason = Object.fromEntries(
    reasonKeys.map((key) => [
      key,
      { count: Number(w.by_reason?.[key]?.count ?? 0), qty: Number(w.by_reason?.[key]?.qty ?? 0) }
    ])
  );
  return {
    totalQty: Number(w.total_qty ?? 0),
    revenue: Number(w.revenue ?? 0),
    byReason,
    topItems: (json?.top_items ?? []).map((t) => ({
      label: t.label,
      code: t.code,
      sub: subOf(t),
      qty: Number(t.qty ?? 0)
    }))
  };
}

// Suprantamas klaidos tekstas. PGRST202 = DB funkcijos nėra (migracija dar
// nepaleista tame Supabase projekte) — dažniausia priežastis diegiant.
export function statsErrorMessage(error) {
  if (!error) return "";
  if (error.code === "PGRST202") {
    return "DB trūksta statistikos funkcijų — paleiskite supabase/migrate_add_stats_functions.sql.";
  }
  return error.message || "Nežinoma klaida.";
}
