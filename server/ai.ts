import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";
import type { BehaviorRules, EmailMessage, Lead, ReplyCategory } from "../src/lib/types";

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL_CANDIDATES = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.8-27b",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
];
let cachedWorkingGroqModel: string | null = null;

export function getAiStatus(): { configured: boolean; provider: "groq" | "gemini" | "none" } {
  const groqKey = process.env.GROQ_API_KEY?.trim();
  if (groqKey) return { configured: true, provider: "groq" };
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  if (geminiKey && geminiKey !== "MY_GEMINI_API_KEY") {
    return { configured: true, provider: "gemini" };
  }
  return { configured: false, provider: "none" };
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    throw new Error("Neither GROQ_API_KEY nor GEMINI_API_KEY is configured.");
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

async function callGroqChat(input: {
  system: string;
  user: string;
  jsonMode?: boolean;
  temperature?: number;
}): Promise<string> {
  const groqKey = process.env.GROQ_API_KEY?.trim();
  if (!groqKey) throw new Error("GROQ_API_KEY is not configured.");

  const envModel = process.env.GROQ_MODEL?.trim();
  const modelsToTry = Array.from(
    new Set([
      ...(envModel ? [envModel] : []),
      ...(cachedWorkingGroqModel ? [cachedWorkingGroqModel] : []),
      ...GROQ_MODEL_CANDIDATES,
    ]),
  );

  let lastError = "Groq API request failed.";
  for (const model of modelsToTry) {
    for (const useJsonFormat of input.jsonMode ? [true, false] : [false]) {
      const res = await fetch(GROQ_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${groqKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: input.temperature ?? 0.4,
          ...(useJsonFormat ? { response_format: { type: "json_object" } } : {}),
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        choices?: { message?: { content?: string } }[];
        error?: { message?: string };
      };

      if (res.ok) {
        cachedWorkingGroqModel = model;
        return (data.choices?.[0]?.message?.content ?? "").trim();
      }

      const msg = data.error?.message || `Groq API error (${res.status}).`;
      lastError = msg;

      // If model doesn't exist or isn't accessible, move to next candidate model
      if (/does not exist|do not have access|model_not_found/i.test(msg)) {
        break;
      }
      // If json response_format isn't supported for this model, retry inner loop without response_format
      if (useJsonFormat && /response_format|json_object/i.test(msg)) {
        continue;
      }
      throw new Error(msg);
    }
  }

  throw new Error(lastError);
}

function extractJsonObject<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1)) as T;
      } catch {
        return fallback;
      }
    }
    return fallback;
  }
}

export async function generateAiIcebreakers(
  leads: Pick<Lead, "id" | "first_name" | "last_name" | "company" | "designation" | "industry" | "custom_fields">[],
  aiContext: string,
): Promise<{ id: string; line: string }[]> {
  const leadDescriptions = leads.map((l) => ({
    id: l.id,
    name: `${l.first_name} ${l.last_name}`.trim(),
    role: l.designation,
    company: l.company,
    industry: l.industry,
    extra: l.custom_fields,
  }));

  const status = getAiStatus();
  if (status.provider === "groq") {
    const raw = await callGroqChat({
      jsonMode: true,
      system:
        "You write concise, human-sounding 1-sentence cold email opening lines. Return strictly JSON: {\"items\":[{\"id\":\"...\",\"line\":\"...\"}]}.",
      user: `Generate one natural, specific cold email opening line ({{ai_line}}) for each contact below.
Return strictly one concise sentence per contact (12–24 words), no generic flattery ("I hope this finds you well"), no emojis, no exclamation marks.

Sender context: ${aiContext || "DECILE Media, a B2B editorial and growth studio."}

Contacts:
${JSON.stringify(leadDescriptions, null, 2)}`,
    });
    const parsed = extractJsonObject<{ items?: { id: string; line: string }[] }>(raw, { items: [] });
    return Array.isArray(parsed.items) ? parsed.items : [];
  }

  const ai = getGeminiClient();
  const response = await ai.models.generateContent({
    model: "gemini-4-hydrogen",
    contents: `Generate one natural, specific, human-sounding cold email opening line ({{ai_line}}) for each contact below.
Return strictly one concise sentence per contact (12–24 words), no generic flattery ("I hope this finds you well"), no emojis, no exclamation marks.

Sender context: ${aiContext || "DECILE Media, a B2B editorial and growth studio."}

Contacts:
${JSON.stringify(leadDescriptions, null, 2)}`,
    config: {
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING, description: "The lead id passed in." },
            line: { type: Type.STRING, description: "One-sentence personalized cold email opening line." },
          },
          required: ["id", "line"],
        },
      },
    },
  });

  const text = (response.text ?? "[]").trim();
  const parsed = JSON.parse(text) as { id: string; line: string }[];
  return Array.isArray(parsed) ? parsed : [];
}

