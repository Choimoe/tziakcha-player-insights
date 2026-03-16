import { w } from "../../shared/env";
import { infoLog, warnLog } from "../../shared/logger";
import { ReviewResponseItem } from "../record/reviewer/types";

type SessionPlayer = {
  name: string;
  id?: string;
};

type SessionRecord = {
  id: string;
};

type SessionData = {
  players: SessionPlayer[];
  records: SessionRecord[];
};

type StepPlayer = {
  n?: string;
  i?: string;
};

type StepData = {
  p?: StepPlayer[];
  a?: Array<[number, number]>;
};

type ChoiceKind = "play" | "chi" | "peng" | "gang" | "hu" | "pass" | "abandon";

type Choice = {
  seat: number;
  actionIndex: number;
  kind: ChoiceKind;
  value: number | null;
};

type PlayerMetric = {
  playerName: string;
  matched: number;
  total: number;
  ratio: number;
  chagaSum: number;
  chagaCount: number;
  chagaAvg: number;
};

type MetricsResult = {
  players: PlayerMetric[];
  overall: {
    matched: number;
    total: number;
    ratio: number;
    chagaAvg: number;
  };
};

const CHOICE_ACTION_TYPES = new Set([2, 3, 4, 5, 6, 8, 9]);
const FIXED_RI_OFFSET = -1;
let startedGameHref = "";

function getGameIdFromUrl(): string | null {
  const url = new URL(w.location.href);
  return url.searchParams.get("id");
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...options,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return (await response.json()) as T;
}

function extractSessionPlayers(raw: unknown): SessionPlayer[] {
  if (!Array.isArray((raw as { players?: unknown[] })?.players)) {
    return [];
  }
  return ((raw as { players: unknown[] }).players || []).map((item) => {
    const player = item as {
      n?: string;
      name?: string;
      i?: string;
      id?: string;
    };
    return {
      name: player.n || player.name || "",
      id: player.i || player.id,
    };
  });
}

function extractSessionRecords(raw: unknown): SessionRecord[] {
  if (!Array.isArray((raw as { records?: unknown[] })?.records)) {
    return [];
  }
  return ((raw as { records: unknown[] }).records || [])
    .map((item) => {
      const record = item as { id?: string; i?: string };
      const id = record.id || record.i;
      return id ? { id } : null;
    })
    .filter((item): item is SessionRecord => Boolean(item));
}

async function fetchSessionData(sessionId: string): Promise<SessionData> {
  const raw = await fetchJson<unknown>(
    `/_qry/game/?id=${encodeURIComponent(sessionId)}`,
    {
      method: "POST",
    },
  );
  return {
    players: extractSessionPlayers(raw),
    records: extractSessionRecords(raw),
  };
}

async function fetchAiResponse(
  sessionId: string,
  seat: number,
): Promise<ReviewResponseItem[]> {
  const raw = await fetchJson<
    ReviewResponseItem[] | { data?: ReviewResponseItem[] }
  >(
    `https://tc-api.pesiu.org/review/?id=${encodeURIComponent(sessionId)}&seat=${seat}`,
    { credentials: "omit" },
  );
  return Array.isArray(raw) ? raw : Array.isArray(raw.data) ? raw.data : [];
}

function base64ToBytes(input: string): Uint8Array {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function decompressZlibBase64(input: string): Promise<string> {
  const streamCtor = (
    w as Window & {
      DecompressionStream?: new (
        format: string,
      ) => TransformStream<Uint8Array, Uint8Array>;
    }
  ).DecompressionStream;
  if (!streamCtor) {
    throw new Error("当前浏览器不支持 DecompressionStream");
  }
  const bytes = base64ToBytes(input);
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const source = new Blob([buffer]).stream();
  const decompressed = source.pipeThrough(new streamCtor("deflate"));
  return await new Response(decompressed).text();
}

async function fetchStepData(recordId: string): Promise<StepData> {
  const raw = await fetchJson<{ script?: string }>("/_qry/record/", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
    body: new URLSearchParams({ id: recordId }).toString(),
  });
  if (!raw.script) {
    throw new Error(`record ${recordId} 缺少 script`);
  }
  const jsonText = await decompressZlibBase64(raw.script);
  return JSON.parse(jsonText) as StepData;
}

