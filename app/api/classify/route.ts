import { NextResponse } from "next/server";

import { classifyMessages } from "@/lib/classify-messages";

export async function POST(request: Request) {
  let messages: string[];
  try {
    const body = (await request.json()) as { messages?: unknown };
    if (!Array.isArray(body.messages)) {
      return NextResponse.json({
        joy: 0,
        anger: 0,
        sadness: 0,
        surprise: 0,
        fear: 0,
      });
    }
    messages = body.messages.filter((m): m is string => typeof m === "string");
  } catch {
    return NextResponse.json({
      joy: 0,
      anger: 0,
      sadness: 0,
      surprise: 0,
      fear: 0,
    });
  }

  const result = await classifyMessages(messages);
  return NextResponse.json(result);
}
