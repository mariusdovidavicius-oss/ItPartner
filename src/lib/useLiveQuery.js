import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./supabaseClient";

// Bendras "užkrauti duomenis + atnaujinti realiu laiku" hook'as statistikos
// skydeliams. Sprendžia tris dalykus, kurių anksčiau nebuvo:
//
//  1. KLAIDOS — fetcher'is turi mesti klaidą (throw), hook'as ją grąžina
//     kaip `error`, o ne tyliai rodo nulius.
//  2. SENI DUOMENYS RODOMI KOL KRAUNASI NAUJI — `loading` true tik pirmą
//     kartą (kai dar nėra ką rodyti); vėliau (laikotarpio pakeitimas,
//     realtime) keičiasi tik `refreshing`, todėl turinys nemirga spinner'iu ir
//     slinkimo pozicija nešoka.
//  3. REALTIME BE AUDROS — pakeitimų serija (pvz. importas, įrašantis 500
//     eilučių) sujungiama į vieną perkrovimą (debounce). Pasenę atsakymai
//     (greitai keičiant laikotarpį) ignoruojami per užklausos numerį.
//
// "fetcher" gali keistis kiekvieną render'į — naudojamas naujausias. Perkrovimą
// paleidžia `deps` pasikeitimas (pvz. [period]) ir realtime įvykiai `tables`
// lentelėse.
export function useLiveQuery(fetcher, { deps = [], tables = [], channel, debounceMs = 800 } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const requestId = useRef(0);

  const run = useCallback(async () => {
    const id = ++requestId.current;
    setRefreshing(true);
    try {
      const result = await fetcherRef.current();
      if (id !== requestId.current) return; // atėjo pasenęs atsakymas
      setData(result);
      setError(null);
    } catch (e) {
      if (id !== requestId.current) return;
      setError(e || new Error("Nepavyko įkelti duomenų."));
    } finally {
      if (id === requestId.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, ...deps]);

  const tablesKey = tables.join(",");
  useEffect(() => {
    if (!tablesKey || !channel) return undefined;
    let timer;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(run, debounceMs);
    };
    let ch = supabase.channel(channel);
    tablesKey.split(",").forEach((table) => {
      ch = ch.on("postgres_changes", { event: "*", schema: "public", table }, schedule);
    });
    ch.subscribe();
    return () => {
      clearTimeout(timer);
      supabase.removeChannel(ch);
    };
  }, [run, channel, tablesKey, debounceMs]);

  return { data, error, loading, refreshing, reload: run };
}
