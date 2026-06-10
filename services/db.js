const { createClient } = require('@supabase/supabase-js');

// This is a trusted server-only backend — the key never reaches the browser.
// Prefer the service_role key so writes are not blocked by Row Level Security
// (RLS is enabled without policies on scan_assignments, presence,
// assignment_audit, and snapshots). Fall back to the anon key if unset.
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!process.env.SUPABASE_URL || !supabaseKey) {
  console.warn('Warning: SUPABASE_URL or Supabase key not set. Database calls will fail.');
} else if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    'Warning: SUPABASE_SERVICE_ROLE_KEY not set — using anon key. ' +
    'Writes to RLS-protected tables (scan_assignments, presence, assignment_audit, snapshots) will fail.'
  );
}

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  supabaseKey || 'placeholder'
);

module.exports = supabase;
