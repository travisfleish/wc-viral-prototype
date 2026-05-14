import type {
  ClassifyUsageMeta,
  EmotionScores,
} from "@/lib/classify-messages";

export const TWITCH_IRC_URL = "wss://irc-ws.chat.twitch.tv:443";

export const JETSTREAM_URL =
  "wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post";

/** Case-insensitive substring on post text — tuned for broader sports / WC fan chatter. */
export const BLUESKY_KEYWORDS = [
  "goal",
  "penalty",
  "match",
  "game",
  "worldcup",
  "fifa",
  "soccer",
  "football",
  "score",
  "winner",
  "halftime",
  "trophy",
  "stadium",
] as const;

/** Channel login names (no #). Active high-viewership streams for live chat volume. */
export const TWITCH_CHANNELS = [
  "asianjeff",
  "evelone2004",
  "ohnepixel",
  "anarabdullaev",
] as const;

export const LANE_IDS = [
  ...TWITCH_CHANNELS.map((c) => `tw:${c}`),
  ...BLUESKY_KEYWORDS.map((k) => `bs:${k}`),
] as const;

export const WINDOW_MS = 60_000;
export const BUCKET_MS = 1_000;
export const BUCKET_COUNT = 60;
export const TICK_MS = 500;
export const RECENT_MAX = 5;
export const CLASSIFY_INTERVAL_MS = 5000;

export const EMOTION_ORDER = [
  "joy",
  "anger",
  "sadness",
  "surprise",
  "fear",
] as const;

export type EmotionKey = (typeof EMOTION_ORDER)[number];

export function blueskyLaneId(keyword: string): string {
  return `bs:${keyword}`;
}

export function twitchLaneId(channel: string): string {
  return `tw:${channel}`;
}

export function getCommitPostText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  if (root.kind !== "commit") return null;
  const commit = root.commit;
  if (!commit || typeof commit !== "object") return null;
  const c = commit as Record<string, unknown>;
  if (c.collection !== "app.bsky.feed.post") return null;
  const record = c.record;
  if (!record || typeof record !== "object") return null;
  const text = (record as Record<string, unknown>).text;
  return typeof text === "string" ? text : null;
}

export function randomJustinfanNick(): string {
  const n = Math.floor(10000 + Math.random() * 90000);
  return `justinfan${n}`;
}

export function parseTwitchPrivmsg(
  line: string,
): { channel: string; username: string; message: string } | null {
  const priv = " PRIVMSG ";
  const i = line.indexOf(priv);
  if (i === -1) return null;
  if (!line.startsWith(":")) return null;

  const prefix = line.slice(1, i);
  const bang = prefix.indexOf("!");
  if (bang === -1) return null;
  const username = prefix.slice(0, bang);

  const rest = line.slice(i + priv.length);
  const space = rest.indexOf(" ");
  if (space === -1) return null;
  const channelToken = rest.slice(0, space);
  if (!channelToken.startsWith("#")) return null;
  const channel = channelToken.slice(1);
  const trailing = rest.slice(space + 1);
  if (!trailing.startsWith(":")) return null;
  const message = trailing.slice(1);

  return { channel, username, message };
}

export function resolveTwitchChannelKey(
  channelFromIrc: string,
): (typeof TWITCH_CHANNELS)[number] | null {
  const lower = channelFromIrc.toLowerCase();
  for (const c of TWITCH_CHANNELS) {
    if (c.toLowerCase() === lower) return c;
  }
  return null;
}

export function emptyBuckets(): number[] {
  return new Array<number>(BUCKET_COUNT).fill(0);
}

export function pruneAndBucket(now: number, times: number[]): {
  kept: number[];
  buckets: number[];
} {
  const kept: number[] = [];
  const buckets = emptyBuckets();

  for (const t of times) {
    const age = now - t;
    if (age >= WINDOW_MS) continue;
    kept.push(t);
    const sec = Math.min(
      BUCKET_COUNT - 1,
      Math.floor(age / BUCKET_MS),
    );
    buckets[BUCKET_COUNT - 1 - sec] += 1;
  }

  return { kept, buckets };
}

export function laneBuckets(series: Record<string, number[]>, id: string): number[] {
  const row = series[id];
  if (!row || row.length !== BUCKET_COUNT) return emptyBuckets();
  return row;
}

export function last10sCountFromBuckets(buckets: number[]): number {
  return buckets.slice(BUCKET_COUNT - 10).reduce((sum, c) => sum + c, 0);
}

export function emotionSum(s: EmotionScores): number {
  return EMOTION_ORDER.reduce((acc, k) => acc + s[k], 0) || 1;
}

export function dominantEmotionKey(s: EmotionScores): EmotionKey {
  let best: EmotionKey = "joy";
  let bestV = -1;
  for (const k of EMOTION_ORDER) {
    if (s[k] > bestV) {
      bestV = s[k];
      best = k;
    }
  }
  return best;
}

export function totalEventsPerSec(series: Record<string, number[]>): number {
  let n = 0;
  for (const id of LANE_IDS) {
    n += last10sCountFromBuckets(laneBuckets(series, id));
  }
  return n / 10;
}

export function aggregateGlobalEmotions(
  series: Record<string, number[]>,
  emotionsByLane: Partial<Record<string, EmotionScores>>,
): EmotionScores | null {
  const acc: EmotionScores = {
    joy: 0,
    anger: 0,
    sadness: 0,
    surprise: 0,
    fear: 0,
  };
  let wSum = 0;
  for (const id of LANE_IDS) {
    const w = last10sCountFromBuckets(laneBuckets(series, id));
    const em = emotionsByLane[id];
    if (!em || w === 0) continue;
    wSum += w;
    for (const k of EMOTION_ORDER) {
      acc[k] += w * em[k];
    }
  }
  if (wSum === 0) return null;
  for (const k of EMOTION_ORDER) {
    acc[k] /= wSum;
  }
  return acc;
}

export function parseEmotionScores(data: unknown): EmotionScores | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  const out: EmotionScores = {
    joy: Number(o.joy),
    anger: Number(o.anger),
    sadness: Number(o.sadness),
    surprise: Number(o.surprise),
    fear: Number(o.fear),
  };
  for (const k of EMOTION_ORDER) {
    if (Number.isNaN(out[k])) return null;
  }
  return out;
}

export type ApiSpendState = {
  totalUsd: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
};

export function parseClassifyUsageMeta(data: unknown): ClassifyUsageMeta | null {
  if (!data || typeof data !== "object") return null;
  const raw = (data as Record<string, unknown>)._meta;
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const promptTokens = Number(o.promptTokens);
  const completionTokens = Number(o.completionTokens);
  const costUsd = Number(o.costUsd);
  if (
    Number.isNaN(promptTokens) ||
    Number.isNaN(completionTokens) ||
    Number.isNaN(costUsd)
  ) {
    return null;
  }
  return { promptTokens, completionTokens, costUsd };
}

export type HubSnapshotMessage = {
  type: "snapshot";
  series: Record<string, number[]>;
  emotionsByLane: Partial<Record<string, EmotionScores>>;
  recentByLane: Record<string, string[]>;
  apiSpend: ApiSpendState;
};
