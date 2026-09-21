// Supabase/PostgREST vienu atsakymu grąžina ne daugiau kaip max_rows (pagal
// numatymą 1000) eilučių — net jei .range() prašo daugiau, atsakymas tyliai
// sutrumpinamas. Sumoms (kurioms reikia VISŲ atitinkančių eilučių) todėl
// užklausa kartojama po puslapį, kol gaunama mažiau nei pilnas puslapis.
//
// "makeQuery" turi kiekvieną kartą grąžinti NAUJĄ užklausos objektą (supabase
// builder'is po await vėl naudoti negalima).
export async function fetchAllRows(makeQuery, { pageSize = 1000, maxPages = 50 } = {}) {
  const rows = [];
  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}
