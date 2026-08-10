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