function bz2tc(tileCode: string): number {
  if (!tileCode || tileCode.length < 2) {
    return -1;
  }
  const tileType = tileCode[0];
  const number = Number.parseInt(tileCode.slice(1), 10) - 1;
  if (Number.isNaN(number)) {
    return -1;
  }
  if (tileType === "W") return number;
  if (tileType === "T") return number + 9;
  if (tileType === "B") return number + 18;
  if (tileType === "F") return number + 27;
  if (tileType === "J") return number + 31;
  if (tileType === "H") return number + 34;
  return -1;
}

function normalizeAiAction(
  actionText: string,
): [ChoiceKind, number | null] | null {
  const trimmed = actionText.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("Play ")) {
    const tileIndex = bz2tc(trimmed.split(/\s+/).at(-1) || "");
    return ["play", tileIndex >= 0 ? tileIndex : null];
  }
  if (trimmed.startsWith("Chi")) return ["chi", null];
  if (trimmed.startsWith("Peng")) return ["peng", null];
  if (trimmed.startsWith("Gang") || trimmed.startsWith("BuGang"))
    return ["gang", null];
  if (trimmed.startsWith("Hu")) return ["hu", null];
  if (trimmed.startsWith("Pass")) return ["pass", null];
  if (trimmed.startsWith("Abandon")) return ["abandon", null];
  return null;
}

function actionToChoice(
  actionIndex: number,
  combined: number,
  data: number,
): Choice | null {
  const seat = (combined >> 4) & 3;
  const actionType = combined & 15;
  if (!CHOICE_ACTION_TYPES.has(actionType)) {
    return null;
  }
  if (actionType === 2) {
    const tileId = data & 0xff;
    return { seat, actionIndex, kind: "play", value: Math.floor(tileId / 4) };
  }
  if (actionType === 3) {
    return { seat, actionIndex, kind: "chi", value: null };
  }
  if (actionType === 4) {
    return { seat, actionIndex, kind: "peng", value: null };
  }
  if (actionType === 5) {
    return { seat, actionIndex, kind: "gang", value: null };
  }
  if (actionType === 6) {
    const isAutoHu = Boolean(data & 1);
    return isAutoHu ? null : { seat, actionIndex, kind: "hu", value: null };
  }
  if (actionType === 8) {
    const passMode = data & 3;
    return passMode !== 0
      ? null
      : { seat, actionIndex, kind: "pass", value: null };
  }
  if (actionType === 9) {
    return { seat, actionIndex, kind: "abandon", value: null };
  }
  return null;
}

function extractChoices(stepData: StepData): Choice[] {
  if (!Array.isArray(stepData.a)) {
    return [];
  }
  const result: Choice[] = [];
  stepData.a.forEach((action, actionIndex) => {
    if (!Array.isArray(action) || action.length < 2) {
      return;
    }
    const [combined, data] = action;
    if (typeof combined !== "number" || typeof data !== "number") {
      return;
    }
    const choice = actionToChoice(actionIndex, combined, data);
    if (choice) {
      result.push(choice);
    }
  });
  return result;
}

function buildResponseMap(
  responseRows: ReviewResponseItem[],
  roundIndex: number,
): Map<number, ReviewResponseItem> {
  const responseMap = new Map<number, ReviewResponseItem>();
  responseRows.forEach((row) => {
    if (row.rr !== roundIndex || typeof row.ri !== "number") {
      return;
    }
    if (!responseMap.has(row.ri)) {
      responseMap.set(row.ri, row);
    }
  });
  return responseMap;
}

