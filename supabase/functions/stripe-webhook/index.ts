/**
 * stripe-webhook
 *
 * Stripe calls this URL when a payment event occurs.
 * Listens for: invoice.payment_succeeded
 * 1. Verifies the Stripe webhook signature (STRIPE_WEBHOOK_SECRET env var)
 * 2. Finds the CRM invoice by stripe_invoice_id
 * 3. Marks the invoice as paid
 * 4. Updates the linked job status to 'paid'
 * 5. Logs a payment activity
 *
 * Configure in Stripe Dashboard:
 *   Webhook URL: https://<project>.supabase.co/functions/v1/stripe-webhook
 *   Events: invoice.payment_succeeded
 *
 * Set in Supabase Edge Function secrets:
 *   STRIPE_WEBHOOK_SECRET = whsec_...
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto }       from "https://deno.land/std@0.168.0/crypto/mod.ts";

const SUPABASE_URL       = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET     = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ── Stripe webhook signature verification ─────────────────────
async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string
): Promise<boolean> {
  if (!secret) return true; // skip in dev if not set

  const parts     = Object.fromEntries(header.split(",").map(p => p.split("=")));
  const timestamp = parts["t"];
  const signature = parts["v1"];
  if (!timestamp || !signature) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const key  = new TextEncoder().encode(secret);
  const data = new TextEncoder().encode(signedPayload);

  const cryptoKey = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, data);

  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  return expected === signature;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200 });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await req.text();
  const sigHeader = req.headers.get("stripe-signature") || "";

  if (WEBHOOK_SECRET && !await verifyStripeSignature(rawBody, sigHeader, WEBHOOK_SECRET)) {
    console.error("Invalid Stripe signature");
    return new Response("Forbidden", { status: 403 });
  }

  let event: {
    type: string;
    data: {
      object: {
        id: string;
        amount_paid?: number;
        customer?: string;
        metadata?: {
          tenant_id?: string;
          crm_job_id?: string;
          crm_contact_id?: string;
        };
      };
    };
  };

  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (event.type !== "invoice.payment_succeeded") {
    return new Response("OK", { status: 200 }); // Ignore other events
  }

  const stripeInvoice = event.data.object;
  const stripeId      = stripeInvoice.id;
  const amountPaid    = (stripeInvoice.amount_paid || 0) / 100;

  // Find our CRM invoice
  const { data: crmInvoice, error } = await sb
    .from("crm_invoices")
    .select("id, job_id, contact_id, tenant_id")
    .eq("stripe_invoice_id", stripeId)
    .single();

  if (error || !crmInvoice) {
    console.warn("CRM invoice not found for Stripe invoice:", stripeId);
    return new Response("OK", { status: 200 });
  }

  const now = new Date().toISOString();

  // Mark invoice as paid
  await sb
    .from("crm_invoices")
    .update({ status: "paid", paid_at: now })
    .eq("id", crmInvoice.id);

  // Update job status to paid
  if (crmInvoice.job_id) {
    await sb
      .from("crm_jobs")
      .update({ status: "paid" })
      .eq("id", crmInvoice.job_id);
  }

  // Log payment activity
  await sb.from("crm_activities").insert({
    tenant_id:  crmInvoice.tenant_id,
    contact_id: crmInvoice.contact_id,
    job_id:     crmInvoice.job_id,
    type:       "payment",
    direction:  "inbound",
    summary:    `Payment received: $${amountPaid.toFixed(2)}`,
    body:       JSON.stringify({ stripe_invoice_id: stripeId, amount_paid: amountPaid })
  });

  // Promote contact to 'customer' status
  if (crmInvoice.contact_id) {
    await sb
      .from("crm_contacts")
      .update({ status: "customer" })
      .eq("id", crmInvoice.contact_id);
  }

  console.log(`Payment processed: $${amountPaid} for invoice ${crmInvoice.id}`);
  return new Response("OK", { status: 200 });
});
