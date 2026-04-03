/**
 * stripe-create-invoice
 *
 * Called from jobs.html when staff clicks "Generate Invoice".
 * 1. Creates a Stripe Customer (or reuses existing one by email/phone)
 * 2. Creates a Stripe Invoice with line items
 * 3. Finalizes the invoice → Stripe generates a hosted payment page URL
 * 4. Saves the invoice record to crm_invoices
 * 5. Returns the hosted_invoice_url for sharing via SMS
 *
 * Requires: tenant's stripe_secret_key stored in crm_tenants
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function stripeRequest(
  secretKey: string,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const creds = btoa(`${secretKey}:`);
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body ? new URLSearchParams(flattenStripe(body)).toString() : undefined
  });

  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    throw new Error((data as { error?: { message?: string } }).error?.message || "Stripe error");
  }
  return data;
}

// Stripe API uses nested form encoding (e.g. metadata[key]=value)
function flattenStripe(
  obj: Record<string, unknown>,
  prefix = ""
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === null || v === undefined) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, flattenStripe(v as Record<string, unknown>, key));
    } else {
      out[key] = String(v);
    }
  }
  return out;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, content-type"
      }
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: {
    job_id?: string;
    contact_id?: string;
    tenant_id: string;
    amount: number;
    due_date?: string;
    line_items?: Array<{ desc: string; qty: number; price: number }>;
  };

  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { tenant_id, job_id, contact_id, amount, due_date, line_items = [] } = body;

  // Load tenant
  const { data: tenant, error: tErr } = await sb
    .from("crm_tenants")
    .select("id, name, stripe_secret_key")
    .eq("id", tenant_id)
    .single();

  if (tErr || !tenant?.stripe_secret_key) {
    return Response.json({ error: "Stripe not configured for this tenant." }, { status: 400 });
  }

  const stripeKey = tenant.stripe_secret_key;

  // Load contact for customer info
  let customerEmail: string | null = null;
  let customerName: string | null  = null;
  let stripeCustomerId: string | null = null;

  if (contact_id) {
    const { data: contact } = await sb
      .from("crm_contacts")
      .select("name, email, phone")
      .eq("id", contact_id)
      .single();

    customerEmail = contact?.email ?? null;
    customerName  = contact?.name  ?? null;

    if (customerEmail) {
      // Search for existing Stripe customer by email
      try {
        const existing = await stripeRequest(stripeKey, "GET",
          `/customers?email=${encodeURIComponent(customerEmail)}&limit=1`
        ) as { data: Array<{ id: string }> };
        stripeCustomerId = existing.data?.[0]?.id ?? null;
      } catch { /* ignore */ }
    }

    if (!stripeCustomerId) {
      // Create new Stripe customer
      const customerParams: Record<string, unknown> = {
        metadata: { tenant_id, crm_contact_id: contact_id }
      };
      if (customerEmail) customerParams.email = customerEmail;
      if (customerName)  customerParams.name  = customerName;

      const customer = await stripeRequest(stripeKey, "POST", "/customers", customerParams) as { id: string };
      stripeCustomerId = customer.id;
    }
  }

  // Create Stripe Invoice
  const dueTimestamp = due_date
    ? Math.floor(new Date(due_date).getTime() / 1000)
    : Math.floor(Date.now() / 1000) + 30 * 86400;

  const invoiceParams: Record<string, unknown> = {
    collection_method: "send_invoice",
    days_until_due:    30,
    metadata: {
      tenant_id,
      crm_job_id:     job_id     || "",
      crm_contact_id: contact_id || ""
    }
  };
  if (stripeCustomerId) invoiceParams.customer = stripeCustomerId;

  const stripeInvoice = await stripeRequest(
    stripeKey, "POST", "/invoices", invoiceParams
  ) as { id: string; hosted_invoice_url?: string };

  // Add invoice line items
  for (const item of line_items) {
    await stripeRequest(stripeKey, "POST", "/invoiceitems", {
      invoice:    stripeInvoice.id,
      customer:   stripeCustomerId,
      amount:     Math.round(item.qty * item.price * 100), // cents
      currency:   "usd",
      description: item.desc
    });
  }

  // If no line items passed, add a single line for the total amount
  if (!line_items.length && amount > 0) {
    await stripeRequest(stripeKey, "POST", "/invoiceitems", {
      invoice:  stripeInvoice.id,
      customer: stripeCustomerId,
      amount:   Math.round(amount * 100),
      currency: "usd",
      description: "Service"
    });
  }

  // Finalize invoice → generates hosted payment page
  const finalized = await stripeRequest(
    stripeKey, "POST", `/invoices/${stripeInvoice.id}/finalize`, {}
  ) as { id: string; hosted_invoice_url: string; amount_due: number };

  // Save to crm_invoices
  const { data: saved } = await sb
    .from("crm_invoices")
    .insert({
      tenant_id,
      job_id:              job_id || null,
      contact_id:          contact_id || null,
      amount:              finalized.amount_due / 100,
      status:              "sent",
      due_date:            due_date || null,
      stripe_invoice_id:   finalized.id,
      stripe_customer_id:  stripeCustomerId,
      hosted_invoice_url:  finalized.hosted_invoice_url,
      line_items:          line_items.length ? line_items : [{ desc: "Service", qty: 1, unit_price: amount }]
    })
    .select()
    .single();

  // Log activity
  if (contact_id || job_id) {
    await sb.from("crm_activities").insert({
      tenant_id,
      contact_id: contact_id || null,
      job_id:     job_id || null,
      type:       "payment",
      direction:  "outbound",
      summary:    `Invoice created: $${(finalized.amount_due / 100).toFixed(2)}`,
      body:       finalized.hosted_invoice_url
    });
  }

  return Response.json({
    invoice_id:         saved?.id,
    stripe_invoice_id:  finalized.id,
    hosted_invoice_url: finalized.hosted_invoice_url,
    amount:             finalized.amount_due / 100
  }, { headers: { "Access-Control-Allow-Origin": "*" } });
});
