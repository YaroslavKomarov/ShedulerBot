# OpenRouter LLM Patterns

Patterns for using OpenRouter API in this project: NLU/parsing with a lightweight model, plan generation and dialogs with a strong model.

## Client Setup

```typescript
// src/llm/client.ts
import OpenAI from "openai"; // OpenRouter is OpenAI-compatible

export const openrouter = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY!,
  defaultHeaders: {
    "HTTP-Referer": "https://schedulerbot", // required by OpenRouter
    "X-Title": "SchedulerBot",
  },
});

// Model aliases
export const MODELS = {
  // Fast, cheap — for NLU: intent detection, entity extraction, task parsing
  fast: "google/gemini-flash-1.5",
  // Strong — for plan generation, onboarding interview, retrospective
  strong: "anthropic/claude-sonnet-4-5",
} as const;
```

## Pattern 1 — Structured Output (JSON)

Use for NLU tasks: intent detection, task parsing, period extraction.

```typescript
// src/llm/parse-intent.ts
import { openrouter, MODELS } from "./client";
import { z } from "zod";

const IntentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_task"), title: z.string(), period_slug: z.string().optional(), is_urgent: z.boolean() }),
  z.object({ type: z.literal("mark_done"), task_references: z.array(z.string()) }),
  z.object({ type: z.literal("show_plan"), date: z.enum(["today", "tomorrow"]) }),
  z.object({ type: z.literal("show_backlog"), period_slug: z.string().optional() }),
  z.object({ type: z.literal("modify_task"), task_reference: z.string(), changes: z.record(z.unknown()) }),
  z.object({ type: z.literal("unknown") }),
]);

export type Intent = z.infer<typeof IntentSchema>;

export async function detectIntent(
  userMessage: string,
  context: { activePeriod?: string; pendingTasks?: string[] }
): Promise<Intent> {
  const response = await openrouter.chat.completions.create({
    model: MODELS.fast,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are an intent classifier for a day scheduler bot.
Current context: ${JSON.stringify(context)}
Respond ONLY with valid JSON matching one of the intent types.
Types: add_task, mark_done, show_plan, show_backlog, modify_task, unknown`,
      },
      { role: "user", content: userMessage },
    ],
    temperature: 0,
  });

  const raw = JSON.parse(response.choices[0].message.content ?? "{}");
  const parsed = IntentSchema.safeParse(raw);
  return parsed.success ? parsed.data : { type: "unknown" };
}
```

## Pattern 2 — Task Parsing

Extract structured task data from free-form user input.

```typescript
// src/llm/parse-task.ts
import { openrouter, MODELS } from "./client";

export interface TaskDraft {
  title: string;
  period_slug: string;
  is_urgent: boolean;
  estimated_minutes?: number;
  deadline_date?: string; // ISO date
  description?: string;
  needs_clarification?: string; // question to ask user if ambiguous
}

export async function parseTaskMessage(
  message: string,
  availablePeriods: { slug: string; name: string }[]
): Promise<TaskDraft> {
  const response = await openrouter.chat.completions.create({
    model: MODELS.fast,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Extract a task from the user message.
Available periods: ${availablePeriods.map(p => `${p.slug} (${p.name})`).join(", ")}
If the task title is vague, set needs_clarification to a specific question.
If no period mentioned, infer from context or use the most fitting one.
Respond with JSON: { title, period_slug, is_urgent, estimated_minutes?, deadline_date?, description?, needs_clarification? }`,
      },
      { role: "user", content: message },
    ],
    temperature: 0,
  });

  return JSON.parse(response.choices[0].message.content ?? "{}") as TaskDraft;
}
```

## Pattern 3 — Conversational LLM (streaming optional)

Use for onboarding interview and retrospective — multi-turn dialogs where the LLM drives the conversation.

```typescript
// src/llm/interview.ts
import { openrouter, MODELS } from "./client";

interface Message { role: "user" | "assistant"; content: string; }

export async function continueInterview(
  systemPrompt: string,
  history: Message[],
  userMessage: string
): Promise<string> {
  const response = await openrouter.chat.completions.create({
    model: MODELS.strong,
    messages: [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: userMessage },
    ],
    temperature: 0.3,
    max_tokens: 500,
  });

  return response.choices[0].message.content ?? "";
}

// Onboarding system prompt
export const ONBOARDING_SYSTEM_PROMPT = `You are a scheduling assistant conducting onboarding for a day planner bot.
Your goal: collect timezone, activity periods (name, start/end time, days of week), morning notification time, end-of-day time.
Be conversational, warm, and concise. Speak Russian.
When you have all data, output a JSON block wrapped in <data>...</data> tags.
JSON format: { timezone, morning_time, end_of_day_time, periods: [{ name, slug, start, end, days }] }`;
```

## Pattern 4 — Plan Generation

Generate the formatted morning plan message.

```typescript
// src/llm/generate-plan.ts
import { openrouter, MODELS } from "./client";

export async function generateDayPlanMessage(
  date: string,
  periods: Array<{
    name: string;
    emoji: string;
    start: string;
    end: string;
    tasks: Array<{ title: string; estimated_minutes?: number; is_urgent: boolean }>;
  }>
): Promise<string> {
  // For plan generation, LLM is used for natural formatting only
  // The actual task ordering is done in code (urgent → deadline → no-deadline)
  const response = await openrouter.chat.completions.create({
    model: MODELS.strong,
    messages: [
      {
        role: "system",
        content: `Format a day plan as a Telegram message (HTML parse_mode).
Use emojis. Calculate approximate time slots for tasks based on estimated_minutes.
Mark urgent tasks with ⚡. Speak Russian. Return only the formatted message, no explanation.`,
      },
      {
        role: "user",
        content: JSON.stringify({ date, periods }),
      },
    ],
    temperature: 0.2,
  });

  return response.choices[0].message.content ?? "";
}
```

## Error Handling

Always wrap LLM calls — models can timeout, return invalid JSON, or hit rate limits:

```typescript
export async function safeLLMCall<T>(
  fn: () => Promise<T>,
  fallback: T
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error("LLM call failed:", err);
    return fallback;
  }
}

// Usage
const intent = await safeLLMCall(
  () => detectIntent(text, context),
  { type: "unknown" } as Intent
);
```

## Model Selection Guide

| Task | Model | Reason |
|------|-------|--------|
| Intent detection | `fast` | Simple classification, high frequency |
| Task parsing | `fast` | Structured extraction, cheap |
| Onboarding interview | `strong` | Nuanced multi-turn dialog |
| Plan generation | `strong` | Complex formatting + reasoning |
| Retrospective | `strong` | Multi-step, context-heavy |
| Progress note update | `fast` | Simple text rewrite |

## Key Rules

1. Always validate LLM JSON output with Zod before using it
2. Use `temperature: 0` for deterministic parsing/classification
3. Use `temperature: 0.2–0.4` for generation tasks
4. `conversation.external()` when calling LLM inside Grammy conversations
5. Never expose `OPENROUTER_API_KEY` client-side
6. Log model used + token count for cost tracking
