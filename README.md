# SantuyBot - Telegram Finance & Agenda Bot

Bot keuangan & agenda pribadi yang nyantai aje. Jalan di **Supabase Edge Functions** (Deno runtime). Connected ke **Telegram** buat catet keuangan, atur agenda, budget tracking, hutang/piutang, dan AI chat assistant via **OpenRouter**. Ngaranna "Santuy" mah emang geus jelas -- santuy wae urusanna.

> Penting euy: Ganti kabeh `YOUR_PROJECT_REF` jeung project ID maneh ti Supabase Dashboard (Settings > General > Reference ID). Kudu diganti teh di 3 file: `config.toml`, `deploy.sh`, jeung `002_setup_pg_cron.sql`

---

## Fitur

| Fitur | Keterangan |
|-------|------------|
| Catet Pengeluaran | `/beli 50rb makan siang` - auto parse nominal (rb, jt, k, ribu, juta) |
| Catet Pemasukan | `/terima 2jt gaji kantor` - auto detect kategori leres |
| AI Chat | Ketik naon wae langsung chat jeung AI (OpenRouter), santuy pisan |
| Rekap Keuangan | Bisa rekap harian, mingguan, bulanan, taunan -- lengkep pisan |
| Budget Tracking | Set limit per kategori, ada progress bar warna-warni |
| Pengeluaran Rutin | Netflix, Spotify, kontrakan -- auto catet unggal bulan |
| Auto Gaji | Set tanggal gajian, auto catet jadi pemasukan bulanan |
| Hutang/Piutang | Track piutang & utang, bisa tandai geus lunas atawa can |
| Agenda & Reminder | Tambah agenda, reminder 15 menit sateupacana via pg_cron |
| Outgoing Message Queue | Kirim pesan terjadwal, bisa di-queue atuh |
| Akses Kontrol | Batasi user via `ALLOWED_USER_IDS` -- privasi aman |

---

## Arsitektur

```
Telegram API  ──POST──>  bot-webhook (Edge Function)
                              │
                              ├──> Supabase REST API (CRUD data)
                              ├──> OpenRouter AI API (chat)
                              └──> Supabase Database (simpen data)

pg_cron (unggal menit) ──POST──>  cron-handler (Edge Function)
                                       │
                                       ├──> Kirim reminder agenda
                                       ├──> Proses outgoing message queue
                                       └──> Auto-catet pengeluaran rutin

Telegram API  <──GET───  super-api (Health Check)
```

**Komponen utamana:**

1. **bot-webhook** - Handler utama, nrima kabeh update ti Telegram (pesen, callback button). Zero external imports, pure fetch-based teh.
2. **cron-handler** - Dipanggil ku pg_cron unggal menit. Make `@supabase/supabase-js@2`. Triple auth (CRON_SECRET, service role key, JWT validation) -- aman pisan.
3. **super-api** - Health check endpoint simpel (default Supabase template).

---

## Struktur Proyek

```
Assistengw/
├── README.md                          <- Dokumentasi ieu
├── .gitignore                         <- Git ignore rules
├── deploy.sh                          <- Script deploy otomatis
└── supabase/
    ├── config.toml                    <- Konfigurasi Supabase project
    ├── functions/
    │   ├── bot-webhook/
    │   │   └── index.ts               <- FILE UTAMA: Telegram bot handler
    │   ├── cron-handler/
    │   │   └── index.ts               <- Cron job processor
    │   └── super-api/
    │       └── index.ts               <- Health check endpoint
    └── migrations/
        ├── 000_setup_all.sql          <- Enable extensions (uuid-ossp, pg_cron, pg_net)
        ├── 001_full_schema.sql        <- Schema lengkep (8 tabel, RLS, indexes)
        ├── 002_setup_pg_cron.sql      <- Schedule cron job unggal menit
        ├── 003_budgets.sql            <- Placeholder budget
        ├── 004_recurring_expenses.sql <- Placeholder pengeluaran rutin
        └── 005_debts.sql              <- Placeholder hutang/piutang
```

