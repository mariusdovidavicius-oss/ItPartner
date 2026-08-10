import { splitDestination } from "./destination";

function labelData(pallet) {
  const { manufacturer } = splitDestination(pallet.destination);
  const dateStr = pallet.packed_at
    ? new Date(pallet.packed_at).toLocaleDateString("lt-LT")
    : new Date().toLocaleDateString("lt-LT");
  return { manufacturer, number: pallet.number ?? "—", dateStr };
}

function openPrintWindow(title, styleCss, bodyHtml) {
  const win = window.open("", "_blank", "width=800,height=1000");
  if (!win) return;

  win.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>${styleCss}</style>
</head>
<body>
${bodyHtml}
<script>window.onload = function () { window.print(); };</script>
</body>
</html>`);
  win.document.close();
}

// Atidaro naują langą su VIENOS paletės etikete visame A4 lape ir iškart
// iškviečia spausdinimo dialogą. Naudojama uždarius paletę mygtuku "Išvežta"
// (ScanEntry), tiek spausdinant pakartotinai po vieną iš /paletes sąrašo.
export function printPalletLabel(pallet) {
  const { manufacturer, number, dateStr } = labelData(pallet);
  const style = `
    @page { size: A4; margin: 20mm; }
    body { font-family: Arial, sans-serif; margin: 0; }
    .label { box-sizing: border-box; height: 100%; border: 4px solid #000; border-radius: 16px;
      padding: 48px; display: flex; flex-direction: column; align-items: center; justify-content: center;
      text-align: center; }
    .manufacturer { font-size: 56px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; }
    .number-label { margin-top: 40px; font-size: 22px; text-transform: uppercase; letter-spacing: 3px; color: #555; }
    .number { font-size: 160px; font-weight: 900; line-height: 1; }
    .date { margin-top: 40px; font-size: 30px; }
  `;
  const body = `
    <div class="label">
      <div class="manufacturer">${manufacturer}</div>
      <div class="number-label">Paletė Nr.</div>
      <div class="number">${number}</div>
      <div class="date">Uždaryta: ${dateStr}</div>
    </div>
  `;
  openPrintWindow("Paletės etiketė", style, body);
}

// Atidaro naują langą su KELIŲ paletžų etiketėmis, sudėliotomis tinkleliu
// (2 stulpeliai) ant kiek reikia A4 lapų — tiek etikečių viename lape, kiek
// telpa. Kiekviena etiketė turi punktyrinį rėmelį kirpimui. Vienos paletės
// atveju naudojama pilno lapo versija (printPalletLabel).
export function printPalletLabels(pallets) {
  if (!pallets || pallets.length === 0) return;
  if (pallets.length === 1) {
    printPalletLabel(pallets[0]);
    return;
  }

  const style = `
    @page { size: A4; margin: 8mm; }
    body { font-family: Arial, sans-serif; margin: 0; }
    .sheet { display: flex; flex-wrap: wrap; gap: 4mm; }
    .label { box-sizing: border-box; width: calc(50% - 2mm); height: 65mm; border: 2px dashed #999;
      border-radius: 10px; padding: 6mm; display: flex; flex-direction: column; align-items: center;
      justify-content: center; text-align: center; break-inside: avoid; page-break-inside: avoid; }
    .manufacturer { font-size: 22px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; }
    .number-label { margin-top: 8px; font-size: 10px; text-transform: uppercase; letter-spacing: 2px; color: #555; }
    .number { font-size: 54px; font-weight: 900; line-height: 1; }
    .date { margin-top: 8px; font-size: 12px; }
  `;
  const body = `
    <div class="sheet">
      ${pallets
        .map((p) => {
          const { manufacturer, number, dateStr } = labelData(p);
          return `
            <div class="label">
              <div class="manufacturer">${manufacturer}</div>
              <div class="number-label">Paletė Nr.</div>
              <div class="number">${number}</div>
              <div class="date">Uždaryta: ${dateStr}</div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
  openPrintWindow("Palečių etiketės", style, body);
}
