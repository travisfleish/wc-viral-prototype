/**
 * Single-process live worker: Jetstream + Twitch IRC + OpenAI classify, fan-out via WebSocket.
 *
 * Run: `npm run hub` (loads .env.local for OPENAI_API_KEY)
 * Point the Next app at it: `NEXT_PUBLIC_LIVE_HUB_WS=ws://localhost:3333` then `npm run dev`
 */

import { config } from "dotenv";
import { resolve } from "node:path";
import WebSocket, { WebSocketServer } from "ws";

import { classifyMessages } from "@/lib/classify-messages";
import type { EmotionScores } from "@/lib/classify-messages";
import {
  BLUESKY_KEYWORDS,
  CLASSIFY_INTERVAL_MS,
  JETSTREAM_URL,
  LANE_IDS,
  RECENT_MAX,
  pruneAndBucket,
  randomJustinfanNick,
  resolveTwitchChannelKey,
  TICK_MS,
  TWITCH_CHANNELS,
  TWITCH_IRC_URL,
  blueskyLaneId,
  getCommitPostText,
  parseTwitchPrivmsg,
  twitchLaneId,
  type ApiSpendState,
  type HubSnapshotMessage,
} from "@/lib/live-shared";

config({ path: resolve(process.cwd(), ".env.local") });
config({ path: resolve(process.cwd(), ".env") });

const PORT = Number(process.env.LIVE_HUB_PORT ?? "3333");

const timestamps: Record<string, number[]> = Object.fromEntries(
  LANE_IDS.map((id) => [id, [] as number[]]),
) as Record<string, number[]>;

const messageBuffers: Record<string, string[]> = Object.fromEntries(
  LANE_IDS.map((id) => [id, [] as string[]]),
) as Record<string, string[]>;

const recentByLane: Record<string, string[]> = Object.fromEntries(
  LANE_IDS.map((id) => [id, [] as string[]]),
) as Record<string, string[]>;

let emotionsByLane: Partial<Record<string, EmotionScores>> = {};

let apiSpend: ApiSpendState = {
  totalUsd: 0,
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
};

const hubClients = new Set<WebSocket>();

function buildSnapshot(): HubSnapshotMessage {
  const now = Date.now();
  const series: Record<string, number[]> = {};
  for (const id of LANE_IDS) {
    const times = timestamps[id] ?? [];
    const { kept, buckets } = pruneAndBucket(now, times);
    timestamps[id] = kept;
    series[id] = buckets;
  }
  return {
    type: "snapshot",
    series,
    emotionsByLane: { ...emotionsByLane },
    recentByLane: { ...recentByLane },
    apiSpend: { ...apiSpend },
  };
}

function broadcastSnapshot(): void {
  const payload = buildSnapshot();
  const json = JSON.stringify(payload);
  for (const client of hubClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  }
}

setInterval(broadcastSnapshot, TICK_MS);

async function classifySweep(): Promise<void> {
  for (const laneId of LANE_IDS) {
    const buf = messageBuffers[laneId] ?? [];
    messageBuffers[laneId] = [];
    const snapshot = [...buf];
    if (snapshot.length < 3) continue;

    const data = await classifyMessages(snapshot);
    const scores: EmotionScores = {
      joy: data.joy,
      anger: data.anger,
      sadness: data.sadness,
      surprise: data.surprise,
      fear: data.fear,
    };
    emotionsByLane = { ...emotionsByLane, [laneId]: scores };

    const meta = data._meta;
    if (meta) {
      apiSpend = {
        totalUsd: apiSpend.totalUsd + meta.costUsd,
        calls: apiSpend.calls + 1,
        promptTokens: apiSpend.promptTokens + meta.promptTokens,
        completionTokens: apiSpend.completionTokens + meta.completionTokens,
      };
    }
  }
}

setInterval(() => {
  void classifySweep();
}, CLASSIFY_INTERVAL_MS);

/* Bluesky Jetstream */
const jetstream = new WebSocket(JETSTREAM_URL);
jetstream.onmessage = (event) => {
  let payload: unknown;
  try {
    payload = JSON.parse(String(event.data));
  } catch {
    return;
  }

  const text = getCommitPostText(payload);
  if (!text) return;

  const haystack = text.toLowerCase();
  const matched = BLUESKY_KEYWORDS.filter((kw) =>
    haystack.includes(kw.toLowerCase()),
  );
  if (matched.length === 0) return;

  const now = Date.now();
  for (const kw of matched) {
    const id = blueskyLaneId(kw);
    timestamps[id]?.push(now);
    messageBuffers[id]?.push(text);
    recentByLane[id] = [text, ...(recentByLane[id] ?? [])].slice(
      0,
      RECENT_MAX,
    );
  }
};

jetstream.onerror = () => {
  console.error("[live-hub] jetstream socket error");
};

/* Twitch IRC */
const irc = new WebSocket(TWITCH_IRC_URL);
let ircInbound = "";

irc.onopen = () => {
  const nick = randomJustinfanNick();
  irc.send(`NICK ${nick}\r\n`);
  irc.send("PASS SCHMOOPIIE\r\n");
  for (const c of TWITCH_CHANNELS) {
    irc.send(`JOIN #${c}\r\n`);
  }
};

irc.onmessage = (event) => {
  ircInbound += String(event.data);
  const parts = ircInbound.split(/\r\n/);
  ircInbound = parts.pop() ?? "";

  for (const raw of parts) {
    const line = raw.trimEnd();
    if (!line) continue;

    if (line.startsWith("PING")) {
      const arg = line.replace(/^PING\s*/i, "");
      irc.send(`PONG ${arg}\r\n`);
      continue;
    }

    const msg = parseTwitchPrivmsg(line);
    if (!msg) continue;

    const channelKey = resolveTwitchChannelKey(msg.channel);
    if (!channelKey) continue;

    const id = twitchLaneId(channelKey);
    timestamps[id]?.push(Date.now());
    messageBuffers[id]?.push(msg.message);
    const lineText = `${msg.username}: ${msg.message}`;
    recentByLane[id] = [lineText, ...(recentByLane[id] ?? [])].slice(
      0,
      RECENT_MAX,
    );
  }
};

irc.onerror = () => {
  console.error("[live-hub] twitch irc socket error");
};

/* Fan-out WebSocket server */
const wss = new WebSocketServer({ port: PORT });
wss.on("connection", (socket) => {
  hubClients.add(socket);
  socket.send(JSON.stringify(buildSnapshot()));
  socket.on("close", () => {
    hubClients.delete(socket);
  });
});

wss.on("listening", () => {
  console.log(
    `[live-hub] WebSocket on ws://localhost:${PORT} — ${LANE_IDS.length} lanes, classify every ${CLASSIFY_INTERVAL_MS}ms`,
  );
});
