const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.warn('[db] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing. API routes that use the database will fail until configured.');
}

const supabase = createClient(url || 'http://127.0.0.1:54321', key || 'placeholder', {
  auth: { persistSession: false, autoRefreshToken: false }
});

module.exports = supabase;