export async function draftEmailCopy(input: {
  brief: string;
  kind: "email" | "follow_up" | "reply";
  tone: string;
  context: string;
}): Promise<{ subject: string; body: string; subjectIdeas: string[] }> {
  const kindGuide =
    input.kind === "email"
      ? "Write an initial cold email (60-120 words) plus a crisp subject line and 4 alternative subject lines."
      : input.kind === "follow_up"
        ? "Write a brief, polite follow-up step (40-85 words) referencing the previous email without repeating everything."
        : "Write a warm, clear inbox reply (45-100 words) moving the conversation toward a next step.";

  const promptBody = `${kindGuide}

Available merge variables: {{first_name|there}}, {{company}}, {{designation}}, {{industry}}, {{ai_line}}.
Strict deliverability rules:
- No exclamation marks in subject lines
- No sales spam triggers ("free", "discount", "act now", "100%", "guarantee")
- No links unless explicitly asked in the brief
- No sign-off name (the mailbox signature is appended automatically)

Tone: ${input.tone || "warm, direct, peer-to-peer"}
About the sender: ${input.context || "DECILE Media, a B2B editorial and demand studio."}

Brief:
${input.brief}`;

  const status = getAiStatus();
  if (status.provider === "groq") {
    const raw = await callGroqChat({
      jsonMode: true,
      system:
        'Return strictly valid JSON with keys: "subject" (string, empty for follow_up/reply), "body" (string), and "subjectIdeas" (array of 4 strings).',
      user: promptBody,
    });
    const parsed = extractJsonObject<{
      subject?: string;
      body?: string;
      subjectIdeas?: string[];
    }>(raw, {});
    return {
      subject: String(parsed.subject ?? "").trim().slice(0, 200),
      body: String(parsed.body ?? "").trim().slice(0, 6000),
      subjectIdeas: Array.isArray(parsed.subjectIdeas) ? parsed.subjectIdeas.slice(0, 5) : [],
    };
  }

  const ai = getGeminiClient();
  const response = await ai.models.generateContent({
    model: "gemini-4-hydrogen",
    contents: promptBody,
    config: {
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          subject: { type: Type.STRING, description: "Primary subject line (empty string if follow_up or reply)." },
          body: { type: Type.STRING, description: "Email body copy with optional merge variables." },
          subjectIdeas: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "4 concise alternative subject lines for testing.",
          },
        },
        required: ["subject", "body", "subjectIdeas"],
      },
    },
  });

  const parsed = JSON.parse((response.text ?? "{}").trim()) as {
    subject?: string;
    body?: string;
    subjectIdeas?: string[];
  };

  return {
    subject: String(parsed.subject ?? "").trim().slice(0, 200),
    body: String(parsed.body ?? "").trim().slice(0, 6000),
    subjectIdeas: Array.isArray(parsed.subjectIdeas) ? parsed.subjectIdeas.slice(0, 5) : [],
  };
}

export async function draftThreadReply(input: {
  lead: Pick<Lead, "first_name" | "last_name" | "company" | "designation" | "industry">;
  messages: Pick<EmailMessage, "direction" | "body" | "created_at">[];
  instruction: string;
  context: string;
}): Promise<string> {
  const transcript = input.messages
    .map((m) => `[${m.direction.toUpperCase()} - ${m.created_at.slice(0, 10)}]\n${m.body}`)
    .join("\n\n---\n\n");

  const userPrompt = `Draft a crisp, human reply to ${input.lead.first_name} ${input.lead.last_name} (${input.lead.designation} at ${input.lead.company}).
Do NOT include a subject line or sign-off signature (signature is added automatically). Keep it concise (40-90 words).

Sender context: ${input.context}
Goal / instruction: ${input.instruction || "Acknowledge their reply warmly and propose a clear next step."}

Conversation history:
${transcript}`;

  const status = getAiStatus();
  if (status.provider === "groq") {
    return callGroqChat({
      system:
        "You are an expert B2B outbound reply assistant. Write warm, direct, natural replies matching the prospect's tone and response behavior. Never include a signature block.",
      user: userPrompt,
    });
  }

  const ai = getGeminiClient();
  const response = await ai.models.generateContent({
    model: "gemini-4-hydrogen",
    contents: userPrompt,
    config: {
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    },
  });

  return (response.text ?? "").trim();
}

