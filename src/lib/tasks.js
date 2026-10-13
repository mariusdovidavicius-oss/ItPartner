import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

// Darbų (/darbai) terminai saugomi kaip "date" (be laiko), todėl visur
// lyginama vietinė data "YYYY-MM-DD" eilute — ne Date objektai, kad UTC
// poslinkis (vidurnaktį LT laiku dar "vakar" UTC) neperkeltų darbo į kitą dieną.
export function localDateStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDaysStr(days, from = new Date()) {
  const date = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
  return localDateStr(date);
}

function parseDateStr(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Dienų skirtumas tarp termino ir šiandienos (neigiamas — vėluoja).
export function daysUntil(dueDate, today = localDateStr()) {
  return Math.round((parseDateStr(dueDate) - parseDateStr(today)) / 86400000);
}

export function formatDue(dueDate, today = localDateStr()) {
  const diff = daysUntil(dueDate, today);
  if (diff === 0) return "Šiandien";
  if (diff === 1) return "Rytoj";
  if (diff === -1) return "Vakar";
  const label = parseDateStr(dueDate).toLocaleDateString("lt-LT", { weekday: "short", month: "short", day: "numeric" });
  return diff < 0 ? `${label} (vėluoja ${-diff} d.)` : label;
}

// Neatliktų / vėluojančių darbų skaičius viršutinės juostos ženkliukui.
// Perskaičiuojama realtime pakeitimams ir grįžus į langą (telefone programa
// ilgai būna fone — "šiandien" per tą laiką gali tapti "vėluoja").
export function useTaskCounts(userId) {
  const [counts, setCounts] = useState({ open: 0, overdue: 0 });

  const load = useCallback(async () => {
    if (!userId) return;
    const [{ count: open }, { count: overdue }] = await Promise.all([
      supabase.from("tasks").select("id", { count: "exact", head: true }).eq("done", false),
      supabase.from("tasks").select("id", { count: "exact", head: true }).eq("done", false).lt("due_date", localDateStr())
    ]);
    setCounts({ open: open ?? 0, overdue: overdue ?? 0 });
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setCounts({ open: 0, overdue: 0 });
      return undefined;
    }
    load();
    const channel = supabase
      .channel("tasks-counts")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, load)
      .subscribe();
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      supabase.removeChannel(channel);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId, load]);

  return counts;
}
