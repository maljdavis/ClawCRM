/**
 * twilio-voice-webhook
 *
 * Twilio calls this URL when an inbound call arrives on any tenant's number.
 * 1. Validates the Twilio request signature
 * 2. Looks up tenant by the called phone number
 * 3. If AI enabled: returns ConversationRelay TwiML → live AI agent handles call
 * 4. If AI disabled: returns voicemail TwiML
 * 5. Sets statusCallback so missed-call-handler fires on no-answer
 *
 * Configure in Twilio console:
 *   Voice URL (HTTP POST): https://<project>.supabase.co/functions/v1/twilio-voice-webhook
 */

import { serve }         from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient }  from "https://esm.sh/@supabase/supabase-js@2";
import { crypto }        from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { encodeBase64 }  from "https://deno.land/std@0.168.0/encoding/base64.ts";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MISSED_CALL_FN_URL = `${SUPABASE_URL}/functions/v1/missed-call-handler`;
const VOICE_AI_WS_URL   = SUPABASE_URL.replace("https://", "wss://") + "/functions/v1/voice-ai-agent";

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ── Twilio signature validation ───────────────────────────────
async function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>
): Promise<boolean> {
  // Build validation string: URL + sorted param key-values concatenated
  const sortedKeys = Object.keys(params).sort();
  const strToSign = url + sortedKeys.map(k => k + params[k]).join("");

  const key  = new TextEncoder().encode(authToken);
  const data = new TextEncoder().encode(strToSign);

  const cryptoKey = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, data);
  const expected = encodeBase64(new Uint8Array(sig));

  return expected === signature;
}

// ── Build TwiML response ──────────────────────────────────────
function twimlAI(tenant: Record<string, string>, callSid: string): string {
  const greeting = `Hi! Thanks for calling ${tenant.name}. Please hold for just a moment.`;
  const wsUrl    = `${VOICE_AI_WS_URL}?tenant_id=${tenant.id}&call_sid=${encodeURIComponent(callSid)}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${wsUrl}"
      welcomeGreeting="${greeting}"
      voice="en-US-Neural2-F"
      transcriptionProvider="google"
      interruptByDtmf="true"
    />
  </Connect>
</Response>`;
}

function twimlVoicemail(tenant: Record<string, string>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="en-US-Neural2-F">
    You've reached ${tenant.name}. We're unavailable right now.
    Please leave a message after the tone, or we'll text you shortly.
  </Say>
  <Record maxLength="120" transcribe="false" playBeep="true"
    statusCallback="${MISSED_CALL_FN_URL}"
    statusCallbackMethod="POST" />
  <Say>Thank you. Goodbye!</Say>
</Response>`;
}

// ── Main handler ──────────────────────────────────────────────
serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const contentType = req.headers.get("content-type") || "";
  let params: Record<string, string> = {};

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    params = Object.fromEntries(new URLSearchParams(text));
  }

  const calledNumber = params["Called"] || params["To"] || "";
  if (!calledNumber) {
    return new Response("Missing Called param", { status: 400 });
  }

  // Look up tenant by their Twilio phone number
  const { data: tenant, error } = await sb
    .from("crm_tenants")
    .select("id, name, ai_enabled, twilio_auth_token, missed_call_sms_template")
    .eq("twilio_phone_number", calledNumber)
    .single();

  if (error || !tenant) {
    console.error("Tenant not found for number:", calledNumber, error);
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say>This number is not configured.</Say></Response>`,
      { headers: { "Content-Type": "text/xml" } }
    );
  }

  // Validate Twilio signature (skip in dev if no auth token stored yet)
  if (tenant.twilio_auth_token) {
    const sig      = req.headers.get("x-twilio-signature") || "";
    const reqUrl   = req.url;
    const isValid  = await validateTwilioSignature(tenant.twilio_auth_token, sig, reqUrl, params);
    if (!isValid) {
      return new Response("Forbidden: invalid Twilio signature", { status: 403 });
    }
  }

  const callSid  = params["CallSid"] || "";
  const caller   = params["Caller"] || params["From"] || "";

  // Log inbound call activity (will update to missed/answered via statusCallback)
  if (caller) {
    // Upsert contact by phone number
    const { data: existingContact } = await sb
      .from("crm_contacts")
      .select("id")
      .eq("tenant_id", tenant.id)
      .eq("phone", caller)
      .single();

    const contactId = existingContact?.id ?? null;
    if (!existingContact && caller) {
      // Create new lead from call
      await sb.from("crm_contacts").insert({
        tenant_id: tenant.id,
        phone: caller,
        status: "lead",
        source: tenant.ai_enabled ? "ai_call" : "missed_call"
      });
    }

    await sb.from("crm_activities").insert({
      tenant_id:  tenant.id,
      contact_id: contactId,
      type:       "call",
      direction:  "inbound",
      summary:    `Inbound call from ${caller}`,
      body:       JSON.stringify({ call_sid: callSid, status: "ringing" })
    });
  }

  const twiml = tenant.ai_enabled
    ? twimlAI(tenant, callSid)
    : twimlVoicemail(tenant);

  return new Response(twiml, {
    headers: {
      "Content-Type": "text/xml",
      "Access-Control-Allow-Origin": "*"
    }
  });
});
