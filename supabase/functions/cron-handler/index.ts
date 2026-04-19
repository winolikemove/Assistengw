import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "santuybot-cron";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

/**
 * Cron Handler — Dipanggil oleh pg_cron setiap menit.
 * Fungsi:
 * 1. Kirim reminder agenda yang udah waktunya (atau 15 menit sebelum)
 * 2. Proses outgoing message queue
 */

async function sendTelegramMessage(chatId: number | string, text: string, parseMode = "HTML", disableNotification = false) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_notification: disableNotification,
    }),
  });
  const result = await res.json();
  if (!result.ok) {
    console.error(`[TG] Send failed to ${chatId}:`, JSON.stringify(result));
  }
  return result;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(isoStr: string): string {
  const d = new Date(isoStr);
  return d.toLocaleString('id-ID', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function processReminders() {
  const now = new Date();

  // ── 1. EARLY REMINDER: 15 menit sebelum waktu agenda ──
  const fifteenMinLater = new Date(now.getTime() + 15 * 60 * 1000);
  const { data: earlyReminders, error: err1 } = await supabase
    .from("agendas")
    .select("id, user_id, title, scheduled_time")
    .eq("is_completed", false)
    .eq("is_reminded", false)
    .gte("scheduled_time", now.toISOString())
    .lte("scheduled_time", fifteenMinLater.toISOString());

  if (!err1 && earlyReminders && earlyReminders.length > 0) {
    console.log(`[CRON] ${earlyReminders.length} early reminders (15 min before)`);
    for (const r of earlyReminders) {
      try {
        const timeStr = formatTime(r.scheduled_time);
        await sendTelegramMessage(
          r.user_id,
          `🔔 <b>Reminder — 15 menit lagi!</b>\n\n` +
          `📋 <b>${escapeHtml(r.title)}</b>\n` +
          `⏰ ${timeStr}\n\n` +
          `Bentar lagi nih bro, siap-siap! 💪`,
          "HTML",
          false, // enable notification sound
        );
        await supabase
          .from("agendas")
          .update({ is_reminded: true })
          .eq("id", r.id);
        console.log(`[CRON] Early reminder sent: ${r.title}`);
      } catch (err: any) {
        console.error(`[CRON] Failed early reminder ${r.id}:`, err.message);
      }
    }
  }

  // ── 2. OVERDUE REMINDER: Waktu udah lewat tapi belum di-remind ──
  const { data: overdueReminders, error: err2 } = await supabase
    .from("agendas")
    .select("id, user_id, title, scheduled_time")
    .eq("is_completed", false)
    .eq("is_reminded", false)
    .lte("scheduled_time", now.toISOString());

  if (!err2 && overdueReminders && overdueReminders.length > 0) {
    console.log(`[CRON] ${overdueReminders.length} overdue reminders`);
    for (const r of overdueReminders) {
      try {
        const timeStr = formatTime(r.scheduled_time);
        await sendTelegramMessage(
          r.user_id,
          `⚠️ <b>Agenda udah lewat bro!</b>\n\n` +
          `📋 <b>${escapeHtml(r.title)}</b>\n` +
          `⏰ ${timeStr}\n\n` +
          `Gua udah ingetin, coba cek lagi ya! 👀`,
          "HTML",
          false,
        );
        await supabase
          .from("agendas")
          .update({ is_reminded: true })
          .eq("id", r.id);
        console.log(`[CRON] Overdue reminder sent: ${r.title}`);
      } catch (err: any) {
        console.error(`[CRON] Failed overdue reminder ${r.id}:`, err.message);
      }
    }
  }

  if (err1) console.error(`[CRON] Early reminder query error:`, err1);
  if (err2) console.error(`[CRON] Overdue reminder query error:`, err2);

  const total = (earlyReminders?.length || 0) + (overdueReminders?.length || 0);
  if (total === 0) console.log("[CRON] No pending reminders");
}

async function processOutgoingMessages() {
  const { data: messages, error } = await supabase
    .from("outgoing_messages")
    .select("*")
    .eq("is_sent", false)
    .order("created_at", { ascending: true })
    .limit(50);

  if (error || !messages || messages.length === 0) return;

  for (const msg of messages) {
    try {
      await sendTelegramMessage(msg.user_id, msg.message_text, msg.parse_mode || "HTML");
      await supabase.from("outgoing_messages").update({ is_sent: true }).eq("id", msg.id);
    } catch (err: any) {
      console.error(`[CRON] Failed outgoing message ${msg.id}:`, err.message);
    }
  }
}

function formatRupiah(amount: number): string {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount);
}

async function processRecurringExpenses() {
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const currentDay = now.getDate();

  // Get all unique user_ids that have recurring expenses
  const { data: userIds, error: userErr } = await supabase
    .from("recurring_expenses")
    .select("user_id")
    .eq("is_active", true);

  if (userErr || !userIds || userIds.length === 0) return;

  // Deduplicate user_ids
  const uniqueUserIds = [...new Set(userIds.map((u: any) => u.user_id))];
  console.log(`[CRON] Processing recurring expenses for ${uniqueUserIds.length} users`);

  for (const userId of uniqueUserIds) {
    try {
      // Get active recurring expenses for this user that need processing
      const { data: expenses, error: expErr } = await supabase
        .from("recurring_expenses")
        .select("*")
        .eq("user_id", userId)
        .eq("is_active", true)
        .lte("payment_day", currentDay)
        .neq("last_processed_month", currentMonth);

      if (expErr || !expenses || expenses.length === 0) continue;

      for (const exp of expenses) {
        const title = exp.title || 'Pengeluaran Rutin';
        const amount = Number(exp.amount) || 0;
        const category = exp.category || 'tagihan';

        // Check if transaction already exists (double-check)
        const { data: existingTx } = await supabase
          .from("transactions")
          .select("id")
          .eq("user_id", userId)
          .eq("type", "expense")
          .eq("category", category)
          .ilike("description", `%${title}%`)
          .gte("created_at", `${currentMonth}-01T00:00:00Z`)
          .limit(1);

        if (existingTx && existingTx.length > 0) {
          // Already exists, just update last_processed_month
          await supabase
            .from("recurring_expenses")
            .update({ last_processed_month: currentMonth })
            .eq("id", exp.id);
          continue;
        }

        // Insert expense transaction
        const { error: insertErr } = await supabase
          .from("transactions")
          .insert({
            user_id: userId,
            type: "expense",
            amount: amount,
            category: category,
            description: title,
          });

        if (!insertErr) {
          await supabase
            .from("recurring_expenses")
            .update({ last_processed_month: currentMonth })
            .eq("id", exp.id);

          console.log(`[CRON] Recurring expense recorded: user=${userId}, title=${title}, amount=${amount}`);

          // Notify user
          try {
            await sendTelegramMessage(
              userId,
              `🔄 <b>Pengeluaran Rutin Tercatat</b>\n\n` +
              `📋 <b>${escapeHtml(title)}</b>\n` +
              `💰 ${formatRupiah(amount)}\n` +
              `📂 ${escapeHtml(category)}\n\n` +
              `Pengeluaran rutin bulan ini udah otomatis dicatat ya bro! 📝`,
              "HTML",
              true, // silent notification
            );
          } catch (notifyErr: any) {
            console.error(`[CRON] Failed to notify user ${userId}:`, notifyErr.message);
          }
        } else {
          console.error(`[CRON] Failed to insert recurring expense tx:`, insertErr);
        }
      }
    } catch (err: any) {
      console.error(`[CRON] Error processing recurring expenses for user ${userId}:`, err.message);
    }
  }
}

Deno.serve(async (req: Request) => {
  // ── Auth check: Accept CRON_SECRET or SUPABASE_SERVICE_ROLE_KEY ──
  // Also accept any valid service_role JWT (pg_cron sends the project's service_role JWT)
  const authHeader = req.headers.get("Authorization");
  const bearerToken = authHeader?.replace("Bearer ", "");

  if (!bearerToken) {
    return new Response("Missing auth", { status: 401 });
  }

  // Check 1: CRON_SECRET
  if (bearerToken === CRON_SECRET) {
    // Valid cron secret
  }
  // Check 2: SUPABASE_SERVICE_ROLE_KEY (raw API key)
  else if (bearerToken === SUPABASE_SERVICE_KEY) {
    // Valid service role key
  }
  // Check 3: JWT token issued by this project's supabase (pg_cron sends this)
  else {
    // Try to decode JWT to verify it's a valid service_role token from this project
    try {
      const parts = bearerToken.split(".");
      if (parts.length !== 3) throw new Error("Not a JWT");
      const payload = JSON.parse(atob(parts[1]));
      if (payload.role !== "service_role") throw new Error("Not service_role");
      if (payload.iss !== "supabase") throw new Error("Not from supabase");
      // Accept any valid service_role JWT from supabase
    } catch {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  console.log(`[${new Date().toISOString()}] Cron handler triggered`);

  try {
    await processReminders();
    await processOutgoingMessages();
    await processRecurringExpenses();

    return new Response(JSON.stringify({ ok: true, timestamp: new Date().toISOString() }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("[CRON] Error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
