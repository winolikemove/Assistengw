// ============================================================
// SANTUYBOT v7 — Supabase Edge Function (Deno)
// Telegram Finance & Agenda Bot
// ZERO IMPORTS — Only Deno Built-in APIs
//
// v7: Migrated AI fallback from Gemini to OpenRouter (free models)
// v8: Added QUERY regex patterns (agenda query + financial query) to save AI tokens
// v8: Fixed agenda regex — "jadwal gw apa" now shows agenda instead of creating one
// v8: Financial queries (pendapatan/pengeluaran/saldo bulan ini) now handled by regex
// v7.1: Added READ tools for AI (get_monthly_summary, get_recent_transactions, get_budget_status, get_debts_summary)
// ============================================================
//
// v4 FIXES:
//   - user_id passed as NUMBER (bigint) not string
//   - Generic regex catches "bakso 18rb", "kopi 5rb", etc.
//   - Regex FIRST, Gemini only as LAST fallback (hemat token)
//   - 100+ makanan & jajanan Sunda keywords → kategori "makan"
//   - "hapus semua pengeluaran/pemasukan/transaksi" command
//   - Confirmation via inline keyboard (safe delete)
//   - Edit fitur: pakai force_reply (tidak tambah data baru)
//   - Edit field: keterangan, nominal, jam (bukan kategori)
//   - /cancel untuk batal edit
//   - parseAmount: "8k" → 8000 (fixed \bk\b bug)
//
// v5 FIXES:
//   - Salary auto-entry: verify tx exists before marking "processed"
//   - Salary auto-entry: auto-re-record if tx was deleted
//   - Salary edit: reset last_processed_month on amount/date change
//   - New "🔥 Proses Ulang Gaji" button for manual re-processing
//   - Salary status: ✅ (exists), ⚠️ (missing), ⏳ (not yet)
//
// v6 FIXES:
//   - Gemini fallback: show helpful message when API key not configured
//   - Gemini fallback: log warning when key is missing
//   - Better user feedback when neither regex nor AI can understand input
//   - Gemini: retry logic for 429 rate limit (1 retry)
//   - Gemini: safety settings to reduce false-positive content filter
//   - Gemini: better error messages (rate limit vs auth error)
//   - Gemini: include date field in expense/income transactions
//   - Gemini: HEMAT TOKEN — system prompt pendek, tool desc minimal
//   - Gemini: HAPUS follow-up API call — konfirmasi dibikin client-side
//   - Gemini: generationConfig (temperature 0.1, maxOutputTokens 150)
// ============================================================

// ─────────────── ENVIRONMENT & CONSTANTS ───────────────

const SUPABASE_URL = 'https://sofknxlyoyozavxhoabd.supabase.co';
const SUPABASE_KEY: string = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const TELEGRAM_TOKEN: string = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
const AI_KEY: string = Deno.env.get('AI_API_KEY') || '';

const TG_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const AI_MODEL = Deno.env.get('AI_MODEL') || 'arcee-ai/trinity-large-preview:free';
const AI_URL = 'https://openrouter.ai/api/v1/chat/completions';

// ── USER WHITELIST (only allowed user_ids can use the bot) ──
const ALLOWED_USER_IDS: Set<number> = new Set();
const _rawAllowedIds = Deno.env.get('ALLOWED_USER_IDS') || '';
if (_rawAllowedIds) {
  for (const id of _rawAllowedIds.split(',').map(s => s.trim()).filter(Boolean)) {
    const n = parseInt(id);
    if (!isNaN(n)) ALLOWED_USER_IDS.add(n);
  }
}

function isUserAllowed(userId: number): boolean {
  // If no ALLOWED_USER_IDS is configured, allow everyone (backward compat)
  return ALLOWED_USER_IDS.size === 0 || ALLOWED_USER_IDS.has(userId);
}

const SB_HEADERS: Record<string, string> = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation',
};

const EXPENSE_CATS = ['makan', 'transport', 'belanja', 'tagihan', 'hiburan', 'kesehatan', 'pendidikan', 'jajan', 'lainnya'];
const INCOME_CATS = ['gaji', 'freelance', 'investasi', 'transfer', 'lainnya'];

// ─────────────── IN-MEMORY CACHE (per-request, survives within single Edge Function invocation) ───────────────

// Simple TTL cache for the current request only
class TtlCache {
  private cache = new Map<string, { data: unknown; expiry: number }>();
  private static DEFAULT_TTL = 5000; // 5 seconds

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }
    return entry.data as T;
  }

  set(key: string, data: unknown, ttlMs = TtlCache.DEFAULT_TTL): void {
    this.cache.set(key, { data, expiry: Date.now() + ttlMs });
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  clear(): void {
    this.cache.clear();
  }
}

// Global request cache instance
const reqCache = new TtlCache();

// AI rate limiter state (persists across requests in same worker)
let aiRateLimitedUntil = 0;

// ─────────────── UTILITY HELPERS ───────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatRupiah(amount: number): string {
  return 'Rp ' + amount.toLocaleString('id-ID');
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseAmount(raw: string): number | null {
  // Normalize: trim and lowercase
  const lower = raw.toLowerCase().trim();

  // Step 1: Extract the numeric part
  let s = lower.replace(/[^0-9.,]/g, '').replace(/\./g, '').replace(',', '.');
  let n = parseFloat(s);
  if (isNaN(n)) return null;

  // Step 2: Determine multiplier from suffix
  // Handles: rb, Rb, RB, rB, k, K, jt, juta, m, M, ribu
  // Fixed: "8k" now correctly returns 8000 (was returning 8 due to \b bug)
  let multiplier = 1;
  if (/ribu/.test(lower) || /rb/.test(lower)) {
    multiplier = 1000;
  } else if (/juta/.test(lower) || /jt/.test(lower)) {
    multiplier = 1000000;
  } else if (/k$/.test(lower) || /k\s/.test(lower)) {
    // "8k", "80K", "100k" → word boundary fix: use k$ instead of \bk\b
    multiplier = 1000;
  } else if (/m$/.test(lower) || /m\s/.test(lower)) {
    // "1m", "1.5M" → word boundary fix: use m$ instead of \bm\b
    multiplier = 1000000;
  }

  n *= multiplier;
  return n > 0 ? Math.round(n) : null;
}

// ── Jakarta timezone helper ──
// Supabase runs in UTC, but users expect WIB (UTC+7) times.
// d.setHours() operates in server local time (UTC on AWS), so "jam 11" becomes 11:00 UTC = 18:00 WIB.
// This helper sets hours in Jakarta timezone instead.
function jakartaSetHours(d: Date, h: number, m: number, s = 0): void {
  const now = new Date();
  const jakartaNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  const offsetMs = jakartaNow.getTime() - now.getTime(); // WIB offset (~7 hours)
  const utcDayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  d.setTime(utcDayStart + (h * 3600000 + m * 60000 + s * 1000) - offsetMs);
}

function parseRelDate(text: string): string | null {
  const d = new Date();
  const today = new Date();
  jakartaSetHours(today, 0, 0);
  const lower = text.toLowerCase().trim();

  // ── Hari ini / sekarang / skrng ──
  if (/hari\s*ini|sekarang|skrng|today/.test(lower)) return d.toISOString();

  // ── Besok / lusa ──
  if (/besok/.test(lower)) { d.setDate(d.getDate() + 1); return d.toISOString(); }
  if (/lusa/.test(lower)) { d.setDate(d.getDate() + 2); return d.toISOString(); }

  // ── N hari lagi (2 hari lagi, 3 minggu depan, etc) ──
  const nHari = lower.match(/(\d+)\s*hari\s*(?:lagi|dari\s*now|kedepan|depan)/);
  if (nHari) { d.setDate(d.getDate() + parseInt(nHari[1])); return d.toISOString(); }

  // ── Minggu depan ──
  if (/minggu\s*depan/.test(lower)) { d.setDate(d.getDate() + 7); return d.toISOString(); }

  // ── Nama hari (senin s.d. minggu, + variant sunda) ──
  const days: Record<string, number> = {
    'senin': 1, 'selasa': 2, 'rabu': 3, 'kamis': 4, 'jumat': 5, 'sabtu': 6, 'minggu': 0,
    'ahad': 0, 'isnin': 1, 'selasa': 2, 'rebo': 3, 'kemis': 4, 'jumah': 5, 'saptu': 6,
  'sane': 1, 'salasa': 2, 'rebo': 3, 'kemis': 4, 'jumat': 5, 'saptu': 6, 'minggu': 0,
    'manis': 1, 'tisna': 2, 'rebo': 3, 'kemis': 4, 'jumah': 5, 'saptu': 6,
  'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4, 'fri': 5, 'sat': 6, 'sun': 0,
  'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 'friday': 5, 'saturday': 6, 'sunday': 0,
  };
  for (const [name, target] of Object.entries(days)) {
    if (lower.includes(name)) {
      const current = d.getDay();
      let diff = target - current;
      if (diff <= 0) diff += 7;
      d.setDate(d.getDate() + diff);
      return d.toISOString();
    }
  }

  // ── tanggal/tgl DD (tanpa bulan) ──
  const tglMatch = lower.match(/(?:tanggal|tgl)\s*(\d{1,2})/);
  if (tglMatch) {
    const day = parseInt(tglMatch[1]);
    d.setDate(day);
    jakartaSetHours(d, 9, 0);
    if (d < today) d.setMonth(d.getMonth() + 1);
    return d.toISOString();
  }

  // ── DD/MM or DD-MM ──
  const slashMatch = lower.match(/(\d{1,2})\s*[\/\-]\s*(\d{1,2})/);
  if (slashMatch) {
    const day = parseInt(slashMatch[1]);
    const month = parseInt(slashMatch[2]) - 1;
    d.setMonth(month, day);
    jakartaSetHours(d, 9, 0);
    if (d < today) d.setFullYear(d.getFullYear() + 1);
    return d.toISOString();
  }

  // ── DD bulan (15 april, 20 mei, dll) ──
  const dayMonth = lower.match(/(\d{1,2})\s+(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan|feb|mar|apr|mei|jun|jul|agu|sep|okt|nov|des)/);
  if (dayMonth) {
    const day = parseInt(dayMonth[1]);
    const monthNames = ['januari','februari','maret','april','mei','juni','juli','agustus','september','oktober','november','desember',
      'jan','feb','mar','apr','mei','jun','jul','agu','sep','okt','nov','des'];
    const mi = monthNames.indexOf(dayMonth[2]);
    if (mi >= 0) {
      const realMonth = mi >= 12 ? mi - 12 : mi;
      d.setMonth(realMonth, day);
      jakartaSetHours(d, 9, 0);
      if (d < today) d.setFullYear(d.getFullYear() + 1);
      return d.toISOString();
    }
  }

  return null;
}

function parseRelTime(text: string): string | null {
  const lower = text.toLowerCase();

  // ── jam H[:MM] ── (jam 14, jam 14.30, jam 14:30, jam 9 pagi)
  const jamMatch = lower.match(/jam\s*(\d{1,2})(?:[.:]\s*(\d{1,2}))?/);
  if (jamMatch) {
    let h = parseInt(jamMatch[1]);
    const m = jamMatch[2] ? parseInt(jamMatch[2]) : 0;

    // period-based adjustments
    if (/pagi|subuh|dini/.test(lower)) {
      if (h === 12) h = 0;         // 12 pagi = 00:00
      // h stays as-is (0-11)
    } else if (/siang/.test(lower)) {
      if (h < 11) h += 12;         // 1-10 siang = 13-22
      else if (h === 11) h = 11;   // 11 siang = 11
      else if (h === 12) h = 12;   // 12 siang = 12
    } else if (/sore/.test(lower)) {
      if (h <= 6) h += 12;         // 1-6 sore = 13-18
      else if (h > 6 && h < 12) h += 6; // 7-11 sore = 13-17
    } else if (/malam|malem/.test(lower)) {
      if (h <= 5) h += 18;         // 1-5 malam = 19-23
      else if (h > 5 && h < 12) h += 12; // 6-11 malam = 18-23
    }
    // default: assume 24h format if h > 12, else leave as-is

    const d = new Date();
    jakartaSetHours(d, h, m);
    if (d < new Date()) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }

  // ── bare H:MM or H.MM (14:30, 09.00) without "jam" keyword ──
  const bareTime = lower.match(/(?:^|\s)(\d{1,2})[.:](\d{2})(?:\s|$|[^\d])/);
  if (bareTime) {
    let h = parseInt(bareTime[1]);
    const m = parseInt(bareTime[2]);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      const d = new Date();
      jakartaSetHours(d, h, m);
      if (d < new Date()) d.setDate(d.getDate() + 1);
      return d.toISOString();
    }
  }

  // ── keyword-only (pagi/siang/sore/malam) without specific hour ──
  if (/pagi/.test(lower)) {
    const d = new Date(); jakartaSetHours(d, 7, 0); if (d < new Date()) d.setDate(d.getDate() + 1); return d.toISOString();
  }
  if (/siang/.test(lower)) {
    const d = new Date(); jakartaSetHours(d, 12, 0); if (d < new Date()) d.setDate(d.getDate() + 1); return d.toISOString();
  }
  if (/sore/.test(lower)) {
    const d = new Date(); jakartaSetHours(d, 16, 0); if (d < new Date()) d.setDate(d.getDate() + 1); return d.toISOString();
  }
  if (/(?:malam|malem)/.test(lower)) {
    const d = new Date(); jakartaSetHours(d, 19, 0); if (d < new Date()) d.setDate(d.getDate() + 1); return d.toISOString();
  }

  return null;
}

function parseDateTime(text: string): string | null {
  const datePart = parseRelDate(text);
  const timePart = parseRelTime(text);
  if (datePart) {
    const d = new Date(datePart);
    if (timePart) {
      const t = new Date(timePart);
      // t already has correct UTC time from jakartaSetHours, just apply hours/minutes
      d.setUTCHours(t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds());
    } else {
      jakartaSetHours(d, 9, 0);
    }
    return d.toISOString();
  }
  if (timePart) return timePart;
  return null;
}

function guessCategory(text: string, type: string): string {
  const lower = text.toLowerCase();
  const cats = type === 'expense' ? EXPENSE_CATS : INCOME_CATS;
  for (const c of cats) {
    if (lower.includes(c)) return c;
  }
  // ══════════ MAKAN — Makanan & Minuman ══════════
  // Nasi & Karbohidrat
  if (/nasi|mie|bakmi|bihun|kwetiaw|lontong|ketupat|roti|bread/.test(lower)) return 'makan';
  // Lauk & Protein
  if (/ayam|bebek|daging|sapi|kambing|ikan|udang|cumi|tahu|tempe|telur|bakso|sate|pentol|pempers|baso/.test(lower)) return 'makan';
  // Masakan Indonesia Umum
  if (/goreng|bakar|rebus|tumis|soto|rawon|rendang|gudeg|pecel|gado|lotek|kupat|tahu\s*geprek|geprek/.test(lower)) return 'makan';
  // Sayur & Lalapan
  if (/sayur|kangkung|bayam|sawi|kacang|lalap|daun|labu|terong|kacang\s*panjang|genjer/.test(lower)) return 'makan';
  // Minuman
  if (/kopi|teh|susu|jus|es\s*|minum|starbuck|kopi|thaitea|boba|minuman|air\s*mineral/.test(lower)) return 'makan';
  // Restoran & Delivery
  if (/warung|resto|rm\.|warteg|kantin|food|grabfood|gofood|shopee\s*food|kfc|mcd|burger|pizza/.test(lower)) return 'makan';
  // Snack ringan
  if (/snack|cemilan|chips|keripik|kacang|roti\s*bakar|popcorn|krupuk/.test(lower)) return 'makan';

  // ══════════ MAKANAN & JAJANAN SUNDA ══════════
  // Nasi Khas Sunda
  if (/liwet|timbel|tutug\s*oncom|jamblang|nasi\s*komplit|cilok|cimol|cireng|cuanki|batagor|siomay/.test(lower)) return 'makan';
  // Makanan Berat Sunda
  if (/sambal\s*terasi|sambal\s*dadak|sambal\s*matah|pindang|bandeng|empal|gehu|combro|misro|pepes|oncom/.test(lower)) return 'makan';
  if (/karedok|urap|asem|lodeh|toge|tauge|kecambah|oseng|tumis\s*kangkung|tumis\s*genjer/.test(lower)) return 'makan';
  if (/soto\s*bandung|soto\s*sunda|bakakak|ayam\s*bakakak|kupat\s*tahu|bandros|surabi/.test(lower)) return 'makan';
  if (/ikan\s*gurame|ikan\s*patin|ikan\s*mujair|ikan\s*asin|ikan\s*pindang|ikan\s*bakar|ikan\s*goreng/.test(lower)) return 'makan';
  if (/seblak|karedok|buntil|bothok|bressem|seuruh|haulum|maranggi/.test(lower)) return 'makan';
  // Jajanan Khas Sunda → masuk kategori 'makan'
  if (/colenak|rangi|peuyeum|tape|tape\s*singkong|dodol|wajit|burayot|opak|rangginang|lemet/.test(lower)) return 'makan';
  if (/awug|nagasari|onde\s*onde|kue\s*ape|kue\s*pancong|kue\s*sarang|kue\s*bandros|kue\s*surabi/.test(lower)) return 'makan';
  if (/tahu\s*crispy|tahu\s*sumedang|tahu\s*isi|tahu\s*geprek|tahu\s*goreng/.test(lower)) return 'makan';
  if (/pisang\s*goreng|pisang\s*bakar|pisang\s*keju|gorengan|pisang|singkong|ubi|ketela/.test(lower)) return 'makan';
  // Jajanan Pasar Sunda
  if (/klepon|putu|serabi|lumpia|risoles|pastel|martabak|martabak\s*manis|martabak\s*telur|terang\s*bulan/.test(lower)) return 'makan';
  if (/dimsum|bakpao|siomay|pangsit|bakwan|perkedel|rempeyek|sate\s*keripik|kerak\s*telor/.test(lower)) return 'makan';
  if (/es\s*cendol|es\s*cincau|es\s*kopi|es\s*teh|es\s*campur|es\s*dawet|es\s*kul\s*kul|es\s*oyen/.test(lower)) return 'makan';

  // ══════════ TRANSPORT ══════════
  if (/gojek|grab|ojol|taxi|uber|bensin|parkir|tol|bus|kereta|tiket|travel/.test(lower)) return 'transport';
  // ══════════ BELANJA ══════════
  if (/belanja|shopee|tokopedia|lazada|baju|celana|sepatu|barang|alat/.test(lower)) return 'belanja';
  // ══════════ TAGIHAN ══════════
  if (/listrik|pdam|wifi|internet|bpjs|kredit|cicilan|tagihan|pulsa|paket/.test(lower)) return 'tagihan';
  // ══════════ HIBURAN ══════════
  if (/nonton|film|game|netflix|spotify|youtube|premium|konser|bowl|karaoke/.test(lower)) return 'hiburan';
  // ══════════ KESEHATAN ══════════
  if (/dokter|obat|apotek|rs|rumah\s*sakit|vitamin|lab|cek\s*kesehatan/.test(lower)) return 'kesehatan';
  // ══════════ PENDIDIKAN ══════════
  if (/kuliah|buku|kursus|bootcamp|seminar|ujian|spp|tuition/.test(lower)) return 'pendidikan';
  // ══════════ JAJAN (umum) ══════════
  if (/jajan|eskrim|bubble|boba|ice\s*cream/.test(lower)) return 'jajan';
  // income keyword mapping
  if (/gaji|salary|paycheck|thp/.test(lower)) return 'gaji';
  if (/freelance|project|side\s*hustle|sampingan/.test(lower)) return 'freelance';
  if (/dividen|saham|reksa|bunga|deposito|trading/.test(lower)) return 'investasi';
  if (/transfer|kirim|tf|dari\s*([a-z])/.test(lower)) return 'transfer';
  return 'lainnya';
}

// ─────────────── TELEGRAM API HELPERS ───────────────

async function tgApi(method: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return await res.json() as Record<string, unknown>;
}

async function sendText(
  chatId: number | string,
  text: string,
  opts: Record<string, unknown> = {}
): Promise<void> {
  await tgApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...opts,
  });
}

async function sendTextWithKeyboard(
  chatId: number | string,
  text: string,
  keyboard: unknown[][]
): Promise<void> {
  await tgApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function sendForceReply(
  chatId: number | string,
  text: string,
  placeholder = 'Ketik balasan...'
): Promise<void> {
  await tgApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      force_reply: true,
      selective: true,
      input_field_placeholder: placeholder,
    },
  });
}

async function answerCb(cbId: string, text = ''): Promise<void> {
  await tgApi('answerCallbackQuery', {
    callback_query_id: cbId,
    text: text || '✅',
    show_alert: false,
  });
}

async function editMsgText(
  chatId: number | string,
  messageId: number,
  text: string,
  keyboard?: unknown[][]
): Promise<void> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  await tgApi('editMessageText', payload);
}

async function deleteMsg(chatId: number | string, messageId: number): Promise<void> {
  await tgApi('deleteMessage', { chat_id: chatId, message_id: messageId });
}

// ─────────────── SUPABASE REST HELPERS ───────────────

async function sbGet(table: string, query: string): Promise<unknown[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: SB_HEADERS,
  });
  if (!res.ok) {
    console.error(`GET ${table} error ${res.status}`);
    return [];
  }
  return await res.json() as unknown[];
}

