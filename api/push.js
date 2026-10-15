import webpush from "web-push";
import { adminClient } from "../src/lib/adminAuth.js";

// Vercel serverless funkcija — Web Push pranešimai.
//   { taskId } — praneša tam, kam darbas priskirtas (kviečia darbo kūrėjas
//                iškart po įrašymo, pvz. "Paruošti išsiuntimui").
//   { test: true } — bandomasis pranešimas paties kviečiančiojo įrenginiams.
// Kviečiantis turi būti prisijungęs (tikrinama pagal jo access token'ą).
// VAPID_SUBJECT nebūtinas — numatytasis yra svetainės adresas.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const publicKey = process.env.VITE_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    res.status(500).json({ error: "Nesukonfigūruoti VAPID raktai (VITE_VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)." });
    return;
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || `https://${req.headers.host}`, publicKey, privateKey);

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) {
    res.status(401).json({ error: "Trūksta prisijungimo žymens." });
    return;
  }

  const supabaseAdmin = adminClient();
  const { data: callerData, error: callerError } = await supabaseAdmin.auth.getUser(token);
  if (callerError || !callerData?.user) {
    res.status(401).json({ error: "Neteisingas arba pasibaigęs prisijungimas." });
    return;
  }
  const callerId = callerData.user.id;

  const { taskId, test } = req.body || {};
  let recipientId;
  let payload;

  if (test) {
    recipientId = callerId;
    payload = { title: "Pranešimai veikia ✓", body: "Taip atrodys pranešimas apie naują darbą.", url: "/darbai", tag: "test" };
  } else {
    if (!taskId) {
      res.status(400).json({ error: "Trūksta taskId." });
      return;
    }
    const { data: task } = await supabaseAdmin
      .from("tasks")
      .select("id, title, note, created_by, assigned_to, quantity, order_ref, part:parts(name, part_code)")
      .eq("id", taskId)
      .maybeSingle();
    // Pranešti gali tik pats darbo kūrėjas — kitaip bet kas galėtų siuntinėti pranešimus.
    if (!task || task.created_by !== callerId) {
      res.status(404).json({ error: "Darbas nerastas." });
      return;
    }
    if (!task.assigned_to || task.assigned_to === callerId) {
      res.status(200).json({ sent: 0 });
      return;
    }
    recipientId = task.assigned_to;

    const { data: creator } = await supabaseAdmin.from("profiles").select("username").eq("id", callerId).maybeSingle();
    const ship = !!task.part || task.quantity != null;
    const details = ship
      ? [
          `${task.part?.name || task.part?.part_code || "Priedas"} — ${task.quantity ?? 1} vnt.`,
          task.order_ref && `užs. ${task.order_ref}`
        ].filter(Boolean).join(" · ")
      : task.title;
    payload = {
      title: ship ? "📦 Naujas išsiuntimas" : "Naujas darbas",
      body: [details, task.note, creator?.username && `Nuo: ${creator.username}`].filter(Boolean).join("\n"),
      url: "/darbai",
      tag: `task-${task.id}`
    };
  }

  const { data: subs } = await supabaseAdmin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", recipientId);

  let sent = 0;
  const expired = [];
  await Promise.all(
    (subs || []).map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          { TTL: 24 * 3600, urgency: "high" }
        );
        sent += 1;
      } catch (err) {
        // 404/410 — naršyklė prenumeratą atšaukė (išvalyti duomenys, kitas įrenginys ir pan.).
        if (err.statusCode === 404 || err.statusCode === 410) expired.push(s.id);
        else console.error("push failed", err.statusCode, err.body);
      }
    })
  );
  if (expired.length) await supabaseAdmin.from("push_subscriptions").delete().in("id", expired);

  res.status(200).json({ sent, subscriptions: (subs || []).length });
}
