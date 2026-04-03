/**
 * voice-ai-agent
 *
 * WebSocket handler for Twilio ConversationRelay.
 * Twilio streams caller speech → this function → Claude API → Twilio TTS.
 *
 * Flow per turn:
 *   Twilio sends: { type: "UserMessage", text: "caller speech" }
 *   We call Claude (streaming) with tenant's custom system prompt
 *   We send tokens: { type: "text", token: "...", last: false }
 *   Final token:    { type: "text", token: "", last: true }
 *   Transcript saved to crm_activities on call end
 *
 * WebSocket URL set in twilio-voice-webhook TwiML:
 *   wss://<project>.supabase.co/functions/v1/voice-ai-agent?tenant_id=xxx&call_sid=yyy
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic        from "https://esm.sh/@anthropic-ai/sdk@0.27.2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY    = Deno.env.get("ANTHROPIC_API_KEY")!;

const sb        = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// Max tokens per AI response (keep short for voice — under 50 words ~150 tokens)
const MAX_TOKENS = 150;

// Default system prompt if tenant has none configured
const DEFAULT_SYSTEM_PROMPT = `You are a friendly AI receptionist for this business.
Answer questions politely and briefly (under 30 words per response).
If asked about pricing or appointments, let the caller know a team member will follow up.
At the end of each call, thank the caller and let them know someone will be in touch soon.`;

serve(async (req: Request) => {
  // ConversationRelay connects via WebSocket upgrade
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  const url        = new URL(req.url);
  const tenantId   = url.searchParams.get("tenant_id") || "";
  const callSid    = url.searchParams.get("call_sid") || "";

  // Load tenant config
  const { data: tenant } = await sb
    .from("crm_tenants")
    .select("id, name, ai_system_prompt")
    .eq("id", tenantId)
    .single();

  const systemPrompt = tenant?.ai_system_prompt || DEFAULT_SYSTEM_PROMPT;

  // Upgrade to WebSocket
  const { socket, response } = Deno.upgradeWebSocket(req);

  // Per-call state
  const conversationHistory: Array<{ role: "user"|"assistant"; content: string }> = [];
  const transcriptParts: string[] = [];

  socket.onopen = () => {
    console.log("ConversationRelay connected:", callSid);
  };

  socket.onmessage = async (event) => {
    let msg: { type: string; text?: string; callSid?: string } = {};
    try {
      msg = JSON.parse(event.data as string);
    } catch {
      return;
    }

    // Twilio sends UserMessage when caller speaks
    if (msg.type === "UserMessage" && msg.text) {
      const userText = msg.text.trim();
      if (!userText) return;

      conversationHistory.push({ role: "user", content: userText });
      transcriptParts.push(`Caller: ${userText}`);

      // Stream Claude response
      try {
        const stream = anthropic.messages.stream({
          model:      "claude-sonnet-4-6",
          max_tokens: MAX_TOKENS,
          system:     systemPrompt,
          messages:   conversationHistory
        });

        let fullResponse = "";

        stream.on("text", (token: string) => {
          fullResponse += token;
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "text", token, last: false }));
          }
        });

        await stream.finalMessage();

        // Send final token to trigger Twilio TTS playback
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "text", token: "", last: true }));
        }

        conversationHistory.push({ role: "assistant", content: fullResponse });
        transcriptParts.push(`AI: ${fullResponse}`);

      } catch (err) {
        console.error("Claude error:", err);
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: "text",
            token: "I apologize, I'm having trouble right now. Someone will call you back shortly.",
            last: true
          }));
        }
      }
    }

    // Twilio sends "disconnect" when call ends
    if (msg.type === "disconnect" || msg.type === "CallEnded") {
      await saveTranscript(tenantId, callSid, transcriptParts);
    }
  };

  socket.onclose = async () => {
    console.log("ConversationRelay disconnected:", callSid);
    if (transcriptParts.length) {
      await saveTranscript(tenantId, callSid, transcriptParts);
    }
  };

  socket.onerror = (err) => {
    console.error("WebSocket error:", err);
  };

  return response;
});

async function saveTranscript(
  tenantId: string,
  callSid: string,
  parts: string[]
): Promise<void> {
  if (!tenantId || !parts.length) return;

  const transcript = parts.join("\n");

  // Find contact by looking up the activity created in twilio-voice-webhook
  const { data: activity } = await sb
    .from("crm_activities")
    .select("contact_id")
    .eq("tenant_id", tenantId)
    .like("body", `%${callSid}%`)
    .single();

  const contactId = activity?.contact_id ?? null;

  await sb.from("crm_activities").insert({
    tenant_id:  tenantId,
    contact_id: contactId,
    type:       "call",
    direction:  "inbound",
    summary:    `AI call — ${parts.length} exchanges`,
    body:       transcript,
    duration_sec: parts.length * 15 // rough estimate
  });

  // Promote contact to prospect if they were a lead
  if (contactId) {
    await sb
      .from("crm_contacts")
      .update({ status: "prospect", source: "ai_call" })
      .eq("id", contactId)
      .eq("status", "lead");
  }
}