async function sbPost(table: string, data: Record<string, unknown>, query = ''): Promise<{ ok: boolean; error?: string }> {
  const url = `${SUPABASE_URL}/rest/v1/${table}${query ? `?${query}` : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'return=minimal,resolution=merge-duplicates',
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error(`[SB POST ${table}] ${res.status}:`, err);
    return { ok: false, error: `${res.status}` };
  }
  return { ok: true };
}

async function sbPatch(table: string, id: string | number, data: Record<string, unknown>): Promise<{ ok: boolean }> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: SB_HEADERS,
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`PATCH ${table} error ${res.status}:`, err);
    return { ok: false };
  }
  return { ok: true };
}

async function sbDelete(table: string, query: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: 'DELETE',
    headers: SB_HEADERS,
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`DELETE ${table} error ${res.status}:`, err);
    return { ok: false };
  }
  return { ok: true };
}

// ─────────────── BUDGET HELPERS ───────────────

function getJakartaMonthStart(): string {
  const now = new Date();
  const jakarta = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  jakarta.setDate(1);
  jakartaSetHours(jakarta, 0, 0);
  return jakarta.toISOString();
}

function budgetProgressBar(percent: number): string {
  const filled = Math.min(10, Math.round((percent / 100) * 10));
  const empty = 10 - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function budgetStatusEmoji(percent: number): string {
  if (percent >= 90) return '🔴';
  if (percent >= 70) return '🟡';
  return '🟢';
}

async function getMonthlySpent(userId: number, category: string): Promise<number> {
  const spentMap = await getMonthlySpentBatch(userId);
  return spentMap.get(category) || 0;
}

async function getMonthlySpentBatch(userId: number): Promise<Map<string, number>> {
  const cacheKey = `monthly_spent:${userId}`;
  const cached = reqCache.get<Map<string, number>>(cacheKey);
  if (cached) return cached;

  const monthStart = getJakartaMonthStart();
  const results = await sbGet(
    'transactions',
    `select=category,amount&user_id=eq.${userId}&type=eq.expense&created_at=gte.${monthStart}`
  ) as Record<string, unknown>[];
  
  const spentMap = new Map<string, number>();
  if (Array.isArray(results)) {
    for (const r of results) {
      const cat = (r.category as string) || 'lainnya';
      const amt = Number(r.amount || 0);
      spentMap.set(cat, (spentMap.get(cat) || 0) + amt);
    }
  }
  
  reqCache.set(cacheKey, spentMap, 10000); // 10s cache
  return spentMap;
}

async function upsertBudget(userId: number, category: string, amount: number): Promise<{ ok: boolean; error?: string }> {
  const existing = await sbGet(
    'budgets',
    `select=id&user_id=eq.${userId}&category=eq.${category}&limit=1`
  ) as Record<string, unknown>[];

  if (Array.isArray(existing) && existing.length > 0) {
    // Clear cache since we're modifying
    reqCache.clear();
    return await sbPatch('budgets', existing[0].id as string, { monthly_limit: amount });
  } else {
    reqCache.clear();
    return await sbPost('budgets', { user_id: userId, category, monthly_limit: amount });
  }
}

async function showBudgetMenu(chatId: number, userId: number, msgId?: number, edit = true): Promise<void> {
  try {
    const budgets = await sbGet(
      'budgets',
      `select=*&user_id=eq.${userId}&order=category.asc`
    ) as Record<string, unknown>[];

    let text: string;
    const keyboard: unknown[][] = [];

    if (Array.isArray(budgets) && budgets.length > 0) {
      const spentMap = await getMonthlySpentBatch(userId);
      text = `📊 <b>Budget Bulan Ini</b>\n\n`;
      for (const b of budgets) {
        const cat = (b.category as string) || 'lainnya';
        const limit = Number(b.monthly_limit || 0);
        const spent = spentMap.get(cat) || 0;
        const percent = limit > 0 ? Math.round((spent / limit) * 100) : 0;
        const emoji = budgetStatusEmoji(percent);
        const bar = budgetProgressBar(percent);

        text += `${emoji} <b>${escapeHtml(cat.charAt(0).toUpperCase() + cat.slice(1))}</b>\n`;
        text += `   ${bar} ${percent}%\n`;
        text += `   ${formatRupiah(spent)} / ${formatRupiah(limit)}\n\n`;
      }

      // Buttons
      const setBtns: unknown[] = [];
      for (const cat of EXPENSE_CATS) {
        setBtns.push({ text: `💰 ${cat.charAt(0).toUpperCase() + cat.slice(1)}`, callback_data: `budget:pick:${cat}` });
      }
      keyboard.push(
        ...chunkArray(setBtns, 3),
        [{ text: '🗑️ Hapus Budget', callback_data: 'budget:del' }],
        [{ text: '🔙 Kembali', callback_data: 'menu_main' }]
      );
    } else {
      text = `📊 <b>Budget Bulan Ini</b>\n\nBelum ada budget yang diset bro.\n\nSet budget buat kontrol pengeluaran lu biar ga over! 💪`;

      const setBtns: unknown[] = [];
      for (const cat of EXPENSE_CATS) {
        setBtns.push({ text: `💰 ${cat.charAt(0).toUpperCase() + cat.slice(1)}`, callback_data: `budget:pick:${cat}` });
      }
      keyboard.push(
        ...chunkArray(setBtns, 3),
        [{ text: '🔙 Kembali', callback_data: 'menu_main' }]
      );
    }

    if (edit && msgId) {
      await editMsgText(chatId, msgId, text, keyboard);
    } else {
      await sendTextWithKeyboard(chatId, text, keyboard);
    }
  } catch (e) {
    const errMsg = `⚠️ Error load budget: ${e}`;
    if (edit && msgId) {
      await editMsgText(chatId, msgId, errMsg, [[{ text: '🔙 Kembali', callback_data: 'menu_main' }]]);
    } else {
      await sendTextWithKeyboard(chatId, errMsg, [[{ text: '🔙 Kembali', callback_data: 'menu_main' }]]);
    }
  }
}

function chunkArray(arr: unknown[], size: number): unknown[][] {
  const chunks: unknown[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ─────────────── RECURRING EXPENSE HELPERS ───────────────

async function processRecurringForMonth(userId: number, force = false): Promise<boolean> {
  const expenses = await sbGet('recurring_expenses', `select=*&user_id=eq.${userId}`) as Record<string, unknown>[];
  if (!Array.isArray(expenses) || expenses.length === 0) return false;

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const today = todayStr();
  let recorded = false;

  for (const exp of expenses) {
    const isActive = exp.is_active !== false;
    if (!isActive) continue;

    const lastProcessed = exp.last_processed_month as string || '';
    const paymentDay = Number(exp.payment_day) || 1;
    const currentDay = now.getDate();

    // Skip if payment day hasn't arrived yet (unless forced)
    if (!force && paymentDay > currentDay) continue;

    // Check if already processed this month
    const alreadyProcessed = lastProcessed === currentMonth;
    if (alreadyProcessed && !force) continue;

    // Even if marked as processed, verify the transaction actually exists
    let txExists = false;
    if (alreadyProcessed) {
      const existingTx = await sbGet(
        'transactions',
        `select=id&user_id=eq.${userId}&type=eq.expense&category=eq.${exp.category || 'tagihan'}&description=ilike.%25${encodeURIComponent((exp.title as string) || 'Pengeluaran Rutin')}%25&created_at=gte.${currentMonth}-01T00:00:00Z&limit=1`
      ) as Record<string, unknown>[];
      txExists = Array.isArray(existingTx) && existingTx.length > 0;
    }

    // Process if: not yet processed OR (processed but transaction missing) OR forced
    if (!alreadyProcessed || !txExists || force) {
      // If forced and tx exists, delete old one first to avoid duplicates
      if (force && txExists) {
        await sbDelete(
          'transactions',
          `user_id=eq.${userId}&type=eq.expense&category=eq.${exp.category || 'tagihan'}&description=ilike.%25${encodeURIComponent((exp.title as string) || 'Pengeluaran Rutin')}%25&created_at=gte.${currentMonth}-01T00:00:00Z`
        );
      }

      // Record recurring expense as expense transaction
      const result = await sbPost('transactions', {
        user_id: userId,
        type: 'expense',
        amount: exp.amount,
        category: exp.category || 'tagihan',
        description: (exp.title as string) || 'Pengeluaran Rutin',
      });

      if (result.ok) {
        await sbPatch('recurring_expenses', exp.id as string, { last_processed_month: currentMonth });
        recorded = true;
        console.log(`Recurring expense processed: user=${userId}, title=${exp.title}, amount=${exp.amount}, date=${today}`);
      } else {
        console.error(`Recurring expense insert failed: user=${userId}, id=${exp.id}, error=${result.error}`);
      }
    }
  }

  return recorded;
}

async function verifyRecurringInExpense(userId: number, exp: Record<string, unknown>): Promise<boolean> {
  // Use batch-verified set when available
  const verifiedSet = reqCache.get<Set<string>>(`recurring_verified:${userId}`);
  if (verifiedSet) {
    const title = ((exp.title as string) || 'Pengeluaran Rutin').trim();
    return verifiedSet.has(title);
  }

  // Fallback to individual query
  const currentMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const cat = (exp.category as string) || 'tagihan';
  const title = (exp.title as string) || 'Pengeluaran Rutin';

  const existingTx = await sbGet(
    'transactions',
    `select=id&user_id=eq.${userId}&type=eq.expense&category=eq.${cat}&description=ilike.%25${encodeURIComponent(title)}%25&created_at=gte.${currentMonth}-01T00:00:00Z&limit=1`
  ) as Record<string, unknown>[];
  return Array.isArray(existingTx) && existingTx.length > 0;
}

async function batchVerifyRecurring(userId: number): Promise<Set<string>> {
  const cacheKey = `recurring_verified:${userId}`;
  const cached = reqCache.get<Set<string>>(cacheKey);
  if (cached) return cached;

  const currentMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const results = await sbGet(
    'transactions',
    `select=description&user_id=eq.${userId}&type=eq.expense&created_at=gte.${currentMonth}-01T00:00:00Z&limit=100`
  ) as Record<string, unknown>[];
  const verified = new Set<string>();
  if (Array.isArray(results)) {
    for (const r of results) {
      const desc = (r.description as string) || '';
      verified.add(desc.trim());
    }
  }
  reqCache.set(cacheKey, verified, 10000);
  return verified;
}

async function showRecurringMenu(chatId: number, userId: number, msgId?: number, edit = true): Promise<void> {
  try {
    // First, auto-process any pending recurring expenses for this month
    const wasRecorded = await processRecurringForMonth(userId);

    // Pre-fetch batch verification set to avoid N+1 queries
    await batchVerifyRecurring(userId);

    const recurring = await sbGet(
      'recurring_expenses',
      `select=*&user_id=eq.${userId}&order=payment_day.asc`
    ) as Record<string, unknown>[];

    let text: string;
    const keyboard: unknown[][] = [];

    if (Array.isArray(recurring) && recurring.length > 0) {
      text = `🔄 <b>Pengeluaran Rutin</b>\n\n`;
      for (let i = 0; i < recurring.length; i++) {
        const r = recurring[i];
        const title = (r.title as string) || '-';
        const amount = Number(r.amount || 0);
        const day = r.payment_day as number;
        const active = r.is_active !== false;
        const lastProcessed = (r.last_processed_month as string) || '-';
        const currentMonthStr = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
        const isProcessedThisMonth = lastProcessed === currentMonthStr;
        const desc = (r.description as string) || '';
        const cat = (r.category as string) || 'tagihan';

        // Verify: even if marked processed, check if tx actually exists
        let txActuallyExists = false;
        if (isProcessedThisMonth) {
          txActuallyExists = await verifyRecurringInExpense(userId, r);
        }

        let statusEmoji = '⏳';
        let statusNote = '';
        if (active) {
          if (isProcessedThisMonth && txActuallyExists) {
            statusEmoji = '✅';
            statusNote = ' (sudah tercatat)';
          } else if (isProcessedThisMonth && !txActuallyExists) {
            statusEmoji = '⚠️';
            statusNote = ' (belum ada di pengeluaran — tekan 🔥 di bawah)';
          }
        } else {
          statusEmoji = '🔴';
          statusNote = ' (pause)';
        }

        text += `${i + 1}. <b>${escapeHtml(title)}</b>\n`;
        text += `   💰 ${formatRupiah(amount)} | 📂 ${escapeHtml(cat)}\n`;
        text += `   📅 Tanggal ${day} ${statusEmoji}${statusNote}\n\n`;

        keyboard.push([
          { text: `✏️ Edit #${i + 1}`, callback_data: `edit_recurring:${r.id}` },
          { text: `🗑️ Hapus #${i + 1}`, callback_data: `recurring:del:${r.id}` },
        ]);
        keyboard.push([
          { text: active ? '⏸ Pause' : '▶️ Aktifkan', callback_data: `recurring:toggle:${r.id}` },
        ]);
      }

      if (wasRecorded) {
        text += `🔔 <b>Pengeluaran rutin bulan ini berhasil dicatat!</b>\n\n`;
      }

      text += `Tekan tombol di bawah buat tambah pengeluaran rutin 👇`;
    } else {
      text = `🔄 <b>Pengeluaran Rutin</b>\n\nBelum ada pengeluaran rutin.\n\nTambah biar otomatis tercatat tiap bulan! 💪`;
    }

    keyboard.push(
      [{ text: '➕ Tambah Rutin', callback_data: 'recurring:add' }],
      [{ text: '🔥 Proses Ulang Bulan Ini', callback_data: 'force_recurring' }],
      [{ text: '🔙 Kembali ke Menu', callback_data: 'menu_main' }]
    );

    if (edit && msgId) {
      await editMsgText(chatId, msgId, text, keyboard);
    } else {
      await sendTextWithKeyboard(chatId, text, keyboard);
    }
  } catch (e) {
    const errMsg = `⚠️ Error load rutin: ${e}`;
    if (edit && msgId) {
      await editMsgText(chatId, msgId, errMsg, [[{ text: '🔙 Kembali', callback_data: 'menu_main' }]]);
    } else {
      await sendTextWithKeyboard(chatId, errMsg, [[{ text: '🔙 Kembali', callback_data: 'menu_main' }]]);
    }
  }
}

async function addRecurringPrompt(chatId: number): Promise<void> {
  const tag = `[ADD_RECURRING]`;
  const text =
    `${tag}\n\n` +
    `🔄 <b>Tambah Pengeluaran Rutin Baru</b>\n\n` +
    `👇 <b>Balas pesan ini</b> dengan format:\n\n` +
    `<code>Judul pengeluaran</code>\n` +
    `<code>Nominal</code>\n` +
    `<code>Tanggal (1-31)</code>\n` +
    `<code>Kategori (opsional)</code>\n\n` +
    `Contoh:\n` +
    `<code>Netflix 153rb 5 tagihan</code>\n` +
    `<code>Spotify 50rb 10</code>\n` +
    `<code>Kontrakan 1.5jt 1 belanja</code>\n\n` +
    `<i>Nominal bisa pakai: rb, k, jt, m, ribu, juta</i>\n` +
    `<i>Tanggal = kapan bayar tiap bulan (1-31)</i>\n\n` +
    `<i>Ketik /cancel untuk batal.</i>`;

  await sendForceReply(chatId, text, 'Ketik judul pengeluaran rutin...');
}

async function checkBudgetAlert(userId: number, category: string): Promise<string> {
  try {
    const budgets = await sbGet(
      'budgets',
      `select=monthly_limit&user_id=eq.${userId}&category=eq.${category}&limit=1`
    ) as Record<string, unknown>[];
    if (!Array.isArray(budgets) || budgets.length === 0) return '';

    const limit = Number(budgets[0].monthly_limit || 0);
    if (limit <= 0) return '';

    const spentMap = await getMonthlySpentBatch(userId);
    const spent = spentMap.get(category) || 0;
    const percent = Math.round((spent / limit) * 100);

    if (percent >= 100) {
      return `\n\n🚨 <b>BUDGET ${escapeHtml(category.toUpperCase())} BULAN INI UDAH KELEBIHAN</b> bro!`;
    } else if (percent >= 80) {
      return `\n\n⚠️ Lu udah pakai <b>${percent}%</b> dari budget ${escapeHtml(category)} bulan ini!`;
    }
  } catch (e) {
    console.error('[BUDGET ALERT ERROR]:', e);
  }
  return '';
}

// ─────────────── DEBT HELPERS ───────────────

function getNextDueDate(dayOfMonth: number): string | null {
  if (dayOfMonth < 1 || dayOfMonth > 31) return null;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  const candidate = new Date(now);
  candidate.setDate(dayOfMonth);
  jakartaSetHours(candidate, 23, 59);
  if (candidate < now) {
    // Move to next month
    candidate.setMonth(candidate.getMonth() + 1);
  }
  return candidate.toISOString();
}

async function showDebtMenu(chatId: number, userId: number, msgId?: number, edit = true): Promise<void> {
  try {
    const debts = await sbGet(
      'debts',
      `select=*&user_id=eq.${userId}&order=created_at.desc`
    ) as Record<string, unknown>[];

    const allDebts = Array.isArray(debts) ? debts : [];
    const piutang = allDebts.filter(d => d.type === 'piutang' && !d.is_settled);
    const utang = allDebts.filter(d => d.type === 'utang' && !d.is_settled);
    const totalPiutang = piutang.reduce((s, d) => s + Number(d.amount || 0), 0);
    const totalUtang = utang.reduce((s, d) => s + Number(d.amount || 0), 0);

    let text = `💰 <b>Piutang / Utang</b>\n\n`;
    text += `📥 <b>Piutang</b> (orang lain hutang ke lu): ${piutang.length} item\n   Total: <b>${formatRupiah(totalPiutang)}</b>\n\n`;
    text += `📤 <b>Utang</b> (lu hutang ke orang lain): ${utang.length} item\n   Total: <b>${formatRupiah(totalUtang)}</b>\n\n`;
    text += `📊 <b>Netto:</b> ${totalPiutang >= totalUtang ? '+' : ''}${formatRupiah(totalPiutang - totalUtang)}\n`;

    const keyboard: unknown[][] = [
      [
        { text: '📥 Tambah Piutang', callback_data: 'debt:add:piutang' },
        { text: '📤 Tambah Utang', callback_data: 'debt:add:utang' },
      ],
    ];

    // Show recent unsettled debts as buttons
    const pending = allDebts.filter(d => !d.is_settled);
    if (pending.length > 0) {
      const debtRows: unknown[][] = [];
      for (const d of pending.slice(0, 6)) {
        const type = d.type as string;
        const name = (d.person_name as string) || '?';
        const amt = Number(d.amount || 0);
        const emoji = type === 'piutang' ? '📥' : '📤';
        debtRows.push([{
          text: `${emoji} ${name} — ${formatRupiah(amt)}`,
          callback_data: `debt:detail:${d.id}`,
        }]);
      }
      keyboard.push(...debtRows);
    }

    keyboard.push(
      [{ text: '✅ Riwayat Lunas', callback_data: 'debt:history' }],
      [{ text: '🔙 Kembali', callback_data: 'menu_main' }],
    );

    if (edit && msgId) {
      await editMsgText(chatId, msgId, text, keyboard);
    } else {
      await sendTextWithKeyboard(chatId, text, keyboard);
    }
  } catch (e) {
    const errMsg = `⚠️ Error load piutang/utang: ${e}`;
    if (edit && msgId) {
      await editMsgText(chatId, msgId, errMsg, [[{ text: '🔙 Kembali', callback_data: 'menu_main' }]]);
    } else {
      await sendTextWithKeyboard(chatId, errMsg, [[{ text: '🔙 Kembali', callback_data: 'menu_main' }]]);
    }
  }
}

async function showDebtDetail(chatId: number, userId: number, debtId: string, msgId: number): Promise<void> {
  try {
    const debts = await sbGet(
      'debts',
      `select=*&id=eq.${debtId}&user_id=eq.${userId}&limit=1`
    ) as Record<string, unknown>[];
    if (!Array.isArray(debts) || debts.length === 0) {
      await answerCb('', '❌ Ga ketemu');
      return;
    }

    const d = debts[0];
    const type = d.type as string;
    const personName = (d.person_name as string) || '?';
    const amount = Number(d.amount || 0);
    const description = (d.description as string) || '-';
    const dueDate = d.due_date as string | null;
    const createdAt = d.created_at as string;
    const emoji = type === 'piutang' ? '📥' : '📤';
    const typeLabel = type === 'piutang' ? 'Piutang (orang lain hutang ke lu)' : 'Utang (lu hutang ke orang lain)';

    let text = `${emoji} <b>Detail ${typeLabel}</b>\n\n`;
    text += `👤 Orang: <b>${escapeHtml(personName)}</b>\n`;
    text += `💰 Nominal: <b>${formatRupiah(amount)}</b>\n`;
    if (description && description !== '-') text += `📌 Keterangan: ${escapeHtml(description)}\n`;
    if (dueDate) {
      const dd = new Date(dueDate);
      const jakartaDate = dd.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long', year: 'numeric' });
      const isOverdue = dd < new Date() && !d.is_settled;
      text += `📅 Jatuh tempo: ${isOverdue ? '🔴 ' : '📅 '}${jakartaDate}\n`;
    }
    if (createdAt) {
      const cd = new Date(createdAt);
      const jakartaCreated = cd.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long', year: 'numeric' });
      text += `📆 Dibuat: ${jakartaCreated}\n`;
    }
    if (d.is_settled && d.settled_at) {
      const sd = new Date(d.settled_at as string);
      const jakartaSettled = sd.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long', year: 'numeric' });
      text += `✅ Lunas: ${jakartaSettled}\n`;
    }

    const keyboard: unknown[][] = [];
    if (!d.is_settled) {
      keyboard.push([
        { text: '✅ Tandai Lunas', callback_data: `debt:settle:${debtId}` },
        { text: '🗑️ Hapus', callback_data: `debt:del:${debtId}` },
      ]);
    } else {
      keyboard.push([{ text: '🗑️ Hapus', callback_data: `debt:del:${debtId}` }]);
    }
    keyboard.push([{ text: '🔙 Kembali', callback_data: 'menu_debt' }]);

    await editMsgText(chatId, msgId, text, keyboard);
  } catch (e) {
    await editMsgText(chatId, msgId, `⚠️ Error: ${e}`,
      [[{ text: '🔙 Kembali', callback_data: 'menu_debt' }]]);
  }
}

async function showDebtHistory(chatId: number, userId: number, msgId: number): Promise<void> {
  try {
    const debts = await sbGet(
      'debts',
      `select=*&user_id=eq.${userId}&is_settled=eq.true&order=settled_at.desc&limit=20`
    ) as Record<string, unknown>[];

    const allDebts = Array.isArray(debts) ? debts : [];

    if (allDebts.length === 0) {
      await editMsgText(chatId, msgId,
        `✅ <b>Riwayat Lunas</b>\n\nBelum ada piutang/utang yang lunas bro.`,
        [[{ text: '🔙 Kembali', callback_data: 'menu_debt' }]]
      );
      return;
    }

    let text = `✅ <b>Riwayat Lunas</b>\n\n`;
    for (let i = 0; i < allDebts.length; i++) {
      const d = allDebts[i];
      const type = d.type as string;
      const personName = (d.person_name as string) || '?';
      const amount = Number(d.amount || 0);
      const settledAt = d.settled_at as string;
      const emoji = type === 'piutang' ? '📥' : '📤';
      const sd = new Date(settledAt);
      const jakartaDate = sd.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short' });
      text += `${i + 1}. ${emoji} ${escapeHtml(personName)} — ${formatRupiah(amount)} (${jakartaDate})\n`;
    }

    await editMsgText(chatId, msgId, text,
      [[{ text: '🔙 Kembali', callback_data: 'menu_debt' }]]
    );
  } catch (e) {
    await editMsgText(chatId, msgId, `⚠️ Error: ${e}`,
      [[{ text: '🔙 Kembali', callback_data: 'menu_debt' }]]);
  }
}

// ─────────────── ENSURE USER (direct REST, no RPC dependency) ───────────────

async function ensureUser(userId: number, username: string): Promise<void> {
  try {
    const cacheKey = `user:${userId}`;
    if (reqCache.has(cacheKey)) return; // Already ensured in this request
    
    await sbPost('users', { id: userId, username: username || 'unknown' }, 'on_conflict=id');
    reqCache.set(cacheKey, true);
  } catch (e) {
    // Ignore duplicate key errors (user already exists = success)
    console.error('ensureUser error:', e);
  }
}

// ─────────────── KEYBOARD BUILDERS ───────────────

function mainMenuKeyboard(): unknown[][] {
  return [
    [
      { text: '💰 Rekap', callback_data: 'menu_rekap' },
      { text: '📉 Cek Pengeluaran', callback_data: 'menu_exp' },
    ],
    [
      { text: '📈 Cek Pemasukan', callback_data: 'menu_inc' },
      { text: '📅 Jadwal Gua', callback_data: 'menu_agenda' },
    ],
    [
      { text: '📊 Budget', callback_data: 'menu_budget' },
      { text: '🔄 Rutin', callback_data: 'menu_recurring' },
    ],
    [
      { text: '💰 Piutang/Utang', callback_data: 'menu_debt' },
      { text: '💵 Setting Gaji', callback_data: 'menu_salary' },
    ],
    [
      { text: '🆘 Help', callback_data: 'menu_help' },
    ],
  ];
}

function rekapPeriodKeyboard(): unknown[][] {
  return [
    [
      { text: '📅 Hari Ini', callback_data: 'rekap:today' },
      { text: '📆 Minggu Ini', callback_data: 'rekap:week' },
    ],
    [
      { text: '🗓 Bulan Ini', callback_data: 'rekap:month' },
      { text: '📊 Tahun Ini', callback_data: 'rekap:year' },
    ],
    [
      { text: '📄 Download PDF Bulan Ini', callback_data: 'pdf_month:0' },
    ],
    [
      { text: '💵 Rekap Gaji', callback_data: 'menu_salary_rekap' },
    ],
    [
      { text: '🔙 Kembali', callback_data: 'menu_main' },
    ],
  ];
}

function txCategoryButtons(type: string, categories: string[]): unknown[][] {
  const rows: unknown[][] = [];
  for (const cat of categories) {
    rows.push([
      {
        text: `🗑️ Hapus ${cat}`,
        callback_data: `del:tx:${type}:${cat}`,
      },
      {
        text: `✏️ Edit ${cat}`,
        callback_data: `edit:tx:${type}:${cat}`,
      },
    ]);
  }
  rows.push([
    { text: '🔙 Kembali', callback_data: 'menu_main' },
  ]);
  return rows;
}

function confirmButtons(payload: string): unknown[][] {
  return [
    [
      { text: '✅ Yakin, Hapus!', callback_data: `cfm:${payload}` },
      { text: '❌ Batal', callback_data: 'cancel' },
    ],
  ];
}

// ─────────────── OPENROUTER AI (ONLY AS FALLBACK) ───────────────

function getAISystem(): string {
  return `SantuyBot, asisten keuangan & agenda. Bahasa Indonesia casual ("lu","gua","bro"). Respons 1-2 kalimat pakai emoji.

ATURAN:
- Kalau user nyebut CATAT pengeluaran/pemasukan/agenda → WAJIB function call WRITE (add_expense/add_income/add_agenda)
- Kalau user TANYA tentang keuangan (berapa pemasukan, pengeluaran, saldo, budget, piutang, utang, transaksi terakhir) → WAJIB function call READ (get_monthly_summary/get_recent_transactions/get_budget_status/get_debts_summary)
- Kalau user cuma nanya umum (bukan keuangan) → jawab text langsung tanpa function call
- Jumlah uang: konversi ke angka penuh ("25rb"→25000, "1.5jt"→1500000)
- Kategori expense: makan, transport, belanja, tagihan, hiburan, kesehatan, pendidikan, jajan, lainnya
- Kategori income: gaji, freelance, investasi, transfer, lainnya
- Hari ini = ${todayStr()}

FORMAT JAWABAN KEUANGAN:
- Pemasukan/pengeluaran → pakai format "Rp xxx.xxx"
- Saldo positif = 😊, negatif = 😬
- Berikan saran singkat kalau pengeluaran terlalu besar

CONTOH EXTRACT DESCRIPTION (WAJIB IKUT):
- "kemarin aku makan siang padang sama temen total 85rb" → amount:85000, category:"makan", description:"makan padang"
- "beli bensin motor full tank" → description:"bensin motor"
- "bayar listrik bulan ini 350rb" → description:"bayar listrik"
- "transfer ke ibu 500rb" → description:"transfer ke ibu"
- "nonton film di bioskop 50rb" → description:"nonton film"
- JANGAN sertakan kata: kemarin, besok, aku, total, sama temen, dll`;
}