export interface ResponseFollowUpSuggestion {
  category: Exclude<ReplyCategory, null>;
  intentSummary: string;
  recommendedAction:
    | "send_reply"
    | "schedule_later_nurture"
    | "continue_sequence"
    | "stop_and_close"
    | "suppress";
  actionLabel: string;
  reasoning: string;
  delayDays: number;
  suggestedReply: string;
  suggestedFollowUpBody: string;
}

export async function analyzeResponseAndSuggestFollowUp(input: {
  lead: Pick<Lead, "first_name" | "last_name" | "company" | "designation" | "industry" | "email">;
  messages: Pick<EmailMessage, "direction" | "subject" | "body" | "created_at">[];
  behavior?: BehaviorRules | null;
  context: string;
  instruction?: string;
}): Promise<ResponseFollowUpSuggestion> {
  const transcript = input.messages
    .map((m) => `[${m.direction.toUpperCase()} - ${m.created_at.slice(0, 10)}] Subject: ${m.subject}\n${m.body}`)
    .join("\n\n---\n\n");

  const behaviorDesc = input.behavior
    ? JSON.stringify({
        out_of_office: input.behavior.out_of_office,
        later_check_in: input.behavior.later_check_in,
        later_delay_days: input.behavior.later_delay_days,
        stop_on_reply: input.behavior.stop_on_reply,
      })
    : "No linked campaign (1-to-1 or brand new inbound message)";

  const userPrompt = `Analyze this prospect conversation and recommend both the exact follow-up behavior action AND tailored email copy.
Contact: ${input.lead.first_name} ${input.lead.last_name} <${input.lead.email}> (${input.lead.designation || "Role unknown"} at ${input.lead.company || "Company unknown"})
Campaign Behavior Settings: ${behaviorDesc}
Sender Context: ${input.context || "DECILE Outreach B2B team."}
Extra Instruction: ${input.instruction || "Respond appropriately based on how the prospect replied and follow-up behavior."}

Transcript:
${transcript}

Return STRICTLY JSON with keys:
- "category": one of "interested" | "question" | "follow_up_later" | "not_interested" | "out_of_office" | "unsubscribe" | "bounce"
- "intentSummary": short 1-sentence summary of how they responded
- "recommendedAction": one of "send_reply" | "schedule_later_nurture" | "continue_sequence" | "stop_and_close" | "suppress"
- "actionLabel": short UI label (e.g. "Reply now & propose a call", "Schedule check-in in 21 days", "Keep sequence active (OOO)", "Close & suppress")
- "reasoning": 1-2 sentences explaining why this behavior + message fits their response
- "delayDays": integer (number of days to wait if scheduling later check-in, otherwise 0)
- "suggestedReply": concise, warm human reply (40-90 words, NO signature, NO subject)
- "suggestedFollowUpBody": concise future check-in message (35-70 words, NO signature) tailored to their reply if they asked to circle back later or didn't reply yet.`;

  const status = getAiStatus();
  let raw = "";
  if (status.provider === "groq") {
    raw = await callGroqChat({
      jsonMode: true,
      system:
        "You are an expert B2B sales behavior & inbox AI. Classify prospect replies accurately, pick the right follow-up behavior rule, and draft crisp human copy without signatures.",
      user: userPrompt,
    });
  } else {
    const ai = getGeminiClient();
    const res = await ai.models.generateContent({
      model: "gemini-4-hydrogen",
      contents: userPrompt,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: "application/json",
      },
    });
    raw = (res.text ?? "{}").trim();
  }

  const parsed = extractJsonObject<Partial<ResponseFollowUpSuggestion>>(raw, {});
  const validCats: Exclude<ReplyCategory, null>[] = [
    "interested",
    "question",
    "follow_up_later",
    "not_interested",
    "out_of_office",
    "unsubscribe",
    "bounce",
  ];
  const category = validCats.includes(parsed.category as Exclude<ReplyCategory, null>)
    ? (parsed.category as Exclude<ReplyCategory, null>)
    : "question";

  const validActions = [
    "send_reply",
    "schedule_later_nurture",
    "continue_sequence",
    "stop_and_close",
    "suppress",
  ] as const;
  const recommendedAction = validActions.includes(parsed.recommendedAction as (typeof validActions)[number])
    ? (parsed.recommendedAction as (typeof validActions)[number])
    : category === "follow_up_later"
      ? "schedule_later_nurture"
      : category === "unsubscribe" || category === "bounce"
        ? "suppress"
        : category === "not_interested"
          ? "stop_and_close"
          : category === "out_of_office"
            ? "continue_sequence"
            : "send_reply";

  return {
    category,
    intentSummary: String(parsed.intentSummary || "Prospect replied to your outreach.").trim(),
    recommendedAction,
    actionLabel: String(parsed.actionLabel || "Send suggested reply").trim(),
    reasoning: String(parsed.reasoning || "Tailored based on the prospect's latest message.").trim(),
    delayDays: Math.max(0, Math.min(365, Math.round(Number(parsed.delayDays) || 0))),
    suggestedReply: String(parsed.suggestedReply || "").trim(),
    suggestedFollowUpBody: String(parsed.suggestedFollowUpBody || "").trim(),
  };
}

