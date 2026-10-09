// Priedo tapatybė — turi atitikti DB funkciją public.part_ident()
// (migrate_parts_split_stock.sql): priedas su numeriu atpažįstamas pagal
// kodą, be numerio ("N/A", tuščias, "-") — pagal pavadinimą + pagrindinį
// modelį (N/A priedai su skirtingais pavadinimais — skirtingi daiktai).
// null — nei numerio, nei pavadinimo (niekada nejungiamas su kitu).
const NO_CODE = new Set(["", "n/a", "na", "-"]);

export function hasPartCode(code) {
  return !NO_CODE.has(String(code ?? "").trim().toLowerCase());
}

export function partIdent(code, name, model) {
  if (hasPartCode(code)) return `c:${String(code).trim().toLowerCase()}`;
  const n = String(name ?? "").trim().toLowerCase();
  if (!n) return null;
  return `n:${n}|${String(model ?? "").trim().toLowerCase()}`;
}