// OpenAI-compatible tool definitions
function getAITools(): Record<string, unknown>[] {
  return [
    // ── WRITE tools ──
    {
      type: 'function' as const,
      function: {
        name: 'add_expense',
        description: 'Catat pengeluaran user',
        parameters: {
          type: 'object',
          properties: {
            amount: { type: 'number', description: 'Rupiah penuh (25000 bukan 25rb)' },
            category: { type: 'string', description: 'Kategori', enum: EXPENSE_CATS },
            description: { type: 'string', description: 'Inti kegiatan saja, 2-5 kata. HAPUS kata sambung, waktu (kemarin/besok), jumlah uang, kata total/dll. Contoh: "makan padang", "bensin motor", "bayar listrik"' },
          },
          required: ['amount', 'category'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'add_income',
        description: 'Catat pemasukan user',
        parameters: {
          type: 'object',
          properties: {
            amount: { type: 'number', description: 'Rupiah penuh' },
            category: { type: 'string', description: 'Kategori', enum: INCOME_CATS },
            description: { type: 'string', description: 'Sumber pemasukan, 2-5 kata. HAPUS jumlah uang & kata sambung. Contoh: "gaji bulanan", "freelance desain logo"' },
          },
          required: ['amount', 'category'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'add_agenda',
        description: 'Buat agenda/reminder',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Judul agenda singkat' },
            scheduled_time: { type: 'string', description: 'ISO 8601 datetime' },
            description: { type: 'string', description: 'Deskripsi tambahan' },
          },
          required: ['title', 'scheduled_time'],
        },
      },
    },
    // ── READ tools ──
    {
      type: 'function' as const,
      function: {
        name: 'get_monthly_summary',
        description: 'Ambil ringkasan keuangan bulan ini: total pemasukan, total pengeluaran, dan saldo. Gunakan saat user tanya tentang keuangan bulan ini.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'get_recent_transactions',
        description: 'Ambil daftar transaksi terakhir user. Gunakan saat user tanya tentang transaksi terbaru, pengeluaran terakhir, dll.',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Jumlah transaksi (default 5, max 10)' },
          },
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'get_budget_status',
        description: 'Ambil status budget per kategori bulan ini. Gunakan saat user tanya tentang budget, sisa budget, dll.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'get_debts_summary',
        description: 'Ambil ringkasan piutang & utang yang belum lunas. Gunakan saat user tanya tentang piutang/utang.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
  ];
}

async function callAI(userText: string, userId: number): Promise<{ text: string; actions: Record<string, unknown>[]; noKey?: boolean; rateLimited?: boolean }> {
  if (!AI_KEY) {
    console.warn('[AI] No auth configured — set AI_API_KEY.');
    return { text: '', actions: [], noKey: true };
  }

  // Check global rate limit
  if (Date.now() < aiRateLimitedUntil) {
    console.log('[AI] Rate limited, skipping');
    return { text: '', actions: [], rateLimited: true };
  }

  // Dedup: same text within this request
  const dedupKey = `ai:${userText}:${userId}`;
  const cached = reqCache.get<{ text: string; actions: Record<string, unknown>[]; rateLimited?: boolean; noKey?: boolean }>(dedupKey);
  if (cached) {
    console.log('[AI] Returning cached result for dedup');
    return cached;
  }

  // Helper: fetch with retry on 429
  async function fetchWithRetry(url: string, bodyObj: Record<string, unknown>, maxRetries = 1): Promise<Response | null> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AI_KEY}`,
        },
        body: JSON.stringify(bodyObj),
      });

      if (res.status === 429) {
        if (attempt < maxRetries) {
          const delay = 8000;
          console.warn(`[AI] Rate limited (429), retry ${attempt + 1}/${maxRetries} after ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        console.warn('[AI] Still rate limited after all retries.');
        return null;
      }

      return res;
    }
    return null;
  }

  try {
    // 1 API CALL ONLY — no follow-up. Konfirmasi dibikin sendiri di client.
    const body: Record<string, unknown> = {
      model: AI_MODEL,
      messages: [
        { role: 'system', content: getAISystem() },
        { role: 'user', content: userText },
      ],
      tools: getAITools(),
      tool_choice: 'auto',
      temperature: 0.1,
      max_tokens: 150,
    };

    const res = await fetchWithRetry(AI_URL, body);
    if (!res) {
      // Rate limited — set global backoff
      aiRateLimitedUntil = Date.now() + 60000;
      const result = { text: '', actions: [], rateLimited: true };
      reqCache.set(dedupKey, result, 60000);
      return result;
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[AI] API error ${res.status}:`, errText);
      // Don't treat non-429 errors as rate limit — just return empty
      return { text: '', actions: [] };
    }

    const data = await res.json() as Record<string, unknown>;
    const choices = data.choices as Record<string, unknown>[] | undefined;
    if (!choices || !choices[0]) {
      // Check if OpenRouter returned an error in the response body
      if (data.error) {
        console.error(`[AI] Error in response:`, JSON.stringify(data.error));
      }
      return { text: '', actions: [] };
    }

    const message = choices[0].message as Record<string, unknown>;
    const toolCalls = (message.tool_calls || []) as Record<string, unknown>[];
    const textResponse = (message.content || '') as string;

    // Execute function calls & buat konfirmasi sendiri (TANPA follow-up API call)
    if (toolCalls.length > 0) {
      const confirmLines: string[] = [];

      for (const tc of toolCalls) {
        const fname = (tc.function as Record<string, unknown>).name as string;
        const fargsRaw = (tc.function as Record<string, unknown>).arguments as string;
        const fargs = JSON.parse(fargsRaw || '{}') as Record<string, unknown>;
        const result = await executeGeminiFunction(fname, fargs, userId);
        confirmLines.push(result);
      }

      const result = { text: confirmLines.join('\n'), actions: toolCalls };
      reqCache.set(dedupKey, result, 30000);
      return result;
    }

    const result = { text: textResponse, actions: [] };
    reqCache.set(dedupKey, result, 30000);
    return result;
  } catch (e) {
    console.error('[AI] Error:', e);
    return { text: '', actions: [] };
  }
}

async function executeGeminiFunction(
  name: string,
  args: Record<string, unknown>,
  userId: number
): Promise<string> {
  try {
    switch (name) {
      case 'add_expense': {
        const result = await sbPost('transactions', {
          user_id: userId,
          type: 'expense',
          amount: args.amount,
          category: args.category || 'lainnya',
          description: (args.description as string) || '',
        });
        if (!result.ok) return `Error: ${result.error}`;
        return `✅ Pengeluaran ${formatRupiah(args.amount as number)} (${args.category}) ${args.description ? '- ' + (args.description as string) : ''}tercatat!`;
      }
      case 'add_income': {
        const result = await sbPost('transactions', {
          user_id: userId,
          type: 'income',
          amount: args.amount,
          category: args.category || 'lainnya',
          description: (args.description as string) || '',
        });
        if (!result.ok) return `Error: ${result.error}`;
        return `💰 Pemasukan ${formatRupiah(args.amount as number)} (${args.category}) ${args.description ? '- ' + (args.description as string) : ''}tercatat!`;
      }
      case 'add_agenda': {
        const result = await sbPost('agendas', {
          user_id: userId,
          title: args.title,
          scheduled_time: args.scheduled_time,
          description: (args.description as string) || '',
          is_completed: false,
          is_reminded: false,
        });
        if (!result.ok) return `Error: ${result.error}`;
        const agendaTime = new Date(args.scheduled_time as string);
        const agendaStr = agendaTime.toLocaleString('id-ID', {
          timeZone: 'Asia/Jakarta',
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
          hour: '2-digit', minute: '2-digit',
        });
        return `📅 <b>Agenda Dicatat!</b>\n\n📋 <b>${args.title}</b>\n⏰ ${agendaStr}\n\nNanti gua ingetin ya! 🔔`;
      }
      // ── READ tools (formatted response) ──
      case 'get_monthly_summary': {
        const monthStart = getJakartaMonthStart();
        const txns = await sbGet('transactions', `user_id=eq.${userId}&created_at=gte.${monthStart}&select=type,amount`);
        let totalIncome = 0, totalExpense = 0;
        for (const t of txns as { type: string; amount: number }[]) {
          if (t.type === 'income') totalIncome += t.amount;
          else totalExpense += t.amount;
        }
        const saldo = totalIncome - totalExpense;
        const saldoEmoji = saldo >= 0 ? '😊' : '😬';
        return `📊 <b>Ringkasan Bulan Ini</b>\n\n💰 Pemasukan: <b>${formatRupiah(totalIncome)}</b>\n💸 Pengeluaran: <b>${formatRupiah(totalExpense)}</b>\n${saldoEmoji} Saldo: <b>${formatRupiah(saldo)}</b>`;
      }
      case 'get_recent_transactions': {
        const limit = Math.min(10, Math.max(1, (args.limit as number) || 5));
        const txns = await sbGet('transactions', `user_id=eq.${userId}&select=type,amount,category,description,created_at&order=created_at.desc&limit=${limit}`);
        if (!txns.length) return '📭 Belum ada transaksi bro.';
        const lines = txns.map((t: Record<string, unknown>) => {
          const type = t.type === 'income' ? '💰' : '💸';
          const date = new Date(t.created_at as string).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
          const desc = (t.description as string) ? ` — ${t.description}` : '';
          return `${type} <b>${formatRupiah(t.amount as number)}</b> · ${t.category}${desc} · ${date}`;
        });
        return `📋 <b>Transaksi Terakhir</b>\n\n${lines.join('\n')}`;
      }
      case 'get_budget_status': {
        const budgets = await sbGet('budgets', `user_id=eq.${userId}&select=category,amount`);
        if (!budgets.length) return '📋 Belum ada budget yang diset bro. Ketik "budget makan 500rb" untuk mulai.';
        const spentMap = await getMonthlySpentBatch(userId);
        const lines = (budgets as { category: string; amount: number }[]).map(b => {
          const spent = spentMap.get(b.category) || 0;
          const pct = b.amount > 0 ? Math.round((spent / b.amount) * 100) : 0;
          const emoji = budgetStatusEmoji(pct);
          const bar = budgetProgressBar(pct);
          return `${emoji} ${b.category}\n   ${bar} ${formatRupiah(spent)} / ${formatRupiah(b.amount)} (${pct}%)`;
        });
        return `📊 <b>Status Budget Bulan Ini</b>\n\n${lines.join('\n\n')}`;
      }
      case 'get_debts_summary': {
        const debts = await sbGet('debts', `user_id=eq.${userId}&is_lunasi=eq.false&select=type,name,amount,description&order=created_at.desc`);
        if (!debts.length) return '✅ Ga ada piutang/utang aktif bro. Bersih! 🎉';
        const piutang = (debts as Record<string, unknown>[]).filter(d => d.type === 'piutang');
        const utang = (debts as Record<string, unknown>[]).filter(d => d.type === 'utang');
        const totalPiutang = piutang.reduce((s, d) => s + (d.amount as number), 0);
        const totalUtang = utang.reduce((s, d) => s + (d.amount as number), 0);
        const lines: string[] = [];
        if (piutang.length) {
          lines.push(`📥 <b>PIUTANG</b> (total: ${formatRupiah(totalPiutang)})`);
          lines.push(...piutang.map(d => `   • <b>${d.name}</b>: ${formatRupiah(d.amount as number)} ${d.description ? '- ' + (d.description as string) : ''}`));
        }
        if (utang.length) {
          lines.push(`📤 <b>UTANG</b> (total: ${formatRupiah(totalUtang)})`);
          lines.push(...utang.map(d => `   • <b>${d.name}</b>: ${formatRupiah(d.amount as number)} ${d.description ? '- ' + (d.description as string) : ''}`));
        }
        return `📋 <b>Piutang & Utang</b>\n\n${lines.join('\n\n')}`;
      }
      default:
        return `Function "${name}" tidak dikenali.`;
    }
  } catch (e) {
    return `Error executing ${name}: ${e}`;
  }
}

// ─────────────── REGEX PARSER (OFFLINE MODE — NO API NEEDED) ───────────────

// Filler words yang harus dihapus dari description (kata sambung, waktu, sapaan, dll)
const FILLER_WORDS = /\b(?:kemarin|besok|kemarinin|tadi|nanti|sekarang|hari\s*ini|bulan\s*ini|bulan\s*lalu|tahun\s*ini|pagi|siang|sore|malam|aku|gue|gua|lu|kamu|kita|dia|kita|sama|bareng|temen|teman|total|jadi|udah|sudah|lagi|mau|pengen|ninja|doang|banget|aja|saja|dong|kok|yah|ya|nih|ini|itu|buat|ke|di|dari|on|the|dan|atau|plus|minus|ceritanya|pas|waktu|ketika|saat|habis|abis|dah)\b/g;

function cleanDesc(raw: string): string {
  return raw.replace(FILLER_WORDS, '').replace(/[,\-\.]/g, '').replace(/\s+/g, ' ').trim();
}

interface RegexResult {
  handled: boolean;
  text: string;
  action?: string;
  data?: Record<string, unknown>;
}

function parseRegex(text: string): RegexResult {
  const lower = text.toLowerCase().trim();

  // ══════════ EXPENSE PATTERNS ══════════

  // Pattern 1: "beli/bayar/makan/jajan [desc] [amount]"
  const expenseVerbs = /(?:beli|bayar|makan|jajan|habis|keluar|spending|output|pengeluaran)/;
  if (expenseVerbs.test(lower)) {
    const amountMatch = lower.match(/(\d[\d.,]*\s*(?:rb|k|jt|m)?)/);
    const amount = amountMatch ? parseAmount(amountMatch[1]) : null;
    if (amount) {
      const desc = cleanDesc(lower.replace(expenseVerbs, '').replace(amountMatch[1], ''));
      const cat = guessCategory(desc || text, 'expense');
      return {
        handled: true,
        action: 'add_expense',
        data: { amount, category: cat, description: desc || cat },
        text: `📝 Oke bro, gua catat pengeluaran lu:\n💰 <b>${formatRupiah(amount)}</b> — ${escapeHtml(cat)}\n${desc ? '📌 ' + escapeHtml(desc) : ''}\n\nTetap jaga keuangan ya! 💪`,
      };
    }
  }

  // Pattern 2: "[amount] untuk/ke/beli [desc]"
  const amountFirst = lower.match(/^(\d[\d.,]*\s*(?:rb|k|jt|m)?)\s*(?:untuk|ke|buat|beli|bayar|di\s*)\s*(.+)/);
  if (amountFirst) {
    const amount = parseAmount(amountFirst[1]);
    if (amount) {
      const desc = cleanDesc(amountFirst[2].trim());
      const cat = guessCategory(desc, 'expense');
      return {
        handled: true,
        action: 'add_expense',
        data: { amount, category: cat, description: desc },
        text: `📝 Catat bro, pengeluaran lu:\n💰 <b>${formatRupiah(amount)}</b> — ${escapeHtml(cat)}\n📌 ${escapeHtml(desc)}\n\nSemoga ga overbudget! 🤞`,
      };
    }
  }

  // Pattern 3: "[category] [amount]" e.g. "makan 15rb", "transport 50rb"
  for (const cat of EXPENSE_CATS) {
    const pattern = new RegExp(`^${cat}\\s+(\\d[\\d.,]*\\s*(?:rb|k|jt|m)?)\\b`, 'i');
    const match = lower.match(pattern);
    if (match) {
      const amount = parseAmount(match[1]);
      if (amount) {
        return {
          handled: true,
          action: 'add_expense',
          data: { amount, category: cat, description: cat },
          text: `📝 Sip, pengeluaran ${escapeHtml(cat)}:\n💰 <b>${formatRupiah(amount)}</b>\n\nDicatat ya bro! 📌`,
        };
      }
    }
  }

  // Pattern 4: ★ GENERIC — "[any food/item keyword] [amount]" e.g. "bakso 18rb", "kopi 5rb", "nasi goreng 25rb"
  // This catches cases where no explicit verb is used
  const genericExpense = lower.match(/^(.+?)\s+(\d[\d.,]*\s*(?:rb|k|jt|m)?)\s*$/);
  if (genericExpense) {
    const desc = cleanDesc(genericExpense[1].trim());
    const rawAmount = genericExpense[2];
    const amount = parseAmount(rawAmount);
    if (amount && desc.length >= 2) {
      // Check if this looks like INCOME (gaji, terima, dapat, freelance, investasi, etc.)
      const incomeKeywords = /(?:gaji|terima|dapat|uang\s*masuk|income|pemasukan|masuk\s*duit|freelance|investasi|dividen|saham|reksa|transfer|kirim|dari\s*([a-z]))/;
      if (incomeKeywords.test(desc)) {
        // Treat as INCOME, not expense
        const cat = guessCategory(desc, 'income');
        return {
          handled: true,
          action: 'add_income',
          data: { amount, category: cat, description: desc },
          text: `🎉 Sip bro! Pemasukan gua catat:\n💵 <b>${formatRupiah(amount)}</b> — ${escapeHtml(cat)}\n📌 ${escapeHtml(desc)}\n\nDuit masuk! 😎`,
        };
      }
      // Treat as EXPENSE for anything else with a clear monetary suffix (rb/k/jt/m)
      if (/(?:rb|k|jt|m)/.test(rawAmount.toLowerCase())) {
        const cat = guessCategory(desc, 'expense');
        return {
          handled: true,
          action: 'add_expense',
          data: { amount, category: cat, description: desc },
          text: `📝 Sip bro, gua catat:\n💰 <b>${formatRupiah(amount)}</b> — ${escapeHtml(cat)}\n📌 ${escapeHtml(desc)}\n\nDicatat! 💪`,
        };
      }
    }
  }

  // ══════════ INCOME PATTERNS ══════════

  // Pattern 5: "gaji/terima/dapat/uang masuk [desc] [amount]"
  const incomeVerbs = /(?:gaji|terima|dapat|uang\s*masuk|income|pemasukan|masuk\s*duit)/;
  if (incomeVerbs.test(lower)) {
    const amountMatch = lower.match(/(\d[\d.,]*\s*(?:rb|k|jt|m)?)/);
    const amount = amountMatch ? parseAmount(amountMatch[1]) : null;
    if (amount) {
      const desc = cleanDesc(lower.replace(incomeVerbs, '').replace(amountMatch![1], ''));
      const cat = guessCategory(desc || text, 'income');
      return {
        handled: true,
        action: 'add_income',
        data: { amount, category: cat, description: desc || cat },
        text: `🎉 Mantap bro! Pemasukan dicatat:\n💵 <b>${formatRupiah(amount)}</b> — ${escapeHtml(cat)}\n${desc ? '📌 ' + escapeHtml(desc) : ''}\n\nDuit masuk, hati seneng! 😎`,
      };
    }
  }

  // Pattern 6: "[amount] masuk/dari" e.g. "500rb dari teman"
  const incomeAmountFirst = lower.match(/^(\d[\d.,]*\s*(?:rb|k|jt|m)?)\s*(?:masuk|dari)\s*(.*)/);
  if (incomeAmountFirst) {
    const amount = parseAmount(incomeAmountFirst[1]);
    if (amount) {
      const desc = cleanDesc(incomeAmountFirst[2].trim());
      const cat = guessCategory(desc, 'income');
      return {
        handled: true,
        action: 'add_income',
        data: { amount, category: cat, description: desc || cat },
        text: `🎉 Sip! Pemasukan gua catat:\n💵 <b>${formatRupiah(amount)}</b> — ${escapeHtml(cat)}\n${desc ? '📌 ' + escapeHtml(desc) : ''}\n\nKeren! 🥳`,
      };
    }
  }

  // ══════════ RECURRING EXPENSE PATTERN ══════════
  // "rutin netflix 153rb 5", "langganan spotify 50rb 10", "subscribe youtube 65rb 15"
  // "autodebet netflix 153rb 5 tagihan", "berlangganan spotify 50rb 10"
  const recurringMatch = lower.match(/(?:rutin|langganan|subscribe|berlangganan|autodebet)\s+(.+?)\s+(\d[\d.,]*\s*(?:rb|k|jt|m|juta|ribu))\s+(\d{1,2})(?:\s+(\w+))?\s*$/);
  if (recurringMatch) {
    const title = recurringMatch[1].trim();
    const amount = parseAmount(recurringMatch[2]);
    const day = parseInt(recurringMatch[3]);
    const category = guessCategory(recurringMatch[4] || title, 'expense');

    if (amount && amount > 0 && day >= 1 && day <= 31) {
      const titleCased = title.charAt(0).toUpperCase() + title.slice(1);
      return {
        handled: true,
        action: 'add_recurring',
        data: { title: titleCased, amount, payment_day: day, category },
        text: `🔄 <b>Pengeluaran Rutin Ditambah!</b>\n\n📋 ${escapeHtml(titleCased)}\n💰 ${formatRupiah(amount)} per bulan\n📅 Tanggal ${day}\n📂 ${escapeHtml(category)}\n\nBakal otomatis tercatat tiap bulan! 🔥`,
      };
    }
  }

  // ══════════ FINANCIAL QUERY PATTERNS (READ — no AI needed!) ══════════
  // Catches queries about financial data WITHOUT using AI tokens
  // "pendapatan bulan ini brp", "pengeluaran bulan ini berapa", "saldo bulan ini"

  // 1. Monthly summary (income/expense/saldo)
  const sumQ = /(?:pendapatan|pemasukan|pengeluaran|saldo|sisa|total|income|expense).*?(?:bulan\s*ini|bulan\s*lalu|tahun\s*ini|hari\s*ini|minggu\s*ini|skrng|sekarang).*?(?:berapa|brp|apa\b|gimana|gmn)/i;
  const sumQ2 = /(?:berapa|brp|apa\b|gimana|gmn).*?(?:pendapatan|pemasukan|pengeluaran|saldo|sisa|total|income|expense).*?(?:bulan\s*ini|bulan\s*lalu|tahun\s*ini|hari\s*ini|minggu\s*ini|skrng|sekarang)/i;
  if (sumQ.test(lower) || sumQ2.test(lower)) {
    return { handled: true, action: 'get_summary', text: '', data: {} };
  }

  // 2. Recent transactions
  const recentQ = /(?:transaksi|riwayat|history|catatan)\s+(?:terakhir|recent|terbaru|baru|hari\s*ini|minggu\s*ini)/i;
  if (recentQ.test(lower)) {
    return { handled: true, action: 'get_recent', text: '', data: {} };
  }

  // 3. Budget status
  const budgetQ = /(?:budget|budgetan).*?(?:berapa|brp|apa\b|status|sisa)/i;
  if (budgetQ.test(lower)) {
    return { handled: true, action: 'get_budget', text: '', data: {} };
  }

  // 4. Piutang/Utang status
  const debtQ = /(?:piutang|utang|hutang).*?(?:berapa|brp|apa\b|status|sisa|total)/i;
  if (debtQ.test(lower)) {
    return { handled: true, action: 'get_debts', text: '', data: {} };
  }

  // ══════════ DELETE/CLEAR AGENDA (must be BEFORE agenda creation!) ══════════
  // Catches: "bersihkan jadwal", "hapus semua agenda", "clear jadwal", "reset agenda",
  //          "hapus jadwal gua", "bersihkan semua reminder", etc.
  // Without this, "jadwal" inside "bersihkan jadwal" would trigger agenda creation.
  const clearAgendaVerbs = /(?:hapus|bersihkan|clear|reset|batal(?:kan)?|buang|clean)/;
  const clearAgendaNouns = /(?:jadwal|agenda|reminder|ingetan)/;
  if (clearAgendaVerbs.test(lower) && clearAgendaNouns.test(lower)) {
    return {
      handled: true,
      action: 'delete_all',
      data: { delete_type: 'agenda', label: 'jadwal' },
      text: `⚠️ <b>Konfirmasi Hapus Semua Agenda</b>\n\nLu yakin mau hapus SEMUA agenda lu?\n\n⚠️ Tindakan ini <b>GA BISA di-undo</b> bro!\n\nTekan tombol di bawah untuk konfirmasi 👇`,
    };
  }

  // ══════════ AGENDA QUERY (READ — must be BEFORE agenda creation!) ══════════
  // Catches queries about existing agendas (not creating new ones)
  // "jadwal gw apa", "apa aja agenda gw", "jadwal terdekat gw apa", "lihat jadwal"
  // NOT: "jadwal meeting jam 10", "catat agenda besok" (those fall through to creation)
  const agendaQCheck = /(?:jadwal|agenda|reminder|schedule)/;
  if (agendaQCheck.test(lower)) {
    const isAgendaQuery = /(?:apa|berapa|brp)/i.test(lower)
      || /(?:lihat|tampilin|tampilkan|show|cek|list|buka)/i.test(lower)
      || /(?:terdekat|berikutnya)/i.test(lower);
    if (isAgendaQuery) {
      return { handled: true, action: 'show_agenda', text: '', data: {} };
    }
  }

  // ══════════ AGENDA PATTERNS (IMPROVED) ══════════

  // ── 1. Trigger detection — all ways user might request agenda ──
  // Covers: inget/ingat, reminder, agenda, jadwal, todo/to-do, meeting, rapat,
  //          janji/janjian, catat, notif/alarm, task, appointment, schedule,
  //          call, video call, zoom, gmeet, google meet, seminar, workshop, webinar,
  //          olahraga/gym/futsal/badminton/bola (activity), libur/cuti (day-off)
  const agendaTriggers = /(?:inget(?:in)?|ingat(?:in)?|jangan\s*lupa|jgn\s*lupa|reminder|agenda|jadwal(?:kan)?|schedule|todo|to[- ]?do|task|list(?=\s)|meeting|rapat|diskusi|presentasi|present|briefing|janji(?:an)?|temu(?:an)?|pappoint|appointment|catat|notif(?:ikasi)?|alarm|peringatan|call|video[- ]?call|zoom|gmeet|google[- ]?meet|seminar|workshop|webinar|training|pelatihan|ujian|test|exam|tes|quiz|sidang|demosi|dokter|klinik|cek\s*kesehatan|medical|flight|penerbangan|kereta|tiket\s*ka|check[- ]?in|bayar\s*(?:cicilan|tagihan|listrik|wifi|bpjs|sewa|kontrak|pajak|parkir|tol|kuliah|spp|angsuran))/;

  // Also detect activity-type triggers (without explicit agenda keyword)
  const activityTriggers = /(?:gym|fitness|olahraga|lari|jogging|futsal|badminton|bola|basket|voli|renang|yoga|nonton|film|bioskop|konser|concert|karaoke|bowling|biliar|birthday|ulang\s*tahun|ultah|wisuda|nikah|pernikahan|khitanan|libur|cuti|vacation|jalan[- ]?jalan|jalan2|hangout|kumpul|gather|cus(?:tomer)?|klien|client|visit|dateng|datang|antar)/;

  if (agendaTriggers.test(lower) || activityTriggers.test(lower)) {
    // ── Use full text for date/time extraction (rest = the whole user input) ──
    const rest = lower;

    // ── Extract date + time first ──
    const dt = parseDateTime(rest);
    const timeDetected = !!parseRelTime(rest);

    // ── Extract title: remove ALL date/time/noise words ──
    // Keep activity trigger words IN the title (gym, bioskop, etc. are meaningful context)
    let title = rest;

    // Remove only the "function word" triggers (not content words like meeting, gym, etc.)
    // Strip: inget/ingat/reminder/agenda/jadwal/todo/task/catat/notif/alarm/janji/temu/call/zoom/gmeet/seminar/workshop/webinar/training/pelatihan
    title = title.replace(/(?:inget(?:in)?|ingat(?:in)?|jangan\s*lupa|jgn\s*lupa|reminder|agenda|jadwal(?:kan)?|schedule|todo|to[- ]?do|task|list(?=\s)|catat|notif(?:ikasi)?|alarm|peringatan|janji(?:an)?|temu(?:an)?|appointment|deadline|seminar|workshop|webinar|training|pelatihan|bayar(?=\s))/g, ' ');
    // Keep meeting/rapat/diskusi/presentasi/call/zoom/gmeet etc as they are likely the title topic

    // Remove date words
    title = title.replace(/hari\s*ini|sekarang|skrng|today/g, ' ');
    title = title.replace(/besok|lusa|kemarin/g, ' ');
    title = title.replace(/minggu\s*depan|pekan\s*depan/g, ' ');
    title = title.replace(/\d+\s*hari\s*(?:lagi|dari\s*now|kedepan|depan)/g, ' ');

    // Remove day names
    title = title.replace(/(?:senin|selasa|rabu|kamis|jumat|sabtu|minggu|ahad|isnin|rebo|kemis|jumah|saptu|sane|salasa|manis|tisna)(?:\s*(?:depan|besok|ini))?/gi, ' ');

    // Remove time patterns
    title = title.replace(/jam\s*\d{1,2}(?:[.:]\s*\d{1,2})?/g, ' ');
    title = title.replace(/\d{1,2}[.:]\d{2}/g, ' ');
    title = title.replace(/(?:tanggal|tgl)\s*\d{1,2}(?:\s*[\/\-]\s*\d{1,2})?/g, ' ');
    title = title.replace(/\d{1,2}\s*[\/\-]\s*\d{1,2}/g, ' ');
    title = title.replace(/\d{1,2}\s+(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan|feb|mar|apr|jun|jul|agu|sep|okt|nov|des)/gi, ' ');
    title = title.replace(/(?:pagi|siang|sore|malam|malem|subuh|dini\s*hari)/gi, ' ');

    // Remove noise/connector words
    title = title.replace(/\b(?:yang|dengan|untuk|buat|bareng|sama|ke|di|dari|pada|buat|di|pada|kepada|tentang|soal|mengenai|dengan|oleh|secara|itu|ini|sana|sini|lagi|nanti| juga|dong|ya|yah|nih|deh|banget|aja|saja|doang|kalau|kalo|klo|biar|supaya|agar|bisa|harus|mesti|perlu|wajib|wajib|jadi|gitu|gitu|sih|kok|kenapa|gimana|gmn|bro|ga|nggak|enggak|gak|tdk|tidak|udah|sudah|belum|mo|mau|pengen|pengin)\b/g, ' ');

    // Remove leading bullets/numbers
    title = title.replace(/^[-*•.]+\s*/, '');
    title = title.replace(/^\d+[.)]\s*/, '');

    // Clean up
    title = title.replace(/[\-,;:'"(){}\[\]<>]/g, ' ');
    title = title.replace(/\s+/g, ' ').trim();
    title = title.charAt(0).toUpperCase() + title.slice(1);

    // Fallback: if title is empty or too short (1-2 chars), use contextual default
    if (!title || title.length < 2) {
      // Re-check original text for meaningful keywords
      if (/meeting|rapat|diskusi|briefing/.test(lower)) title = 'Meeting';
      else if (/call|zoom|gmeet|video/.test(lower)) title = 'Video Call';
      else if (/dokter|klinik|cek\s*kesehatan/.test(lower)) title = 'Ke Dokter';
      else if (/gym|fitness|olahraga/.test(lower)) title = 'Gym / Olahraga';
      else if (/bayar\s*(?:cicilan|tagihan|listrik|wifi|bpjs|sewa|kontrak|pajak|parkir|tol|kuliah|spp|angsuran)/.test(lower)) {
        const bMatch = lower.match(/bayar\s*(cicilan|tagihan|listrik|wifi|bpjs|sewa|kontrak|pajak|parkir|tol|kuliah|spp|angsuran)/);
        title = bMatch ? `Bayar ${bMatch[1].charAt(0).toUpperCase() + bMatch[1].slice(1)}` : 'Bayar';
      }
      else if (/ujian|test|exam|tes|quiz|sidang/.test(lower)) title = 'Ujian';
      else if (/flight|penerbangan|kereta|tiket/.test(lower)) title = 'Perjalanan';
      else if (/birthday|ulang\s*tahun|ultah/.test(lower)) title = 'Ulang Tahun';
      else if (/nonton|bioskop|film|konser/.test(lower)) title = 'Nonton';
      else if (/libur|cuti/.test(lower)) title = 'Libur';
      else if (/deadline/.test(lower)) title = 'Deadline';
      else title = 'Agenda';
    }

    if (dt) {
      const scheduledDate = new Date(dt);
      const timeStr = scheduledDate.toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
      return {
        handled: true,
        action: 'add_agenda',
        data: { title, scheduled_time: dt },
        text: `📅 Sip bro, gua ingetin:\n\n📋 <b>${escapeHtml(title)}</b>\n⏰ ${timeStr}\n\nNanti gua kasih notif ya! 🔔`,
      };
    }

    // No date/time detected → default besok 09:00
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    jakartaSetHours(tomorrow, 9, 0);
    return {
      handled: true,
      action: 'add_agenda',
      data: { title, scheduled_time: tomorrow.toISOString() },
      text: `📅 Sip bro, gua catat agendanya:\n\n📋 <b>${escapeHtml(title)}</b>\n⏰ Besok 09:00\n\n${timeDetected ? '' : 'Kasih waktu spesifik biar lebih akurat ya! 🔔'}`,
    };
  }

  // ══════════ BUDGET PATTERN ══════════
  // "budget makan 500rb", "budget transport 1jt", "budget kuliah 2.5jt"
  const budgetMatch = lower.match(/^budget\s+(.+?)(?:\s+(\d[\d.,]*\s*(?:rb|k|jt|m|juta|ribu)))?\s*$/);
  if (budgetMatch) {
    const rawCat = budgetMatch[1].trim();
    const rawAmount = budgetMatch[2];

    // Map common aliases to categories
    let category = '';
    const catLower = rawCat.toLowerCase();
    for (const c of EXPENSE_CATS) {
      if (catLower === c || catLower.includes(c)) {
        category = c;
        break;
      }
    }
    // Extra alias mapping
    if (!category) {
      if (/kuliah|buku|kursus|seminar/.test(catLower)) category = 'pendidikan';
      else if (/dokter|obat|apotek|vitamin|rs/.test(catLower)) category = 'kesehatan';
      else if (/nonton|film|game|netflix|spotify/.test(catLower)) category = 'hiburan';
      else if (/gojek|grab|bensin|parkir|tol|bus/.test(catLower)) category = 'transport';
      else if (/listrik|wifi|internet|bpjs|pulsa/.test(catLower)) category = 'tagihan';
      else if (/belanja|baju|celana|sepatu|shopee/.test(catLower)) category = 'belanja';
      else if (/jajan|boba|eskrim/.test(catLower)) category = 'jajan';
      else if (/makan|nasi|kopi|bakso|mie|goreng/.test(catLower)) category = 'makan';
    }
    if (!category) category = catLower;

    if (rawAmount) {
      const amount = parseAmount(rawAmount);
      if (amount && amount > 0) {
        return {
          handled: true,
          action: 'set_budget',
          data: { category, amount },
          text: `💰 <b>Budget ${escapeHtml(category.charAt(0).toUpperCase() + category.slice(1))} Diset!</b>\n\n📊 Budget bulanan: <b>${formatRupiah(amount)}</b>\n\nSip bro, pengeluaran lu bakal ke monitor! 🔥`,
        };
      }
    }

    // No amount — show budget status or prompt
    return {
      handled: true,
      action: 'set_budget',
      data: { category, amount: 0 },
      text: '',
    };
  }

  // ══════════ DEBT PATTERN ══════════
  // "piutang budi 500rb", "utang andi 1jt", "hutang ke budi 200rb", "budi hutangin 500rb"
  const debtPiutangMatch = lower.match(/(?:piutang|hutang\s*(?:ke|dari)?)\s+(.+?)\s+(\d[\d.,]*\s*(?:rb|k|jt|m|juta|ribu))/);
  const debtUtangMatch = lower.match(/(?:utang|hutang)\s+(?:ke\s+)?(.+?)\s+(\d[\d.,]*\s*(?:rb|k|jt|m|juta|ribu))/);

  if (debtPiutangMatch) {
    const person = cleanDesc(debtPiutangMatch[1].trim());
    const amount = parseAmount(debtPiutangMatch[2]);
    if (amount && person.length >= 2) {
      return {
        handled: true,
        action: 'add_debt',
        data: { type: 'piutang', person_name: person, amount, description: '' },
        text: `📥 <b>Piutang Dicatat!</b>\n\n👤 ${escapeHtml(person)}\n💰 <b>${formatRupiah(amount)}</b>\n\nOrang lain hutang ke lu ya bro! Catat biar ga lupa 📝`,
      };
    }
  }

  if (debtUtangMatch && !debtPiutangMatch) {
    const person = cleanDesc(debtUtangMatch[1].trim());
    const amount = parseAmount(debtUtangMatch[2]);
    if (amount && person.length >= 2) {
      return {
        handled: true,
        action: 'add_debt',
        data: { type: 'utang', person_name: person, amount, description: '' },
        text: `📤 <b>Utang Dicatat!</b>\n\n👤 ${escapeHtml(person)}\n💰 <b>${formatRupiah(amount)}</b>\n\nLu hutang ke orang lain ya bro! Jangan lupa bayar ya 💪`,
      };
    }
  }

  // ══════════ SEARCH PATTERN ══════════

  const searchMatch = lower.match(/(?:cari|search|find|temukan)\s+(.+)/);
  if (searchMatch) {
    return {
      handled: true,
      action: 'search',
      data: { keyword: searchMatch[1].trim() },
      text: '',
    };
  }

  // ══════════ DELETE ALL PATTERN ══════════
  // Catches: "hapus semua pengeluaran", "delete all expenses", "clear all transaksi",
  //          "tolong hapus pengeluaran saya", "bersihkan semua data", "hapus seluruh catatan", etc.
  const deleteAllVerbs = /(?:hapus|delete|clear|bersihkan|reset|buang)/;
  const deleteAllNouns = /(?:pengeluaran|expense|keluaran|pemasukan|income|transaksi|data|catatan|riwayat|jadwal|agenda|reminder|semua)/;
  if (deleteAllVerbs.test(lower) && deleteAllNouns.test(lower)) {
    let delType = '';
    let label = '';
    if (/pengeluaran|expense|keluar/.test(lower)) {
      delType = 'expense';
      label = 'pengeluaran';
    } else if (/pemasukan|income|masuk/.test(lower)) {
      delType = 'income';
      label = 'pemasukan';
    } else if (/jadwal|agenda|reminder/.test(lower)) {
      delType = 'agenda';
      label = 'jadwal';
    } else {
      // transaksi/data/catatan/riwayat → hapus semua
      delType = 'all';
      label = 'semua transaksi';
    }
    return {
      handled: true,
      action: 'delete_all',
      data: { delete_type: delType, label },
      text: `⚠️ <b>Konfirmasi Hapus ${escapeHtml(label.charAt(0).toUpperCase() + label.slice(1))}</b>\n\nLu yakin mau hapus SEMUA ${escapeHtml(label)} lu?\n\n⚠️ Tindakan ini <b>GA BISA di-undo</b> bro!\n\nTekan tombol di bawah untuk konfirmasi 👇`,
    };
  }

  // ══════════ FINANCIAL QUERY PATTERNS (NO AI NEEDED) ══════════

  // Pattern: tanya tentang pendapatan/pemasukan bulan ini
  const summaryQuery = /(?:pendapatan|pemasukan|penghasilan|income|earning|gaji|bulan ini|keuangan|finance|summary|ringkasan|laporan|report).*?(?:berapa|brp|sisa|total|gimana|bagaimana|status)/i;
  const summaryQuery2 = /(?:berapa|brp|sisa|total|gimana|bagaimana|status).*(?:pendapatan|pemasukan|penghasilan|gaji|bulan ini|keuangan|pengeluaran|saldo|expense)/i;
  const summaryQuery3 = /(?:keuangan|finance|laporan|report|summary|ringkasan|statistik|stats)(?:\s+(?:bulanan|bulan|ini|gw|gue|gua|lu|saya))?/i;
  if (summaryQuery.test(lower) || summaryQuery2.test(lower) || summaryQuery3.test(lower)) {
    return { handled: true, action: 'get_summary', data: {}, text: '' };
  }

  // Pattern: tanya tentang transaksi terakhir / riwayat
  const recentQuery = /(?:transaksi|riwayat|history|catatan|record|terakhir|recent|latest).*?(?:berapa|brp|apa|gimana|saya|gw|gue|gua|lu|tadi|kemarin)?/i;
  const recentQuery2 = /(?:berapa|apa|tampilkan|lihat|show|cek|check).*(?:transaksi|riwayat|catatan|pengeluaran|pemasukan|history|terakhir|recent)/i;
  if (recentQuery.test(lower) || recentQuery2.test(lower)) {
    return { handled: true, action: 'get_recent', data: {}, text: '' };
  }

  // Pattern: tanya tentang budget
  const budgetQuery = /(?:budget|anggaran|sisa\s*budget|cek\s*budget|status\s*budget)/i;
  if (budgetQuery.test(lower)) {
    return { handled: true, action: 'get_budget', data: {}, text: '' };
  }

  // Pattern: tanya tentang piutang/utang
  const debtQuery = /(?:piutang|utang|hutang|berhutang|dipinjam|meminjam|ngebon|bon|kredit).*?(?:berapa|brp|sisa|status|list|daftar)?/i;
  const debtQuery2 = /(?:berapa|brp|sisa|status|list|daftar|cek|check).*(?:piutang|utang|hutang)/i;
  if (debtQuery.test(lower) || debtQuery2.test(lower)) {
    return { handled: true, action: 'get_debts', data: {}, text: '' };
  }

  // ══════════ NOT HANDLED BY REGEX ══════════
  return { handled: false, text: '' };
}

// ─────────────── PDF MONTHLY REPORT ───────────────

const CAT_COLORS: number[][] = [
  [37, 99, 235],    // makan
  [249, 115, 22],   // transport
  [147, 51, 234],   // belanja
  [22, 163, 74],    // tagihan
  [236, 72, 153],   // hiburan
  [6, 182, 212],    // kesehatan
  [234, 179, 8],    // pendidikan
  [220, 38, 38],    // jajan
  [100, 116, 139],  // lainnya
];

const CAT_LABELS: Record<string, number> = {
  makan: 0, transport: 1, belanja: 2, tagihan: 3,
  hiburan: 4, kesehatan: 5, pendidikan: 6, jajan: 7, lainnya: 8,
  gaji: 0, freelance: 1, investasi: 2, transfer: 3,
};

function getCatColor(cat: string): number[] {
  return CAT_COLORS[CAT_LABELS[cat] ?? 8] || CAT_COLORS[8];
}

async function sendPDFDocument(chatId: number, pdfBytes: Uint8Array, filename: string): Promise<boolean> {
  try {
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('document', blob, filename);
    form.append('caption', 'Laporan keuangan bulanan lu udah siap bro!');

    const res = await fetch(`${TG_API}/sendDocument`, { method: 'POST', body: form });
    return res.ok;
  } catch (e) {
    console.error('PDF send error:', e);
    return false;
  }
}

async function generateRekapPDF(userId: number, monthOffset: number): Promise<Uint8Array | null> {
  try {
    const { jsPDF } = await import('https://esm.sh/jspdf@2.5.2');

    // ── Date range ──
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth() - monthOffset, 1);
    const monthStr = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}`;
    const nextM = new Date(target.getFullYear(), target.getMonth() + 1, 1);
    const nextStr = `${nextM.getFullYear()}-${String(nextM.getMonth() + 1).padStart(2, '0')}`;
    const MONTHS = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
    const label = `${MONTHS[target.getMonth()]} ${target.getFullYear()}`;

    // ── Fetch data ──
    const incomes = await sbGet('transactions',
      `select=amount,category,description,created_at&user_id=eq.${userId}&type=eq.income&created_at=gte.${monthStr}-01T00:00:00Z&created_at=lt.${nextStr}-01T00:00:00Z&order=created_at.asc`
    ) as Record<string, unknown>[];
    const expenses = await sbGet('transactions',
      `select=amount,category,description,created_at&user_id=eq.${userId}&type=eq.expense&created_at=gte.${monthStr}-01T00:00:00Z&created_at=lt.${nextStr}-01T00:00:00Z&order=created_at.asc`
    ) as Record<string, unknown>[];

    // ── Calculate ──
    let totalInc = 0, totalExp = 0;
    const expCats: Record<string, number> = {};
    const incCats: Record<string, number> = {};
    for (const r of (incomes || [])) { const a = Number(r.amount)||0; totalInc+=a; const c=(r.category as string)||'lainnya'; incCats[c]=(incCats[c]||0)+a; }
    for (const r of (expenses|| [])) { const a = Number(r.amount)||0; totalExp+=a; const c=(r.category as string)||'lainnya'; expCats[c]=(expCats[c]||0)+a; }
    const balance = totalInc - totalExp;
    const savingsPct = totalInc > 0 ? ((balance / totalInc) * 100) : 0;

    // ── PDF setup ──
    const doc = new jsPDF('p', 'mm', 'a4');
    const W = doc.internal.pageSize.getWidth();   // 210
    const H = doc.internal.pageSize.getHeight();  // 297
    const M = 15;
    const cW = W - M * 2;
    let y = 0;

    // ── Helper: page break check ──
    function needSpace(need: number): void {
      if (y + need > H - 20) { doc.addPage(); y = M; }
    }

    // ── Helper: draw rounded rect ──
    function rRect(x: number, yy: number, w: number, h: number, r: number): void {
      doc.setLineWidth(0.3);
      doc.roundedRect(x, yy, w, h, r, r, 'S');
    }

    // ═══ PAGE 1: HEADER ═══
    doc.setFillColor(37, 99, 235);
    doc.rect(0, 0, W, 30, 'F');
    doc.setTextColor(255);
    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.text('SANTUYBOT', W / 2, 12, { align: 'center' });
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(`Laporan Keuangan Bulanan - ${label}`, W / 2, 21, { align: 'center' });

    // ═══ SUMMARY CARDS ═══
    y = 38;
    const cardW = (cW - 8) / 3;
    const cardH = 24;

    // Income card
    doc.setFillColor(240, 253, 244);
    doc.roundedRect(M, y, cardW, cardH, 3, 3, 'F');
    rRect(M, y, cardW, cardH, 3);
    doc.setTextColor(22, 163, 74);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.text('PEMASUKAN', M + cardW / 2, y + 8, { align: 'center' });
    doc.setFontSize(13);
    doc.text(formatRupiah(totalInc), M + cardW / 2, y + 17, { align: 'center' });

    // Expense card
    const x2 = M + cardW + 4;
    doc.setFillColor(254, 242, 242);
    doc.roundedRect(x2, y, cardW, cardH, 3, 3, 'F');
    rRect(x2, y, cardW, cardH, 3);
    doc.setTextColor(220, 38, 38);
    doc.setFontSize(8);
    doc.text('PENGELUARAN', x2 + cardW / 2, y + 8, { align: 'center' });
    doc.setFontSize(13);
    doc.text(formatRupiah(totalExp), x2 + cardW / 2, y + 17, { align: 'center' });

    // Balance card
    const x3 = M + (cardW + 4) * 2;
    if (balance >= 0) { doc.setFillColor(240, 253, 244); } else { doc.setFillColor(254, 242, 242); }
    doc.roundedRect(x3, y, cardW, cardH, 3, 3, 'F');
    rRect(x3, y, cardW, cardH, 3);
    if (balance >= 0) { doc.setTextColor(22, 163, 74); } else { doc.setTextColor(220, 38, 38); }
    doc.setFontSize(8);
    doc.text('SALDO', x3 + cardW / 2, y + 8, { align: 'center' });
    doc.setFontSize(13);
    doc.text(formatRupiah(balance), x3 + cardW / 2, y + 17, { align: 'center' });

    // ═══ SAVINGS RATE BAR ═══
    y = 70;
    doc.setTextColor(30, 41, 59);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text('Tingkat Tabungan', M, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    const pctLabel = savingsPct >= 0 ? `${savingsPct.toFixed(1)}%` : `${savingsPct.toFixed(1)}%`;
    doc.text(pctLabel, M + cW, y, { align: 'right' });
    y += 4;
    // background bar
    doc.setFillColor(241, 245, 249);
    doc.roundedRect(M, y, cW, 8, 2, 2, 'F');
    // fill bar
    const fillW = Math.max(0, Math.min(cW, (Math.abs(savingsPct) / 100) * cW));
    if (fillW > 1) {
      doc.setFillColor(savingsPct >= 0 ? 22 : 220, savingsPct >= 0 ? 163 : 38, savingsPct >= 0 ? 74 : 38);
      doc.roundedRect(M, y, fillW, 8, 2, 2, 'F');
    }
    // percentage text inside bar
    doc.setTextColor(255);
    doc.setFontSize(7);
    if (fillW > 25) {
      doc.text(`${savingsPct >= 0 ? 'Disimpan' : 'Defisit'} ${Math.abs(savingsPct).toFixed(1)}%`, M + fillW / 2, y + 5.5, { align: 'center' });
    }

    // ═══ EXPENSE BREAKDOWN BAR CHART ═══
    y = 90;
    needSpace(60);
    doc.setTextColor(30, 41, 59);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('Pengeluaran per Kategori', M, y);
    y += 3;

    const expSorted = Object.entries(expCats).sort((a, b) => b[1] - a[1]);
    if (expSorted.length > 0) {
      const barMaxW = cW - 85;
      for (let i = 0; i < Math.min(expSorted.length, 8); i++) {
        y += 7;
        const [cat, amt] = expSorted[i];
        const pct = totalExp > 0 ? (amt / totalExp) * 100 : 0;
        const barW = Math.max(2, (pct / 100) * barMaxW);
        const col = getCatColor(cat);

        // category label
        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(30, 41, 59);
        doc.text(capitalize(cat), M, y + 3);

        // bar
        doc.setFillColor(col[0], col[1], col[2]);
        doc.roundedRect(M + 30, y, barW, 6, 1, 1, 'F');

        // percentage
        doc.setFontSize(7);
        doc.setTextColor(100, 116, 139);
        doc.text(`${pct.toFixed(0)}%`, M + 35 + barW, y + 3);

        // amount
        doc.setFontSize(7);
        doc.setTextColor(30, 41, 59);
        doc.text(formatRupiah(amt), M + cW, y + 3, { align: 'right' });
      }
    } else {
      y += 8;
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(148, 163, 184);
      doc.text('Belum ada pengeluaran bulan ini.', M, y);
    }

    // ═══ INCOME BREAKDOWN ═══
    y += 16;
    needSpace(40);
    doc.setTextColor(30, 41, 59);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('Sumber Pemasukan', M, y);
    y += 3;

    const incSorted = Object.entries(incCats).sort((a, b) => b[1] - a[1]);
    if (incSorted.length > 0) {
      for (const [cat, amt] of incSorted) {
        y += 7;
        const pct = totalInc > 0 ? (amt / totalInc) * 100 : 0;
        const col = getCatColor(cat);
        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(30, 41, 59);
        doc.text(capitalize(cat), M, y + 3);
        doc.text(formatRupiah(amt), M + 30, y + 3);
        doc.setTextColor(100, 116, 139);
        doc.setFontSize(7);
        doc.text(`${pct.toFixed(1)}%`, M + cW, y + 3, { align: 'right' });
      }
    } else {
      y += 8;
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(148, 163, 184);
      doc.text('Belum ada pemasukan bulan ini.', M, y);
    }

    // ═══ PAGE 2+: TRANSACTION DETAILS ═══
    doc.addPage();
    y = M;

    // Expense details
    doc.setTextColor(30, 41, 59);
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text(`Detail Pengeluaran - ${label}`, M, y);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(148, 163, 184);
    doc.text(`${(expenses||[]).length} transaksi`, M + cW, y, { align: 'right' });
    y += 5;

    if ((expenses || []).length > 0) {
      // Table header
      doc.setFillColor(37, 99, 235);
      doc.roundedRect(M, y, cW, 7, 1, 1, 'F');
      doc.setTextColor(255);
      doc.setFontSize(7);
      doc.setFont('helvetica', 'bold');
      doc.text('#', M + 3, y + 4.5);
      doc.text('Tanggal', M + 12, y + 4.5);
      doc.text('Kategori', M + 35, y + 4.5);
      doc.text('Keterangan', M + 62, y + 4.5);
      doc.text('Jumlah', M + cW - 2, y + 4.5, { align: 'right' });
      y += 7;

      for (let i = 0; i < expenses.length; i++) {
        const r = expenses[i];
        if (y > H - 25) { doc.addPage(); y = M; }
        if (i % 2 === 0) {
          doc.setFillColor(248, 250, 252);
          doc.rect(M, y - 2, cW, 6.5, 'F');
        }
        doc.setTextColor(30, 41, 59);
        doc.setFontSize(7);
        doc.setFont('helvetica', 'normal');
        doc.text(String(i + 1), M + 3, y + 2.5);
        const d = (r.created_at as string) ? new Date(r.created_at as string) : null;
        doc.text(d ? d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }) : '-', M + 12, y + 2.5);
        doc.text(capitalize((r.category as string) || '-'), M + 35, y + 2.5);
        doc.setTextColor(100, 116, 139);
        const desc = ((r.description as string) || '-').substring(0, 35);
        doc.text(desc, M + 62, y + 2.5);
        doc.setTextColor(220, 38, 38);
        doc.setFont('helvetica', 'bold');
        doc.text(formatRupiah(Number(r.amount) || 0), M + cW - 2, y + 2.5, { align: 'right' });
        y += 6;
      }

      // Expense total
      y += 2;
      doc.setDrawColor(37, 99, 235);
      doc.setLineWidth(0.5);
      doc.line(M, y, M + cW, y);
      y += 5;
      doc.setTextColor(220, 38, 38);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.text('Total Pengeluaran', M, y);
      doc.text(formatRupiah(totalExp), M + cW, y, { align: 'right' });
    }

    // Income details
    y += 14;
    needSpace(40);
    doc.setTextColor(30, 41, 59);
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text(`Detail Pemasukan - ${label}`, M, y);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(148, 163, 184);
    doc.text(`${(incomes||[]).length} transaksi`, M + cW, y, { align: 'right' });
    y += 5;

    if ((incomes || []).length > 0) {
      doc.setFillColor(22, 163, 74);
      doc.roundedRect(M, y, cW, 7, 1, 1, 'F');
      doc.setTextColor(255);
      doc.setFontSize(7);
      doc.setFont('helvetica', 'bold');
      doc.text('#', M + 3, y + 4.5);
      doc.text('Tanggal', M + 12, y + 4.5);
      doc.text('Kategori', M + 35, y + 4.5);
      doc.text('Keterangan', M + 62, y + 4.5);
      doc.text('Jumlah', M + cW - 2, y + 4.5, { align: 'right' });
      y += 7;

      for (let i = 0; i < incomes.length; i++) {
        const r = incomes[i];
        if (y > H - 25) { doc.addPage(); y = M; }
        if (i % 2 === 0) {
          doc.setFillColor(248, 250, 252);
          doc.rect(M, y - 2, cW, 6.5, 'F');
        }
        doc.setTextColor(30, 41, 59);
        doc.setFontSize(7);
        doc.setFont('helvetica', 'normal');
        doc.text(String(i + 1), M + 3, y + 2.5);
        const d = (r.created_at as string) ? new Date(r.created_at as string) : null;
        doc.text(d ? d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }) : '-', M + 12, y + 2.5);
        doc.text(capitalize((r.category as string) || '-'), M + 35, y + 2.5);
        doc.setTextColor(100, 116, 139);
        const desc = ((r.description as string) || '-').substring(0, 35);
        doc.text(desc, M + 62, y + 2.5);
        doc.setTextColor(22, 163, 74);
        doc.setFont('helvetica', 'bold');
        doc.text(formatRupiah(Number(r.amount) || 0), M + cW - 2, y + 2.5, { align: 'right' });
        y += 6;
      }

      y += 2;
      doc.setDrawColor(22, 163, 74);
      doc.setLineWidth(0.5);
      doc.line(M, y, M + cW, y);
      y += 5;
      doc.setTextColor(22, 163, 74);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.text('Total Pemasukan', M, y);
      doc.text(formatRupiah(totalInc), M + cW, y, { align: 'right' });
    }

    // ═══ FOOTER ═══
    y = H - 12;
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.3);
    doc.line(M, y, M + cW, y);
    doc.setTextColor(148, 163, 184);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.text(`Generated by SantuyBot | ${now.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}`, W / 2, y + 5, { align: 'center' });

    return new Uint8Array(doc.output('arraybuffer'));
  } catch (e) {
    console.error('PDF generation error:', e);
    return null;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─────────────── COMMAND HANDLERS ───────────────

async function cmdStart(chatId: number, user: Record<string, unknown>): Promise<void> {
  const username = (user.username as string) || (user.first_name as string) || 'bro';
  const welcomeText =
    `🤙 <b>Yo ${escapeHtml(username)}! Gua SantuyBot!</b>\n\n` +
    `Asisten keuangan & agenda pribadi lu yang paling santai 🌴\n\n` +
    `Gua bisa bantu lu:\n` +
    `📝 Catat pengeluaran & pemasukan\n` +
    `📅 Buat agenda & reminder\n` +
    `📊 Rekap keuangan\n` +
    `🔍 Cari transaksi\n\n` +
    `Cukup tulis bahasa biasa aja bro, gua ngerti! 🧠\n\n` +
    `Contoh:\n` +
    `• "bakso 18rb"\n` +
    `• "beli nasi goreng 25000"\n` +
    `• "gaji 5jt"\n` +
    `• "inget meeting besok jam 10"\n\n` +
    `Atau pake menu di bawah 👇`;

  await sendTextWithKeyboard(chatId, welcomeText, mainMenuKeyboard());
}

async function cmdHelp(chatId: number): Promise<void> {
  const helpText =
    `🆘 <b>Bantuan SantuyBot</b>\n\n` +
    `📝 <b>Catat Pengeluaran:</b>\n` +
    `• "bakso 18rb" (langsung tulis!)\n` +
    `• "beli nasi goreng 25000"\n` +
    `• "bayar listrik 500rb"\n` +
    `• "15rb untuk jajan"\n\n` +
    `💵 <b>Catat Pemasukan:</b>\n` +
    `• "gaji 5jt"\n` +
    `• "terima project 2jt"\n` +
    `• "500rb dari teman"\n\n` +
    `📅 <b>Buat Agenda:</b>\n` +
    `• "inget meeting besok jam 10"\n` +
    `• "reminder dokter senin jam 14"\n\n` +
    `🔍 <b>Cari Transaksi:</b>\n` +
    `• "cari makan"\n` +
    `• "search grab"\n\n` +
    `📊 <b>Rekap:</b>\n` +
    `• "rekap bulan ini"\n\n` +
    `Tulis aja bahasa santai, gua pasti ngerti! 😎`;

  await sendTextWithKeyboard(chatId, helpText, mainMenuKeyboard());
}

// ─────────────── FEATURE HANDLERS (all via direct REST) ───────────────

async function showRekap(chatId: number, userId: number, period: string): Promise<void> {
  // Auto-process salary for this month (ALL periods, not just month/year)
  await processSalaryForMonth(userId);

  const periodLabels: Record<string, string> = {
    today: 'Hari Ini',
    week: 'Minggu Ini',
    month: 'Bulan Ini',
    year: 'Tahun Ini',
  };

  // Calculate date range
  const now = new Date();
  let startDate: string;

  switch (period) {
    case 'today':
      startDate = now.toISOString().split('T')[0];
      break;
    case 'week': {
      const d = new Date(now);
      d.setDate(d.getDate() - d.getDay() + (d.getDay() === 0 ? -6 : 1));
      startDate = d.toISOString().split('T')[0];
      break;
    }
    case 'month':
      startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      break;
    case 'year':
      startDate = `${now.getFullYear()}-01-01`;
      break;
    default:
      startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  }

  try {
    const results = await sbGet(
      'transactions',
      `select=type,amount,category&user_id=eq.${userId}&created_at=gte.${startDate}T00:00:00Z&order=created_at.desc&limit=1000`
    ) as Record<string, unknown>[];

    let totalExp = 0;
    let totalInc = 0;
    const catMap: Record<string, number> = {};

    if (Array.isArray(results)) {
      for (const r of results) {
        const amt = Number(r.amount) || 0;
        if (r.type === 'expense') {
          totalExp += amt;
          const cat = (r.category as string) || 'lainnya';
          catMap[cat] = (catMap[cat] || 0) + amt;
        } else {
          totalInc += amt;
        }
      }
    }

    const balance = totalInc - totalExp;
    const balEmoji = balance >= 0 ? '🎉' : '😰';

    let text =
      `💰 <b>Rekap Keuangan — ${periodLabels[period] || period}</b>\n\n` +
      `📈 Pemasukan: <b>${formatRupiah(totalInc)}</b>\n` +
      `📉 Pengeluaran: <b>${formatRupiah(totalExp)}</b>\n` +
      `${balEmoji} Sisa: <b>${formatRupiah(balance)}</b>\n`;

    if (Object.keys(catMap).length > 0) {
      text += `\n📊 <b>Detail Pengeluaran:</b>\n`;
      const sorted = Object.entries(catMap).sort((a, b) => b[1] - a[1]);
      for (const [cat, amt] of sorted) {
        text += `  • ${cat}: ${formatRupiah(amt)}\n`;
      }
    }

    text += `\nPilih periode lain 👇`;
    await sendTextWithKeyboard(chatId, text, rekapPeriodKeyboard());
  } catch (e) {
    await sendText(chatId, `⚠️ Error ambil rekap bro. ${e}`);
  }
}

async function showExpenses(chatId: number, userId: number): Promise<void> {
  try {
    // Auto-process salary for this month
    await processSalaryForMonth(userId);

    const results = await sbGet(
      'transactions',
      `select=id,type,amount,category,description,created_at&user_id=eq.${userId}&type=eq.expense&order=created_at.desc&limit=10`
    ) as Record<string, unknown>[];

    let text: string;
    const keyboard: unknown[][] = [];

    if (Array.isArray(results) && results.length > 0) {
      text = `📉 <b>Pengeluaran Terbaru</b> (${results.length})\n\n`;
      const itemRows: unknown[][] = [];

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const txId = r.id as string;
        const amount = Number(r.amount);
        const category = (r.category as string) || 'lainnya';
        const desc = (r.description as string) || '-';
        const txDate = (r.created_at as string) ? new Date(r.created_at as string).toLocaleDateString('id-ID') : '-';
        text += `${i + 1}. ${formatRupiah(amount)} — <b>${escapeHtml(category)}</b>\n   📌 ${escapeHtml(desc)} | ${txDate}\n`;
        // Per-transaction buttons: Edit & Hapus
        itemRows.push([
          { text: `✏️ Edit #${i + 1}`, callback_data: `edit_item:${txId}` },
          { text: `🗑️ Hapus #${i + 1}`, callback_data: `del_item:${txId}` },
        ]);
      }

      keyboard.push(...itemRows);
    } else {
      text = `📉 <b>Pengeluaran Terbaru</b>\n\nBelum ada pengeluaran bro.\n\nCoba catat:\n"bakso 18rb"`;
    }

    keyboard.push([{ text: '🔙 Kembali', callback_data: 'menu_main' }]);
    await sendTextWithKeyboard(chatId, text, keyboard);
  } catch (e) {
    await sendText(chatId, `⚠️ Error: ${e}`);
  }
}

