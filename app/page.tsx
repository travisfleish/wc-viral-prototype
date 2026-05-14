"use client";

import { useEffect, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
} from "recharts";

import type { EmotionScores } from "@/lib/classify-messages";
import {
  BLUESKY_KEYWORDS,
  CLASSIFY_INTERVAL_MS,
  EMOTION_ORDER,
  JETSTREAM_URL,
  LANE_IDS,
  RECENT_MAX,
  TICK_MS,
  TWITCH_CHANNELS,
  TWITCH_IRC_URL,
  aggregateGlobalEmotions,
  blueskyLaneId,
  dominantEmotionKey,
  emotionSum,
  getCommitPostText,
  laneBuckets,
  last10sCountFromBuckets,
  parseClassifyUsageMeta,
  parseEmotionScores,
  pruneAndBucket,
  randomJustinfanNick,
  resolveTwitchChannelKey,
  parseTwitchPrivmsg,
  totalEventsPerSec,
  twitchLaneId,
  type EmotionKey,
  type HubSnapshotMessage,
} from "@/lib/live-shared";

const LIVE_HUB_WS =
  process.env.NEXT_PUBLIC_LIVE_HUB_WS?.trim().length
    ? process.env.NEXT_PUBLIC_LIVE_HUB_WS.trim()
    : "";

const ACCENT_BLUESKY = "#22d3ee";
const ACCENT_TWITCH = "#a855f7";

const CHART_H = 44;

const EMOTION_COLORS: Record<EmotionKey, string> = {
  joy: "#fbbf24",
  anger: "#ef4444",
  sadness: "#3b82f6",
  surprise: "#c084fc",
  fear: "#14b8a6",
};

const usdSpendFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 6,
});

function ApiSpendPanel(props: {
  totalUsd: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  spendSource: "tab" | "hub";
}) {
  const totalTok = props.promptTokens + props.completionTokens;
  const label =
    props.spendSource === "hub"
      ? "API spend (shared hub)"
      : "API spend (this tab)";
  const resetHint =
    props.spendSource === "hub"
      ? "Cumulative on the hub process; resets when the hub restarts."
      : "Resets on full page reload.";
  return (
    <div
      className="border border-neutral-800 bg-[#111111] px-3 py-2 text-right"
      title={`Estimated from gpt-4o-mini list prices (input $0.15 / 1M · output $0.60 / 1M). ${resetHint}`}
    >
      <div className="text-[10px] uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className="mt-0.5 text-xl tabular-nums leading-none text-neutral-100">
        {usdSpendFormatter.format(props.totalUsd)}
      </div>
      <div className="mt-1.5 text-[10px] leading-snug text-neutral-500">
        {props.calls} classify calls · {totalTok.toLocaleString()} tokens
        <span className="text-neutral-600">
          {" "}
          (in {props.promptTokens.toLocaleString()} · out{" "}
          {props.completionTokens.toLocaleString()})
        </span>
      </div>
    </div>
  );
}

function GlobalEmotionStrip(props: { scores: EmotionScores | null }) {
  const s = props.scores;
  const sum = s ? emotionSum(s) : 1;
  const title = s
    ? EMOTION_ORDER.map((k) => `${k}: ${s[k].toFixed(1)}%`).join(" · ")
    : undefined;

  return (
    <div className="flex flex-col items-end gap-1">
      <div
        className="flex h-3 w-[200px] overflow-hidden rounded-sm bg-neutral-800"
        title={title}
      >
        {s ? (
          EMOTION_ORDER.map((key) => (
            <div
              key={key}
              className="h-full shrink-0"
              style={{
                width: `${(s[key] / sum) * 100}%`,
                transition: "width 800ms ease",
                backgroundColor: EMOTION_COLORS[key],
              }}
            />
          ))
        ) : (
          <div className="h-full w-full bg-neutral-800" />
        )}
      </div>
      <div className="text-[9px] uppercase tracking-wide text-neutral-500">
        GLOBAL EMOTIONAL STATE
      </div>
    </div>
  );
}

