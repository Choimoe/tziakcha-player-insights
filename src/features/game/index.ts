import { w } from "../../shared/env";
import { infoLog, warnLog } from "../../shared/logger";
import { fetchSessionData } from "../../shared/session-data";

import { ReviewResponseItem } from "../record/reviewer/types";
import { calcChagaScore, choiceMatchesAi, Choice } from "./chaga-score";
import { fetchAiResponse } from "./chaga-data";
import { fetchStepData, StepData } from "./step-data";
import { extractChoices } from "./step-simulator";

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

const FIXED_RI_OFFSET = -1;
const SESSION_NOT_FINISHED_ERROR = "SESSION_NOT_FINISHED";
let startedGameHref = "";

function getGameIdFromUrl(): string | null {
  const url = new URL(w.location.href);
  return url.searchParams.get("id");
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

async function computeMetrics(sessionId: string): Promise<MetricsResult> {
  const sessionData = await fetchSessionData(sessionId);
  if (!sessionData.isFinished) {
    throw new Error(SESSION_NOT_FINISHED_ERROR);
  }
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

function findStandardScoreRow(): HTMLTableRowElement | null {
  // 先尝试带 .table 类（桌面端），再兜底普通 table（移动端）
  const selectors = ["table.table tr", "table tr"];
  for (const selector of selectors) {
    const found = Array.from(document.querySelectorAll(selector)).find((row) =>
      (row.querySelector("th")?.textContent || "").includes("标准分"),
    );
    if (found) {
      return found as HTMLTableRowElement;
    }
  }
  return null;
}

function clearInsertedRows(): void {
  document.getElementById("reviewer-game-ratio-row")?.remove();
  document.getElementById("reviewer-game-chaga-row")?.remove();
  document.getElementById("reviewer-game-pending-row")?.remove();
}

function withAnchorRow(
  callback: (anchor: HTMLTableRowElement) => void,
  retryInterval = 200,
): void {
  const anchor = findStandardScoreRow();
  if (!anchor || !anchor.parentElement) {
    setTimeout(() => withAnchorRow(callback, retryInterval), retryInterval);
    return;
  }
  callback(anchor);
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
  withAnchorRow((anchor) => {
    clearInsertedRows();
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
    anchor.insertAdjacentElement("afterend", chagaRow);
    anchor.insertAdjacentElement("afterend", ratioRow);
    infoLog("Game overview metrics updated", metrics.overall);
  });
}

function upsertPendingRow(message: string): void {
  withAnchorRow((anchor) => {
    clearInsertedRows();
    const cells = Array.from(anchor.children).slice(1);
    const totalColSpan = cells.reduce((sum, cell) => {
      return sum + ((cell as HTMLTableCellElement).colSpan || 1);
    }, 0);

    const row = document.createElement("tr");
    row.id = "reviewer-game-pending-row";
    const header = document.createElement("th");
    header.className = "bg-secondary text-light";
    header.textContent = "AI评分";
    row.appendChild(header);
    const cell = document.createElement("td");
    cell.className = "bg-secondary text-light";
    cell.colSpan = Math.max(totalColSpan, 1);
    cell.textContent = message;
    row.appendChild(cell);

    anchor.insertAdjacentElement("afterend", row);
  });
}

function upsertLoadingRows(message: string): void {
  withAnchorRow((anchor) => {
    clearInsertedRows();
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
    anchor.insertAdjacentElement("afterend", chagaRow);
    anchor.insertAdjacentElement("afterend", ratioRow);
  });
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
      if ((error as Error)?.message === SESSION_NOT_FINISHED_ERROR) {
        upsertPendingRow("等待对局完成");
        return;
      }
      warnLog("Game overview metrics failed", error);
      upsertLoadingRows("加载失败");
    });
  return true;
}
