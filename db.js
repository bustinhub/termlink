const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
const serverKey = process.env.RELAY_SERVER_KEY;

if (!url || !key || !serverKey) {
  console.warn('[db] SUPABASE_URL, SUPABASE_ANON_KEY, or RELAY_SERVER_KEY missing. Database routes will fail until configured.');
}

const supabase = createClient(url || 'http://127.0.0.1:54321', key || 'placeholder', {
  auth: { persistSession: false, autoRefreshToken: false },
  global: {
    headers: serverKey ? { 'x-relay-server-key': serverKey } : {}
  }
});

module.exports = supabase;
