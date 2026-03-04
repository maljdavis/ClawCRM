import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Unauthorized' }, 401)

  const url = Deno.env.get('SUPABASE_URL')!
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!
  const svc  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  // Verify caller is admin
  const caller = createClient(url, anon, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await caller.auth.getUser()
  if (!user) return json({ error: 'Unauthorized' }, 401)

  const { data: prof } = await caller.from('profiles').select('role').eq('id', user.id).single()
  if (prof?.role !== 'admin') return json({ error: 'Forbidden' }, 403)

  // Create auth user + profile
  const admin = createClient(url, svc)
  const { branchName, password } = await req.json()
  if (!branchName || !password) return json({ error: 'branchName and password required' }, 400)

  const email = toEmail(branchName)

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (createErr) return json({ error: createErr.message }, 400)

  const { error: profErr } = await admin
    .from('profiles')
    .insert({ id: created.user.id, role: 'branch', branch_name: branchName })

  if (profErr) {
    await admin.auth.admin.deleteUser(created.user.id)
    return json({ error: profErr.message }, 400)
  }

  return json({ success: true, email })
})

function toEmail(name: string) {
  return name.toLowerCase().replace(/\s+/g, '.').replace(/[^a-z0-9.]/g, '') + '@claw.internal'
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}
