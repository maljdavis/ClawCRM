import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Unauthorized' }, 401)

  const url  = Deno.env.get('SUPABASE_URL')!
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!
  const svc  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const caller = createClient(url, anon, { global: { headers: { Authorization: authHeader } } })
  const admin  = createClient(url, svc)

  // Parse body and verify caller in parallel
  const [{ data: { user } }, body] = await Promise.all([
    caller.auth.getUser(),
    req.json(),
  ])
  if (!user) return json({ error: 'Unauthorized' }, 401)

  const { data: prof } = await caller.from('profiles').select('role').eq('id', user.id).single()
  if (prof?.role !== 'admin') return json({ error: 'Forbidden' }, 403)

  const { branchName } = body
  if (!branchName) return json({ error: 'branchName required' }, 400)

  // Look up the branch user ID directly from profiles — no listUsers needed
  const { data: target } = await admin
    .from('profiles')
    .select('id')
    .eq('branch_name', branchName)
    .eq('role', 'branch')
    .maybeSingle()

  if (target?.id) {
    const { error } = await admin.auth.admin.deleteUser(target.id)
    if (error) return json({ error: error.message }, 400)
  }

  return json({ success: true })
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}
