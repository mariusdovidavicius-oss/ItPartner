// Eilutė virš nurašymų lentelės: bendra suma pagal AKTUALIUS filtrus (paieška,
// priežastis, laikotarpis), ne tik pagal rodomą puslapį. Suma sutampa su
// /statistika plytele, nes abi skaičiuoja tik aktyvius (neatšauktus) nurašymus.
export default function WriteoffSummary({ summary }) {
  if (!summary || summary.count === 0) return null;
  return (
    <p className="text-sm text-ink-600/80">
      <span className="font-semibold text-ink-900">Iš viso: {summary.qty} vnt.</span>
      {summary.soldCount > 0 && (
        <>
          {" · "}Parduota už{" "}
          <span className="font-semibold text-ink-900">{summary.revenue.toFixed(2)} €</span>
        </>
      )}
      <span className="text-ink-600/50"> (atšaukti nurašymai neįskaičiuoti)</span>
    </p>
  );
}
