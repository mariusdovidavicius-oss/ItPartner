// pdfjs-dist (ir jo worker'is) importuojami TIK iškvietus šio failo
// funkciją (dinaminis import), o ne visada su pagrindiniu bundle'u — tai
// vienintelis puslapis visame projekte, kuriam jo reikia, o pati
// biblioteka nemaža (~1.5 MB su worker'iu).
let pdfjsLibPromise;
function loadPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url")
    ]).then(([pdfjsLib, { default: workerUrl }]) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjsLib;
    });
  }
  return pdfjsLibPromise;
}

// Vidinės sistemos "Internal transfer" PDF eilutės formatas:
// "<Nr.> <Pavadinimas>(<IAN>) <Kiekis>,<dešimtainė dalis> <Vnt>"
// IAN kartais skliausteliuose ("...oAL (508282)"), kartais be jų
// ("...PAPP 208 A1 80001185") — pastarojo atveju IAN tiesiog paskutinis
// skaičius eilutėje. Pavadinime pasitaikantys skaičiai (modelio numeriai,
// pvz. "12 D3", "208 A1", "40-Li") visada TRUMPESNI nei 4 skaitmenys, tad
// "bent 4 skaitmenys" patikimai atskiria juos nuo IAN kodo (6-8 skaitmenys
// šiame dokumente).
const ROW_PATTERN = /^\d+\s+(.+?)\s*\(?(\d{4,})\)?\s+(\d+,\d+)\s+\S+\s*$/;

// PDF.js grąžina teksto fragmentus (ne visas eilutes iš karto) su x/y
// koordinatėmis — sugrupuojame į eilutes pagal Y (suapvalinta iki sveiko
// pikselio, kad smulkūs šrifto bazinės linijos skirtumai tos pačios
// eilutės viduje nesukurtų atskirų "eilučių"), tada surikiuojame pagal X,
// kad žodžiai eitų teisinga tvarka iš kairės į dešinę.
function groupIntoLines(items) {
  const lines = new Map();
  items.forEach((item) => {
    const y = Math.round(item.transform[5]);
    const x = item.transform[4];
    if (!item.str.trim()) return;
    if (!lines.has(y)) lines.set(y, []);
    lines.get(y).push({ x, str: item.str });
  });
  return [...lines.entries()]
    .sort((a, b) => b[0] - a[0]) // PDF Y ašis auga aukštyn — viršus pirmas
    .map(([, parts]) =>
      parts
        .sort((a, b) => a.x - b.x)
        .map((p) => p.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    );
}

// Grąžina [{ name, ian, quantity }, ...] eilutes, rastas PDF faile.
// Nieko neišmeta klaidos, jei eilučių nerandama — tuščias masyvas, sprendimą
// ką daryti (pvz. rodyti klaidą vartotojui) palieka kviečiančiam kodui.
export async function readTransferPdfRows(file) {
  const pdfjsLib = await loadPdfjs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const rows = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const lines = groupIntoLines(content.items);
    lines.forEach((line) => {
      const match = line.match(ROW_PATTERN);
      if (!match) return;
      const [, name, ian, qtyRaw] = match;
      const quantity = Math.round(Number(qtyRaw.replace(",", ".")));
      if (!quantity || quantity <= 0) return;
      rows.push({ name: name.trim(), ian: ian.trim(), quantity });
    });
  }

  return rows;
}