function choiceMatchesAi(
  choice: Choice,
  row: ReviewResponseItem | undefined,
): boolean {
  if (!row) {
    return true;
  }
  const candidates = row.extra?.candidates;
  if (!Array.isArray(candidates) || !candidates.length) {
    return true;
  }
  const top = candidates[0];
  if (!Array.isArray(top) || typeof top[1] !== "string") {
    return true;
  }
  const normalized = normalizeAiAction(top[1]);
  if (!normalized) {
    return true;
  }
  const [kind, value] = normalized;
  if (kind !== choice.kind) {
    return false;
  }
  if (kind === "play" && value !== choice.value) {
    return false;
  }
  return true;
}

function calcChagaScore(
  choice: Choice,
  row: ReviewResponseItem | undefined,
): number {
  if (!row) {
    return 100;
  }
  const candidates = row.extra?.candidates;
  if (!Array.isArray(candidates) || !candidates.length) {
    return 100;
  }
  const parsed: Array<{
    weight: number;
    normalized: [ChoiceKind, number | null];
  }> = [];
  candidates.forEach((item) => {
    if (!Array.isArray(item) || item.length < 2) {
      return;
    }
    const [weightRaw, actionRaw] = item;
    if (typeof weightRaw !== "number" || typeof actionRaw !== "string") {
      return;
    }
    const normalized = normalizeAiAction(actionRaw);
    if (!normalized) {
      return;
    }
    parsed.push({ weight: weightRaw, normalized });
  });
  if (!parsed.length) {
    return 100;
  }
  const topWeight = parsed[0].weight;
  let matchedWeight: number | null = null;
  parsed.forEach(({ weight, normalized }) => {
    const [kind, value] = normalized;
    if (kind !== choice.kind) {
      return;
    }
    if (kind === "play" && value !== choice.value) {
      return;
    }
    if (matchedWeight === null || weight > matchedWeight) {
      matchedWeight = weight;
    }
  });
  if (matchedWeight === null) {
    return 0;
  }
  return Math.exp(matchedWeight - topWeight) * 100;
}

async function computeMetrics(sessionId: string): Promise<MetricsResult> {
  const sessionData = await fetchSessionData(sessionId);
  const sessionPlayers = sessionData.players;
  const sessionPlayerNames = sessionPlayers.map(
    (player, index) => player.name || `Seat ${index}`,
  );
  const playerMetrics = sessionPlayerNames.map<PlayerMetric>((playerName) => ({
    playerName,
    matched: 0,
    total: 0,
    ratio: 0,
    chagaSum: 0,
    chagaCount: 0,
    chagaAvg: 0,
  }));

  const aiResponses = await Promise.all(
    [0, 1, 2, 3].map((seat) => fetchAiResponse(sessionId, seat)),
  );
  const steps = await Promise.all(
    sessionData.records.map((record) => fetchStepData(record.id)),
  );

  steps.forEach((stepData, roundNo) => {
    const roundPlayers = Array.isArray(stepData.p) ? stepData.p : [];
    const aiToRoundSeat = sessionPlayerNames.map((aiPlayerName) =>
      roundPlayers.findIndex((player) => player?.n === aiPlayerName),
    );
    const allChoices = extractChoices(stepData);

    for (let aiSeat = 0; aiSeat < 4; aiSeat += 1) {
      const stepSeat = aiToRoundSeat[aiSeat];
      if (stepSeat < 0) {
        continue;
      }
      const responseMap = buildResponseMap(aiResponses[aiSeat] || [], roundNo);
      const seatChoices = allChoices.filter(
        (choice) => choice.seat === stepSeat,
      );
      seatChoices.forEach((choice) => {
        const ri = choice.actionIndex + FIXED_RI_OFFSET;
        const row = responseMap.get(ri);
        const matched = choiceMatchesAi(choice, row);
        const chagaScore = calcChagaScore(choice, row);
        const metric = playerMetrics[aiSeat];
        metric.total += 1;
        if (matched) {
          metric.matched += 1;
        }
        metric.chagaSum += chagaScore;
        metric.chagaCount += 1;
      });
    }
  });

  playerMetrics.forEach((metric) => {
    metric.ratio = metric.total ? metric.matched / metric.total : 0;
    metric.chagaAvg = metric.chagaCount
      ? metric.chagaSum / metric.chagaCount
      : 0;
  });

  const overallMatched = playerMetrics.reduce(
    (sum, item) => sum + item.matched,
    0,
  );
  const overallTotal = playerMetrics.reduce((sum, item) => sum + item.total, 0);
  const overallChagaSum = playerMetrics.reduce(
    (sum, item) => sum + item.chagaSum,
    0,
  );
  const overallChagaCount = playerMetrics.reduce(
    (sum, item) => sum + item.chagaCount,
    0,
  );

  return {
    players: playerMetrics,
    overall: {
      matched: overallMatched,
      total: overallTotal,
      ratio: overallTotal ? overallMatched / overallTotal : 0,
      chagaAvg: overallChagaCount ? overallChagaSum / overallChagaCount : 0,
    },
  };
}

