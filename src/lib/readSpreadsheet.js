import ExcelJS from "exceljs";

// Nedidelis, priklausomybių neturintis CSV parseris — palaiko kabutėse
// esančius kablelius/eilutes bei escapintas dvigubas kabutes (""). Naudojamas
// vietoj atskiros CSV bibliotekos, kad nereikėtų papildomos priklausomybės
// vien CSV skaitymui.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (char === "\r") {
      i++;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += char;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function padRows(rows) {
  const maxCols = rows.reduce((max, r) => Math.max(max, r.length), 0);
  return rows.map((r) => Array.from({ length: maxCols }, (_, i) => r[i] ?? ""));
}

// Excel (.xlsx) arba CSV failas -> masyvas eilučių (kiekviena eilutė —
// masyvas TEKSTO reikšmių pagal stulpelio indeksą, visos eilutės tolygiai
// užpildytos iki bendro stulpelių skaičiaus). Naudojama /priedai/importas ir
// /katalogas importo puslapiuose vietoj anksčiau naudotos "xlsx" bibliotekos
// (senas .xls binarinis formatas nebepalaikomas — tik .xlsx ir .csv).
export async function readSpreadsheetRows(file) {
  if (/\.csv$/i.test(file.name)) {
    const text = await file.text();
    const rows = parseCsv(text).filter((r) => !(r.length === 1 && r[0] === ""));
    return padRows(rows);
  }

  const buffer = await file.arrayBuffer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const rows = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const values = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      values.push(cell.text ?? "");
    });
    rows.push(values);
  });

  return padRows(rows);
}