async function showIncomes(chatId: number, userId: number): Promise<void> {
  try {
    // Auto-process salary for this month
    await processSalaryForMonth(userId);

    const results = await sbGet(
      'transactions',
      `select=id,type,amount,category,description,created_at&user_id=eq.${userId}&type=eq.income&order=created_at.desc&limit=10`
    ) as Record<string, unknown>[];

    let text: string;
    const keyboard: unknown[][] = [];

    if (Array.isArray(results) && results.length > 0) {
      text = `📈 <b>Pemasukan Terbaru</b> (${results.length})\n\n`;
      const itemRows: unknown[][] = [];

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const txId = r.id as string;
        const amount = Number(r.amount);
        const category = (r.category as string) || 'lainnya';
        const desc = (r.description as string) || '-';
        const txDate = (r.created_at as string) ? new Date(r.created_at as string).toLocaleDateString('id-ID') : '-';
        text += `${i + 1}. ${formatRupiah(amount)} — <b>${escapeHtml(category)}</b>\n   📌 ${escapeHtml(desc)} | ${txDate}\n`;
        // Per-transaction buttons: Edit & Hapus
        itemRows.push([
          { text: `✏️ Edit #${i + 1}`, callback_data: `edit_item:${txId}` },
          { text: `🗑️ Hapus #${i + 1}`, callback_data: `del_item:${txId}` },
        ]);
      }

      keyboard.push(...itemRows);
    } else {
      text = `📈 <b>Pemasukan Terbaru</b>\n\nBelum ada pemasukan bro.\n\nCoba catat:\n"gaji 5jt"`;
    }

    keyboard.push([{ text: '🔙 Kembali', callback_data: 'menu_main' }]);
    await sendTextWithKeyboard(chatId, text, keyboard);
  } catch (e) {
    await sendText(chatId, `⚠️ Error: ${e}`);
  }
}