function createMetricRow(
  label: string,
  values: string[],
  rowId: string,
): HTMLTableRowElement {
  const row = document.createElement("tr");
  row.id = rowId;
  const header = document.createElement("th");
  header.className = "bg-secondary text-light";
  header.textContent = label;
  row.appendChild(header);
  values.forEach((value) => {
    const cell = document.createElement("td");
    cell.className = "bg-secondary text-light";
    cell.colSpan = 2;
    cell.textContent = value;
    row.appendChild(cell);
  });
  return row;
}

function upsertMetricsRows(metrics: MetricsResult): void {
  const standardScoreRow = Array.from(
    document.querySelectorAll("table.table tr"),
  ).find((row) =>
    (row.querySelector("th")?.textContent || "").includes("标准分"),
  );
  if (!standardScoreRow || !standardScoreRow.parentElement) {
    return;
  }

  document.getElementById("reviewer-game-ratio-row")?.remove();
  document.getElementById("reviewer-game-chaga-row")?.remove();

  const ratioRow = createMetricRow(
    "一致率",
    metrics.players.map((item) => `${(item.ratio * 100).toFixed(2)}%`),
    "reviewer-game-ratio-row",
  );
  const chagaRow = createMetricRow(
    "CHAGA度",
    metrics.players.map((item) => item.chagaAvg.toFixed(2)),
    "reviewer-game-chaga-row",
  );

  standardScoreRow.insertAdjacentElement("afterend", chagaRow);
  standardScoreRow.insertAdjacentElement("afterend", ratioRow);
  infoLog("Game overview metrics updated", metrics.overall);
}

function upsertLoadingRows(message: string): void {
  const standardScoreRow = Array.from(
    document.querySelectorAll("table.table tr"),
  ).find((row) =>
    (row.querySelector("th")?.textContent || "").includes("标准分"),
  );
  if (!standardScoreRow || !standardScoreRow.parentElement) {
    setTimeout(() => upsertLoadingRows(message), 200);
    return;
  }
  document.getElementById("reviewer-game-ratio-row")?.remove();
  document.getElementById("reviewer-game-chaga-row")?.remove();
  const ratioRow = createMetricRow(
    "一致率",
    [message, message, message, message],
    "reviewer-game-ratio-row",
  );
  const chagaRow = createMetricRow(
    "CHAGA度",
    [message, message, message, message],
    "reviewer-game-chaga-row",
  );
  standardScoreRow.insertAdjacentElement("afterend", chagaRow);
  standardScoreRow.insertAdjacentElement("afterend", ratioRow);
}

export function initGameFeature(href: string): boolean {
  if (startedGameHref === href) {
    return false;
  }
  startedGameHref = href;
  const sessionId = getGameIdFromUrl();
  if (!sessionId) {
    warnLog("Game feature init skipped: missing session id");
    return false;
  }
  infoLog("Game feature init started", { sessionId });
  upsertLoadingRows("计算中...");
  void computeMetrics(sessionId)
    .then((metrics) => {
      upsertMetricsRows(metrics);
    })
    .catch((error) => {
      warnLog("Game overview metrics failed", error);
      upsertLoadingRows("加载失败");
    });
  return true;
}
