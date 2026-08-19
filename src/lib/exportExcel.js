import ExcelJS from "exceljs";
import { supabase } from "./supabaseClient";
import { UNCLASSIFIED } from "./destination";

function palletLabel(p) {
  return p.number ? `${p.number} paletė` : p.code;
}

function formatDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("lt-LT");
}

// Bendra Excel generavimo funkcija — naudojama tiek pažymėtoms paletėms
// /paletes puslapyje, tiek siuntos turinio atsisiuntimui (istorijoje ir
// siuntos peržiūros puslapyje). Saugikliui: atsisako generuoti, jei sąraše
// sumaišytos abi paskirtys, kad vadybininkei nesusimaišytų sandėliai viename
// faile.
//
// Kiekviena paletė gauna SAVO atskirą lentelę TAME PAČIAME lape (tarpas
// tarp jų): A1 = "<paletė> (<supakavimo data>)", A2/B2 = stulpelių antraštės
// "Pavadinimas"/"Kiekis". Pavadinimo stulpelyje IAN kodas pridedamas
// tiesiogiai prie pavadinimo — "<pavadinimas>(<IAN>)" — todėl atskiro IAN
// stulpelio nebėra, ir kiekvienas įrašas (ne pagal pavadinimą sugrupuotas)
// rodomas savo eilutėje.
//
// Grąžina { ok: true } arba { ok: false, message }.
export async function exportPalletsToExcel(palletList, filename) {
  const destinationsInList = new Set(palletList.map((p) => p.destination || UNCLASSIFIED));
  if (destinationsInList.size > 1) {
    return { ok: false, message: "Klaida: negalima generuoti Excel su paletėmis iš skirtingų paskirčių vienu metu." };
  }

  const sorted = [...palletList].sort((a, b) => (a.number || 0) - (b.number || 0));
  const palletIds = sorted.map((p) => p.id);
  let itemsData = [];
  if (palletIds.length > 0) {
    const { data } = await supabase
      .from("items")
      .select("pallet_id, ian, name, quantity")
      .in("pallet_id", palletIds)
      .order("created_at", { ascending: true });
    itemsData = data || [];
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Paletės");
  sheet.columns = [{ width: 60 }, { width: 10 }];

  const thin = { style: "thin" };
  const fullBorder = { top: thin, left: thin, bottom: thin, right: thin };

  sorted.forEach((p, index) => {
    if (index > 0) sheet.addRow([]); // tuščia eilutė tarp palečių lentelių

    const headerRow = sheet.addRow([`${palletLabel(p)} (${formatDate(p.packed_at)})`]);
    sheet.mergeCells(headerRow.number, 1, headerRow.number, 2);
    headerRow.getCell(1).font = { bold: true };
    headerRow.getCell(1).border = fullBorder;
    headerRow.getCell(2).border = fullBorder;

    const colHeaderRow = sheet.addRow(["Pavadinimas", "Kiekis"]);
    colHeaderRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { bold: true };
      cell.border = fullBorder;
    });

    const palletItems = itemsData.filter((i) => i.pallet_id === p.id);
    const dataRows = palletItems.length === 0
      ? [["(tuščia paletė)", 0]]
      : palletItems.map((item) => [`${item.name || "(be pavadinimo)"}(${item.ian})`, item.quantity || 1]);

    dataRows.forEach((r) => {
      const row = sheet.addRow(r);
      row.getCell(1).border = fullBorder;
      row.getCell(2).border = fullBorder;
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return { ok: true };
}

// Priedų (parts) sąrašo eksportas — viena plokščia lentelė, naudojama
// /priedai puslapyje (eksportuoja tuo metu matomą, t.y. paieškos filtrą
// atitinkantį, sąrašą).
export async function exportPartsToExcel(partsList, filename) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Priedai");
  sheet.columns = [
    { width: 10 }, { width: 22 }, { width: 28 }, { width: 16 },
    { width: 10 }, { width: 12 }, { width: 40 }
  ];

  const thin = { style: "thin" };
  const fullBorder = { top: thin, left: thin, bottom: thin, right: thin };

  const headerRow = sheet.addRow([
    "Lokacija", "Pagrindinis modelis", "Pavadinimas", "Detalės kodas",
    "Kiekis", "El. p-vė", "Suderinami modeliai"
  ]);
  headerRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { bold: true };
    cell.border = fullBorder;
  });

  const sorted = [...partsList].sort((a, b) => (a.location || 0) - (b.location || 0));
  sorted.forEach((p) => {
    const row = sheet.addRow([
      p.location ?? "",
      p.main_model || "",
      p.name || "",
      p.part_code || "",
      p.quantity ?? 0,
      p.online_store ? "Taip" : "Ne",
      p.compatible_models || ""
    ]);
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = fullBorder;
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return { ok: true };
}

// Prietaisų (devices) sąrašo eksportas — kiekvienas prietaisas gali turėti
// kelias lokacijas (device_stock), todėl kiekviena lokacija eksportuojama
// SAVO eilute (tas pats formatas, koks yra originaliame Excel šaltinyje).
// Prietaisas be jokio likučio įrašo eksportuojamas su tuščia lokacija/0 kiekiu.
// Komentaras priklauso VISAM prietaisui (devices.notes), todėl kartojasi
// kiekvienoje jo lokacijos eilutėje.
export async function exportDevicesToExcel(devicesList, filename) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Prietaisai");
  sheet.columns = [
    { width: 40 }, { width: 16 }, { width: 10 }, { width: 14 }, { width: 30 }, { width: 14 }
  ];

  const thin = { style: "thin" };
  const fullBorder = { top: thin, left: thin, bottom: thin, right: thin };

  const headerRow = sheet.addRow(["Prietaisas", "IAN", "Kiekis", "Lokacija", "Komentaras", "Gamintojas"]);
  headerRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { bold: true };
    cell.border = fullBorder;
  });

  devicesList.forEach((d) => {
    const stock = d.device_stock && d.device_stock.length > 0 ? d.device_stock : [null];
    stock.forEach((s) => {
      const row = sheet.addRow([
        d.name || "",
        d.ian || "",
        s?.quantity ?? 0,
        s?.location || "",
        d.notes || "",
        d.manufacturer || ""
      ]);
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.border = fullBorder;
      });
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return { ok: true };
}

const WRITEOFF_REASON_LABELS = { parduota: "Parduota", remontui: "Panaudota remontui", garantija: "Garantinis pakeitimas", kita: "Kita" };

// Priedų nurašymų (parts_writeoffs) sąrašo eksportas — naudojama
// /priedai/nurasymai puslapyje.
export async function exportPartsWriteoffsToExcel(writeoffsList, filename) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Nurašymai");
  sheet.columns = [
    { width: 14 }, { width: 28 }, { width: 16 }, { width: 8 },
    { width: 18 }, { width: 24 }, { width: 16 }, { width: 12 }
  ];

  const thin = { style: "thin" };
  const fullBorder = { top: thin, left: thin, bottom: thin, right: thin };

  const headerRow = sheet.addRow([
    "Data", "Priedas", "Detalės kodas", "Kiekis", "Priežastis", "Detalė", "Kas", "Būsena"
  ]);
  headerRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { bold: true };
    cell.border = fullBorder;
  });

  writeoffsList.forEach((w) => {
    const detail =
      w.reason_type === "parduota" ? (w.price != null ? `${w.price} €` : "") :
      w.reason_type === "remontui" ? (w.rma || "") :
      (w.reason || "");
    const row = sheet.addRow([
      formatDate(w.created_at),
      w.parts?.name || "",
      w.parts?.part_code || "",
      w.quantity ?? 0,
      WRITEOFF_REASON_LABELS[w.reason_type] || w.reason_type,
      detail,
      w.profiles?.username || "",
      w.undone_at ? "Atšaukta" : "Aktyvus"
    ]);
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = fullBorder;
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return { ok: true };
}

// Prietaisų nurašymų (device_writeoffs) sąrašo eksportas — naudojama
// /prietaisai/nurasymai puslapyje. Skirtingai nuo priedų nurašymų, čia yra
// papildomas "Lokacija" stulpelis, nes prietaiso kiekis yra per lokaciją.
export async function exportDeviceWriteoffsToExcel(writeoffsList, filename) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Nurašymai");
  sheet.columns = [
    { width: 14 }, { width: 28 }, { width: 16 }, { width: 14 }, { width: 8 },
    { width: 18 }, { width: 24 }, { width: 16 }, { width: 12 }
  ];

  const thin = { style: "thin" };
  const fullBorder = { top: thin, left: thin, bottom: thin, right: thin };

  const headerRow = sheet.addRow([
    "Data", "Prietaisas", "IAN", "Lokacija", "Kiekis", "Priežastis", "Detalė", "Kas", "Būsena"
  ]);
  headerRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { bold: true };
    cell.border = fullBorder;
  });

  writeoffsList.forEach((w) => {
    const detail =
      w.reason_type === "parduota" ? (w.price != null ? `${w.price} €` : "") :
      w.reason_type === "remontui" ? (w.rma || "") :
      (w.reason || "");
    const row = sheet.addRow([
      formatDate(w.created_at),
      w.device_name || "",
      w.device_ian || "",
      w.location || "",
      w.quantity ?? 0,
      WRITEOFF_REASON_LABELS[w.reason_type] || w.reason_type,
      detail,
      w.profiles?.username || "",
      w.undone_at ? "Atšaukta" : "Aktyvus"
    ]);
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = fullBorder;
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return { ok: true };
}
