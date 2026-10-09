import { useEffect, useRef, useState } from "react";
import {
  ScanLine, CheckCircle2, AlertCircle, AlertTriangle, Loader2, PackageCheck,
  ChevronDown, ChevronUp, Pencil, Trash2, X, Plus, Save, ArrowDownToLine
} from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { computeDestination, prettifyDestination, UNCLASSIFIED } from "../lib/destination";
import { printPalletLabel } from "../lib/printLabel";
import { useAuth } from "../lib/AuthProvider";
import { searchPattern, formatDateTime } from "../lib/format";

// Leistini gamintojo -> tipo deriniai rankiniam naujo įrankio įvedimui.
// Reikšmės TIKSLIAI atitinka jau naudojamas catalog.manufacturer/item_type
// reikšmes, kad naujas įrašas patektų į tą pačią destination grupavimo logiką.
const MANUFACTURER_TYPES = {
  Grizzly: ["Prietaisas", "Bat"],
  Kompernass: ["Prietaisas", "Prietaisas2", "Prietaisas3", "Bat"]
};

// Naujai sukurta ("open") paletė TYČIA neturi nei "number", nei "code" —
// abu priskiriami tik UŽDARANT paletę (žr. assign_pallet_number_on_close()
// schema.sql), ne ją kuriant. Be šio "|| pallet.destination" pakaitalo
// šablonas paverstų null į pažodinį tekstą "null" vartotojui rodomame
// pranešime (žr. registerItem() žemiau).
function formatPalletLabel(pallet) {
  if (!pallet) return "";
  const base = pallet.number ? `${pallet.number} paletė` : (pallet.code || openPalletName(pallet));
  return `${base} — ${prettifyDestination(pallet.destination)}`;
}

// Atvira paletė numerio dar neturi (jis suteikiamas tik "Išvežta") — kelios
// tos pačios paskirties atviros paletės atskiriamos pastaba arba pradžios laiku.
function openPalletName(pallet) {
  if (pallet.notes?.trim()) return `paletė „${pallet.notes.trim()}“`;
  if (pallet.created_at) {
    const t = new Date(pallet.created_at);
    return `paletė (pradėta ${t.toLocaleDateString("lt-LT", { month: "2-digit", day: "2-digit" })} ${t.toLocaleTimeString("lt-LT", { hour: "2-digit", minute: "2-digit" })})`;
  }
  return "nauja paletė";
}

// Katalogo variantai su gamintoju/tipu (iš catalog). `refine` papildo
// užklausą filtru/limitu.
async function fetchVariants(refine) {
  const { data } = await refine(
    supabase
      .from("catalog_variants")
      .select("ian, name, catalog(manufacturer, item_type)")
      .order("ian", { ascending: true })
      .order("name", { ascending: true })
  );
  return (data || []).map((v) => ({
    ian: v.ian,
    name: v.name,
    manufacturer: v.catalog?.manufacturer ?? null,
    item_type: v.catalog?.item_type ?? null
  }));
}

// Ta pati regex logika, kuri naudojama src/pages/CatalogImport.jsx —
// IAN yra skaičius skliausteliuose teksto gale, likusi dalis yra pavadinimas.
function parseManualEntry(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { ian: null, name: null };
  const match = text.match(/^(.*)\((\d+)\)\s*$/);
  if (!match) return { ian: null, name: null };
  return { ian: match[2].trim(), name: match[1].trim() };
}