// ─────────────── SALARY / GAJI BULANAN HANDLERS ───────────────

async function processSalaryForMonth(userId: number, force = false): Promise<boolean> {
  // Check if salary should be auto-recorded this month
  const salaries = await sbGet('monthly_salaries', `select=*&user_id=eq.${userId}`) as Record<string, unknown>[];
  if (!Array.isArray(salaries) || salaries.length === 0) return false;

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const today = todayStr();
  let recorded = false;

  for (const sal of salaries) {
    const lastProcessed = sal.last_processed_month as string || '';
    const paymentDay = Number(sal.payment_day) || 1;
    const currentDay = now.getDate();

    // Skip if payment day hasn't arrived yet (unless forced)
    if (!force && paymentDay > currentDay) continue;

    // Check if already processed this month
    const alreadyProcessed = lastProcessed === currentMonth;
    if (alreadyProcessed && !force) continue;

    // Even if marked as processed, verify the transaction actually exists
    // (user might have deleted it manually)
    let txExists = false;
    if (alreadyProcessed) {
      const existingTx = await sbGet(
        'transactions',
        `select=id&user_id=eq.${userId}&type=eq.income&category=eq.${sal.category || 'gaji'}&description=ilike.%25${encodeURIComponent((sal.description as string) || 'Gaji Bulanan')}%25&created_at=gte.${currentMonth}-01T00:00:00Z&limit=1`
      ) as Record<string, unknown>[];
      txExists = Array.isArray(existingTx) && existingTx.length > 0;
    }

    // Process if: not yet processed OR (processed but transaction missing) OR forced
    if (!alreadyProcessed || !txExists || force) {
      // If forced and tx exists, delete old one first to avoid duplicates
      if (force && txExists) {
        await sbDelete(
          'transactions',
          `user_id=eq.${userId}&type=eq.income&category=eq.${sal.category || 'gaji'}&description=ilike.%25${encodeURIComponent((sal.description as string) || 'Gaji Bulanan')}%25&created_at=gte.${currentMonth}-01T00:00:00Z`
        );
      }

      // Record salary as income transaction — use TODAY as date, not payment_day
      const result = await sbPost('transactions', {
        user_id: userId,
        type: 'income',
        amount: sal.amount,
        category: sal.category || 'gaji',
        description: (sal.description as string) || 'Gaji Bulanan',
      });

      if (result.ok) {
        // Update last_processed_month
        await sbPatch('monthly_salaries', sal.id as string, { last_processed_month: currentMonth });
        recorded = true;
        console.log(`Salary processed: user=${userId}, sal=${sal.description}, amount=${sal.amount}, date=${today}`);
      } else {
        console.error(`Salary insert failed: user=${userId}, sal=${sal.id}, error=${result.error}`);
      }
    }
  }

  return recorded;
}

async function verifySalaryInIncome(userId: number, sal: Record<string, unknown>): Promise<boolean> {
  const currentMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const cat = (sal.category as string) || 'gaji';
  const desc = (sal.description as string) || 'Gaji Bulanan';

  const existingTx = await sbGet(
    'transactions',
    `select=id&user_id=eq.${userId}&type=eq.income&category=eq.${cat}&description=ilike.%25${encodeURIComponent(desc)}%25&created_at=gte.${currentMonth}-01T00:00:00Z&limit=1`
  ) as Record<string, unknown>[];
  return Array.isArray(existingTx) && existingTx.length > 0;
}

async function showSalarySettings(chatId: number, userId: number): Promise<void> {
  try {
    // First, auto-process any pending salary for this month
    // Also verifies: if marked processed but tx missing, re-records
    const wasRecorded = await processSalaryForMonth(userId);

    const salaries = await sbGet('monthly_salaries', `select=*&user_id=eq.${userId}&order=created_at.desc`) as Record<string, unknown>[];
    let text: string;
    const keyboard: unknown[][] = [];

    if (Array.isArray(salaries) && salaries.length > 0) {
      text = `💵 <b>Setting Gaji Bulanan</b>\n\n`;
      for (let i = 0; i < salaries.length; i++) {
        const s = salaries[i];
        const amount = Number(s.amount) || 0;
        const desc = (s.description as string) || 'Gaji';
        const day = (s.payment_day as number) || 1;
        const cat = (s.category as string) || 'gaji';
        const lastProcessed = (s.last_processed_month as string) || '';
        const currentMonthStr = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
        const isProcessedThisMonth = lastProcessed === currentMonthStr;

        // Verify: even if marked processed, check if tx actually exists
        let txActuallyExists = false;
        if (isProcessedThisMonth) {
          txActuallyExists = await verifySalaryInIncome(userId, s);
        }

        let statusEmoji = '⏳';
        let statusNote = '';
        if (isProcessedThisMonth && txActuallyExists) {
          statusEmoji = '✅';
          statusNote = ' (sudah masuk pemasukan)';
        } else if (isProcessedThisMonth && !txActuallyExists) {
          statusEmoji = '⚠️';
          statusNote = ' (belum ada di pemasukan — tekan 🔥 di bawah)';
        }

        text += `${i + 1}. <b>${escapeHtml(desc)}</b>\n`;
        text += `   💰 ${formatRupiah(amount)} | 📂 ${escapeHtml(cat)}\n`;
        text += `   📅 Tanggal ${day} setiap bulan ${statusEmoji}${statusNote}\n\n`;

        keyboard.push([
          { text: `✏️ Edit #${i + 1}`, callback_data: `edit_salary:${s.id}` },
          { text: `🗑️ Hapus #${i + 1}`, callback_data: `del_salary:${s.id}` },
        ]);
      }

      if (wasRecorded) {
        text += `🔔 <b>Gaji bulan ini berhasil dicatat ke pemasukan!</b>\n\n`;
      }

      text += `Tekan tombol di bawah untuk tambah/ubah gaji 👇`;
    } else {
      text = `💵 <b>Setting Gaji Bulanan</b>\n\n`;
      text += `Lu belum setting gaji bulanan nih bro.\n\n`;
      text += `Klik tombol di bawah buat set gaji pertama lu! 👇`;
    }

    keyboard.push([
      { text: `➕ Tambah Gaji Baru`, callback_data: 'add_salary' },
    ]);
    keyboard.push([
      { text: `🔥 Proses Ulang Gaji Bulan Ini`, callback_data: 'force_salary' },
    ]);
    keyboard.push([
      { text: '🔙 Kembali ke Menu', callback_data: 'menu_main' },
    ]);

    await sendTextWithKeyboard(chatId, text, keyboard);
  } catch (e) {
    await sendText(chatId, `⚠️ Error: ${e}`);
  }
}

async function addSalaryPrompt(chatId: number): Promise<void> {
  const tag = `[ADD_SALARY]`;
  const text =
    `${tag}\n\n` +
    `💵 <b>Set Gaji Bulanan Baru</b>\n\n` +
    `👇 <b>Balas pesan ini</b> dengan format:\n\n` +
    `<code>Deskripsi gaji</code>\n` +
    `<code>Nominal gaji</code>\n` +
    `<code>Tanggal (1-28)</code>\n\n` +
    `Contoh:\n` +
    `<code>Gaji kantor</code>\n<code>5jt</code>\n<code>25</code>\n\n` +
    `<i>Nominal bisa pakai: rb, k, jt, m, ribu, juta</i>\n` +
    `<i>Tanggal = kapan gaji cair tiap bulan (1-28)</i>\n\n` +
    `<i>Ketik /cancel untuk batal.</i>`;

  await sendForceReply(chatId, text, 'Ketik deskripsi gaji...');
}