---

## Prasyarat

| Tool | Versi | Keterangan |
|------|-------|------------|
| Supabase CLI | >= 2.x | Deploy functions & migrations |
| Node.js | >= 18 | Keur Supabase CLI |
| Akun Telegram Bot | - | Ti [@BotFather](https://t.me/botfather) |
| Akun Supabase | Free tier | https://supabase.com |
| API Key OpenRouter | - | https://openrouter.ai (opsional, keur AI chat) |

---

## Setup - Panduan Lengkap

### 1. Buat Proyek Supabase

1. Buka [supabase.com/dashboard](https://supabase.com/dashboard) terus login
2. Klik **"New Project"**
3. Isi:
   - **Name**: `santuyBot`
   - **Database Password**: ( simpen alus-alus, ulah hilang euy! )
   - **Region**: `Southeast Asia (Singapore)` -- pangdeukeutna ti Indonesia
4. Klik **"Create new project"** tuluy tunggu provisioning (~2 menit)
5. Catat **Project URL** jeung **Project API keys** (Settings > API)

### 2. Setup Database (Migrations)

Jalankeun migrasi sacara berurutan di **SQL Editor** Supabase Dashboard:

1. Buka **SQL Editor** di dashboard
2. Jalankeun `000_setup_all.sql`:
   ```sql
   CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
   CREATE EXTENSION IF NOT EXISTS pg_cron;
   CREATE EXTENSION IF NOT EXISTS pg_net;
   ```
3. Jalankeun `001_full_schema.sql` (isi lengkep aya di file)
   - Nyieun 8 tabel: users, transactions, agendas, outgoing_messages, monthly_salaries, budgets, recurring_expenses, debts
   - Ngaktifkeun Row Level Security (RLS) di kabeh tabel
   - Nyieun 12 indexes keur performa query

> **Atawa** via CLI:
> ```bash
> supabase db push --project-ref YOUR_PROJECT_REF
> ```

### 3. Deploy Edge Functions

#### Via Script (Lebih gampang):

```bash
# Login ke Supabase CLI heula
supabase login

# Jalankeun deploy script
chmod +x deploy.sh
./deploy.sh
```

#### Manual (satu per satu):

```bash
# Deploy tiap function
supabase functions deploy bot-webhook --project-ref YOUR_PROJECT_REF
supabase functions deploy cron-handler --project-ref YOUR_PROJECT_REF
supabase functions deploy super-api --project-ref YOUR_PROJECT_REF
```

> **Catatan**: `verify_jwt = false` geus di-set di `config.toml` keur kabeh functions kusabab Telegram webhook teu kirim JWT. Lamun dibikin true mah bakal error 401 wae, ati-ati euy.

### 4. Set Environment Variables (Secrets)

Buka **Settings > Edge Functions** di Supabase Dashboard, tuluy tambahkeun secrets ieu:

| Secret | Wajib? | Contoh | Keterangan |
|--------|--------|--------|------------|
| `TELEGRAM_BOT_TOKEN` | **Wajib** | `123456:ABC-DEF...` | Token ti @BotFather |
| `AI_API_KEY` | Opsional | `sk-or-v1-...` | OpenRouter API key |
| `AI_MODEL` | Opsional | `arcee-ai/trinity-large-preview:free` | Model AI (default: free tier) |
| `ALLOWED_USER_IDS` | Opsional | `123456,789012` | Batasi akses. Kosongkeun = kabeh user boleh |
| `CRON_SECRET` | Opsional | `my-secret-key` | Secret keur auth cron handler |
| `SUPABASE_URL` | Auto | `https://...supabase.co` | Auto-set ku Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto | `eyJ...` | Auto-set ku Supabase |

#### Cara Set Secrets:

1. **Via Dashboard**: Settings > Edge Functions > Add new secret
2. **Via CLI**:
   ```bash
   supabase secrets set TELEGRAM_BOT_TOKEN=123456:ABC-DEF
   supabase secrets set AI_API_KEY=sk-or-v1-xxx
   ```

### 5. Setup Telegram Webhook

Set webhook di Telegram supaya update dikirim ka bot-webhook:

```bash
# Ganti <TOKEN> jeung Telegram Bot Token maneh
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://YOUR_PROJECT_REF.supabase.co/functions/v1/bot-webhook"
```

Atawa buka browser langsung:
```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://YOUR_PROJECT_REF.supabase.co/functions/v1/bot-webhook&allowed_updates=["message","callback_query"]
```

Verifikasi geus nyambung:
```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

### 6. Setup pg_cron (Auto Reminder)

Jalankeun `002_setup_pg_cron.sql` di SQL Editor, tapi **ganti heula** `YOUR_SERVICE_ROLE_KEY_HERE` jeung service role key maneh:

1. Buka **Settings > API** di dashboard Supabase
2. Copy **service_role** key (nu anon public mah bilih, nu service_role teh!)
3. Di SQL Editor, jalankeun:

```sql
SELECT cron.schedule(
  'send-telegram-reminders',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/cron-handler',
    headers := jsonb_build_object(
      'Authorization', 'Bearer PASTE_SERVICE_ROLE_KEY_DISINI',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
```

Verifikasi cron job geus aktif:
```sql
SELECT * FROM cron.job;
```

---

## Penggunaan Bot

### Commands

| Command | Contoh | Fungsi |
|---------|--------|--------|
| `/start` | `/start` | Tampilkeun menu utama |
| `/help` | `/help` | Tampilkeun panduan |
| `/beli` | `/beli 50rb makan siang` | Catet pengeluaran |
| `/keluar` | `/keluar 200rb bensin` | Catet pengeluaran (alias) |
| `/terima` | `/terima 5jt gaji` | Catet pemasukan |
| `/masuk` | `/masuk 1jt freelance` | Catet pemasukan (alias) |
| `/agenda` | `/agenda Rapat jam 14 besok` | Tambah agenda |

### Format Nominal

Bot ngadukung rupa-rupa format nominal, gausah pusing:

| Format | Nilai |
|--------|-------|
| `50000` | Rp 50.000 |
| `50rb` | Rp 50.000 |
| `50k` | Rp 50.000 |
| `50ribu` | Rp 50.000 |
| `1.5jt` | Rp 1.500.000 |
| `1.5juta` | Rp 1.500.000 |
| `1.5m` | Rp 1.500.000 |

### Auto-detect Kategori

Bot otomatis deteksi kategori dumasar deskripsi, hayu atuh coba:

**Pengeluaran**: makan, transport, belanja, tagihan, hiburan, kesehatan, pendidikan, jajan, lainnya

**Pemasukan**: gaji, freelance, investasi, transfer, lainnya

### Format Tanggal & Waktu

Bot mah ngartos bahasa Indonesia keur tanggal jeung waktu, lengkep pisan:

| Input | Arti |
|-------|-------|
| `besok` | Besok |
| `3 hari lagi` | H+3 |
| `senin` | Senin payun |
| `jam 14` | Pukul 14:00 WIB |
| `jam 9 pagi` | Pukul 09:00 WIB |
| `sore` | Pukul 16:00 WIB |
| `malam` | Pukul 19:00 WIB |
| `tgl 25` | Tanggal 25 bulan ieu |
| `15/8` | 15 Agustus |

---

## Database Schema

### Entity Relationship Diagram

```
users (bigint PK)
  ├──< transactions (uuid PK, user_id FK)
  ├──< agendas (uuid PK, user_id FK)
  ├──< outgoing_messages (uuid PK, user_id)
  ├──< monthly_salaries (uuid PK, user_id FK)
  ├──< budgets (uuid PK, user_id FK, UNIQUE user_id+category)
  ├──< recurring_expenses (uuid PK, user_id FK)
  └──< debts (uuid PK, user_id FK)
```

### Tabel Users
| Kolom | Tipe | Keterangan |
|-------|------|------------|
| id | BIGINT PK | Telegram user ID |
| username | TEXT | Username Telegram |
| created_at | TIMESTAMPTZ | Waktu registrasi |

### Tabel Transactions
| Kolom | Tipe | Keterangan |
|-------|------|------------|
| id | UUID PK | gen_random_uuid() |
| user_id | BIGINT FK | Referensi users |
| type | TEXT | 'expense' atawa 'income' |
| amount | NUMERIC | Nominal |
| description | TEXT | Deskripsi |
| category | TEXT | Kategori (default: 'umum') |
| subcategory | TEXT | Sub-kategori |
| date | TEXT | Tanggal string |
| created_at | TIMESTAMPTZ | Waktu pencatatan |

### Tabel Agendas
| Kolom | Tipe | Keterangan |
|-------|------|------------|
| id | UUID PK | gen_random_uuid() |
| user_id | BIGINT FK | Referensi users |
| title | TEXT | Judul agenda |
| scheduled_time | TIMESTAMPTZ | Waktu jadwal |
| is_completed | BOOLEAN | Status geus rengse atawa can |
| is_reminded | BOOLEAN | Status geus di-remind atawa can |
| description | TEXT | Keterangan tambahan |
| created_at | TIMESTAMPTZ | Waktu dibikin |

### Tabel Budgets
| Kolom | Tipe | Keterangan |
|-------|------|------------|
| id | UUID PK | uuid_generate_v4() |
| user_id | BIGINT FK | Referensi users |
| category | TEXT | Kategori (UNIQUE per user) |
| monthly_limit | NUMERIC | Limit bulanan |
| created_at | TIMESTAMPTZ | Waktu dibikin |

### Tabel Debts
| Kolom | Tipe | Keterangan |
|-------|------|------------|
| id | UUID PK | uuid_generate_v4() |
| user_id | BIGINT FK | Referensi users |
| person_name | TEXT | Nama batur |
| amount | NUMERIC | Nominal |
| description | TEXT | Keterangan |
| type | TEXT | 'piutang' atawa 'utang' |
| due_date | TIMESTAMPTZ | Tanggal jatuh tempo |
| is_settled | BOOLEAN | Status geus lunas atawa can |
| created_at | TIMESTAMPTZ | Waktu dibikin |

---

## Troubleshooting

### Webhook teu naréspon

1. Cek webhook URL geus bener atawa can:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
   ```
2. Pastikeun secrets geus di-set (hususna `TELEGRAM_BOT_TOKEN`)
3. Cek Edge Function logs di Supabase Dashboard > Edge Functions > bot-webhook > Logs

### Cron reminder teu jalan

1. Pastikeun `pg_cron` extension aktif:
   ```sql
   SELECT * FROM pg_extensions WHERE extname = 'pg_cron';
   ```
2. Cek cron job aya atawa can:
   ```sql
   SELECT * FROM cron.job;
   ```
3. Pastikeun service role key di cron job masih valid
4. Cek cron-handler function logs

### AI chat teu naréspon

1. Pastikeun `AI_API_KEY` secret geus di-set
2. Cek model nu dipake aya di OpenRouter atawa can
3. Cek rate limit (bot punya global rate limiter)

### Error "auth.role() does not exist"

Pastikeun RLS policy make syntax nu bener. Policy kudu kieu:
```sql
USING (auth.role() = 'service_role')
```
Bukan `auth.jwt()`. `auth.role()` mah built-in function di Supabase RLS.

### Deploy gagal

1. Pastikeun geus login: `supabase login`
2. Pastikeun project ref bener: `YOUR_PROJECT_REF` (geus diganti di config.toml jeung deploy.sh)
3. Cek koneksi internet
4. Cek versi Supabase CLI: `supabase --version` (min. 2.x)