export default function ScanEntry() {
  const { hasPalletPermission } = useAuth();
  const canScan = hasPalletPermission("scan");
  const [ian, setIan] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null); // { type: 'ok'|'warn'|'error', message }
  const [catalogNotFound, setCatalogNotFound] = useState(false);
  const [previewUnclassified, setPreviewUnclassified] = useState(false);
  const [openPallets, setOpenPallets] = useState([]); // visos atviros paletės, sugrupuotos pagal destination (įsk. tuščias — jas reikia matyti, kad būtų galima ištrinti)
  const [itemsByPallet, setItemsByPallet] = useState({}); // pallet id -> pilnas items sąrašas (peržiūrai/redagavimui)
  const [expandedIds, setExpandedIds] = useState(new Set()); // kurios paletės kortelės išskleistos
  const [editingItem, setEditingItem] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [deletingPalletId, setDeletingPalletId] = useState(null);
  const [palletNotesDrafts, setPalletNotesDrafts] = useState({}); // pallet id -> juodraštis (nekeičiamas prilaike, kad neišsivalytų nebaigtas redagavimas per realtime reload)
  const [savingPalletNotesId, setSavingPalletNotesId] = useState(null);
  const [loadingPallets, setLoadingPallets] = useState(true);
  const [closingId, setClosingId] = useState(null);
  const [closeMsg, setCloseMsg] = useState("");

  // "Formuoti naują paletę" — dar viena atvira paletė pasirinktai paskirčiai
  // (pvz. antra Grizzly paletė, kol pirmoji dar neišvežta). Nauja paletė
  // tampa "Kraunu čia" (žr. migrate_pallet_loading.sql).
  const [newPalletOpen, setNewPalletOpen] = useState(false);
  const [newPalletManufacturer, setNewPalletManufacturer] = useState("");
  const [newPalletType, setNewPalletType] = useState("");
  const [newPalletNotes, setNewPalletNotes] = useState("");
  const [newPalletError, setNewPalletError] = useState("");
  const [creatingPallet, setCreatingPallet] = useState(false);
  const [settingLoadingId, setSettingLoadingId] = useState(null);

  // Registravimo režimas: "ian" (skenavimas), "name" (paieška pagal
  // pavadinimą, kai fizinė etiketė neįskaitoma / nėra) arba "manual"
  // (naujo, kataloge dar neregistruoto įrankio įvedimas rankiniu būdu).
  const [mode, setMode] = useState("ian");
  const [ianSuggestions, setIanSuggestions] = useState([]);
  const [nameQuery, setNameQuery] = useState("");
  const [nameResults, setNameResults] = useState([]);
  const [searchingName, setSearchingName] = useState(false);

  const [manualText, setManualText] = useState("");
  const [manualManufacturer, setManualManufacturer] = useState("");
  const [manualItemType, setManualItemType] = useState("");
  const [manualError, setManualError] = useState("");

  const inputRef = useRef(null);
  const nameInputRef = useRef(null);
  const manualInputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    loadOpenPallets();

    // Realtime: kito įrenginio/lango atliktas prietaiso ar paletės pakeitimas
    // taip pat turi atsispindėti čia (pvz. redagavimas iš paletės detalės puslapio).
    const channel = supabase
      .channel("scan-entry-open-pallets")
      .on("postgres_changes", { event: "*", schema: "public", table: "items" }, loadOpenPallets)
      .on("postgres_changes", { event: "*", schema: "public", table: "pallets" }, loadOpenPallets)
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, []);

  // Perkeliant fokusą į aktyvaus režimo lauką (patogu ir keičiant režimą, ir
  // registruojant kelis be-IAN įrankius iš eilės paieškos režime).
  useEffect(() => {
    if (mode === "ian") inputRef.current?.focus();
    else if (mode === "name") nameInputRef.current?.focus();
    else manualInputRef.current?.focus();
  }, [mode]);

  // Ieško IAN kodo kataloge (su debounce), automatiškai užpildo pavadinimą ir
  // rodo gyvą paskirties peržiūrą (tik UI patogumui — autoritetinga paieška
  // vyksta iš naujo registerItem metu, žr. komentarą ten).
  useEffect(() => {
    if (mode !== "ian") {
      setCatalogNotFound(false);
      setPreviewUnclassified(false);
      return;
    }
    const trimmed = ian.trim();
    if (!trimmed) {
      setCatalogNotFound(false);
      setPreviewUnclassified(false);
      return;
    }
    const handle = setTimeout(async () => {
      const { data } = await supabase
        .from("catalog")
        .select("name, manufacturer, item_type")
        .eq("ian", trimmed)
        .maybeSingle();
      if (data?.name) {
        setName(data.name);
        setCatalogNotFound(false);
      } else {
        setCatalogNotFound(true);
      }
      setPreviewUnclassified(computeDestination(data?.manufacturer, data?.item_type) === UNCLASSIFIED);
    }, 400);
    return () => clearTimeout(handle);
  }, [ian, mode]);

  // IAN pasiūlymai vedant ranka (su debounce) — katalogo variantai
  // (catalog_variants), kurių IAN prasideda įvestais skaitmenimis; IAN su
  // keliais daiktais rodomas kiekvienu variantu atskirai. Laukas priima tik
  // skaitmenis, todėl ilike šablone nėra specialių simbolių.
  useEffect(() => {
    const trimmed = ian.trim();
    if (mode !== "ian" || trimmed.length < 2) {
      setIanSuggestions([]);
      return;
    }
    const handle = setTimeout(async () => {
      setIanSuggestions(await fetchVariants((q) => q.ilike("ian", `${trimmed}%`).limit(15)));
    }, 250);
    return () => clearTimeout(handle);
  }, [ian, mode]);

  // Paieška pagal pavadinimą (su debounce) — dalinė, case-insensitive
  // atitiktis catalog.name lauke. Rodomi ir gamintojas/tipas/IAN, nes tas
  // pats pavadinimas gali kartotis tarp skirtingų gamintojų/tipų.
  useEffect(() => {
    if (mode !== "name") {
      setNameResults([]);
      setSearchingName(false);
      return;
    }
    const trimmed = nameQuery.trim();
    if (!trimmed) {
      setNameResults([]);
      setSearchingName(false);
      return;
    }
    setSearchingName(true);
    const handle = setTimeout(async () => {
      const { data } = await supabase
        .from("catalog")
        .select("ian, name, manufacturer, item_type")
        .ilike("search_text", searchPattern(trimmed))
        .not("name", "is", null)
        .order("name", { ascending: true })
        .limit(10);
      setNameResults(data || []);
      setSearchingName(false);
    }, 300);
    return () => clearTimeout(handle);
  }, [nameQuery, mode]);

  // Kraunamos visos status='open' paletės (įsk. tuščias — kad būtų galima jas
  // ištrinti), sugrupuotos pagal paskirtį, kartu su pilnu kiekvienos paletės
  // items sąrašu (peržiūrai, redagavimui ir trynimui tiesiai skenavimo puslapyje).
  async function loadOpenPallets() {
    setLoadingPallets(true);
    const { data: pallets } = await supabase
      .from("pallets")
      .select("id, code, number, destination, notes, is_loading, created_at")
      .eq("status", "open");

    const list = pallets || [];
    if (list.length === 0) {
      setOpenPallets([]);
      setItemsByPallet({});
      setPalletNotesDrafts({});
      setLoadingPallets(false);
      return;
    }

    const { data: items } = await supabase
      .from("items")
      .select("id, ian, name, quantity, notes, created_at, pallet_id")
      .in("pallet_id", list.map((p) => p.id))
      .order("created_at", { ascending: false });

    const itemsMap = {};
    const qtyMap = {};
    (items || []).forEach((i) => {
      if (!i.pallet_id) return;
      (itemsMap[i.pallet_id] ||= []).push(i);
      qtyMap[i.pallet_id] = (qtyMap[i.pallet_id] || 0) + (i.quantity || 1);
    });

    // Tos pačios paskirties paletės — greta, seniausia pirma.
    const withQty = list
      .map((p) => ({ ...p, qty: qtyMap[p.id] || 0 }))
      .sort((a, b) =>
        prettifyDestination(a.destination).localeCompare(prettifyDestination(b.destination)) ||
        String(a.created_at).localeCompare(String(b.created_at))
      );

    setOpenPallets(withQty);
    setItemsByPallet(itemsMap);

    // Juodraštį inicijuojame TIK pirmą kartą pamačius paletę (ir pašaliname
    // juodraščius nebeegzistuojančioms) — taip nebaigtas pastabos
    // redagavimas neišsivalo, kai realtime įvykis (pvz. kitos paletės
    // pakeitimas) sukelia šio sąrašo perkrovimą.
    setPalletNotesDrafts((prev) => {
      const next = {};
      withQty.forEach((p) => {
        next[p.id] = p.id in prev ? prev[p.id] : (p.notes || "");
      });
      return next;
    });

    setLoadingPallets(false);
  }

  async function handleSavePalletNotes(palletId) {
    setSavingPalletNotesId(palletId);
    const value = palletNotesDrafts[palletId] || "";
    await supabase.from("pallets").update({ notes: value.trim() || null }).eq("id", palletId);
    setSavingPalletNotesId(null);
  }

  function toggleExpand(id) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleCreatePallet() {
    if (!newPalletManufacturer || !newPalletType) {
      setNewPalletError("Pasirinkite gamintoją ir tipą.");
      return;
    }
    setCreatingPallet(true);
    setNewPalletError("");
    const { error } = await supabase.from("pallets").insert({
      status: "open",
      destination: computeDestination(newPalletManufacturer, newPalletType),
      notes: newPalletNotes.trim() || null,
      is_loading: true
    });
    setCreatingPallet(false);
    if (error) {
      setNewPalletError(`Nepavyko sukurti paletės: ${error.message}`);
      return;
    }
    setNewPalletOpen(false);
    setNewPalletManufacturer("");
    setNewPalletType("");
    setNewPalletNotes("");
    loadOpenPallets();
  }

  // "Kraunu čia" — kitų tos paskirties palečių žymę nuima DB trigeris.
  async function handleSetLoading(pallet) {
    setSettingLoadingId(pallet.id);
    const { error } = await supabase.from("pallets").update({ is_loading: true }).eq("id", pallet.id);
    setSettingLoadingId(null);
    if (error) setFeedback({ type: "error", message: `Nepavyko pažymėti paletės: ${error.message}` });
    loadOpenPallets();
  }

  async function handleClose(pallet) {
    setClosingId(pallet.id);
    setCloseMsg("");
    await supabase.from("pallets").update({ status: "closed" }).eq("id", pallet.id);
    const { data: updated } = await supabase
      .from("pallets")
      .select("number, destination, packed_at")
      .eq("id", pallet.id)
      .single();
    const label = updated?.number
      ? `${updated.number} paletė — ${prettifyDestination(updated.destination)}`
      : prettifyDestination(pallet.destination);
    setCloseMsg(`${label} išvežta į sandėlį`);
    setClosingId(null);
    if (updated) printPalletLabel(updated);
    loadOpenPallets();
  }

  // Tuščios (0 vnt.) paletės trynimas. Paletžų numeravimas skaičiuojamas
  // "gyvai" (spragos paieška, žr. supabase/migrate_gap_fill_pallet_numbering.sql),
  // todėl jokios papildomos skaitliuko korekcijos nebereikia — po ištrynimo
  // atsilaisvinęs numeris tiesiog taps matoma spraga sekantį kartą. Čia
  // pakanka paprasto DELETE, lygiai taip pat, kaip trinamas pavienis prietaisas.
  async function handleDeletePallet(pallet) {
    // Tuščia paletė visada "open" būsenos, tad number/code dar null (žr.
    // formatPalletLabel() aukščiau) — paskirtis yra vienintelis stabilus
    // identifikatorius, kol paletė neuždaryta.
    if (!confirm(`Ištrinti tuščią paletę (${prettifyDestination(pallet.destination)})? Šio veiksmo negalima atšaukti.`)) return;
    setDeletingPalletId(pallet.id);
    await supabase.from("pallets").delete().eq("id", pallet.id);
    setDeletingPalletId(null);
    loadOpenPallets();
  }

  async function handleSaveItem(itemId, form) {
    await supabase
      .from("items")
      .update({
        ian: form.ian.trim(),
        name: form.name.trim() || null,
        quantity: Math.max(1, Math.round(Number(form.quantity)) || 1),
        notes: form.notes.trim() || null
      })
      .eq("id", itemId);
    setEditingItem(null);
    loadOpenPallets();
  }

  async function handleDeleteItem(item) {
    if (!confirm(`Ar tikrai norite ištrinti „${item.name || item.ian}“?`)) return;
    setDeletingId(item.id);
    await supabase.from("items").delete().eq("id", item.id);
    setDeletingId(null);
    loadOpenPallets();
  }

  // Bendra registravimo logika — naudojama tiek skenavus/įvedus IAN rankiniu
  // būdu, tiek pasirinkus rezultatą paieškoje pagal pavadinimą. `nameValue`,
  // pateiktas per overrides, leidžia paieškos pasirinkimui perduoti
  // autoritetingą katalogo pavadinimą, nepasikliaujant asinchroniniu state
  // atnaujinimu. Grąžina true/false — ar registravimas pavyko.
  async function registerItem(ianValue, overrides = {}) {
    const trimmedIan = String(ianValue || "").trim();
    if (!trimmedIan) return false;

    setSaving(true);
    setFeedback(null);
    setCloseMsg("");

    // Šviežia (ne debounce cache) katalogo užklausa — paskirtis nulemia KURIAI
    // paletei priklausys prietaisas, todėl čia svarbiau tikslumas nei greitis:
    // skeneriai dažnai įveda + Enter greičiau nei 400ms debounce.
    const { data: catalogRow } = await supabase
      .from("catalog")
      .select("name, manufacturer, item_type")
      .eq("ian", trimmedIan)
      .maybeSingle();

    // Apsauga nuo neegzistuojančio prietaiso patekimo į paletę: jei IAN
    // kataloge nerastas, registravimas atmetamas — naują prietaisą reikia
    // pridėti per skirtuką "Naujas įrankis" (jis pirma pats įrašo į katalogą).
    if (!catalogRow) {
      setSaving(false);
      setFeedback({
        type: "error",
        message: `IAN ${trimmedIan} nerastas kataloge — naudokite skirtuką „Naujas įrankis“, kad pridėtumėte naują prietaisą.`
      });
      return false;
    }

    const destination = computeDestination(catalogRow?.manufacturer, catalogRow?.item_type);
    const isUnclassified = destination === UNCLASSIFIED;

    // Rasti arba sukurti atvirą tos paskirties paletę — pažymėtą "Kraunu
    // čia" (is_loading), o jei tokios nėra, naujausią.
    const { data: existingPallet } = await supabase
      .from("pallets")
      .select("id, code, number, destination, notes, created_at")
      .eq("status", "open")
      .eq("destination", destination)
      .order("is_loading", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let currentPallet = existingPallet;

    if (!currentPallet) {
      // Auto-sukurti naują paletę — "open" būsenoje number/code TYČIA lieka
      // null (juos priskiria DB trigeris tik uždarant paletę, žr.
      // formatPalletLabel() aukščiau), tad čia grąžintoje eilutėje jų dar
      // nebus.
      const { data: newPallet, error: createError } = await supabase
        .from("pallets")
        .insert({ status: "open", destination, is_loading: true })
        .select("id, code, number, destination, notes, created_at")
        .single();

      if (createError) {
        setSaving(false);
        setFeedback({ type: "error", message: `Klaida kuriant paletę: ${createError.message}` });
        return false;
      }
      currentPallet = newPallet;
    }

    const palletLabel = formatPalletLabel(currentPallet);

    // Pavadinimas: pasirinktas variantas → ranka įvestas → katalogo (skeneris
    // dažnai įveda + Enter, kol laukas dar neužpildytas — tada tuščias, o
    // pavadinimas yra eilutės raktas žemiau, tad imamas katalogo).
    const nameValue = overrides.nameValue !== undefined ? overrides.nameValue : name;
    const itemName = (nameValue || "").trim() || catalogRow.name?.trim() || null;

    // Ieškoti to paties daikto (IAN + pavadinimas) šioje paletėje — skirtingi
    // to paties IAN variantai (catalog_variants) laikomi atskiromis eilutėmis.
    let existingQuery = supabase
      .from("items")
      .select("id, quantity")
      .eq("ian", trimmedIan)
      .eq("pallet_id", currentPallet.id);
    existingQuery = itemName ? existingQuery.eq("name", itemName) : existingQuery.is("name", null);
    const { data: existing } = await existingQuery.limit(1).maybeSingle();

    let feedbackMsg;
    let hasError = false;

    if (existing) {
      const newQty = existing.quantity + 1;
      const { error } = await supabase
        .from("items")
        .update({ quantity: newQty })
        .eq("id", existing.id);
      if (error) {
        hasError = true;
        feedbackMsg = `Klaida atnaujinant: ${error.message}`;
      } else {
        feedbackMsg = `Užregistruota: ${trimmedIan} (dabar ${newQty} vnt. — ${palletLabel})`;
      }
    } else {
      const { error } = await supabase.from("items").insert({
        ian: trimmedIan,
        name: itemName,
        category: category.trim() || null,
        notes: notes.trim() || null,
        status: "packed",
        pallet_id: currentPallet.id,
        quantity: 1
      });
      if (error) {
        hasError = true;
        feedbackMsg = `Klaida įrašant: ${error.message}`;
      } else {
        feedbackMsg = `Užregistruota: ${trimmedIan} (1 vnt. — ${palletLabel})`;
      }
    }

    if (!hasError && isUnclassified) {
      feedbackMsg += " — trūksta gamintojo/tipo informacijos kataloge, patikrinkite.";
    }

    setSaving(false);

    if (hasError) {
      setFeedback({ type: "error", message: feedbackMsg });
      return false;
    }

    setFeedback({ type: isUnclassified ? "warn" : "ok", message: feedbackMsg });
    loadOpenPallets();
    return true;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    // IAN su keliais daiktais (variantais) neregistruojamas aklai — skeneris
    // įveda + Enter greičiau nei pasiūlymų debounce, todėl tikrinama čia.
    const trimmed = ian.trim();
    if (trimmed) {
      const variants = await fetchVariants((q) => q.eq("ian", trimmed));
      if (variants.length > 1) {
        setIanSuggestions(variants);
        setFeedback({ type: "warn", message: `IAN ${trimmed} žymi ${variants.length} skirtingus daiktus — pasirinkite, kurį registruojate.` });
        inputRef.current?.focus();
        return;
      }
    }
    const success = await registerItem(ian);
    if (success) {
      setIan("");
      setName("");
      setCategory("");
      setNotes("");
    }
    inputRef.current?.focus();
  }

  // Pasirinkus IAN pasiūlymą — registruojama iškart, kaip ir paieškoje pagal
  // pavadinimą; laukai išvalomi kaip po įprasto registravimo.
  async function handleSelectIanSuggestion(result) {
    if (saving) return;
    const success = await registerItem(result.ian, { nameValue: result.name });
    if (success) {
      setIan("");
      setName("");
      setCategory("");
      setNotes("");
      setIanSuggestions([]);
    }
    inputRef.current?.focus();
  }

  // Pasirinkus rezultatą paieškoje pagal pavadinimą — elgiamasi lygiai taip
  // pat, kaip būtų nuskenuotas to įrašo IAN kodas. Po sėkmės išvalomas tik
  // paieškos laukas/rezultatai — režimas paliekamas "name", kad darbuotojas
  // galėtų iš karto registruoti kitą be-IAN įrankį.
  async function handleSelectResult(result) {
    if (saving) return;
    const success = await registerItem(result.ian, { nameValue: result.name });
    if (success) {
      setNameQuery("");
      setNameResults([]);
    }
    nameInputRef.current?.focus();
  }

  // Naujo, kataloge dar neregistruoto įrankio įvedimas rankiniu būdu.
  // 1) ištraukiamas IAN + pavadinimas iš pilno teksto (ta pati regex logika
  //    kaip CatalogImport.jsx), 2) UPSERT į catalog pagal ian (kad ateityje
  //    šis IAN būtų atpažįstamas automatiškai), 3) registruojama TOKIU PAT
  //    būdu, kaip įprastas IAN skenavimas — registerItem savo viduje iš
  //    naujo užklausia catalog, todėl automatiškai pamato ką tik įrašytą
  //    gamintoją/tipą ir teisingai apskaičiuoja paskirtį.
  async function handleManualSubmit() {
    if (saving) return;
    setManualError("");

    const parsed = parseManualEntry(manualText);
    if (!parsed.ian) {
      setManualError("Nepavyko atpažinti IAN kodo, patikrinkite formatą (turi baigtis skaičiumi skliausteliuose).");
      return;
    }
    if (!manualManufacturer || !manualItemType) {
      setManualError("Pasirinkite gamintoją ir tipą.");
      return;
    }

    setSaving(true);
    setFeedback(null);

    const { error: catalogError } = await supabase
      .from("catalog")
      .upsert(
        {
          ian: parsed.ian,
          name: parsed.name,
          manufacturer: manualManufacturer,
          item_type: manualItemType,
          raw_text: manualText.trim()
        },
        { onConflict: "ian" }
      );

    if (catalogError) {
      setSaving(false);
      setManualError(`Klaida įrašant į katalogą: ${catalogError.message}`);
      return;
    }

    // Naujas pavadinimas tampa dar vienu šio IAN variantu (esami lieka).
    if (parsed.name) {
      await supabase
        .from("catalog_variants")
        .upsert({ ian: parsed.ian, name: parsed.name, raw_text: manualText.trim() }, { onConflict: "ian,name", ignoreDuplicates: true });
    }

    const success = await registerItem(parsed.ian, { nameValue: parsed.name });
    if (success) {
      setManualText("");
    }
    manualInputRef.current?.focus();
  }

  // Pasiūlymų sąrašas nerodomas, kai vienintelis pasiūlymas — jau pilnai
  // įvestas IAN su vienu daiktu; rodomas, kai įvestas IAN turi kelis
  // variantus. Kol jis rodomas, "nerasta"/"paskirtis" įspėjimai slepiami
  // (dalinis IAN natūraliai dar nerastas).
  // Paskirtys su keliomis atviromis paletėmis — kur dabar kraunama ("Kraunu čia").
  const loadingTargets = openPallets.filter(
    (p) => p.is_loading && openPallets.some((o) => o.id !== p.id && o.destination === p.destination)
  );

  const typedIan = ian.trim();
  const exactVariantCount = ianSuggestions.filter((r) => r.ian === typedIan).length;
  const showIanSuggestions =
    typedIan !== "" && (exactVariantCount > 1 || ianSuggestions.some((r) => r.ian !== typedIan));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Prietaisų registravimas</h1>
        <p className="mt-1 text-sm text-ink-600/70">
          Nuskenuokite IAN kodą — paskirtis (paletė) nustatoma automatiškai pagal katalogo
          gamintoją ir tipą.
        </p>
      </div>

      {!canScan && (
        <div className="rounded-xl border border-ink-700/10 bg-ink-900/[0.02] px-3.5 py-2.5 text-sm text-ink-600/70">
          Peržiūros režimas — bet kas gali matyti atviras paletes. Norėdami registruoti/redaguoti prietaisus,
          prisijunkite (viršuje) su skenavimo teise.
        </div>
      )}

      {/* Skenerio / paieškos forma */}
      {canScan && (
      <form
        onSubmit={handleSubmit}
        className="rounded-2xl bg-ink-950 p-5 shadow-panel lg:p-6"
      >
        <div className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-signal-orange">
          <ScanLine size={14} strokeWidth={2.5} />
          Skenerio įvestis
        </div>

        {/* Režimo perjungiklis */}
        <div className="mb-3 inline-flex rounded-lg border border-white/10 bg-white/5 p-1 text-xs font-semibold">
          <button
            type="button"
            onClick={() => setMode("ian")}
            className={
              mode === "ian"
                ? "rounded-md bg-white px-3 py-1.5 text-ink-950"
                : "rounded-md px-3 py-1.5 text-white/60 hover:text-white"
            }
          >
            IAN kodas
          </button>
          <button
            type="button"
            onClick={() => setMode("name")}
            className={
              mode === "name"
                ? "rounded-md bg-white px-3 py-1.5 text-ink-950"
                : "rounded-md px-3 py-1.5 text-white/60 hover:text-white"
            }
          >
            Ieškoti pagal pavadinimą
          </button>
          <button
            type="button"
            onClick={() => setMode("manual")}
            className={
              mode === "manual"
                ? "rounded-md bg-white px-3 py-1.5 text-ink-950"
                : "rounded-md px-3 py-1.5 text-white/60 hover:text-white"
            }
          >
            Naujas įrankis
          </button>
        </div>

        {loadingTargets.length > 0 && (
          <p className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/60">
            <span className="flex items-center gap-1 font-semibold text-signal-orange">
              <ArrowDownToLine size={13} /> Kraunama:
            </span>
            {loadingTargets.map((p) => (
              <span key={p.id}>
                {prettifyDestination(p.destination)} → <span className="text-white">{openPalletName(p)}</span>
              </span>
            ))}
          </p>
        )}

        {mode === "ian" ? (
          <>
            <div className="relative">
              <input
                ref={inputRef}
                value={ian}
                onChange={(e) => setIan(e.target.value.replace(/\D/g, ""))}
                placeholder="000000"
                inputMode="numeric"
                autoComplete="off"
                className="w-full rounded-xl border border-white/10 bg-ink-900 px-4 py-4 font-mono text-lg tracking-wider text-white
                  placeholder:text-white/20 outline-none focus:border-signal-orange focus:ring-2 focus:ring-signal-orange/30"
              />
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 font-mono text-xs text-white/20">
                ENTER
              </span>
            </div>

            {showIanSuggestions && exactVariantCount > 1 && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-signal-amber">
                <AlertTriangle size={13} />
                IAN {typedIan} žymi {exactVariantCount} skirtingus daiktus — pasirinkite, kurį registruojate.
              </p>
            )}
            {showIanSuggestions && (
              <div className="mt-2 max-h-72 divide-y divide-white/5 overflow-y-auto rounded-xl border border-white/10 bg-ink-900">
                {ianSuggestions.map((r) => (
                  <button
                    key={`${r.ian}|${r.name}`}
                    type="button"
                    disabled={saving}
                    onClick={() => handleSelectIanSuggestion(r)}
                    className="block w-full px-4 py-3 text-left text-sm text-white hover:bg-white/5 disabled:opacity-50"
                  >
                    <span className="font-mono font-medium">{r.ian}</span>
                    <span className="text-white/50">
                      {" "}— {r.name || "?"} — {r.manufacturer || "?"} — {r.item_type || "?"}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {previewUnclassified && ian.trim() && !showIanSuggestions && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-signal-amber">
                <AlertTriangle size={13} />
                Paskirtis nenustatyta — prietaisas bus priskirtas „Nepriskirta“ paletei
              </p>
            )}
          </>
        ) : mode === "name" ? (
          <div className="relative">
            <input
              ref={nameInputRef}
              value={nameQuery}
              onChange={(e) => setNameQuery(e.target.value)}
              placeholder="Įrankio pavadinimas…"
              autoComplete="off"
              className="w-full rounded-xl border border-white/10 bg-ink-900 px-4 py-4 text-base text-white
                placeholder:text-white/20 outline-none focus:border-signal-orange focus:ring-2 focus:ring-signal-orange/30"
            />
            {searchingName && (
              <Loader2
                size={16}
                className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 animate-spin text-white/30"
              />
            )}

            {nameQuery.trim() && !searchingName && (
              nameResults.length > 0 ? (
                <div className="mt-2 max-h-72 divide-y divide-white/5 overflow-y-auto rounded-xl border border-white/10 bg-ink-900">
                  {nameResults.map((r) => (
                    <button
                      key={r.ian}
                      type="button"
                      disabled={saving}
                      onClick={() => handleSelectResult(r)}
                      className="block w-full px-4 py-3 text-left text-sm text-white hover:bg-white/5 disabled:opacity-50"
                    >
                      <span className="font-medium">{r.name}</span>
                      <span className="text-white/50">
                        {" "}— {r.manufacturer || "?"} — {r.item_type || "?"} — IAN {r.ian}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-signal-amber">
                  <AlertTriangle size={13} />
                  Nerasta — patikrinkite rašybą arba naudokite IAN kodą, jei žinote.
                </p>
              )
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <textarea
                ref={manualInputRef}
                value={manualText}
                onChange={(e) => { setManualText(e.target.value); setManualError(""); }}
                placeholder='Pvz. "BRM Parkside PBRM 39 D3-Service (478255)"'
                rows={2}
                autoComplete="off"
                className="w-full resize-none rounded-xl border border-white/10 bg-ink-900 px-4 py-3 text-sm text-white
                  placeholder:text-white/20 outline-none focus:border-signal-orange focus:ring-2 focus:ring-signal-orange/30"
              />
              <p className="mt-1.5 text-[11px] text-white/30">
                Formatas: „Pavadinimas (IAN kodas)“ — IAN turi būti skaičius skliausteliuose gale.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-semibold text-white/50">Gamintojas</label>
                <select
                  value={manualManufacturer}
                  onChange={(e) => { setManualManufacturer(e.target.value); setManualItemType(""); }}
                  className="input-field bg-white/[0.06] border-white/10 text-white"
                >
                  <option value="" className="bg-ink-900 text-white">— Pasirinkite —</option>
                  {Object.keys(MANUFACTURER_TYPES).map((m) => (
                    <option key={m} value={m} className="bg-ink-900 text-white">{m}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-white/50">Tipas</label>
                <select
                  value={manualItemType}
                  onChange={(e) => setManualItemType(e.target.value)}
                  disabled={!manualManufacturer}
                  className="input-field bg-white/[0.06] border-white/10 text-white disabled:opacity-40"
                >
                  <option value="" className="bg-ink-900 text-white">— Pasirinkite —</option>
                  {(MANUFACTURER_TYPES[manualManufacturer] || []).map((t) => (
                    <option key={t} value={t} className="bg-ink-900 text-white">{t}</option>
                  ))}
                </select>
              </div>
            </div>

            {manualError && (
              <p className="flex items-center gap-1.5 text-xs text-signal-red">
                <AlertCircle size={13} /> {manualError}
              </p>
            )}
          </div>
        )}

        <div className={`mt-4 grid gap-3 ${mode === "ian" ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
          {mode === "ian" && (
            <div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Pavadinimas (nebūtina)"
                className="input-field bg-white/[0.06] border-white/10 text-white placeholder:text-white/30"
              />
              {catalogNotFound && !showIanSuggestions && (
                <p className="mt-1.5 text-xs text-signal-red">
                  Nerasta kataloge — registruoti negalima. Naudokite skirtuką „Naujas įrankis“.
                </p>
              )}
            </div>
          )}
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="Kategorija (nebūtina)"
            className="input-field bg-white/[0.06] border-white/10 text-white placeholder:text-white/30"
          />
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Pastaba (nebūtina)"
            className="input-field bg-white/[0.06] border-white/10 text-white placeholder:text-white/30"
          />
        </div>

        <div className="mt-4 flex items-center gap-3">
          {mode === "ian" && (
            <button type="submit" disabled={saving || !ian.trim() || catalogNotFound} className="btn-primary">
              {saving ? <Loader2 size={16} className="animate-spin" /> : <ScanLine size={16} />}
              Registruoti
            </button>
          )}
          {mode === "manual" && (
            <button
              type="button"
              onClick={handleManualSubmit}
              disabled={saving || !manualText.trim() || !manualManufacturer || !manualItemType}
              className="btn-primary"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
              Pridėti
            </button>
          )}
          {feedback && (
            <span
              className={`flex items-center gap-1.5 text-sm font-medium ${
                feedback.type === "ok"
                  ? "text-signal-teal"
                  : feedback.type === "warn"
                    ? "text-signal-amber"
                    : "text-signal-red"
              }`}
            >
              {feedback.type === "ok"
                ? <CheckCircle2 size={16} />
                : feedback.type === "warn"
                  ? <AlertTriangle size={16} />
                  : <AlertCircle size={16} />}
              {feedback.message}
            </span>
          )}
        </div>
      </form>
      )}

      {/* Dabartinės atviros paletės */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink-800">Dabartinės atviros paletės</h2>
          {canScan && !newPalletOpen && (
            <button type="button" onClick={() => setNewPalletOpen(true)} className="btn-secondary">
              <Plus size={14} /> Formuoti naują paletę
            </button>
          )}
        </div>

        {canScan && newPalletOpen && (
          <div className="panel space-y-3 p-3.5">
            <p className="text-sm font-semibold text-ink-900">Nauja paletė</p>
            <p className="text-xs text-ink-600/60">
              Nuskenuoti šios paskirties prietaisai bus dedami į naują paletę. Kitą tos paskirties paletę
              galėsite vėl pažymėti „Krauti čia“. Numeris suteikiamas tik išvežant.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-ink-600/70">Gamintojas</label>
                <select
                  value={newPalletManufacturer}
                  onChange={(e) => { setNewPalletManufacturer(e.target.value); setNewPalletType(""); setNewPalletError(""); }}
                  className="input-field"
                >
                  <option value="">— Pasirinkite —</option>
                  {Object.keys(MANUFACTURER_TYPES).map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-ink-600/70">Tipas</label>
                <select
                  value={newPalletType}
                  onChange={(e) => { setNewPalletType(e.target.value); setNewPalletError(""); }}
                  disabled={!newPalletManufacturer}
                  className="input-field disabled:opacity-40"
                >
                  <option value="">— Pasirinkite —</option>
                  {(MANUFACTURER_TYPES[newPalletManufacturer] || []).map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-ink-600/70">Pastaba (atskirti paletes)</label>
                <input
                  value={newPalletNotes}
                  onChange={(e) => setNewPalletNotes(e.target.value)}
                  placeholder="pvz. Dideli"
                  className="input-field"
                />
              </div>
            </div>
            {newPalletError && (
              <p className="flex items-center gap-1.5 text-xs text-signal-red">
                <AlertCircle size={13} /> {newPalletError}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleCreatePallet}
                disabled={creatingPallet || !newPalletManufacturer || !newPalletType}
                className="btn-primary"
              >
                {creatingPallet ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                Sukurti paletę
              </button>
              <button
                type="button"
                onClick={() => { setNewPalletOpen(false); setNewPalletError(""); }}
                className="btn-secondary"
              >
                Atšaukti
              </button>
            </div>
          </div>
        )}

        {loadingPallets ? (
          <div className="panel flex items-center justify-center p-4">
            <Loader2 className="animate-spin text-ink-600/40" size={18} />
          </div>
        ) : openPallets.length === 0 ? (
          <div className="panel p-4 text-sm text-ink-600/50">
            Paletė bus sukurta automatiškai su pirmu skenavimu.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {openPallets.map((p) => {
              const expanded = expandedIds.has(p.id);
              const palletItems = itemsByPallet[p.id] || [];
              // Kelios tos pačios paskirties atviros paletės — rodomas jų
              // atskyrimas (pastaba/laikas) ir "Kraunu čia" pasirinkimas.
              const sameDestination = openPallets.filter((o) => o.destination === p.destination).length > 1;
              return (
                <div
                  key={p.id}
                  className={`panel space-y-3 p-3.5 ${sameDestination && p.is_loading ? "ring-2 ring-signal-orange/60" : ""}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-ink-900">
                        {prettifyDestination(p.destination)}
                        {sameDestination && (
                          <span className="font-medium text-ink-600/70"> · {openPalletName(p)}</span>
                        )}
                      </p>
                      <p className="text-xs text-ink-600/60">
                        {sameDestination && !p.is_loading ? "Laukia išvežimo" : "Pildoma"} &middot; {p.qty} vnt.
                      </p>
                    </div>
                    {canScan && (
                    <div className="flex shrink-0 flex-col items-stretch gap-1.5 sm:flex-row sm:items-center">
                      {sameDestination && (
                        p.is_loading ? (
                          <span className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-signal-orange px-3 py-2 text-xs font-semibold text-white">
                            <ArrowDownToLine size={14} /> Kraunu čia
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleSetLoading(p)}
                            disabled={settingLoadingId === p.id}
                            className="btn-secondary"
                          >
                            {settingLoadingId === p.id
                              ? <Loader2 size={14} className="animate-spin" />
                              : <ArrowDownToLine size={14} />}
                            Krauti čia
                          </button>
                        )
                      )}
                      <button
                        onClick={() => handleClose(p)}
                        disabled={closingId === p.id}
                        className="btn-secondary"
                      >
                        {closingId === p.id
                          ? <Loader2 size={14} className="animate-spin" />
                          : <PackageCheck size={14} />}
                        Išvežta
                      </button>
                      {p.qty === 0 && (
                        <button
                          onClick={() => handleDeletePallet(p)}
                          disabled={deletingPalletId === p.id}
                          className="btn-secondary text-signal-red hover:bg-signal-red/10"
                        >
                          {deletingPalletId === p.id
                            ? <Loader2 size={14} className="animate-spin" />
                            : <Trash2 size={14} />}
                          Ištrinti paletę
                        </button>
                      )}
                    </div>
                    )}
                  </div>

                  {canScan && (
                  <div className="flex items-center gap-2">
                    <input
                      value={palletNotesDrafts[p.id] ?? ""}
                      onChange={(e) =>
                        setPalletNotesDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))
                      }
                      placeholder="Pastaba apie paletę (nebūtina)"
                      className="input-field flex-1 py-2 text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => handleSavePalletNotes(p.id)}
                      disabled={
                        savingPalletNotesId === p.id ||
                        (palletNotesDrafts[p.id] ?? "") === (p.notes || "")
                      }
                      className="btn-secondary shrink-0 px-2.5 py-2"
                      aria-label="Išsaugoti pastabą"
                    >
                      {savingPalletNotesId === p.id
                        ? <Loader2 size={14} className="animate-spin" />
                        : <Save size={14} />}
                    </button>
                  </div>
                  )}

                  <button
                    type="button"
                    onClick={() => toggleExpand(p.id)}
                    className="flex items-center gap-1.5 text-xs font-medium text-ink-600/70 hover:text-ink-900"
                  >
                    {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    Peržiūrėti turinį
                  </button>

                  {expanded && (
                    <div className="overflow-hidden rounded-xl border border-ink-700/10">
                      {palletItems.length === 0 ? (
                        <p className="p-3 text-center text-xs text-ink-600/50">Prietaisų dar nepridėta.</p>
                      ) : (
                        <div className="divide-y divide-ink-900/5">
                          {palletItems.map((item) => (
                            <div key={item.id} className="flex items-center justify-between gap-2 p-2.5">
                              <div className="min-w-0">
                                <p className="truncate font-mono text-xs font-medium text-ink-900">{item.ian}</p>
                                {item.name && (
                                  <p className="truncate text-xs text-ink-600/60">{item.name}</p>
                                )}
                                <p className="text-[10px] text-ink-600/40">{formatDateTime(item.created_at)}</p>
                              </div>
                              <div className="flex shrink-0 items-center gap-1.5">
                                <span className="text-xs font-medium text-ink-600/50">{item.quantity || 1} vnt.</span>
                                {canScan && (
                                  <>
                                    <button
                                      onClick={() => setEditingItem(item)}
                                      className="rounded-lg p-1.5 text-ink-600/60 hover:bg-ink-900/5 hover:text-ink-900"
                                      aria-label="Redaguoti"
                                    >
                                      <Pencil size={14} />
                                    </button>
                                    <button
                                      onClick={() => handleDeleteItem(item)}
                                      disabled={deletingId === item.id}
                                      className="rounded-lg p-1.5 text-ink-600/60 hover:bg-signal-red/10 hover:text-signal-red"
                                      aria-label="Trinti"
                                    >
                                      {deletingId === item.id
                                        ? <Loader2 size={14} className="animate-spin" />
                                        : <Trash2 size={14} />}
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {closeMsg && (
          <p className="flex items-center gap-1.5 text-xs font-medium text-signal-teal">
            <CheckCircle2 size={13} /> {closeMsg}
          </p>
        )}
      </div>

      {editingItem && (
        <EditItemModal
          item={editingItem}
          onClose={() => setEditingItem(null)}
          onSave={handleSaveItem}
        />
      )}
    </div>
  );
}

// Supaprastinta redagavimo modalo versija paletės turiniui skenavimo puslapyje —
// tik ian/name/quantity/notes, nes status ir pallet_id čia nekintami (įrašas
// jau žinomai priklauso šiai paletei ir yra 'packed' būsenos).
function EditItemModal({ item, onClose, onSave }) {
  const [form, setForm] = useState({
    ian: item.ian || "",
    name: item.name || "",
    quantity: item.quantity ?? 1,
    notes: item.notes || ""
  });
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    await onSave(item.id, form);
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink-950/50 p-0 sm:items-center sm:p-4">
      <form
        onSubmit={submit}
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-panel sm:rounded-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-ink-900">Redaguoti įrašą</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-ink-900/5">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">IAN kodas</label>
            <input
              value={form.ian}
              onChange={(e) => setForm({ ...form, ian: e.target.value.replace(/\D/g, "") })}
              inputMode="numeric"
              className="input-field font-mono"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Pavadinimas</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="input-field"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Kiekis</label>
            <input
              type="number"
              min={1}
              value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              className="input-field"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Pastaba</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={2}
              className="input-field resize-none"
            />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Atšaukti
          </button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving && <Loader2 size={15} className="animate-spin" />}
            Išsaugoti
          </button>
        </div>
      </form>
    </div>
  );
}
