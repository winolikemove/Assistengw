-- ============================================
-- SantuyBot Migration: 001_full_schema
-- Complete database schema for Telegram Finance & Agenda Bot
-- ============================================

-- ------------------------------------------
-- 1. users table
-- ------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY,
  username TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON users
  FOR ALL TO service_role
  USING (auth.role() = 'service_role');

-- ------------------------------------------
-- 2. transactions table
-- ------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT,
  amount NUMERIC NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  category TEXT DEFAULT 'umum',
  subcategory TEXT DEFAULT 'umum',
  date TEXT
);

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON transactions
  FOR ALL TO service_role
  USING (auth.role() = 'service_role');

-- ------------------------------------------
-- 3. agendas table
-- ------------------------------------------
CREATE TABLE IF NOT EXISTS agendas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  scheduled_time TIMESTAMPTZ NOT NULL,
  is_completed BOOLEAN DEFAULT false,
  is_reminded BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  description TEXT
);

ALTER TABLE agendas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON agendas
  FOR ALL TO service_role
  USING (auth.role() = 'service_role');

-- ------------------------------------------
-- 4. outgoing_messages table
-- ------------------------------------------
CREATE TABLE IF NOT EXISTS outgoing_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id BIGINT NOT NULL,
  message_text TEXT NOT NULL,
  parse_mode TEXT DEFAULT 'Markdown',
  is_sent BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE outgoing_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON outgoing_messages
  FOR ALL TO service_role
  USING (auth.role() = 'service_role');

-- ------------------------------------------
-- 5. monthly_salaries table
-- ------------------------------------------
CREATE TABLE IF NOT EXISTS monthly_salaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  description TEXT NOT NULL,
  category TEXT DEFAULT 'gaji',
  payment_day INTEGER NOT NULL,
  last_processed_month TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE monthly_salaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON monthly_salaries
  FOR ALL TO service_role
  USING (auth.role() = 'service_role');

-- ------------------------------------------
-- 6. budgets table
-- ------------------------------------------
CREATE TABLE IF NOT EXISTS budgets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  monthly_limit NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, category)
);

ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON budgets
  FOR ALL TO service_role
  USING (auth.role() = 'service_role');

-- ------------------------------------------
-- 7. recurring_expenses table
-- ------------------------------------------
CREATE TABLE IF NOT EXISTS recurring_expenses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  category TEXT DEFAULT 'tagihan',
  payment_day INTEGER NOT NULL,
  description TEXT DEFAULT '',
  is_active BOOLEAN DEFAULT true,
  last_processed_month TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE recurring_expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON recurring_expenses
  FOR ALL TO service_role
  USING (auth.role() = 'service_role');

-- ------------------------------------------
-- 8. debts table
-- ------------------------------------------
CREATE TABLE IF NOT EXISTS debts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_name TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  description TEXT DEFAULT '',
  type TEXT NOT NULL,
  due_date TIMESTAMPTZ,
  is_settled BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE debts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON debts
  FOR ALL TO service_role
  USING (auth.role() = 'service_role');

-- ============================================
-- Indexes
-- ============================================

-- agendas indexes
CREATE INDEX idx_agendas_user_id ON agendas(user_id);
CREATE INDEX idx_agendas_pending ON agendas(is_completed, is_reminded, scheduled_time);

-- budgets indexes
CREATE INDEX idx_budgets_user ON budgets(user_id);

-- transactions indexes
CREATE INDEX idx_transactions_user_id ON transactions(user_id);
CREATE INDEX idx_transactions_user_type ON transactions(user_id, type);
CREATE INDEX idx_transactions_category ON transactions(user_id, category);
CREATE INDEX idx_transactions_created ON transactions(created_at DESC);

-- debts indexes
CREATE INDEX idx_debts_user ON debts(user_id);
CREATE INDEX idx_debts_pending ON debts(user_id, is_settled);

-- monthly_salaries indexes
CREATE INDEX idx_monthly_salaries_user ON monthly_salaries(user_id);

-- recurring_expenses indexes
CREATE INDEX idx_recurring_expenses_user ON recurring_expenses(user_id);

-- outgoing_messages indexes
CREATE INDEX idx_outgoing_unsent ON outgoing_messages(is_sent, created_at);
