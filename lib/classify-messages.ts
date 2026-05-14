import OpenAI from "openai";
import type { ChatCompletion } from "openai/resources/chat/completions";

export type EmotionScores = {
  joy: number;
  anger: number;
  sadness: number;
  surprise: number;
  fear: number;
};

export type ClassifyUsageMeta = {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
};

export type ClassifyResult = EmotionScores & { _meta?: ClassifyUsageMeta };

/** gpt-4o-mini — standard tier (USD per 1M tokens). */
const PRICE_INPUT_PER_1M = 0.15;
const PRICE_OUTPUT_PER_1M = 0.6;

const EMPTY_SCORES: EmotionScores = {
  joy: 0,
  anger: 0,
  sadness: 0,
  surprise: 0,
  fear: 0,
};

function costUsdFromUsage(usage: ChatCompletion["usage"]): number {
  if (!usage) return 0;
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  return (input * PRICE_INPUT_PER_1M) / 1_000_000 + (output * PRICE_OUTPUT_PER_1M) / 1_000_000;
}

function resultWithUsage(
  scores: EmotionScores,
  completion: ChatCompletion | null,
): ClassifyResult {
  const usage = completion?.usage;
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  if (!usage && promptTokens === 0 && completionTokens === 0) {
    return scores;
  }
  const costUsd = costUsdFromUsage(usage);
  return {
    ...scores,
    _meta: {
      promptTokens,
      completionTokens,
      costUsd,
    },
  };
}

/**
 * Classifies a batch of messages with gpt-4o-mini. Used by `/api/classify` and the live hub worker.
 */
export async function classifyMessages(messages: string[]): Promise<ClassifyResult> {
  if (messages.length === 0) {
    return { ...EMPTY_SCORES };
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return { ...EMPTY_SCORES };
  }

  try {
    const openai = new OpenAI({ apiKey });
    const numberedList = messages.map((m, i) => `${i + 1}. ${m}`).join("\n");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You classify the dominant emotions in a batch of short social media messages from sports fans. Score the overall emotional tone of the batch across five emotions: joy, anger, sadness, surprise, fear. Return percentages that sum to 100.",
        },
        { role: "user", content: numberedList },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "emotion_scores",
          strict: true,
          schema: {
            type: "object",
            properties: {
              joy: { type: "number" },
              anger: { type: "number" },
              sadness: { type: "number" },
              surprise: { type: "number" },
              fear: { type: "number" },
            },
            required: ["joy", "anger", "sadness", "surprise", "fear"],
            additionalProperties: false,
          },
        },
      },
    });

    const message = completion.choices[0]?.message;
    const content = message?.content;
    if (!content) {
      if (process.env.NODE_ENV !== "production" && message?.refusal) {
        console.error("[classifyMessages] model refusal:", message.refusal);
      }
      return resultWithUsage(EMPTY_SCORES, completion);
    }

    const parsed = JSON.parse(content) as Record<string, unknown>;
    const keys = ["joy", "anger", "sadness", "surprise", "fear"] as const;
    for (const k of keys) {
      const v = parsed[k];
      if (typeof v !== "number" || Number.isNaN(v)) {
        return resultWithUsage(EMPTY_SCORES, completion);
      }
    }

    return resultWithUsage(
      {
        joy: parsed.joy as number,
        anger: parsed.anger as number,
        sadness: parsed.sadness as number,
        surprise: parsed.surprise as number,
        fear: parsed.fear as number,
      },
      completion,
    );
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[classifyMessages]", err);
    }
    return { ...EMPTY_SCORES };
  }
}