export async function classifyInboundReplyWithAi(
  subject: string,
  body: string,
  fromEmail: string,
): Promise<Exclude<ReplyCategory, null> | null> {
  const status = getAiStatus();
  if (!status.configured) return null;
  try {
    const prompt = `Classify this inbound email reply strictly into ONE category:
"interested" | "question" | "follow_up_later" | "not_interested" | "out_of_office" | "unsubscribe" | "bounce"

Rules:
- "follow_up_later": asks to check back next month/quarter, busy right now, later, etc.
- "out_of_office": automatic vacation / away responder.
- "unsubscribe": asks to remove/stop emailing/opt out.
- "bounce": delivery failure / mailbox not found.
- "not_interested": polite rejection / no thanks / not a fit.
- "question": asks a question about pricing, details, timing, or team.
- "interested": positive interest, wants a call/demo/info.

From: ${fromEmail}
Subject: ${subject}
Body:
${body.slice(0, 1200)}

Return strictly JSON: {"category":"..."}`;

    let raw = "";
    if (status.provider === "groq") {
      raw = await callGroqChat({
        jsonMode: true,
        temperature: 0.1,
        system: 'Classify the email reply and return strictly {"category":"..."}.',
        user: prompt,
      });
    } else {
      const ai = getGeminiClient();
      const res = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: prompt,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: "application/json",
        },
      });
      raw = (res.text ?? "{}").trim();
    }
    const parsed = extractJsonObject<{ category?: string }>(raw, {});
    const valid: Exclude<ReplyCategory, null>[] = [
      "interested",
      "question",
      "follow_up_later",
      "not_interested",
      "out_of_office",
      "unsubscribe",
      "bounce",
    ];
    return valid.includes(parsed.category as Exclude<ReplyCategory, null>)
      ? (parsed.category as Exclude<ReplyCategory, null>)
      : null;
  } catch {
    return null;
  }
}

export async function generateBehaviorFollowUps(input: {
  campaignSubject: string;
  campaignBody: string;
  behavior: BehaviorRules;
  context: string;
}): Promise<{
  followUps: { delay_days: number; body: string }[];
  laterBody: string;
}> {
  const userPrompt = `Based on this initial campaign email and behavior settings, generate 3 high-converting follow-up steps AND a tailored Step 99 "Not now / Later" check-in email.

Initial Subject: ${input.campaignSubject}
Initial Body:
${input.campaignBody}

Behavior rules:
- OOO rule: ${input.behavior.out_of_office}
- Later check-in delay: ${input.behavior.later_delay_days} days
Sender context: ${input.context || "DECILE Outreach B2B team."}

Keep {{first_name|there}} and {{company}} placeholders where natural. Do NOT include any signature lines.
Return STRICTLY JSON:
{
  "followUps": [
    {"delay_days": 3, "body": "..."},
    {"delay_days": 5, "body": "..."},
    {"delay_days": 7, "body": "..."}
  ],
  "laterBody": "..."
}`;

  const status = getAiStatus();
  let raw = "";
  if (status.provider === "groq") {
    raw = await callGroqChat({
      jsonMode: true,
      system:
        "You write concise B2B cold email follow-ups and behavior-based check-ins. Return strictly JSON.",
      user: userPrompt,
    });
  } else {
    const ai = getGeminiClient();
    const res = await ai.models.generateContent({
      model: "gemini-4-hydrogen",
      contents: userPrompt,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: "application/json",
      },
    });
    raw = (res.text ?? "{}").trim();
  }

  const parsed = extractJsonObject<{
    followUps?: { delay_days?: number; body?: string }[];
    laterBody?: string;
  }>(raw, {});

  return {
    followUps: (Array.isArray(parsed.followUps) ? parsed.followUps : [])
      .filter((f) => typeof f.body === "string" && f.body.trim())
      .slice(0, 5)
      .map((f, idx) => ({
        delay_days: Math.max(1, Math.min(90, Math.round(Number(f.delay_days) || (idx + 1) * 3))),
        body: String(f.body).trim(),
      })),
    laterBody: String(parsed.laterBody || input.behavior.later_body).trim(),
  };
}