function LaneCard(props: {
  label: string;
  buckets: number[];
  recent: string[];
  stroke: string;
  emotions?: EmotionScores;
}) {
  const [drawChart, setDrawChart] = useState(false);

  useEffect(() => {
    setDrawChart(true);
  }, []);

  const last10sCount = last10sCountFromBuckets(props.buckets);
  const data = props.buckets.map((c, i) => ({ i, c }));

  const emotions = props.emotions;
  const emSum = emotions ? emotionSum(emotions) : 0;

  return (
    <div className="min-w-0 border border-neutral-800 bg-[#111111] p-3">
      <div className="text-[11px] uppercase tracking-wide text-neutral-500">
        {props.label}
      </div>

      <div className="mt-2 h-7 w-full min-w-0 overflow-hidden rounded-sm">
        {emotions ? (
          <div className="flex h-full w-full">
            {EMOTION_ORDER.map((key) => {
              const pct = (emotions[key] / emSum) * 100;
              const showLabel = pct >= 12;
              return (
                <div
                  key={key}
                  className="flex h-full shrink-0 items-center justify-center overflow-hidden font-mono text-[10px] leading-none"
                  style={{
                    width: `${pct}%`,
                    transition: "width 800ms ease",
                    backgroundColor: EMOTION_COLORS[key],
                    color:
                      key === "joy"
                        ? showLabel
                          ? "#0a0a0a"
                          : "transparent"
                        : showLabel
                          ? "#fafafa"
                          : "transparent",
                    textShadow:
                      key === "joy" || !showLabel
                        ? undefined
                        : "0 1px 2px rgba(0,0,0,0.85)",
                  }}
                >
                  {showLabel
                    ? `${key} ${Math.round(emotions[key])}%`
                    : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-neutral-800 text-[10px] uppercase tracking-wide text-neutral-500">
            AWAITING CLASSIFICATION
          </div>
        )}
      </div>

      {emotions ? (
        <div className="mt-1.5 font-mono text-[10px] tracking-wide text-neutral-500">
          DOMINANT: {dominantEmotionKey(emotions)}
        </div>
      ) : (
        <div className="mt-1.5 text-[10px] uppercase tracking-wide text-neutral-600">
          &nbsp;
        </div>
      )}

      <div className="mt-2 text-xl tabular-nums leading-none text-neutral-200">
        {last10sCount}
      </div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wide text-neutral-500">
        LAST 10s
      </div>
      <div className="mt-2 w-full min-w-0" style={{ height: CHART_H }}>
        {drawChart ? (
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <AreaChart
              data={data}
              margin={{ top: 0, right: 0, left: 0, bottom: 0 }}
            >
              <Area
                type="monotone"
                dataKey="c"
                stroke={props.stroke}
                fill={props.stroke}
                fillOpacity={0.14}
                strokeWidth={1.25}
                isAnimationActive={false}
                dot={false}
                activeDot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full w-full bg-neutral-900/20" />
        )}
      </div>
      <div className="mt-2 space-y-0.5 border-t border-neutral-800 pt-2">
        {Array.from({ length: RECENT_MAX }, (_, i) => {
          const line = props.recent[i];
          return (
            <div
              key={i}
              className="truncate text-[11px] leading-tight text-neutral-500"
            >
              {line ?? ""}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Home() {
  const timestampsRef = useRef(
    Object.fromEntries(
      LANE_IDS.map((id) => [id, [] as number[]]),
    ) as Record<string, number[]>,
  );

  const messagesRef = useRef(
    Object.fromEntries(
      LANE_IDS.map((id) => [id, [] as string[]]),
    ) as Record<string, string[]>,
  );

  const [series, setSeries] = useState<Record<string, number[]>>({});

  const [emotionsByLane, setEmotionsByLane] = useState<
    Partial<Record<string, EmotionScores>>
  >({});

  const [recentByLane, setRecentByLane] = useState<Record<string, string[]>>(
    () =>
      Object.fromEntries(
        LANE_IDS.map((id) => [id, [] as string[]]),
      ) as Record<string, string[]>,
  );

  const [apiSpend, setApiSpend] = useState({
    totalUsd: 0,
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
  });

  const [hubConnected, setHubConnected] = useState(false);

  useEffect(() => {
    if (!LIVE_HUB_WS) return;

    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const applySnapshot = (raw: unknown) => {
      if (!raw || typeof raw !== "object") return;
      const msg = raw as HubSnapshotMessage;
      if (msg.type !== "snapshot") return;
      setSeries(msg.series ?? {});
      setEmotionsByLane(msg.emotionsByLane ?? {});
      setRecentByLane(
        (msg.recentByLane ??
          Object.fromEntries(
            LANE_IDS.map((id) => [id, [] as string[]]),
          )) as Record<string, string[]>,
      );
      if (msg.apiSpend) {
        setApiSpend(msg.apiSpend);
      }
    };

    function connect() {
      if (cancelled) return;
      ws = new WebSocket(LIVE_HUB_WS);
      ws.onopen = () => setHubConnected(true);
      ws.onclose = () => {
        setHubConnected(false);
        ws = null;
        if (!cancelled) {
          reconnectTimer = setTimeout(connect, 2000);
        }
      };
      ws.onerror = () => {
        ws?.close();
      };
      ws.onmessage = (event) => {
        try {
          applySnapshot(JSON.parse(String(event.data)));
        } catch {
          /* ignore */
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  useEffect(() => {
    if (LIVE_HUB_WS) return;

    const tick = () => {
      const now = Date.now();
      const next: Record<string, number[]> = {};

      for (const id of LANE_IDS) {
        const times = timestampsRef.current[id] ?? [];
        const { kept, buckets } = pruneAndBucket(now, times);
        timestampsRef.current[id] = kept;
        next[id] = buckets;
      }

      setSeries(next);
    };

    tick();
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (LIVE_HUB_WS) return;

    async function classifySweep() {
      for (const laneId of LANE_IDS) {
        const buf = messagesRef.current[laneId] ?? [];
        messagesRef.current[laneId] = [];
        const snapshot = [...buf];
        if (snapshot.length < 3) continue;

        const res = await fetch("/api/classify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: snapshot }),
        });

        let data: unknown;
        try {
          data = await res.json();
        } catch {
          continue;
        }

        const parsed = parseEmotionScores(data);
        if (!parsed) continue;

        const meta = parseClassifyUsageMeta(data);
        if (meta) {
          setApiSpend((prev) => ({
            totalUsd: prev.totalUsd + meta.costUsd,
            calls: prev.calls + 1,
            promptTokens: prev.promptTokens + meta.promptTokens,
            completionTokens: prev.completionTokens + meta.completionTokens,
          }));
        }

        setEmotionsByLane((prev) => ({ ...prev, [laneId]: parsed }));
      }
    }

    const classifyId = window.setInterval(() => {
      void classifySweep();
    }, CLASSIFY_INTERVAL_MS);

    return () => clearInterval(classifyId);
  }, []);

  useEffect(() => {
    if (LIVE_HUB_WS) return;

    const ws = new WebSocket(JETSTREAM_URL);

    ws.onmessage = (event) => {
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

      const did =
        payload &&
        typeof payload === "object" &&
        typeof (payload as Record<string, unknown>).did === "string"
          ? (payload as Record<string, unknown>).did
          : undefined;

      console.log("[bluesky jetstream]", { matched, text, did });

      const now = Date.now();
      for (const kw of matched) {
        const id = blueskyLaneId(kw);
        timestampsRef.current[id]?.push(now);
        messagesRef.current[id]?.push(text);
      }

      setRecentByLane((prev) => {
        const next = { ...prev };
        for (const kw of matched) {
          const id = blueskyLaneId(kw);
          next[id] = [text, ...(next[id] ?? [])].slice(0, RECENT_MAX);
        }
        return next;
      });
    };

    return () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    if (LIVE_HUB_WS) return;

    const ws = new WebSocket(TWITCH_IRC_URL);
    let inbound = "";

    ws.onopen = () => {
      const nick = randomJustinfanNick();
      ws.send(`NICK ${nick}\r\n`);
      ws.send("PASS SCHMOOPIIE\r\n");
      for (const c of TWITCH_CHANNELS) {
        ws.send(`JOIN #${c}\r\n`);
      }
    };

    ws.onmessage = (event) => {
      inbound += String(event.data);
      const parts = inbound.split(/\r\n/);
      inbound = parts.pop() ?? "";

      for (const raw of parts) {
        const line = raw.trimEnd();
        if (!line) continue;

        if (line.startsWith("PING")) {
          const arg = line.replace(/^PING\s*/i, "");
          ws.send(`PONG ${arg}\r\n`);
          continue;
        }

        const msg = parseTwitchPrivmsg(line);
        if (!msg) continue;

        const channelKey = resolveTwitchChannelKey(msg.channel);
        if (!channelKey) continue;

        const id = twitchLaneId(channelKey);

        console.log("[twitch irc]", {
          channel: channelKey,
          username: msg.username,
          message: msg.message,
        });

        timestampsRef.current[id]?.push(Date.now());
        messagesRef.current[id]?.push(msg.message);
        const lineText = `${msg.username}: ${msg.message}`;

        setRecentByLane((prev) => {
          const next = { ...prev };
          next[id] = [lineText, ...(next[id] ?? [])].slice(0, RECENT_MAX);
          return next;
        });
      }
    };

    return () => {
      ws.close();
    };
  }, []);

  const globalEmotions = aggregateGlobalEmotions(series, emotionsByLane);
  const totalEps = totalEventsPerSec(series);

  return (
    <div className="min-h-screen bg-[#0a0a0a] p-6 font-mono text-neutral-300">
      {LIVE_HUB_WS ? (
        <div
          className={`mb-4 border px-3 py-2 text-[11px] uppercase tracking-wide ${
            hubConnected
              ? "border-emerald-900/60 bg-emerald-950/30 text-emerald-400/90"
              : "border-amber-900/60 bg-amber-950/30 text-amber-400/90"
          }`}
        >
          Live hub:{" "}
          {hubConnected
            ? "connected — one worker feeds all viewers"
            : "disconnected — reconnecting…"}
        </div>
      ) : null}
      <header className="mb-8 flex flex-wrap items-end justify-between gap-6 border-b border-neutral-800 pb-4">
        <div>
          <div className="text-2xl tabular-nums text-neutral-100">
            {totalEps.toFixed(1)}
          </div>
          <div className="mt-0.5 text-[10px] uppercase tracking-wide text-neutral-500">
            TOTAL EVENTS/SEC
          </div>
        </div>
        <div className="flex flex-wrap items-end justify-end gap-4">
          <ApiSpendPanel
            totalUsd={apiSpend.totalUsd}
            calls={apiSpend.calls}
            promptTokens={apiSpend.promptTokens}
            completionTokens={apiSpend.completionTokens}
            spendSource={LIVE_HUB_WS ? "hub" : "tab"}
          />
          <GlobalEmotionStrip scores={globalEmotions} />
        </div>
      </header>
      <section>
        <h1 className="border-b border-neutral-800 pb-2 text-xs uppercase tracking-[0.2em] text-neutral-500">
          TWITCH · LIVE
        </h1>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {TWITCH_CHANNELS.map((ch) => {
            const id = twitchLaneId(ch);
            return (
              <LaneCard
                key={id}
                label={ch.toUpperCase()}
                buckets={laneBuckets(series, id)}
                recent={recentByLane[id] ?? []}
                stroke={ACCENT_TWITCH}
                emotions={emotionsByLane[id]}
              />
            );
          })}
        </div>
      </section>

      <section className="mt-10">
        <h1 className="border-b border-neutral-800 pb-2 text-xs uppercase tracking-[0.2em] text-neutral-500">
          BLUESKY · LIVE
        </h1>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {BLUESKY_KEYWORDS.map((kw) => {
            const id = blueskyLaneId(kw);
            return (
              <LaneCard
                key={id}
                label={kw.toUpperCase()}
                buckets={laneBuckets(series, id)}
                recent={recentByLane[id] ?? []}
                stroke={ACCENT_BLUESKY}
                emotions={emotionsByLane[id]}
              />
            );
          })}
        </div>
      </section>
    </div>
  );
}