async function showSalaryRekap(chatId: number, userId: number): Promise<void> {
  // Auto-process salary first
  await processSalaryForMonth(userId);

  const now = new Date();
  const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // Compute next month's first day for upper bound
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const nextMonthStr = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}`;

  // Get all income this month
  const allTx = await sbGet(
    'transactions',
    `select=type,amount,description,category,created_at&user_id=eq.${userId}&created_at=gte.${monthStr}-01T00:00:00Z&created_at=lt.${nextMonthStr}-01T00:00:00Z&order=created_at.desc`
  ) as Record<string, unknown>[];

  // Split in memory
  const incomes = Array.isArray(allTx) ? allTx.filter(t => t.type === 'income') : [];
  const expenses = Array.isArray(allTx) ? allTx.filter(t => t.type === 'expense') : [];

  // Get salary settings
  const salaries = await sbGet('monthly_salaries', `select=*&user_id=eq.${userId}`) as Record<string, unknown>[];

  let totalSalary = 0;
  let totalIncome = 0;
  let totalExpense = 0;
  const incMap: Record<string, number> = {};
  const expMap: Record<string, number> = {};

  if (Array.isArray(incomes)) {
    for (const r of incomes) {
      const amt = Number(r.amount) || 0;
      totalIncome += amt;
      const cat = (r.category as string) || 'lainnya';
      incMap[cat] = (incMap[cat] || 0) + amt;
    }
  }
  if (Array.isArray(expenses)) {
    for (const r of expenses) {
      const amt = Number(r.amount) || 0;
      totalExpense += amt;
      const cat = (r.category as string) || 'lainnya';
      expMap[cat] = (expMap[cat] || 0) + amt;
    }
  }
  if (Array.isArray(salaries)) {
    for (const s of salaries) {
      totalSalary += Number(s.amount) || 0;
    }
  }

  const sisa = totalIncome - totalExpense;
  const sisaEmoji = sisa >= 0 ? '🎉' : '😰';

  let text =
    `💵 <b>Rekap Gaji & Keuangan — Bulan Ini</b>\n\n` +
    `📋 Total Gaji Setting: <b>${formatRupiah(totalSalary)}</b>\n` +
    `📈 Pemasukan Bulan Ini: <b>${formatRupiah(totalIncome)}</b>\n` +
    `📉 Pengeluaran Bulan Ini: <b>${formatRupiah(totalExpense)}</b>\n` +
    `${sisaEmoji} Sisa Saldo: <b>${formatRupiah(sisa)}</b>\n`;

  // Progress bar-like indicator
  if (totalSalary > 0) {
    const percent = Math.min(100, Math.round((totalExpense / totalSalary) * 100));
    const bar = percent > 80 ? '🔴' : percent > 50 ? '🟡' : '🟢';
    text += `\n📊 <b>Pengeluaran vs Gaji:</b> ${bar} ${percent}%\n`;
  }

  if (Object.keys(expMap).length > 0) {
    text += `\n📉 <b>Detail Pengeluaran:</b>\n`;
    const sorted = Object.entries(expMap).sort((a, b) => b[1] - a[1]);
    for (const [cat, amt] of sorted) {
      text += `  • ${cat}: ${formatRupiah(amt)}\n`;
    }
  }

  const keyboard: unknown[][] = [
    [
      { text: '💵 Setting Gaji', callback_data: 'menu_salary' },
      { text: '📅 Hari Ini', callback_data: 'rekap:today' },
    ],
    [
      { text: '🔙 Kembali', callback_data: 'menu_main' },
    ],
  ];

  await sendTextWithKeyboard(chatId, text, keyboard);
}

async function showAgendas(chatId: number, userId: number): Promise<void> {
  try {
    const results = await sbGet(
      'agendas',
      `select=*&user_id=eq.${userId}&is_completed=eq.false&order=scheduled_time.asc&limit=20`
    ) as Record<string, unknown>[];

    let text: string;
    let keyboard: unknown[][] = [];

    if (Array.isArray(results) && results.length > 0) {
      text = `📅 <b>Jadwal Gua</b> (${results.length} agenda aktif)\n\n`;
      const agendaRows: unknown[][] = [];

      for (const r of results) {
        const id = r.id as string;
        const title = (r.title as string) || 'Tanpa judul';
        const scheduledTime = r.scheduled_time as string;
        const reminded = r.is_reminded as boolean;

        const d = new Date(scheduledTime);
        const dateStr = d.toLocaleDateString('id-ID', {
          timeZone: 'Asia/Jakarta',
          weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
        });
        const timeStr = d.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });
        const isPast = d < new Date();
        const statusEmoji = reminded ? '🔔' : isPast ? '⚠️' : '📋';

        text += `${statusEmoji} <b>${escapeHtml(title)}</b>\n   📆 ${dateStr} ⏰ ${timeStr}\n\n`;

        agendaRows.push([
          { text: '✅ Selesai', callback_data: `done:ag:${id}` },
          { text: '🗑️ Hapus', callback_data: `del:ag:${id}` },
          { text: '✏️ Edit', callback_data: `edit:ag:${id}` },
        ]);
      }

      keyboard = [...agendaRows, [{ text: '🔙 Kembali', callback_data: 'menu_main' }]];
    } else {
      text = `📅 <b>Jadwal Gua</b>\n\nGa ada agenda aktif bro. Lu santai banget! 🌴\n\nCoba buat agenda:\n"inget meeting besok jam 10"`;
      keyboard = [[{ text: '🔙 Kembali', callback_data: 'menu_main' }]];
    }

    await sendTextWithKeyboard(chatId, text, keyboard);
  } catch (e) {
    await sendText(chatId, `⚠️ Error: ${e}`);
  }
}

// ─────────────── CALLBACK QUERY HANDLER ───────────────

async function handleCallback(cbQuery: Record<string, unknown>): Promise<void> {
  const cbId = cbQuery.id as string;
  const data = cbQuery.data as string;
  const message = cbQuery.message as Record<string, unknown> | undefined;
  if (!message) { await answerCb(cbId, '❌'); return; }

  const chatId = message.chat?.id as number;
  const userId = (cbQuery.from as Record<string, unknown>).id as number;
  const username = ((cbQuery.from as Record<string, unknown>).username as string) || 'unknown';
  const msgId = message.message_id as number;

  await ensureUser(userId, username).catch(() => {});

  // ── USER WHITELIST CHECK ──
  if (!isUserAllowed(userId)) {
    console.log(`[BLOCKED] userId=${userId} not in ALLOWED_USER_IDS (callback)`);
    await answerCb(cbId, '🚫 Lu gak punya akses bro.');
    return;
  }

  try {
    if (data === 'menu_main' || data === 'menu_back') {
      await answerCb(cbId);
      await editMsgText(chatId, msgId, '🤙 <b>Menu SantuyBot</b>\n\nPilih menu di bawah bro 👇', mainMenuKeyboard());
      return;
    }

    if (data === 'menu_rekap') {
      await answerCb(cbId);
      await editMsgText(chatId, msgId, '💰 <b>Pilih periode rekap:</b>', rekapPeriodKeyboard());
      return;
    }

    if (data === 'menu_exp') {
      await answerCb(cbId);
      await editMsgText(chatId, msgId, '📉 Loading pengeluaran...');
      await showExpenses(chatId, userId);
      return;
    }

    if (data === 'menu_inc') {
      await answerCb(cbId);
      await editMsgText(chatId, msgId, '📈 Loading pemasukan...');
      await showIncomes(chatId, userId);
      return;
    }

    if (data === 'menu_agenda') {
      await answerCb(cbId);
      await editMsgText(chatId, msgId, '📅 Loading agenda...');
      await showAgendas(chatId, userId);
      return;
    }

    if (data === 'menu_help') {
      await answerCb(cbId);
      const helpText =
        `🆘 <b>Bantuan SantuyBot</b>\n\n` +
        `📝 <b>Catat Pengeluaran:</b> "bakso 18rb"\n` +
        `💵 <b>Catat Pemasukan:</b> "gaji 5jt"\n` +
        `📅 <b>Buat Agenda:</b> "inget meeting besok jam 10"\n` +
        `🔄 <b>Pengeluaran Rutin:</b> "rutin netflix 153rb 5"\n` +
        `🔍 <b>Cari Transaksi:</b> "cari makan"\n` +
        `📊 <b>Rekap:</b> "rekap bulan ini"\n\n` +
        `Tulis bahasa biasa aja bro! 😎`;
      await editMsgText(chatId, msgId, helpText, mainMenuKeyboard());
      return;
    }

    // ── BUDGET MENU ──
    if (data === 'menu_budget') {
      await answerCb(cbId);
      await editMsgText(chatId, msgId, '📊 Loading budget...');
      await showBudgetMenu(chatId, userId, msgId, true);
      return;
    }

    if (data === 'budget:set') {
      await answerCb(cbId);
      const setBtns: unknown[] = [];
      for (const cat of EXPENSE_CATS) {
        setBtns.push({ text: `💰 ${cat.charAt(0).toUpperCase() + cat.slice(1)}`, callback_data: `budget:pick:${cat}` });
      }
      await editMsgText(chatId, msgId,
        `📊 <b>Set Budget — Pilih Kategori</b>\n\nPilih kategori yang mau lu set budget-nya:`,
        [...chunkArray(setBtns, 3), [{ text: '🔙 Kembali', callback_data: 'menu_budget' }]]
      );
      return;
    }

    if (data.startsWith('budget:pick:')) {
      const category = data.replace('budget:pick:', '');
      await answerCb(cbId);
      const budgetTag = `[SET_BUDGET:${category}]`;
      const promptText =
        `💰 <b>Set Budget: ${escapeHtml(category.charAt(0).toUpperCase() + category.slice(1))}</b>\n\n` +
        `👇 <b>Balas pesan ini</b> dengan nominal budget bulanan.\n\n` +
        `Contoh:\n` +
        `• <code>500rb</code>\n` +
        `• <code>1.5jt</code>\n` +
        `• <code>2000000</code>\n\n` +
        `<i>Ketik /cancel untuk batal.</i>`;
      await sendForceReply(chatId, `${budgetTag}\n\n${promptText}`, `Budget ${category} (contoh: 500rb)`);
      return;
    }

    if (data === 'budget:del') {
      await answerCb(cbId);
      const budgets = await sbGet(
        'budgets',
        `select=category,monthly_limit&user_id=eq.${userId}&order=category.asc`
      ) as Record<string, unknown>[];

      if (!Array.isArray(budgets) || budgets.length === 0) {
        await editMsgText(chatId, msgId,
          '📊 <b>Belum ada budget buat dihapus.</b>',
          [[{ text: '🔙 Kembali', callback_data: 'menu_budget' }]]
        );
        return;
      }

      const rows: unknown[][] = [];
      for (const b of budgets) {
        const cat = (b.category as string) || 'lainnya';
        const limit = formatRupiah(Number(b.monthly_limit || 0));
        rows.push([{ text: `🗑️ ${cat} (${limit})`, callback_data: `budget:del:${cat}` }]);
      }
      rows.push([{ text: '🔙 Kembali', callback_data: 'menu_budget' }]);

      await editMsgText(chatId, msgId,
        `🗑️ <b>Hapus Budget</b>\n\nPilih budget yang mau dihapus:`,
        rows
      );
      return;
    }

    if (data.startsWith('budget:del:')) {
      const category = data.replace('budget:del:', '');
      await answerCb(cbId);

      const budgets = await sbGet(
        'budgets',
        `select=monthly_limit&user_id=eq.${userId}&category=eq.${category}&limit=1`
      ) as Record<string, unknown>[];

      if (Array.isArray(budgets) && budgets.length > 0) {
        const limit = formatRupiah(Number(budgets[0].monthly_limit || 0));
        await editMsgText(chatId, msgId,
          `⚠️ <b>Konfirmasi Hapus Budget</b>\n\n` +
          `Hapus budget "${escapeHtml(category)}" (${limit})?\n\n` +
          `⚠️ GA BISA di-undo bro!`,
          [
            [{ text: '✅ Yakin, Hapus!', callback_data: `cfm:del_budget:${category}` }],
            [{ text: '❌ Batal', callback_data: 'budget:del' }],
          ]
        );
      } else {
        await editMsgText(chatId, msgId, '❌ Budget ga ketemu.',
          [[{ text: '🔙 Kembali', callback_data: 'menu_budget' }]]
        );
      }
      return;
    }

    if (data.startsWith('cfm:del_budget:')) {
      const category = data.replace('cfm:del_budget:', '');
      await answerCb(cbId, '🗑️ Budget dihapus!');
      const result = await sbDelete('budgets', `user_id=eq.${userId}&category=eq.${category}`);
      if (result.ok) {
        await editMsgText(chatId, msgId,
          `🗑️ <b>Budget Dihapus!</b>\n\nBudget "${escapeHtml(category)}" udah dihapus bro! 🌴`,
          [[{ text: '📊 Lihat Budget', callback_data: 'menu_budget' }, { text: '🔙 Kembali', callback_data: 'menu_main' }]]
        );
      } else {
        await editMsgText(chatId, msgId, '❌ Gagal hapus budget bro.',
          [[{ text: '🔙 Kembali', callback_data: 'menu_budget' }]]
        );
      }
      return;
    }

    // ── DEBT (PIUTANG/UTANG) MENU ──
    if (data === 'menu_debt') {
      await answerCb(cbId);
      await editMsgText(chatId, msgId, '💰 Loading piutang/utang...');
      await showDebtMenu(chatId, userId, msgId, true);
      return;
    }

    if (data === 'debt:add:piutang') {
      await answerCb(cbId);
      const debtTag = `[ADD_DEBT:piutang]`;
      await sendForceReply(chatId,
        `${debtTag}\n\n` +
        `📥 <b>Tambah Piutang</b> (orang lain hutang ke lu)\n\n` +
        `👇 <b>Balas pesan ini</b> dengan format:\n` +
        `• <code>Nama 100rb</code>\n` +
        `• <code>Budi 500rb bayar makan</code>\n` +
        `• <code>Andi 1jt 15</code> (15 = tanggal jatuh tempo)\n\n` +
        `<i>Ketik /cancel untuk batal.</i>`,
        `Nama Nominal [keterangan] [tgl jatuh tempo]`
      );
      return;
    }

    if (data === 'debt:add:utang') {
      await answerCb(cbId);
      const debtTag = `[ADD_DEBT:utang]`;
      await sendForceReply(chatId,
        `${debtTag}\n\n` +
        `📤 <b>Tambah Utang</b> (lu hutang ke orang lain)\n\n` +
        `👇 <b>Balas pesan ini</b> dengan format:\n` +
        `• <code>Nama 100rb</code>\n` +
        `• <code>Budi 500rb bayar makan</code>\n` +
        `• <code>Andi 1jt 15</code> (15 = tanggal jatuh tempo)\n\n` +
        `<i>Ketik /cancel untuk batal.</i>`,
        `Nama Nominal [keterangan] [tgl jatuh tempo]`
      );
      return;
    }

    if (data.startsWith('debt:detail:')) {
      const debtId = data.replace('debt:detail:', '');
      await answerCb(cbId);
      await showDebtDetail(chatId, userId, debtId, msgId);
      return;
    }

    if (data.startsWith('debt:settle:')) {
      const debtId = data.replace('debt:settle:', '');
      await answerCb(cbId);

      const debts = await sbGet('debts', `select=*&id=eq.${debtId}&user_id=eq.${userId}&limit=1`) as Record<string, unknown>[];
      if (!Array.isArray(debts) || debts.length === 0) {
        await editMsgText(chatId, msgId, '❌ Ga ketemu bro.',
          [[{ text: '🔙 Kembali', callback_data: 'menu_debt' }]]);
        return;
      }
      const d = debts[0];
      const type = d.type as string;
      const personName = (d.person_name as string) || '?';
      const amount = Number(d.amount || 0);
      const emoji = type === 'piutang' ? '📥' : '📤';

      await editMsgText(chatId, msgId,
        `⚠️ <b>Konfirmasi Lunas</b>\n\n` +
        `${emoji} ${escapeHtml(personName)} — ${formatRupiah(amount)}\n\n` +
        `Yakin udah lunas bro?`,
        [[
          { text: '✅ Yakin, Lunas!', callback_data: `cfm:settle_debt:${debtId}` },
          { text: '❌ Batal', callback_data: `debt:detail:${debtId}` },
        ]]
      );
      return;
    }

    if (data.startsWith('cfm:settle_debt:')) {
      const debtId = data.replace('cfm:settle_debt:', '');
      await answerCb(cbId, '✅ Lunas bro!');
      const result = await sbPatch('debts', debtId, {
        is_settled: true,
        settled_at: new Date().toISOString(),
      });
      if (result.ok) {
        await editMsgText(chatId, msgId,
          `✅ <b>Udah Lunas!</b>\n\nPiutang/utang udah ditandai lunas bro! 🎉`,
          [[{ text: '💰 Piutang/Utang', callback_data: 'menu_debt' }, { text: '🔙 Kembali', callback_data: 'menu_main' }]]
        );
      } else {
        await editMsgText(chatId, msgId, '❌ Gagal update bro.',
          [[{ text: '🔙 Kembali', callback_data: 'menu_debt' }]]);
      }
      return;
    }

    if (data.startsWith('debt:del:')) {
      const debtId = data.replace('debt:del:', '');
      await answerCb(cbId);

      const debts = await sbGet('debts', `select=*&id=eq.${debtId}&user_id=eq.${userId}&limit=1`) as Record<string, unknown>[];
      if (!Array.isArray(debts) || debts.length === 0) {
        await editMsgText(chatId, msgId, '❌ Ga ketemu bro.',
          [[{ text: '🔙 Kembali', callback_data: 'menu_debt' }]]);
        return;
      }
      const d = debts[0];
      const type = d.type as string;
      const personName = (d.person_name as string) || '?';
      const amount = Number(d.amount || 0);
      const emoji = type === 'piutang' ? '📥' : '📤';

      await editMsgText(chatId, msgId,
        `⚠️ <b>Konfirmasi Hapus</b>\n\n` +
        `${emoji} ${escapeHtml(personName)} — ${formatRupiah(amount)}\n\n` +
        `⚠️ GA BISA di-undo bro!`,
        [[
          { text: '✅ Yakin, Hapus!', callback_data: `cfm:del_debt:${debtId}` },
          { text: '❌ Batal', callback_data: `debt:detail:${debtId}` },
        ]]
      );
      return;
    }

    if (data.startsWith('cfm:del_debt:')) {
      const debtId = data.replace('cfm:del_debt:', '');
      await answerCb(cbId, '🗑️ Dihapus!');
      const result = await sbDelete('debts', `id=eq.${debtId}&user_id=eq.${userId}`);
      if (result.ok) {
        await editMsgText(chatId, msgId, `🗑️ <b>Berhasil Dihapus!</b>\n\nPiutang/utang udah dihapus bro! 🌴`,
          [[{ text: '💰 Piutang/Utang', callback_data: 'menu_debt' }, { text: '🔙 Kembali', callback_data: 'menu_main' }]]);
      } else {
        await editMsgText(chatId, msgId, '❌ Gagal hapus bro.',
          [[{ text: '🔙 Kembali', callback_data: 'menu_debt' }]]);
      }
      return;
    }

    if (data === 'debt:history') {
      await answerCb(cbId);
      await showDebtHistory(chatId, userId, msgId);
      return;
    }

    // ── RECURRING EXPENSE MENU ──
    if (data === 'menu_recurring') {
      await answerCb(cbId);
      await editMsgText(chatId, msgId, '🔄 Loading pengeluaran rutin...');
      await showRecurringMenu(chatId, userId);
      return;
    }

    if (data === 'recurring:add') {
      await answerCb(cbId);
      await addRecurringPrompt(chatId);
      return;
    }

    // ── FORCE PROCESS RECURRING EXPENSES ──
    if (data === 'force_recurring') {
      await answerCb(cbId);
      const wasRecorded = await processRecurringForMonth(userId, true);
      if (wasRecorded) {
        await editMsgText(chatId, msgId,
          `🔥 <b>Pengeluaran Rutin Diproses Ulang!</b>\n\nPengeluaran rutin udah dicatat ulang ke pengeluaran ya bro! ✅\nCek menu 📉 Cek Pengeluaran untuk lihat hasilnya.`,
          [[{ text: '📉 Cek Pengeluaran', callback_data: 'menu_exp' }, { text: '🔄 Rutin', callback_data: 'menu_recurring' }]]
        );
      } else {
        await editMsgText(chatId, msgId,
          `ℹ️ Ga ada pengeluaran rutin yang perlu diproses.\n\nMungkin payment day belum lewat, atau ga ada setting rutin yang aktif.`,
          [[{ text: '🔄 Rutin', callback_data: 'menu_recurring' }, { text: '🔙 Kembali', callback_data: 'menu_main' }]]
        );
      }
      return;
    }

    // ── EDIT RECURRING ──
    if (data.startsWith('edit_recurring:')) {
      const recurringId = data.split(':')[1];
      await answerCb(cbId);

      const results = await sbGet('recurring_expenses', `select=*&id=eq.${recurringId}&user_id=eq.${userId}`) as Record<string, unknown>[];
      if (!Array.isArray(results) || results.length === 0) {
        await editMsgText(chatId, msgId, '❌ Pengeluaran rutin ga ketemu bro.',
          [[{ text: '🔙 Kembali', callback_data: 'menu_recurring' }]]);
        return;
      }

      const r = results[0];
      const amount = Number(r.amount);
      const title = (r.title as string) || '-';
      const day = (r.payment_day as number) || 1;
      const cat = (r.category as string) || 'tagihan';
      const desc = (r.description as string) || '';

      const editTag = `[EDIT_RECURRING:${recurringId}]`;
      const editText =
        `✏️ <b>Edit Pengeluaran Rutin</b>\n\n` +
        `📋 Judul: <b>${escapeHtml(title)}</b>\n` +
        `💰 Nominal: <b>${formatRupiah(amount)}</b>\n` +
        `📅 Tanggal: <b>${day}</b> setiap bulan\n` +
        `📂 Kategori: <b>${escapeHtml(cat)}</b>\n` +
        `${desc ? `📌 Keterangan: <b>${escapeHtml(desc)}</b>\n` : ''}\n\n` +
        `👇 <b>Balas pesan ini</b> dengan data baru.\n\n` +
        `Format fleksibel, misalnya:\n` +
        `• <code>Netflix 186rb</code> (judul + nominal)\n` +
        `• <code>Netflix 186rb 10</code> (+ tanggal)\n` +
        `• <code>200rb</code> (ubah nominal saja)\n` +
        `• <code>15</code> (ubah tanggal saja)\n\n` +
        `<i>Ketik /cancel untuk batal.</i>`;

      await sendForceReply(chatId, `${editTag}\n\n${editText}`, 'Ketik data baru...');
      return;
    }

    // ── DELETE RECURRING ──
    if (data.startsWith('recurring:del:')) {
      const recurringId = data.split(':')[2];
      await answerCb(cbId);

      const results = await sbGet('recurring_expenses', `select=*&id=eq.${recurringId}&user_id=eq.${userId}`) as Record<string, unknown>[];
      if (!Array.isArray(results) || results.length === 0) {
        await editMsgText(chatId, msgId, '❌ Pengeluaran rutin ga ketemu.',
          [[{ text: '🔙 Kembali', callback_data: 'menu_recurring' }]]);
        return;
      }

      const r = results[0];
      await editMsgText(chatId, msgId,
        `⚠️ <b>Konfirmasi Hapus Pengeluaran Rutin</b>\n\n` +
        `Hapus pengeluaran rutin ini?\n\n` +
        `📋 ${escapeHtml((r.title as string) || '-')}\n` +
        `💰 ${formatRupiah(Number(r.amount))}\n` +
        `📅 Tanggal ${(r.payment_day as number) || 1}\n\n` +
        `⚠️ GA BISA di-undo bro!`,
        [[
          { text: '✅ Yakin, Hapus!', callback_data: `cfm:del_recurring:${recurringId}` },
          { text: '❌ Batal', callback_data: 'menu_recurring' },
        ]]
      );
      return;
    }

    if (data.startsWith('cfm:del_recurring:')) {
      const recurringId = data.split(':')[2];
      await answerCb(cbId, '🗑️ Dihapus!');
      const result = await sbDelete('recurring_expenses', `id=eq.${recurringId}&user_id=eq.${userId}`);
      if (result.ok) {
        await editMsgText(chatId, msgId, `🗑️ <b>Pengeluaran Rutin Dihapus!</b>\n\nUdah dihapus bro! 🌴`,
          [[{ text: '🔄 Rutin', callback_data: 'menu_recurring' }, { text: '🔙 Kembali', callback_data: 'menu_main' }]]);
      } else {
        await editMsgText(chatId, msgId, '❌ Gagal hapus.',
          [[{ text: '🔙 Kembali', callback_data: 'menu_recurring' }]]);
      }
      return;
    }

    // ── TOGGLE RECURRING (pause/resume) ──
    if (data.startsWith('recurring:toggle:')) {
      const recurringId = data.split(':')[2];
      await answerCb(cbId);

      const results = await sbGet('recurring_expenses', `select=*&id=eq.${recurringId}&user_id=eq.${userId}`) as Record<string, unknown>[];
      if (!Array.isArray(results) || results.length === 0) {
        await editMsgText(chatId, msgId, '❌ Pengeluaran rutin ga ketemu.',
          [[{ text: '🔙 Kembali', callback_data: 'menu_recurring' }]]);
        return;
      }

      const r = results[0];
      const isActive = r.is_active !== false;
      const newActive = !isActive;

      // If re-activating, reset last_processed_month so it re-processes
      const updateData: Record<string, unknown> = { is_active: newActive };
      if (newActive) {
        updateData.last_processed_month = null;
      }

      const result = await sbPatch('recurring_expenses', recurringId, updateData);
      if (result.ok) {
        const statusText = newActive ? '▶️ diaktifkan' : '⏸ di-pause';
        await editMsgText(chatId, msgId,
          `${statusText} <b>${escapeHtml((r.title as string) || '-')}</b>\n\n${newActive ? 'Bakal otomatis tercatat lagi tiap bulan! 🔥' : 'Pengeluaran rutin ini udah di-pause. Ga bakal otomatis tercatat sampai lu aktifkan lagi.'}`,
          [[{ text: '🔄 Rutin', callback_data: 'menu_recurring' }, { text: '🔙 Kembali', callback_data: 'menu_main' }]]);
      } else {
        await editMsgText(chatId, msgId, '❌ Gagal update status.',
          [[{ text: '🔙 Kembali', callback_data: 'menu_recurring' }]]);
      }
      return;
    }

    // ── REKAP PERIOD ──
    if (data.startsWith('rekap:')) {
      const period = data.split(':')[1];
      await answerCb(cbId);
      await editMsgText(chatId, msgId, '💰 Loading rekap...');
      await showRekap(chatId, userId, period);
      return;
    }

    // ── PDF MONTHLY REPORT ──
    if (data.startsWith('pdf_month:')) {
      const offset = parseInt(data.split(':')[1]) || 0;
      await answerCb(cbId, '📄 Generating PDF...');
      await editMsgText(chatId, msgId, '⏳ Sedang generate PDF laporan keuangan...\nBentar ya bro, PDF-nya lagi di bikin!');

      const pdfBytes = await generateRekapPDF(userId, offset);
      if (pdfBytes) {
        const MONTHS = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
        const d = new Date(); d.setMonth(d.getMonth() - offset);
        const fname = `SantuyBot_Rekap_${MONTHS[d.getMonth()]}_${d.getFullYear()}.pdf`;
        const sent = await sendPDFDocument(chatId, pdfBytes, fname);
        if (sent) {
          await editMsgText(chatId, msgId, '✅ <b>PDF berhasil dikirim!</b>\n\nCek file PDF di atas ya bro! 📄');
        } else {
          await editMsgText(chatId, msgId, '❌ Gagal kirim PDF bro. Coba lagi nanti.');
        }
      } else {
        await editMsgText(chatId, msgId, '❌ Gagal generate PDF. Mungkin lagi ada masalah, coba lagi bentar ya bro.');
      }
      return;
    }

    // ── DELETE TRANSACTION ──
    if (data.startsWith('del:tx:')) {
      const parts = data.split(':');
      const type = parts[2];
      const category = parts.slice(3).join(':');
      const label = type === 'expense' ? 'pengeluaran' : 'pemasukan';

      await answerCb(cbId);
      const warning =
        `⚠️ <b>Konfirmasi Hapus</b>\n\n` +
        `Lu yakin mau hapus SEMUA ${label} kategori "<b>${escapeHtml(category)}</b>"?\n\n` +
        `⚠️ Tindakan ini GA BISA di-undo bro!`;
      await editMsgText(chatId, msgId, warning, confirmButtons(data));
      return;
    }

    // ── CONFIRM DELETE ALL TRANSACTIONS ──
    if (data.startsWith('cfm:del_all:')) {
      const delType = data.split(':')[2];
      await answerCb(cbId, '🗑️ Dihapus semua bro!');
      let ok = false;

      if (delType === 'agenda') {
        // Delete all agendas for this user
        const result = await sbDelete('agendas', `user_id=eq.${userId}`);
        ok = result.ok;
      } else {
        // Delete from transactions
        let query = `user_id=eq.${userId}`;
        if (delType === 'expense') query += '&type=eq.expense';
        else if (delType === 'income') query += '&type=eq.income';

        const result = await sbDelete('transactions', query);
        ok = result.ok;
      }

      if (ok) {
        const what = delType === 'expense' ? 'pengeluaran' : delType === 'income' ? 'pemasukan' : delType === 'agenda' ? 'jadwal' : 'transaksi';
        await editMsgText(chatId, msgId,
          `🗑️ <b>Berhasil Dihapus!</b>\n\nSemua ${what} lu udah dihapus bersih.\nData fresh lagi! 🌴`,
          [[{ text: '🔙 Kembali ke Menu', callback_data: 'menu_main' }]]
        );
      } else {
        await editMsgText(chatId, msgId, '❌ Gagal hapus bro. Coba lagi.',
          [[{ text: '🔙 Kembali', callback_data: 'menu_main' }]]
        );
      }
      return;
    }

    // ── CONFIRM DELETE TRANSACTION (by category) ──
    if (data.startsWith('cfm:del:tx:')) {
      const parts = data.split(':');
      const type = parts[3];
      const category = parts.slice(4).join(':');
      const label = type === 'expense' ? 'pengeluaran' : 'pemasukan';

      await answerCb(cbId, '🗑️ Dihapus bro!');
      const result = await sbDelete('transactions', `user_id=eq.${userId}&type=eq.${type}&category=eq.${category}`);
      if (result.ok) {
        await editMsgText(chatId, msgId,
          `🗑️ <b>Berhasil Dihapus!</b>\n\nSemua ${label} kategori "${escapeHtml(category)}" udah dihapus.`,
          [[{ text: '🔙 Kembali ke Menu', callback_data: 'menu_main' }]]
        );
      } else {
        await editMsgText(chatId, msgId, '❌ Gagal hapus bro. Coba lagi.',
          [[{ text: '🔙 Kembali', callback_data: 'menu_main' }]]
        );
      }
      return;
    }

    // ── DELETE AGENDA ──
    if (data.startsWith('del:ag:')) {
      const agendaId = data.split(':')[2];
      await answerCb(cbId);
      await editMsgText(chatId, msgId,
        `⚠️ <b>Konfirmasi Hapus Agenda</b>\n\nLu yakin? GA BISA di-undo!`,
        confirmButtons(data)
      );
      return;
    }

    // ── CONFIRM DELETE AGENDA ──
    if (data.startsWith('cfm:del:ag:')) {
      const agendaId = data.split(':')[3];
      await answerCb(cbId, '🗑️ Agenda dihapus!');
      const result = await sbDelete('agendas', `id=eq.${agendaId}&user_id=eq.${userId}`);
      if (result.ok) {
        await editMsgText(chatId, msgId, `🗑️ <b>Agenda Dihapus!</b>\n\nUdah dihapus bro! 🌴`,
          [[{ text: '🔙 Kembali ke Menu', callback_data: 'menu_main' }]]
        );
      } else {
        await editMsgText(chatId, msgId, '❌ Gagal hapus agenda.',
          [[{ text: '🔙 Kembali', callback_data: 'menu_main' }]]
        );
      }
      return;
    }

    // ── DONE AGENDA ──
    if (data.startsWith('done:ag:')) {
      const agendaId = data.split(':')[2];
      await answerCb(cbId, '✅ Mantap!');
      const result = await sbPatch('agendas', agendaId, { is_completed: true });
      if (result.ok) {
        await editMsgText(chatId, msgId, `✅ <b>Agenda Selesai!</b>\n\nSelamat bro! 🎉`,
          [[{ text: '🔙 Kembali ke Menu', callback_data: 'menu_main' }]]
        );
      }
      return;
    }

    // ── EDIT TRANSACTION (per item — edit keterangan, nominal, jam) ──
    if (data.startsWith('edit_item:')) {
      const txId = data.split(':')[1];
      await answerCb(cbId);

      // Fetch the transaction details
      const txResults = await sbGet('transactions', `select=*&id=eq.${txId}&user_id=eq.${userId}`) as Record<string, unknown>[];
      if (!Array.isArray(txResults) || txResults.length === 0) {
        await editMsgText(chatId, msgId, '❌ Transaksi ga ketemu bro.',
          [[{ text: '🔙 Kembali', callback_data: 'menu_main' }]]);
        return;
      }

      const tx = txResults[0];
      const amount = Number(tx.amount);
      const category = (tx.category as string) || 'lainnya';
      const desc = (tx.description as string) || '-';
      const txDate = (tx.created_at as string) ? new Date(tx.created_at as string).toLocaleDateString('id-ID') : '-';
      const label = tx.type === 'expense' ? 'pengeluaran' : 'pemasukan';

      const editTag = `[EDIT_ITEM:${txId}]`;
      const editText =
        `✏️ <b>Edit ${label}</b>\n\n` +
        `💰 Nominal: <b>${formatRupiah(amount)}</b>\n` +
        `📂 Kategori: ${escapeHtml(category)}\n` +
        `📌 Keterangan: ${escapeHtml(desc)}\n` +
        `📅 Tanggal: ${txDate}\n\n` +
        `👇 <b>Balas pesan ini</b> dengan data baru.\n\n` +
        `Format fleksibel, misalnya:\n` +
        `• <code>Mie ayam 8rb</code> (keterangan + nominal satu baris)\n` +
        `• <code>25000</code> (ubah nominal saja)\n` +
        `• <code>Jam 15:30</code> (ubah jam saja)\n` +
        `• <code>bakso jumbo</code> (ubah keterangan saja)\n\n` +
        `Atau multi-baris:\n` +
        `<code>nasi goreng</code>\n<code>15000</code>\n<code>Jam 12:00</code>\n\n` +
        `<i>Ketik /cancel untuk batal.</i>`;

      await sendForceReply(chatId, `${editTag}\n\n${editText}`, 'Ketik keterangan baru...');
      return;
    }

    // ── DELETE TRANSACTION (per item) ──
    if (data.startsWith('del_item:')) {
      const txId = data.split(':')[1];
      await answerCb(cbId);

      const txResults = await sbGet('transactions', `select=*&id=eq.${txId}&user_id=eq.${userId}`) as Record<string, unknown>[];
      if (!Array.isArray(txResults) || txResults.length === 0) {
        await editMsgText(chatId, msgId, '❌ Transaksi ga ketemu.',
          [[{ text: '🔙 Kembali', callback_data: 'menu_main' }]]);
        return;
      }
      const tx = txResults[0];
      const label = tx.type === 'expense' ? 'pengeluaran' : 'pemasukan';

      await editMsgText(chatId, msgId,
        `⚠️ <b>Konfirmasi Hapus</b>\n\n` +
        `Hapus ${label} ini?\n\n` +
        `💰 ${formatRupiah(Number(tx.amount))} — ${escapeHtml(tx.category as string || 'lainnya')}\n` +
        `📌 ${escapeHtml((tx.description as string) || '-')}\n\n` +
        `⚠️ GA BISA di-undo bro!`,
        [[
          { text: '✅ Yakin, Hapus!', callback_data: `cfm:del_item:${txId}` },
          { text: '❌ Batal', callback_data: 'cancel' },
        ]]
      );
      return;
    }

    // ── CONFIRM DELETE ITEM ──
    if (data.startsWith('cfm:del_item:')) {
      const txId = data.split(':')[2];
      await answerCb(cbId, '🗑️ Dihapus!');
      const result = await sbDelete('transactions', `id=eq.${txId}&user_id=eq.${userId}`);
      if (result.ok) {
        await editMsgText(chatId, msgId, `🗑️ <b>Berhasil Dihapus!</b>\n\nTransaksi udah dihapus bro! 🌴`,
          [[{ text: '🔙 Kembali ke Menu', callback_data: 'menu_main' }]]);
      } else {
        await editMsgText(chatId, msgId, '❌ Gagal hapus bro.',
          [[{ text: '🔙 Kembali', callback_data: 'menu_main' }]]);
      }
      return;
    }

    // ── EDIT AGENDA ──
    if (data.startsWith('edit:ag:')) {
      const agendaId = data.split(':')[2];
      await answerCb(cbId);

      const agendas = await sbGet('agendas', `select=*&id=eq.${agendaId}&user_id=eq.${userId}`) as Record<string, unknown>[];
      if (!Array.isArray(agendas) || agendas.length === 0) {
        await answerCb(cbId, '❌ Agenda ga ketemu');
        return;
      }

      const agenda = agendas[0];
      const title = agenda.title as string;
      const scheduledTime = agenda.scheduled_time as string;
      const d = new Date(scheduledTime);
      const dateStr = d.toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });

      const editTag = `[EDIT_AG:${agendaId}]`;
      const text =
        `${editTag}\n\n` +
        `✏️ <b>Edit Agenda</b>\n\n` +
        `📋 Judul: ${escapeHtml(title)}\n⏰ Waktu: ${dateStr}\n\n` +
        `💬 <b>Balas pesan ini</b> dengan format:\n<code>judul baru\nYYYY-MM-DD HH:MM</code>`;

      await sendTextWithKeyboard(chatId, text, [[{ text: '❌ Batal', callback_data: 'menu_main' }]]);
      return;
    }

    // ── SALARY SETTINGS ──
    if (data === 'menu_salary') {
      await answerCb(cbId);
      await editMsgText(chatId, msgId, '💵 Loading setting gaji...');
      await showSalarySettings(chatId, userId);
      return;
    }

    if (data === 'add_salary') {
      await answerCb(cbId);
      await addSalaryPrompt(chatId);
      return;
    }

    // ── FORCE PROCESS SALARY ──
    if (data === 'force_salary') {
      await answerCb(cbId);
      const wasRecorded = await processSalaryForMonth(userId, true);
      if (wasRecorded) {
        await editMsgText(chatId, msgId,
          `🔥 <b>Gaji Bulan Ini Diproses Ulang!</b>\n\nGaji sudah dicatat ulang ke pemasukan ya bro! ✅\nCek menu 📈 Cek Pemasukan untuk lihat hasilnya.`,
          [[{ text: '📈 Cek Pemasukan', callback_data: 'menu_inc' }, { text: '💵 Setting Gaji', callback_data: 'menu_salary' }]]
        );
      } else {
        await editMsgText(chatId, msgId,
          `ℹ️ Ga ada gaji yang perlu diproses.\n\nMungkin payment day belum lewat, atau ga ada setting gaji yang aktif.`,
          [[{ text: '💵 Setting Gaji', callback_data: 'menu_salary' }, { text: '🔙 Kembali', callback_data: 'menu_main' }]]
        );
      }
      return;
    }

    if (data === 'menu_salary_rekap') {
      await answerCb(cbId);
      await editMsgText(chatId, msgId, '💵 Loading rekap gaji...');
      await showSalaryRekap(chatId, userId);
      return;
    }

    // ── EDIT SALARY ──
    if (data.startsWith('edit_salary:')) {
      const salaryId = data.split(':')[1];
      await answerCb(cbId);

      const salResults = await sbGet('monthly_salaries', `select=*&id=eq.${salaryId}&user_id=eq.${userId}`) as Record<string, unknown>[];
      if (!Array.isArray(salResults) || salResults.length === 0) {
        await editMsgText(chatId, msgId, '❌ Gaji ga ketemu bro.',
          [[{ text: '🔙 Kembali', callback_data: 'menu_salary' }]]);
        return;
      }

      const sal = salResults[0];
      const amount = Number(sal.amount);
      const desc = (sal.description as string) || '-';
      const day = (sal.payment_day as number) || 1;

      const editTag = `[EDIT_SALARY:${salaryId}]`;
      const editText =
        `✏️ <b>Edit Gaji Bulanan</b>\n\n` +
        `📌 Deskripsi: <b>${escapeHtml(desc)}</b>\n` +
        `💰 Nominal: <b>${formatRupiah(amount)}</b>\n` +
        `📅 Tanggal: <b>${day}</b> setiap bulan\n\n` +
        `👇 <b>Balas pesan ini</b> dengan data baru.\n\n` +
        `Format fleksibel, misalnya:\n` +
        `• <code>Gaji kantor 5jt</code> (deskripsi + nominal)\n` +
        `• <code>Gaji kantor 5jt 25</code> (+ tanggal)\n` +
        `• <code>6jt</code> (ubah nominal saja)\n` +
        `• <code>10</code> (ubah tanggal saja)\n\n` +
        `<i>Ketik /cancel untuk batal.</i>`;

      await sendForceReply(chatId, `${editTag}\n\n${editText}`, 'Ketik data gaji baru...');
      return;
    }

    // ── DELETE SALARY ──
    if (data.startsWith('del_salary:')) {
      const salaryId = data.split(':')[1];
      await answerCb(cbId);

      const salResults = await sbGet('monthly_salaries', `select=*&id=eq.${salaryId}&user_id=eq.${userId}`) as Record<string, unknown>[];
      if (!Array.isArray(salResults) || salResults.length === 0) {
        await editMsgText(chatId, msgId, '❌ Gaji ga ketemu.',
          [[{ text: '🔙 Kembali', callback_data: 'menu_salary' }]]);
        return;
      }

      const sal = salResults[0];
      await editMsgText(chatId, msgId,
        `⚠️ <b>Konfirmasi Hapus Gaji</b>\n\n` +
        `Hapus setting gaji ini?\n\n` +
        `📌 ${escapeHtml((sal.description as string) || '-')}\n` +
        `💰 ${formatRupiah(Number(sal.amount))}\n` +
        `📅 Tanggal ${(sal.payment_day as number) || 1}\n\n` +
        `⚠️ GA BISA di-undo bro!`,
        [[
          { text: '✅ Yakin, Hapus!', callback_data: `cfm:del_salary:${salaryId}` },
          { text: '❌ Batal', callback_data: 'menu_salary' },
        ]]
      );
      return;
    }

    if (data.startsWith('cfm:del_salary:')) {
      const salaryId = data.split(':')[2];
      await answerCb(cbId, '🗑️ Dihapus!');
      const result = await sbDelete('monthly_salaries', `id=eq.${salaryId}&user_id=eq.${userId}`);
      if (result.ok) {
        await editMsgText(chatId, msgId, `🗑️ <b>Gaji Dihapus!</b>\n\nSetting gaji udah dihapus bro! 🌴`,
          [[{ text: '💵 Setting Gaji', callback_data: 'menu_salary' }, { text: '🔙 Kembali', callback_data: 'menu_main' }]]);
      } else {
        await editMsgText(chatId, msgId, '❌ Gagal hapus.',
          [[{ text: '🔙 Kembali', callback_data: 'menu_salary' }]]);
      }
      return;
    }

    if (data === 'cancel') {
      await answerCb(cbId, 'Batal bro 👍');
      await editMsgText(chatId, msgId, '👌 Oke bro, dibatalin.',
        [[{ text: '🔙 Kembali ke Menu', callback_data: 'menu_main' }]]);
      return;
    }

    await answerCb(cbId, '❓ Ga kebaca');
  } catch (e) {
    console.error('Callback error:', e);
    await answerCb(cbId, '⚠️ Error bro');
  }
}

// ─────────────── REPLY-TO-MESSAGE HANDLER ───────────────

async function handleReply(
  message: Record<string, unknown>,
  userId: number
): Promise<boolean> {
  const replyTo = message.reply_to_message as Record<string, unknown> | undefined;
  if (!replyTo) return false;

  const replyText = replyTo.text as string || '';
  const userText = (message.text as string || '').trim();
  if (!userText) return false;

  const chatId = (message.chat as Record<string, unknown>).id as number;

  // ── EDIT TRANSACTION ITEM (keterangan, nominal, jam) ──
  const txItemEditMatch = replyText.match(/\[EDIT_ITEM:([a-f0-9-]+)\]/);
  if (txItemEditMatch) {
    const txId = txItemEditMatch[1];

    // Check if user wants to cancel
    if (userText.toLowerCase() === '/cancel' || userText.toLowerCase() === 'batal') {
      await sendText(chatId, '👌 Oke bro, edit dibatalin.');
      await deleteMsg(chatId, replyTo.message_id as number).catch(() => {});
      return true;
    }

    const lines = userText.split('\n').map(l => l.trim()).filter(Boolean);
    let line1 = lines[0] || '';
    let line2 = lines[1] || '';
    let line3 = lines[2] || '';

    const updateData: Record<string, unknown> = {};

    // Fetch existing transaction FIRST to get type and original date
    const txResults = await sbGet('transactions', `select=type,description,created_at&user_id=eq.${userId}&id=eq.${txId}`) as Record<string, unknown>[];
    if (!Array.isArray(txResults) || txResults.length === 0) {
      await sendText(chatId, '❌ Transaksi ga ketemu bro.');
      return true;
    }

    const txType = txResults[0].type as string || 'expense';
    const origDate = (txResults[0].created_at as string) || todayStr();

    // ── SMART PARSER: extract nominal & jam from any line ──
    let extractedDesc = '';
    let extractedAmount: number | null = null;
    let extractedTime: string | null = null;

    for (const line of [line1, line2, line3]) {
      if (!line) continue;
      const lower = line.toLowerCase();

      // Check for time pattern: "Jam 15:30", "15:30", "jam 3 sore"
      if (/jam/i.test(lower) || /^\d{1,2}:\d{2}$/.test(lower)) {
        const timeMatch = lower.match(/(\d{1,2}):(\d{2})/);
        if (timeMatch) {
          const h = parseInt(timeMatch[1]);
          const m = parseInt(timeMatch[2]);
          if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
            extractedTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
          }
          continue;
        }
      }

      // Check for amount pattern — CATCHES ALL variations:
      // "8rb", "8K", "80.000", "1.5jt", "8 ribu", "Rp 8000", "8 juta", "8jt"
      const amountPatterns = [
        // "Rp 8000", "rp.8000", "RP8000"
        /(?:rp|rp\.?)\s*(\d[\d.,]*\s*(?:rb|ribu|k|jt|juta|m)?)\s*$/i,
        // "8 ribu", "80 juta", "1.5 juta"
        /(\d[\d.,]*\s*(?:ribu|juta)\s*)$/,
        // "8rb", "80.000", "1.5jt", "8k", "1m"
        /(\d[\d.,]*\s*(?:rb|k|jt|m)?)\s*$/,
      ];

      let amountMatch: RegExpMatchArray | null = null;
      for (const pat of amountPatterns) {
        amountMatch = lower.match(pat);
        if (amountMatch) {
          // amountPatterns[0] has capture group at index 1, others at index 1 too
          // But for pattern[0] (Rp prefix), the amount is in group 1
          break;
        }
      }

      if (amountMatch) {
        // Extract the amount string (group 1 for all patterns)
        const amountStr = amountMatch[1] || amountMatch[0];
        const parsed = parseAmount(amountStr);
        if (parsed) {
          extractedAmount = parsed;
          // Extract description part (remove amount, Rp prefix, and extra spaces)
          let descPart = line.replace(amountMatch[0], '').replace(/\s+/g, ' ').trim();
          // Remove "Rp" prefix if still present
          descPart = descPart.replace(/^(?:rp|rp\.?)\s*/i, '').trim();
          if (descPart.length >= 2) extractedDesc = descPart;
          continue;
        }
      }

      // Plain number only (e.g., "8000", "25000")
      const plainNum = lower.match(/^(\d[\d.]*)$/);
      if (plainNum) {
        const num = parseFloat(plainNum[1].replace(/\./g, ''));
        if (!isNaN(num) && num > 0) {
          extractedAmount = Math.round(num);
          continue;
        }
      }

      // Otherwise it's description text
      if (!extractedDesc) extractedDesc = line;
    }

    // Apply extracted description
    if (extractedDesc) {
      updateData.description = extractedDesc;
      updateData.category = guessCategory(extractedDesc, txType);
    }

    // Apply extracted nominal
    if (extractedAmount) {
      updateData.amount = extractedAmount;
    }

    // Apply extracted time — preserve original date
    if (extractedTime) {
      const datePart = origDate.split(' ')[0] || origDate.split('T')[0] || todayStr();
      updateData.created_at = new Date(`${datePart}T${extractedTime}:00`).toISOString();
    }

    if (Object.keys(updateData).length === 0) {
      await sendText(chatId, '🤔 Ga ngerti lu mau edit apa bro. Kirim format:\n<code>keterangan baru\nnominal baru\nJam HH:MM</code>\n\nKetik /cancel untuk batal.');
      return true;
    }

    const result = await sbPatch('transactions', txId, updateData);
    if (result.ok) {
      let changes = '';
      if (updateData.description) changes += `📌 Keterangan: ${escapeHtml(updateData.description as string)}\n`;
      if (updateData.amount) changes += `💰 Nominal: ${formatRupiah(updateData.amount as number)}\n`;
      if (updateData.created_at) changes += `⏰ Waktu: ${escapeHtml(new Date(updateData.created_at as string).toLocaleString('id-ID'))}\n`;
      if (updateData.category) changes += `📂 Kategori: ${escapeHtml(updateData.category as string)}\n`;
      await sendText(chatId, `✏️ <b>Berhasil Edit!</b>\n\n${changes}\nData lama udah diupdate, bukan ditambah baru! ✅`);
      await deleteMsg(chatId, replyTo.message_id as number).catch(() => {});
    } else {
      await sendText(chatId, '❌ Gagal update transaksi.');
    }
    return true;
  }

  // ── ADD SALARY ──
  const addSalaryMatch = replyText.match(/\[ADD_SALARY\]/);
  if (addSalaryMatch) {
    if (userText.toLowerCase() === '/cancel' || userText.toLowerCase() === 'batal') {
      await sendText(chatId, '👌 Oke bro, batal set gaji.');
      await deleteMsg(chatId, replyTo.message_id as number).catch(() => {});
      return true;
    }

    // Parse: "Gaji kantor 5jt 25" → desc="Gaji kantor", amount=5000000, day=25
    const lines = userText.split('\n').map(l => l.trim()).filter(Boolean);
    const fullText = lines.join(' ');

    let salaryDesc = '';
    let salaryAmount: number | null = null;
    let salaryDay = 1;
    let amountStr = '';  // track what was matched for description cleanup

    // Step 1: Extract amount with REQUIRED suffix first (rb/k/jt/m/ribu/juta — unambiguous)
    const suffixPat = /(\d[\d.,]*\s*(?:rb|ribu|k|jt|juta|m))/i;
    const suffixMatch = fullText.match(suffixPat);
    let textForDay = fullText;
    if (suffixMatch) {
      salaryAmount = parseAmount(suffixMatch[1]);
      amountStr = suffixMatch[0];
      textForDay = fullText.replace(suffixMatch[0], '').trim();
    }

    // Step 2: Extract day number (1-28) from remaining text
    const dayMatch = textForDay.match(/(\d{1,2})\s*$/);
    if (dayMatch) {
      const d = parseInt(dayMatch[1]);
      if (d >= 1 && d <= 28) {
        salaryDay = d;
        textForDay = textForDay.replace(/\d{1,2}\s*$/, '').trim();
      }
    }

    // Step 3: If no suffix amount, try plain number from remaining text (day already removed)
    if (!salaryAmount) {
      const plainNum = textForDay.match(/(\d[\d.]*)/);
      if (plainNum) {
        const num = parseFloat(plainNum[1].replace(/\./g, ''));
        if (!isNaN(num) && num > 100) {
          salaryAmount = Math.round(num);
          amountStr = plainNum[0];
        }
      }
    }

    // Extract description (remove amount and day from full text)
    let descPart = fullText;
    if (amountStr) {
      descPart = descPart.replace(amountStr, '').trim();
    }
    if (salaryDay >= 1 && salaryDay <= 28) {
      descPart = descPart.replace(/\d{1,2}\s*$/, '').trim();
    }
    descPart = descPart.replace(/\s+/g, ' ').trim();
    if (descPart.length >= 2) {
      salaryDesc = descPart;
    } else {
      salaryDesc = 'Gaji Bulanan';
    }

    if (!salaryAmount || salaryAmount <= 0) {
      await sendText(chatId, '🤔 Ga bisa baca nominalnya bro. Contoh:\n<code>Gaji kantor 5jt 25</code>\n\nKetik /cancel untuk batal.');
      return true;
    }

    const cat = guessCategory(salaryDesc, 'income');
    const result = await sbPost('monthly_salaries', {
      user_id: userId,
      amount: salaryAmount,
      description: salaryDesc,
      category: cat,
      payment_day: salaryDay,
      last_processed_month: null,
    });

    if (result.ok) {
      await sendText(chatId,
        `💵 <b>Gaji Bulanan Diset!</b>\n\n` +
        `📌 ${escapeHtml(salaryDesc)}\n` +
        `💰 ${formatRupiah(salaryAmount)}\n` +
        `📂 ${escapeHtml(cat)}\n` +
        `📅 Setiap tanggal ${salaryDay}\n\n` +
        `Gaji bakal otomatis dicatat tiap bulan ya bro! 🔥`);
      await deleteMsg(chatId, replyTo.message_id as number).catch(() => {});
    } else {
      await sendText(chatId, '❌ Gagal simpan gaji. Coba lagi.');
    }
    return true;
  }

  // ── EDIT SALARY ──
  const editSalaryMatch = replyText.match(/\[EDIT_SALARY:([a-f0-9-]+)\]/);
  if (editSalaryMatch) {
    const salaryId = editSalaryMatch[1];

    if (userText.toLowerCase() === '/cancel' || userText.toLowerCase() === 'batal') {
      await sendText(chatId, '👌 Oke bro, edit gaji dibatalin.');
      await deleteMsg(chatId, replyTo.message_id as number).catch(() => {});
      return true;
    }

    // Parse same as add but update existing
    const lines = userText.split('\n').map(l => l.trim()).filter(Boolean);
    const fullText = lines.join(' ');

    let salaryDesc = '';
    let salaryAmount: number | null = null;
    let salaryDay: number | null = null;
    let amountStr = '';  // track what was matched for description cleanup

    // Step 1: Extract amount with REQUIRED suffix first (rb/k/jt/m/ribu/juta — unambiguous)
    const suffixPat = /(\d[\d.,]*\s*(?:rb|ribu|k|jt|juta|m))/i;
    const suffixMatch = fullText.match(suffixPat);
    let textForDay = fullText;
    if (suffixMatch) {
      salaryAmount = parseAmount(suffixMatch[1]);
      amountStr = suffixMatch[0];
      textForDay = fullText.replace(suffixMatch[0], '').trim();
    }

    // Step 2: Extract day number (1-28) from remaining text
    const dayMatch = textForDay.match(/(\d{1,2})\s*$/);
    if (dayMatch) {
      const d = parseInt(dayMatch[1]);
      if (d >= 1 && d <= 28) {
        salaryDay = d;
        textForDay = textForDay.replace(/\d{1,2}\s*$/, '').trim();
      }
    }

    // Step 3: If no suffix amount, try plain number from remaining text (day already removed)
    if (!salaryAmount) {
      const plainNum = textForDay.match(/(\d[\d.]*)/);
      if (plainNum) {
        const num = parseFloat(plainNum[1].replace(/\./g, ''));
        if (!isNaN(num) && num > 100) {
          salaryAmount = Math.round(num);
          amountStr = plainNum[0];
        }
      }
    }

    // Extract description
    let descPart = fullText;
    if (amountStr) {
      descPart = descPart.replace(amountStr, '').trim();
    }
    if (salaryDay !== null) {
      descPart = descPart.replace(/\d{1,2}\s*$/, '').trim();
    }
    descPart = descPart.replace(/\s+/g, ' ').trim();
    if (descPart.length >= 2) {
      salaryDesc = descPart;
    }

    const updateData: Record<string, unknown> = {};
    if (salaryDesc) {
      updateData.description = salaryDesc;
      updateData.category = guessCategory(salaryDesc, 'income');
    }
    if (salaryAmount) updateData.amount = salaryAmount;
    if (salaryDay !== null) updateData.payment_day = salaryDay;

    // If just a small number (1-28) with no amount, it's a day change
    if (!salaryAmount && !salaryDesc && salaryDay !== null) {
      updateData.payment_day = salaryDay;
    }

    if (Object.keys(updateData).length === 0) {
      await sendText(chatId, '🤔 Ga ngerti lu mau edit apa bro. Contoh:\n<code>Gaji kantor 5jt 25</code>\n\nKetik /cancel untuk batal.');
      return true;
    }

    // If amount or payment_day changed, reset last_processed_month so salary re-processes this month
    if (updateData.amount || updateData.payment_day) {
      updateData.last_processed_month = null;
    }

    const result = await sbPatch('monthly_salaries', salaryId, updateData);
    if (result.ok) {
      let changes = '';
      if (updateData.description) changes += `📌 Deskripsi: ${escapeHtml(updateData.description as string)}\n`;
      if (updateData.amount) changes += `💰 Nominal: ${formatRupiah(updateData.amount as number)}\n`;
      if (updateData.payment_day) changes += `📅 Tanggal: ${updateData.payment_day} setiap bulan\n`;
      if (updateData.category) changes += `📂 Kategori: ${escapeHtml(updateData.category as string)}\n`;
      let extraNote = '';
      if (updateData.last_processed_month === null && (updateData.amount || updateData.payment_day)) {
        extraNote = `\n\n🔄 Gaji bulan ini akan otomatis diupdate saat lu buka menu Rekap/Pemasukan.`;
      }
      await sendText(chatId, `✏️ <b>Gaji Berhasil Diupdate!</b>\n\n${changes}${extraNote}\nSip bro! ✅`);
      await deleteMsg(chatId, replyTo.message_id as number).catch(() => {});
    } else {
      await sendText(chatId, '❌ Gagal update gaji.');
    }
    return true;
  }

  // ── EDIT AGENDA ──
  const agEditMatch = replyText.match(/\[EDIT_AG:(\d+)\]/);
  if (agEditMatch) {
    const agendaId = agEditMatch[1];
    const lines = userText.split('\n').map(l => l.trim()).filter(Boolean);
    const newTitle = lines[0];
    const newTimeStr = lines[1] || '';

    const updateData: Record<string, unknown> = {};
    if (newTitle) updateData.title = newTitle;

    if (newTimeStr) {
      const dtMatch = newTimeStr.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})/);
      if (dtMatch) {
        const d = new Date(
          parseInt(dtMatch[1]), parseInt(dtMatch[2]) - 1, parseInt(dtMatch[3]),
          parseInt(dtMatch[4]), parseInt(dtMatch[5])
        );
        updateData.scheduled_time = d.toISOString();
      } else {
        const parsed = parseDateTime(newTimeStr);
        if (parsed) updateData.scheduled_time = parsed;
      }
    }

    if (Object.keys(updateData).length === 0) {
      await sendText(chatId, '🤔 Ga ngerti lu mau edit apa bro.');
      return true;
    }

    const result = await sbPatch('agendas', agendaId, updateData);
    if (result.ok) {
      let changes = '';
      if (updateData.title) changes += `📋 Judul: ${escapeHtml(updateData.title as string)}\n`;
      if (updateData.scheduled_time) {
        const d = new Date(updateData.scheduled_time as string);
        changes += `⏰ Waktu: ${d.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}\n`;
      }
      await sendText(chatId, `✏️ <b>Agenda Updated!</b>\n\n${changes}Sip bro, udah diupdate! ✅`);
      await deleteMsg(chatId, replyTo.message_id as number).catch(() => {});
    } else {
      await sendText(chatId, `❌ Gagal update agenda.`);
    }
    return true;
  }

  // ── SET BUDGET (reply to force_reply) ──
  const setBudgetMatch = replyText.match(/\[SET_BUDGET:([^\]]+)\]/);
  if (setBudgetMatch) {
    const category = setBudgetMatch[1];

    if (userText.toLowerCase() === '/cancel' || userText.toLowerCase() === 'batal') {
      await sendText(chatId, '👌 Oke bro, set budget dibatalin.');
      await deleteMsg(chatId, replyTo.message_id as number).catch(() => {});
      return true;
    }

    // Parse amount from user reply
    const lines = userText.split('\n').map(l => l.trim()).filter(Boolean);
    const fullText = lines.join(' ');
    let amount: number | null = null;

    // Try to parse with suffix (rb, k, jt, m, ribu, juta)
    const suffixPat = /(\d[\d.,]*\s*(?:rb|ribu|k|jt|juta|m))/i;
    const suffixMatch = fullText.match(suffixPat);
    if (suffixMatch) {
      amount = parseAmount(suffixMatch[1]);
    }

    // Try plain number
    if (!amount) {
      const plainNum = fullText.match(/(\d[\d.]*)/);
      if (plainNum) {
        const num = parseFloat(plainNum[1].replace(/\./g, ''));
        if (!isNaN(num) && num > 100) {
          amount = Math.round(num);
        }
      }
    }

    if (!amount || amount <= 0) {
      await sendText(chatId,
        `🤔 Ga bisa baca nominalnya bro. Contoh:\n<code>500rb</code> atau <code>1.5jt</code>\n\nKetik /cancel untuk batal.`);
      return true;
    }

    // Upsert budget
    const upsertResult = await upsertBudget(userId, category, amount);

    if (upsertResult.ok) {
      const budgetAlert = await checkBudgetAlert(userId, category);
      const alertText = budgetAlert ? `\n${budgetAlert}` : '';
      await sendTextWithKeyboard(chatId,
        `💰 <b>Budget ${escapeHtml(category.charAt(0).toUpperCase() + category.slice(1))} Diset!</b>\n\n📊 Budget bulanan: <b>${formatRupiah(amount)}</b>\n\nSip bro, pengeluaran lu bakal ke monitor! 🔥${alertText}`,
        mainMenuKeyboard()
      );
      await deleteMsg(chatId, replyTo.message_id as number).catch(() => {});
    } else {
      await sendText(chatId, '❌ Gagal set budget bro. Coba lagi.');
    }
    return true;
  }

  // ── ADD DEBT (reply to force_reply) ──
  const addDebtMatch = replyText.match(/\[ADD_DEBT:(piutang|utang)\]/);
  if (addDebtMatch) {
    const debtType = addDebtMatch[1];

    // Check cancel
    if (userText.toLowerCase() === '/cancel' || userText.toLowerCase() === 'batal') {
      await sendText(chatId, '👌 Oke bro, batal tambah piutang/utang.');
      await deleteMsg(chatId, replyTo.message_id as number).catch(() => {});
      return true;
    }

    // Parse: "Budi 500rb" / "Andi 1jt bayar makan" / "Citra 200rb 25"
    const debtInputMatch = userText.match(/^(\S+)\s+(\d[\d.,]*\s*(?:rb|k|jt|m|juta|ribu))\s*(.*)?$/i);
    if (!debtInputMatch) {
      await sendText(chatId, `❌ Format salah bro. Contoh:\n• <code>Budi 500rb</code>\n• <code>Andi 1jt bayar makan</code>\n• <code>Citra 200rb 25</code> (25 = tgl jatuh tempo)\n\nKetik /cancel untuk batal.`);
      return true;
    }

    const personName = debtInputMatch[1].trim();
    const rawAmount = debtInputMatch[2];
    const rest = (debtInputMatch[3] || '').trim();

    const amount = parseAmount(rawAmount);
    if (!amount || amount <= 0) {
      await sendText(chatId, '❌ Nominal ga kebaca bro. Coba lagi.');
      return true;
    }

    // Parse description and optional due day
    let description = '';
    let dueDate: string | null = null;

    if (rest) {
      // Check if the last token is a number (1-31) for due date
      const parts = rest.split(/\s+/);
      const lastPart = parts[parts.length - 1];
      const dueDayMatch = lastPart.match(/^(\d{1,2})$/);
      if (dueDayMatch) {
        const day = parseInt(dueDayMatch[1]);
        if (day >= 1 && day <= 31) {
          dueDate = getNextDueDate(day);
          // Everything before the day number is description
          description = parts.slice(0, -1).join(' ').trim();
        } else {
          description = rest;
        }
      } else {
        description = rest;
      }
    }

    const result = await sbPost('debts', {
      user_id: userId,
      type: debtType,
      person_name: personName,
      amount: amount,
      description: description || '',
      due_date: dueDate,
    });

    if (!result.ok) {
      await sendText(chatId, `❌ Gagal simpan piutang/utang bro. Error: ${result.error}`);
      return true;
    }

    const emoji = debtType === 'piutang' ? '📥' : '📤';
    const label = debtType === 'piutang' ? 'Piutang' : 'Utang';
    let responseText = `${emoji} <b>${label} Dicatat!</b>\n\n`;
    responseText += `👤 ${escapeHtml(personName)}\n`;
    responseText += `💰 <b>${formatRupiah(amount)}</b>\n`;
    if (description) responseText += `📌 ${escapeHtml(description)}\n`;
    if (dueDate) {
      const dd = new Date(dueDate);
      responseText += `📅 Jatuh tempo: ${dd.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long', year: 'numeric' })}\n`;
    }
    responseText += `\n${debtType === 'piutang' ? 'Orang lain hutang ke lu ya bro! 📝' : 'Jangan lupa bayar ya bro! 💪'}`;

    await sendTextWithKeyboard(chatId, responseText, mainMenuKeyboard());
    await deleteMsg(chatId, replyTo.message_id as number).catch(() => {});
    return true;
  }

  // ── ADD RECURRING (reply to force_reply) ──
  const addRecurringMatch = replyText.match(/\[ADD_RECURRING\]/);
  if (addRecurringMatch) {
    if (userText.toLowerCase() === '/cancel' || userText.toLowerCase() === 'batal') {
      await sendText(chatId, '👌 Oke bro, batal tambah pengeluaran rutin.');
      await deleteMsg(chatId, replyTo.message_id as number).catch(() => {});
      return true;
    }

    // Parse: "Netflix 153rb 5 tagihan" → title=Netflix, amount=153000, day=5, category=tagihan
    //         "Spotify 50rb 10" → title=Spotify, amount=50000, day=10, category=tagihan
    //         "Kontrakan 1.5jt 1 belanja" → title=Kontrakan, amount=1500000, day=1, category=belanja
    const lines = userText.split('\n').map(l => l.trim()).filter(Boolean);
    const fullText = lines.join(' ');

    let recurringTitle = '';
    let recurringAmount: number | null = null;
    let recurringDay: number | null = null;
    let amountStr = '';
    let categoryWord = '';

    // Step 1: Extract amount with suffix first (rb/k/jt/m/ribu/juta)
    const suffixPat = /(\d[\d.,]*\s*(?:rb|ribu|k|jt|juta|m))/i;
    const suffixMatch = fullText.match(suffixPat);
    if (suffixMatch) {
      recurringAmount = parseAmount(suffixMatch[1]);
      amountStr = suffixMatch[0];
    }

    // Step 2: Extract day from end of text (after removing amount)
    let textForDay = fullText;
    if (amountStr) {
      textForDay = textForDay.replace(amountStr, '').trim();
    }
    const dayMatch = textForDay.match(/(\d{1,2})\s*$/);
    if (dayMatch) {
      const d = parseInt(dayMatch[1]);
      if (d >= 1 && d <= 31) {
        recurringDay = d;
        textForDay = textForDay.replace(/\d{1,2}\s*$/, '').trim();
      }
    }

    // Step 3: If no suffix amount, try plain number from remaining text
    if (!recurringAmount) {
      const plainNum = textForDay.match(/(\d[\d.]*)/);
      if (plainNum) {
        const num = parseFloat(plainNum[1].replace(/\./g, ''));
        if (!isNaN(num) && num > 100) {
          recurringAmount = Math.round(num);
          amountStr = plainNum[0];
          textForDay = textForDay.replace(amountStr, '').trim();
        }
      }
    }

    // Step 4: Extract title and optional category from remaining text
    // The last word might be a category
    const words = textForDay.replace(/\s+/g, ' ').trim().split(' ');
    if (words.length >= 2) {
      // Check if last word looks like a category (not a number)
      const lastWord = words[words.length - 1];
      if (/^[a-zA-Z]+$/.test(lastWord) && words.length >= 2) {
        categoryWord = lastWord.toLowerCase();
        recurringTitle = words.slice(0, -1).join(' ');
      } else {
        recurringTitle = words.join(' ');
      }
    } else if (words.length === 1 && words[0]) {
      recurringTitle = words[0];
    }

    if (!recurringTitle || recurringTitle.length < 2) {
      recurringTitle = 'Pengeluaran Rutin';
    }

    if (!recurringAmount || recurringAmount <= 0) {
      await sendText(chatId,
        `🤔 Ga bisa baca nominalnya bro. Contoh:\n<code>Netflix 153rb 5 tagihan</code>\n\nKetik /cancel untuk batal.`);
      return true;
    }

    if (!recurringDay || recurringDay < 1 || recurringDay > 31) {
      await sendText(chatId,
        `🤔 Ga bisa baca tanggalnya bro (1-31). Contoh:\n<code>Netflix 153rb 5</code>\n\nKetik /cancel untuk batal.`);
      return true;
    }

    const cat = guessCategory(categoryWord || recurringTitle, 'expense');
    const titleCased = recurringTitle.charAt(0).toUpperCase() + recurringTitle.slice(1);

    const result = await sbPost('recurring_expenses', {
      user_id: userId,
      title: titleCased,
      amount: recurringAmount,
      category: cat,
      payment_day: recurringDay,
      description: '',
      is_active: true,
    });

    if (result.ok) {
      await sendText(chatId,
        `🔄 <b>Pengeluaran Rutin Ditambah!</b>\n\n` +
        `📋 ${escapeHtml(titleCased)}\n` +
        `💰 ${formatRupiah(recurringAmount)} per bulan\n` +
        `📂 ${escapeHtml(cat)}\n` +
        `📅 Setiap tanggal ${recurringDay}\n\n` +
        `Bakal otomatis tercatat tiap bulan ya bro! 🔥`);
      await deleteMsg(chatId, replyTo.message_id as number).catch(() => {});
    } else {
      await sendText(chatId, '❌ Gagal simpan pengeluaran rutin. Coba lagi.');
    }
    return true;
  }

  // ── EDIT RECURRING ──
  const editRecurringMatch = replyText.match(/\[EDIT_RECURRING:([a-f0-9-]+)\]/);
  if (editRecurringMatch) {
    const recurringId = editRecurringMatch[1];

    if (userText.toLowerCase() === '/cancel' || userText.toLowerCase() === 'batal') {
      await sendText(chatId, '👌 Oke bro, edit pengeluaran rutin dibatalin.');
      await deleteMsg(chatId, replyTo.message_id as number).catch(() => {});
      return true;
    }

    // Parse same as add but update existing
    const lines = userText.split('\n').map(l => l.trim()).filter(Boolean);
    const fullText = lines.join(' ');

    let recurringTitle = '';
    let recurringAmount: number | null = null;
    let recurringDay: number | null = null;
    let amountStr = '';
    let categoryWord = '';

    // Step 1: Extract amount with suffix first
    const suffixPat = /(\d[\d.,]*\s*(?:rb|ribu|k|jt|juta|m))/i;
    const suffixMatch = fullText.match(suffixPat);
    if (suffixMatch) {
      recurringAmount = parseAmount(suffixMatch[1]);
      amountStr = suffixMatch[0];
    }

    // Step 2: Extract day from end of text
    let textForDay = fullText;
    if (amountStr) {
      textForDay = textForDay.replace(amountStr, '').trim();
    }
    const dayMatch = textForDay.match(/(\d{1,2})\s*$/);
    if (dayMatch) {
      const d = parseInt(dayMatch[1]);
      if (d >= 1 && d <= 31) {
        recurringDay = d;
        textForDay = textForDay.replace(/\d{1,2}\s*$/, '').trim();
      }
    }

    // Step 3: If no suffix amount, try plain number
    if (!recurringAmount) {
      const plainNum = textForDay.match(/(\d[\d.]*)/);
      if (plainNum) {
        const num = parseFloat(plainNum[1].replace(/\./g, ''));
        if (!isNaN(num) && num > 100) {
          recurringAmount = Math.round(num);
          amountStr = plainNum[0];
          textForDay = textForDay.replace(amountStr, '').trim();
        }
      }
    }

    // Step 4: Extract title and optional category
    const words = textForDay.replace(/\s+/g, ' ').trim().split(' ');
    if (words.length >= 2) {
      const lastWord = words[words.length - 1];
      if (/^[a-zA-Z]+$/.test(lastWord)) {
        categoryWord = lastWord.toLowerCase();
        recurringTitle = words.slice(0, -1).join(' ');
      } else {
        recurringTitle = words.join(' ');
      }
    } else if (words.length === 1 && words[0]) {
      recurringTitle = words[0];
    }

    const updateData: Record<string, unknown> = {};
    if (recurringTitle && recurringTitle.length >= 2) {
      updateData.title = recurringTitle.charAt(0).toUpperCase() + recurringTitle.slice(1);
      if (categoryWord) {
        updateData.category = guessCategory(categoryWord, 'expense');
      }
    }
    if (recurringAmount) updateData.amount = recurringAmount;
    if (recurringDay !== null) updateData.payment_day = recurringDay;

    // If just a small number (1-31) with no amount, it's a day change
    if (!recurringAmount && !recurringTitle && recurringDay !== null) {
      updateData.payment_day = recurringDay;
    }

    if (Object.keys(updateData).length === 0) {
      await sendText(chatId, '🤔 Ga ngerti lu mau edit apa bro. Contoh:\n<code>Netflix 186rb 10</code>\n\nKetik /cancel untuk batal.');
      return true;
    }

    // If amount or payment_day changed, reset last_processed_month so it re-processes
    if (updateData.amount || updateData.payment_day) {
      updateData.last_processed_month = null;
    }

    const result = await sbPatch('recurring_expenses', recurringId, updateData);
    if (result.ok) {
      let changes = '';
      if (updateData.title) changes += `📋 Judul: ${escapeHtml(updateData.title as string)}\n`;
      if (updateData.amount) changes += `💰 Nominal: ${formatRupiah(updateData.amount as number)}\n`;
      if (updateData.payment_day) changes += `📅 Tanggal: ${updateData.payment_day} setiap bulan\n`;
      if (updateData.category) changes += `📂 Kategori: ${escapeHtml(updateData.category as string)}\n`;
      let extraNote = '';
      if (updateData.last_processed_month === null && (updateData.amount || updateData.payment_day)) {
        extraNote = `\n\n🔄 Pengeluaran rutin bulan ini akan otomatis diupdate saat lu buka menu 🔄 Rutin.`;
      }
      await sendText(chatId, `✏️ <b>Pengeluaran Rutin Berhasil Diupdate!</b>\n\n${changes}${extraNote}\nSip bro! ✅`);
      await deleteMsg(chatId, replyTo.message_id as number).catch(() => {});
    } else {
      await sendText(chatId, '❌ Gagal update pengeluaran rutin.');
    }
    return true;
  }

  return false;
}

