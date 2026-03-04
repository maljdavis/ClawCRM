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

  // Verify caller is admin
  const caller = createClient(url, anon, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await caller.auth.getUser()
  if (!user) return json({ error: 'Unauthorized' }, 401)

  const { data: prof } = await caller.from('profiles').select('role').eq('id', user.id).single()
  if (prof?.role !== 'admin') return json({ error: 'Forbidden' }, 403)

  const admin = createClient(url, svc)
  const { branchName, password } = await req.json()
  if (!branchName || !password) return json({ error: 'branchName and password required' }, 400)

  const email = toEmail(branchName)

  // Find the user by email
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const target = list?.users.find(u => u.email === email)
  if (!target) return json({ error: `No user found for branch "${branchName}"` }, 404)

  const { error } = await admin.auth.admin.updateUserById(target.id, { password })
  if (error) return json({ error: error.message }, 400)

  return json({ success: true })
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
