/**
 * missed-call-handler
 *
 * Twilio fires this as a statusCallback when a call ends without being answered.
 * 1. Checks CallStatus (no-answer, busy, failed)
 * 2. Looks up tenant by Called number
 * 3. Looks up or creates a contact for the caller
 * 4. Sends auto-reply SMS using tenant's custom template
 * 5. Logs missed call + SMS to crm_activities
 *
 * Configure in Twilio console:
 *   Status Callback URL: https://<project>.supabase.co/functions/v1/missed-call-handler
 *   Status Callback Events: completed
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const MISSED_STATUSES = ["no-answer", "busy", "failed"];

async function sendTwilioSMS(
  accountSid: string,
  authToken: string,
  from: string,
  to: string,
  body: string
): Promise<void> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const creds = btoa(`${accountSid}:${authToken}`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ From: from, To: to, Body: body }).toString()
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Twilio SMS failed: ${err}`);
  }
}

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("OK", { status: 200 }); // Twilio health checks
  }

  const contentType = req.headers.get("content-type") || "";
  let params: Record<string, string> = {};

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    params = Object.fromEntries(new URLSearchParams(text));
  }

  const callStatus = params["CallStatus"] || "";
  if (!MISSED_STATUSES.includes(callStatus)) {
    // Call was answered or completed normally — nothing to do
    return new Response("OK", { status: 200 });
  }

  const calledNumber = params["Called"] || params["To"] || "";
  const callerNumber = params["Caller"] || params["From"] || "";
  const callSid      = params["CallSid"] || "";

  if (!calledNumber || !callerNumber) {
    return new Response("Missing params", { status: 400 });
  }

  // Look up tenant
  const { data: tenant, error: tenantErr } = await sb
    .from("crm_tenants")
    .select("id, name, twilio_account_sid, twilio_auth_token, twilio_phone_number, missed_call_sms_template")
    .eq("twilio_phone_number", calledNumber)
    .single();

  if (tenantErr || !tenant) {
    console.error("Tenant not found for:", calledNumber);
    return new Response("Tenant not found", { status: 404 });
  }

  if (!tenant.twilio_account_sid || !tenant.twilio_auth_token) {
    console.warn("Tenant has no Twilio credentials:", tenant.id);
    return new Response("No Twilio credentials", { status: 200 });
  }

  // Look up or create contact
  let contactId: string | null = null;

  const { data: existing } = await sb
    .from("crm_contacts")
    .select("id, name")
    .eq("tenant_id", tenant.id)
    .eq("phone", callerNumber)
    .single();

  if (existing) {
    contactId = existing.id;
  } else {
    const { data: newContact } = await sb
      .from("crm_contacts")
      .insert({
        tenant_id: tenant.id,
        phone:     callerNumber,
        status:    "lead",
        source:    "missed_call"
      })
      .select("id")
      .single();
    contactId = newContact?.id ?? null;
  }

  // Send auto-SMS reply
  const template = tenant.missed_call_sms_template ||
    "Hi! Sorry we missed your call. We'll get back to you shortly. — {business_name}";
  const smsBody  = template.replace("{business_name}", tenant.name);

  let smsSent = false;
  try {
    await sendTwilioSMS(
      tenant.twilio_account_sid,
      tenant.twilio_auth_token,
      tenant.twilio_phone_number,
      callerNumber,
      smsBody
    );
    smsSent = true;
  } catch (err) {
    console.error("SMS send failed:", err);
  }

  // Log missed call activity
  await sb.from("crm_activities").insert({
    tenant_id:  tenant.id,
    contact_id: contactId,
    type:       "call",
    direction:  "inbound",
    summary:    `Missed call from ${callerNumber} (${callStatus})`,
    body:       JSON.stringify({ call_sid: callSid, status: callStatus })
  });

  // Log auto-SMS if sent
  if (smsSent) {
    await sb.from("crm_activities").insert({
      tenant_id:  tenant.id,
      contact_id: contactId,
      type:       "sms",
      direction:  "outbound",
      summary:    `Auto-reply SMS sent to ${callerNumber}`,
      body:       smsBody
    });
  }

  return new Response("OK", { status: 200 });
});