// ─────────────── MESSAGE PROCESSOR ───────────────

async function processMessage(message: Record<string, unknown>): Promise<void> {
  const chatId = (message.chat as Record<string, unknown>).id as number;
  const user = message.from as Record<string, unknown>;
  const userId = user?.id as number;
  const username = (user?.username as string) || (user?.first_name as string) || 'unknown';
  const text = (message.text as string || '').trim();

  if (!userId || !text) return;

  // ── USER WHITELIST CHECK ──
  if (!isUserAllowed(userId)) {
    console.log(`[BLOCKED] userId=${userId} not in ALLOWED_USER_IDS`);
    await sendText(chatId, '🚫 Maaf bro, bot ini cuma buat user tertentu aja. Lu gak punya akses. 🙅').catch(() => {});
    return;
  }

  console.log(`[MSG] userId=${userId} text="${text}"`);

  // Ensure user exists
  await ensureUser(userId, username).catch(() => {});

  // ── CHECK EDIT MODE (REPLY TO BOT MESSAGE) ──
  if (message.reply_to_message) {
    const handled = await handleReply(message, userId);
    if (handled) return;
  }

  // ── COMMANDS ──
  const lower = text.toLowerCase();
  if (lower === '/start' || lower === '/start@santuybot') {
    await cmdStart(chatId, user);
    return;
  }
  if (lower === '/help' || lower === '/help@santuybot' || lower === '/menu' || lower === '/menu@santuybot') {
    await cmdHelp(chatId);
    return;
  }
  if (lower === '/rekap' || lower.startsWith('/rekap')) {
    await sendTextWithKeyboard(chatId, '💰 <b>Pilih periode rekap:</b>', rekapPeriodKeyboard());
    return;
  }
  if (lower === '/pdf' || lower === '/rekappdf' || lower.startsWith('/pdf')) {
    await sendText(chatId, '⏳ Sedang generate PDF laporan keuangan bulan ini...');
    const pdfBytes = await generateRekapPDF(userId, 0);
    if (pdfBytes) {
      const d = new Date();
      const MONTHS = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
      const fname = `SantuyBot_Rekap_${MONTHS[d.getMonth()]}_${d.getFullYear()}.pdf`;
      const sent = await sendPDFDocument(chatId, pdfBytes, fname);
      if (!sent) await sendText(chatId, '❌ Gagal kirim PDF bro. Coba lagi.');
    } else {
      await sendText(chatId, '❌ Gagal generate PDF bro. Coba lagi nanti.');
    }
    return;
  }
  if (lower === '/pengeluaran' || lower === '/expense' || lower === '/keluar') {
    await showExpenses(chatId, userId);
    return;
  }
  if (lower === '/pemasukan' || lower === '/income' || lower === '/masuk') {
    await showIncomes(chatId, userId);
    return;
  }
  if (lower === '/jadwal' || lower === '/agenda' || lower === '/schedule') {
    await showAgendas(chatId, userId);
    return;
  }
  if (lower === '/gaji' || lower === '/salary' || lower === '/gajibulanan') {
    await showSalarySettings(chatId, userId);
    return;
  }
  if (lower === '/rekapgaji' || lower === '/salaryrekap') {
    await showSalaryRekap(chatId, userId);
    return;
  }
  if (lower === '/rutin' || lower === '/recurring' || lower === '/pengeluaranrutin') {
    await showRecurringMenu(chatId, userId);
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 1: REGEX PARSER DULU (OFFLINE, HEMAT TOKEN GEMINI!)
  // ═══════════════════════════════════════════════════════════════
  const regexResult = parseRegex(text);

  if (regexResult.handled && regexResult.action && regexResult.data) {
    console.log(`[REGEX] action=${regexResult.action} data=${JSON.stringify(regexResult.data)}`);

    try {
      switch (regexResult.action) {
        case 'add_expense': {
          const d = regexResult.data;
          const result = await sbPost('transactions', {
            user_id: userId,
            type: 'expense',
            amount: d.amount,
            category: d.category || 'lainnya',
            description: d.description || '',
          });
          console.log(`[REGEX] add_expense result:`, JSON.stringify(result));
          if (!result.ok) {
            await sendText(chatId, `❌ Gagal simpan pengeluaran bro. Coba lagi. Error: ${result.error}`);
            return;
          }
          // Budget alert check
          const budgetAlert = await checkBudgetAlert(userId, (d.category as string) || 'lainnya');
          if (budgetAlert) {
            regexResult.text += budgetAlert;
          }
          break;
        }

        case 'add_income': {
          const d = regexResult.data;
          const result = await sbPost('transactions', {
            user_id: userId,
            type: 'income',
            amount: d.amount,
            category: d.category || 'lainnya',
            description: d.description || '',
          });
          console.log(`[REGEX] add_income result:`, JSON.stringify(result));
          if (!result.ok) {
            await sendText(chatId, `❌ Gagal simpan pemasukan bro. Error: ${result.error}`);
            return;
          }
          break;
        }

        case 'add_agenda': {
          const d = regexResult.data;
          const result = await sbPost('agendas', {
            user_id: userId,           // ← NUMBER, not String!
            title: d.title,
            scheduled_time: d.scheduled_time,
            description: d.description || '',
            is_completed: false,
            is_reminded: false,
          });
          console.log(`[REGEX] add_agenda result:`, JSON.stringify(result));
          if (!result.ok) {
            await sendText(chatId, `❌ Gagal simpan agenda bro. Error: ${result.error}`);
            return;
          }
          break;
        }

        case 'search': {
          const d = regexResult.data;
          const keyword = d.keyword as string;
          const results = await sbGet(
            'transactions',
            `select=type,amount,category,description&user_id=eq.${userId}&or=(description.ilike.%${keyword}%,category.ilike.%${keyword}%)&order=created_at.desc&limit=10`
          ) as Record<string, unknown>[];

          if (Array.isArray(results) && results.length > 0) {
            let stext = `🔍 <b>Hasil pencarian "${escapeHtml(keyword)}"</b>\n\n`;
            for (let i = 0; i < results.length; i++) {
              const r = results[i];
              const emoji = r.type === 'expense' ? '📉' : '📈';
              const rDate = (r.created_at as string) ? new Date(r.created_at as string).toLocaleDateString('id-ID') : '-';
              stext += `${i + 1}. ${emoji} ${formatRupiah(Number(r.amount))} | ${r.category} | ${r.description || '-'} | ${rDate}\n`;
            }
            await sendTextWithKeyboard(chatId, stext, mainMenuKeyboard());
          } else {
            await sendTextWithKeyboard(chatId, `🔍 Ga ketemu transaksi untuk "${escapeHtml(keyword)}" bro.`, mainMenuKeyboard());
          }
          return;
        }

        case 'show_agenda': {
          await showAgendas(chatId, userId);
          return;
        }

        case 'delete_all': {
          const d = regexResult.data;
          const delType = d.delete_type as string;
          const label = d.label as string;
          // Build confirmation keyboard
          const cfmKeyboard = [
            [
              { text: '✅ Yakin, Hapus Semua!', callback_data: `cfm:del_all:${delType}` },
              { text: '❌ Batal', callback_data: 'cancel' },
            ],
          ];
          await sendTextWithKeyboard(chatId, regexResult.text || `⚠️ Yakin hapus ${label}?`, cfmKeyboard);
          return;
        }

        // ── Financial query handlers (no AI needed) ──
        case 'get_summary': {
          const monthStart = getJakartaMonthStart();
          const txns = await sbGet('transactions', `user_id=eq.${userId}&created_at=gte.${monthStart}&select=type,amount`);
          let totalIncome = 0, totalExpense = 0;
          for (const t of txns as { type: string; amount: number }[]) {
            if (t.type === 'income') totalIncome += t.amount;
            else totalExpense += t.amount;
          }
          const saldo = totalIncome - totalExpense;
          const saldoEmoji = saldo >= 0 ? '😊' : '😬';
          const saran = totalExpense > totalIncome * 0.8 ? '\n\n⚠️ Pengeluaran lu udah lebih dari 80% pemasukan bro, ayo hemat! 💪' : '';
          await sendTextWithKeyboard(chatId,
            `📊 <b>Ringkasan Bulan Ini</b>\n\n💰 Pemasukan: <b>${formatRupiah(totalIncome)}</b>\n💸 Pengeluaran: <b>${formatRupiah(totalExpense)}</b>\n${saldoEmoji} Saldo: <b>${formatRupiah(saldo)}</b>${saran}`,
            mainMenuKeyboard()
          );
          return;
        }

        case 'get_recent': {
          const txns = await sbGet('transactions', `user_id=eq.${userId}&select=type,amount,category,description,created_at&order=created_at.desc&limit=7`);
          if (!txns.length) {
            await sendTextWithKeyboard(chatId, '📭 Belum ada transaksi bro. Coba catat pengeluaran/pemasukan dulu!', mainMenuKeyboard());
            return;
          }
          const lines = txns.map((t: Record<string, unknown>) => {
            const type = t.type === 'income' ? '💰' : '💸';
            const date = new Date(t.created_at as string).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
            const desc = (t.description as string) ? ` — ${t.description}` : '';
            return `${type} <b>${formatRupiah(t.amount as number)}</b> · ${t.category}${desc} · ${date}`;
          });
          await sendTextWithKeyboard(chatId, `📋 <b>Transaksi Terakhir</b>\n\n${lines.join('\n')}`, mainMenuKeyboard());
          return;
        }

        case 'get_budget': {
          const budgets = await sbGet('budgets', `user_id=eq.${userId}&select=category,amount`);
          if (!budgets.length) {
            await sendTextWithKeyboard(chatId, '📋 Belum ada budget yang diset bro. Ketik "budget makan 500rb" untuk mulai!', mainMenuKeyboard());
            return;
          }
          const spentMap = await getMonthlySpentBatch(userId);
          const lines = (budgets as { category: string; amount: number }[]).map(b => {
            const spent = spentMap.get(b.category) || 0;
            const pct = b.amount > 0 ? Math.round((spent / b.amount) * 100) : 0;
            const emoji = budgetStatusEmoji(pct);
            const bar = budgetProgressBar(pct);
            return `${emoji} ${b.category}\n   ${bar} ${formatRupiah(spent)} / ${formatRupiah(b.amount)} (${pct}%)`;
          });
          await sendTextWithKeyboard(chatId, `📊 <b>Status Budget Bulan Ini</b>\n\n${lines.join('\n\n')}`, mainMenuKeyboard());
          return;
        }

        case 'get_debts': {
          const debts = await sbGet('debts', `user_id=eq.${userId}&is_lunasi=eq.false&select=type,name,amount,description&order=created_at.desc`);
          if (!debts.length) {
            await sendTextWithKeyboard(chatId, '✅ Ga ada piutang/utang aktif bro. Bersih! 🎉', mainMenuKeyboard());
            return;
          }
          const piutang = (debts as Record<string, unknown>[]).filter(d => d.type === 'piutang');
          const utang = (debts as Record<string, unknown>[]).filter(d => d.type === 'utang');
          const totalPiutang = piutang.reduce((s, d) => s + (d.amount as number), 0);
          const totalUtang = utang.reduce((s, d) => s + (d.amount as number), 0);
          const lines: string[] = [];
          if (piutang.length) {
            lines.push(`📥 <b>PIUTANG</b> (total: ${formatRupiah(totalPiutang)})`);
            lines.push(...piutang.map(d => `   • <b>${d.name}</b>: ${formatRupiah(d.amount as number)} ${d.description ? '- ' + (d.description as string) : ''}`));
          }
          if (utang.length) {
            lines.push(`📤 <b>UTANG</b> (total: ${formatRupiah(totalUtang)})`);
            lines.push(...utang.map(d => `   • <b>${d.name}</b>: ${formatRupiah(d.amount as number)} ${d.description ? '- ' + (d.description as string) : ''}`));
          }
          await sendTextWithKeyboard(chatId, `📋 <b>Piutang & Utang</b>\n\n${lines.join('\n\n')}`, mainMenuKeyboard());
          return;
        }

        case 'set_budget': {
          const d = regexResult.data;
          const category = d.category as string;
          const amount = d.amount as number;

          if (amount && amount > 0) {
            // Upsert budget
            const upsertResult = await upsertBudget(userId, category, amount);

            if (upsertResult.ok) {
              const budgetAlert = await checkBudgetAlert(userId, category);
              const alertText = budgetAlert ? `\n${budgetAlert}` : '';
              await sendTextWithKeyboard(chatId,
                `💰 <b>Budget ${escapeHtml(category.charAt(0).toUpperCase() + category.slice(1))} Diset!</b>\n\n📊 Budget bulanan: <b>${formatRupiah(amount)}</b>\n\nSip bro, pengeluaran lu bakal ke monitor! 🔥${alertText}`,
                mainMenuKeyboard()
              );
            } else {
              await sendText(chatId, `❌ Gagal set budget bro. Coba lagi.`);
            }
          } else {
            // No amount — prompt user via force reply
            const budgetTag = `[SET_BUDGET:${category}]`;
            await sendForceReply(chatId,
              `${budgetTag}\n\n` +
              `💰 <b>Set Budget: ${escapeHtml(category.charAt(0).toUpperCase() + category.slice(1))}</b>\n\n` +
              `👇 <b>Balas pesan ini</b> dengan nominal budget bulanan.\n\n` +
              `Contoh:\n` +
              `• <code>500rb</code>\n` +
              `• <code>1.5jt</code>\n\n` +
              `<i>Ketik /cancel untuk batal.</i>`,
              `Budget ${category} (contoh: 500rb)`
            );
          }
          return;
        }

        case 'add_recurring': {
          const d = regexResult.data;
          const result = await sbPost('recurring_expenses', {
            user_id: userId,
            title: d.title,
            amount: d.amount,
            category: d.category || 'tagihan',
            payment_day: d.payment_day,
            description: d.description || '',
            is_active: true,
          });
          if (!result.ok) {
            await sendText(chatId, `❌ Gagal simpan pengeluaran rutin bro. Error: ${result.error}`);
            return;
          }
          break;
        }

        case 'add_debt': {
          const d = regexResult.data;
          const result = await sbPost('debts', {
            user_id: userId,
            type: d.type,
            person_name: d.person_name,
            amount: d.amount,
            description: d.description || '',
            due_date: d.due_date || null,
          });
          if (!result.ok) {
            await sendText(chatId, `❌ Gagal simpan piutang/utang bro. Error: ${result.error}`);
            return;
          }
          break;
        }
      }

      // Send success message
      if (regexResult.text) {
        await sendTextWithKeyboard(chatId, regexResult.text, mainMenuKeyboard());
      }
    } catch (e) {
      console.error('[REGEX ACTION ERROR]:', e);
      await sendText(chatId, `❌ Gagal proses bro. Coba lagi ya. ${e}`);
    }
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 2: KALAU REGEX GABISA, BARU PANGGIL AI (FALLBACK)
  // ═══════════════════════════════════════════════════════════════
  console.log(`[AI] Fallback for: "${text}"`);
  const aiResult = await callAI(text, userId);

  if (aiResult.text) {
    await sendTextWithKeyboard(chatId, escapeHtml(aiResult.text), mainMenuKeyboard());
    return;
  }

  if (aiResult.actions.length > 0) {
    const resultTexts = aiResult.actions
      .map((a) => {
        const fn = a.function as Record<string, unknown> | undefined;
        return fn?.name ? `Called ${fn.name}` : '';
      })
      .filter(Boolean)
      .join('\n\n');
    if (resultTexts) {
      await sendTextWithKeyboard(chatId, resultTexts, mainMenuKeyboard());
      return;
    }
  }

  // If AI has no API key configured
  if (aiResult.noKey) {
    await sendTextWithKeyboard(chatId,
      `🤖 AI helper belum aktif bro.\n\nGua cuma bisa paham format standar:\n• "bakso 18rb"\n• "gaji 5jt"\n• "inget meeting besok jam 10"\n\nKetik /help buat lihat menu lengkap.`,
      mainMenuKeyboard()
    );
    return;
  }

  // If AI rate limited
  if (aiResult.rateLimited) {
    await sendTextWithKeyboard(chatId,
      `⏳ AI lagi sibuk nih bro (rate limit). Coba lagi bentar ya, atau tulis langsung kayak:\n• "bakso 18rb"\n• "gaji 5jt"\n\nAtau ketik /help buat lihat menu.`,
      mainMenuKeyboard()
    );
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // FINAL: GABISA HANDLE
  // ═══════════════════════════════════════════════════════════════
  await sendTextWithKeyboard(chatId,
    `🤔 Hmm, gua ga ngerti maksud lu bro. Coba tulis langsung kayak:

• "bakso 18rb"
• "gaji 5jt"
• "rutin netflix 153rb 5"
• "inget meeting besok jam 10"

Atau ketik /help buat lihat menu.`,
    mainMenuKeyboard()
  );
}

// ─────────────── MAIN REQUEST HANDLER ───────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // Clear per-request cache at the start of each invocation
  reqCache.clear();

  if (req.method === 'GET') {
    return new Response(JSON.stringify({
      status: 'ok',
      bot: 'SantuyBot v7',
      message: '🤙 SantuyBot is running!',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json() as Record<string, unknown>;

    if (body.callback_query) {
      await handleCallback(body.callback_query as Record<string, unknown>);
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (body.message) {
      const msg = body.message as Record<string, unknown>;
      if (!msg.text) {
        const chatId = (msg.chat as Record<string, unknown>).id as number;
        await sendText(chatId, '🤷 Gua cuma bisa baca teks bro. Kirim pesan teks ya!').catch(() => {});
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      await processMessage(msg);
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ status: 'ignored' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('Handler error:', e);
    return new Response(JSON.stringify({ error: 'Internal server error', detail: String(e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
