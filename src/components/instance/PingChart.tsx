import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import UplotReact from "uplot-react";
import type uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { Eye, EyeOff, RefreshCw, RotateCcw } from "lucide-react";
import { usePingRecords } from "@/hooks/useRecords";
import { InstancePanel } from "./InstancePanel";
import {
  formatHourMinuteAxis,
  formatTooltipTime,
  getChartTooltipPosition,
  toChartSeconds,
  useResponsiveChartSize,
} from "./chartShared";
import {
  cutPeakValues,
  detectTypicalIntervalMs,
  insertMetricGapSentinels,
} from "./chartData";
import { latencyHeatColor, lossHeatColor } from "@/utils/metricTone";
import { usePreferences } from "@/hooks/usePreferences";
import type { PingRecord } from "@/types/komari";
import type { TimedMetricPoint } from "./chartData";

interface TooltipState {
  show: boolean;
  left: number;
  top: number;
  rows: Array<{ label: string; value: string; color: string }>;
  time: string;
}

interface ViewRange {
  start: number;
  end: number;
}

interface PingChartModel {
  data: uPlot.AlignedData;
  lossKeys: Set<string>;
}

const MIN_VIEW_SPAN = 0.04;
const BRUSH_HEIGHT = 58;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function colorForTask(index: number) {
  const colors = [
    "#5d88ff",
    "#61c08f",
    "#a35cf5",
    "#f1873d",
    "#d4a54a",
  ] as const;
  return colors[index % colors.length];
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

function sliceChartData(data: uPlot.AlignedData, range: ViewRange): uPlot.AlignedData {
  const times = data[0] as number[];
  if (times.length < 2 || (range.start <= 0 && range.end >= 1)) return data;

  const first = times[0];
  const last = times[times.length - 1];
  const span = last - first;
  if (!Number.isFinite(span) || span <= 0) return data;

  const startTime = first + span * range.start;
  const endTime = first + span * range.end;
  const indices = times
    .map((time, index) => ({ time, index }))
    .filter(({ time }) => time >= startTime && time <= endTime)
    .map(({ index }) => index);

  if (indices.length < 2) return data;
  return data.map((series) => indices.map((index) => series[index])) as uPlot.AlignedData;
}

function formatPingChartValue(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)} ms`;
}

function drawLossMarkers({
  u,
  chart,
  tasks,
  visibleTaskIds,
  taskColors,
  lossKeys,
}: {
  u: uPlot;
  chart: uPlot.AlignedData;
  tasks: Array<{ id: number }>;
  visibleTaskIds: Set<number>;
  taskColors: Map<number, string>;
  lossKeys: Set<string>;
}) {
  const times = chart[0] as number[];
  if (!times.length || lossKeys.size === 0) return;

  const pxRatio = typeof window === "undefined" ? 1 : Math.max(1, window.devicePixelRatio || 1);
  const ctx = u.ctx;
  const { left, top, width, height } = u.bbox;
  const markerTop = top + 5 * pxRatio;
  const markerBottom = top + 22 * pxRatio;

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, width, height);
  ctx.clip();
  ctx.lineCap = "round";
  ctx.lineWidth = 1.4 * pxRatio;

  for (const time of times) {
    const losses = tasks.filter(
      (task) => visibleTaskIds.has(task.id) && lossKeys.has(`${time}:${task.id}`),
    );
    if (!losses.length) continue;

    const centerX = u.valToPos(time, "x", true);
    const startOffset = ((losses.length - 1) * -3.5) * pxRatio;

    losses.forEach((task, index) => {
      const x = centerX + startOffset + index * 7 * pxRatio;
      const taskColor = taskColors.get(task.id) ?? "#ff5d73";

      ctx.strokeStyle = "rgba(255, 93, 115, 0.9)";
      ctx.beginPath();
      ctx.moveTo(x, markerTop);
      ctx.lineTo(x, markerBottom);
      ctx.stroke();

      ctx.fillStyle = "rgba(255, 93, 115, 0.18)";
      ctx.beginPath();
      ctx.arc(x, markerTop, 5 * pxRatio, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = taskColor;
      ctx.beginPath();
      ctx.arc(x, markerTop, 2.6 * pxRatio, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  ctx.restore();
}

export function PingChart({
  uuid,
  hours,
  active = true,
}: {
  uuid: string;
  hours: number;
  active?: boolean;
}) {
  const { data, isLoading, refetch } = usePingRecords(uuid, hours, active);
  const { resolvedAppearance } = usePreferences();
  const { w, h } = useResponsiveChartSize("wide");
  const [hiddenTasks, setHiddenTasks] = useState<Set<number>>(new Set());
  const [connectNulls, setConnectNulls] = useState(false);
  const [cutPeak, setCutPeak] = useState(false);
  const [drawLoss, setDrawLoss] = useState(false);
  const [viewRange, setViewRange] = useState<ViewRange>({ start: 0, end: 1 });
  const chartRef = useRef<uPlot.AlignedData>([[]]);
  const [tooltip, setTooltip] = useState<TooltipState>({
    show: false,
    left: 0,
    top: 0,
    rows: [],
    time: "",
  });
  const isDark = resolvedAppearance === "dark";
  const tasks = useMemo(() => [...(data?.tasks ?? [])].sort((a, b) => a.id - b.id), [data]);
  const taskLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      const label = task.name || `任务 #${task.id}`;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return new Map(
      tasks.map((task) => {
        const baseLabel = task.name || `任务 #${task.id}`;
        const label = (counts.get(baseLabel) ?? 0) > 1 ? `${baseLabel} #${task.id}` : baseLabel;
        return [task.id, label] as const;
      }),
    );
  }, [tasks]);
  const taskColors = useMemo(
    () => new Map(tasks.map((task, index) => [task.id, colorForTask(index)] as const)),
    [tasks],
  );
  const taskKeySet = useMemo(() => new Set(tasks.map((task) => String(task.id))), [tasks]);
  const taskKeys = useMemo(() => tasks.map((task) => String(task.id)), [tasks]);
  const taskIndexById = useMemo(
    () => new Map(tasks.map((task, index) => [task.id, index] as const)),
    [tasks],
  );
  const visibleTasks = useMemo(
    () => tasks.filter((task) => !hiddenTasks.has(task.id)),
    [hiddenTasks, tasks],
  );
  const visibleTaskIds = useMemo(
    () => new Set(visibleTasks.map((task) => task.id)),
    [visibleTasks],
  );

  useEffect(() => {
    setHiddenTasks(new Set());
    setViewRange({ start: 0, end: 1 });
  }, [uuid]);

  useEffect(() => {
    setHiddenTasks((prev) => {
      const validTaskIds = new Set(tasks.map((task) => task.id));
      const next = new Set([...prev].filter((taskId) => validTaskIds.has(taskId)));
      return next.size === prev.size ? prev : next;
    });
  }, [tasks]);

  const fullChartModel = useMemo<PingChartModel | null>(() => {
    if (!data?.records.length || !tasks.length || visibleTasks.length === 0) return null;
    const pointMap = new Map<number, TimedMetricPoint>();
    const lossKeys = new Set<string>();
    const sortedRecords = data.records
      .map((record) => ({
        record,
        time: toChartSeconds(record.time),
      }))
      .filter(({ time }) => time > 0)
      .sort((left, right) => left.time - right.time);
    const taskIntervals = tasks
      .map((task) => task.interval)
      .filter((value): value is number => typeof value === "number" && value > 0);
    const fallbackInterval = taskIntervals.length > 0
      ? Math.min(...taskIntervals)
      : detectTypicalIntervalMs(sortedRecords.map(({ time }) => time), 60);
    const tolerance = Math.min(6, Math.max(0.8, fallbackInterval * 0.25));
    const anchors: number[] = [];

    for (const { record, time } of sortedRecords) {
      if (!taskKeySet.has(String(record.task_id))) continue;
      let anchor = time;
      for (const existing of anchors) {
        if (Math.abs(existing - time) <= tolerance) {
          anchor = existing;
          break;
        }
      }
      if (anchor === time) {
        anchors.push(anchor);
      }
      const current = pointMap.get(anchor) ?? { time: anchor };
      const taskKey = String(record.task_id);
      const lossKey = `${anchor}:${taskKey}`;
      if (record.value > 0) {
        current[taskKey] = record.value;
        lossKeys.delete(lossKey);
      } else {
        current[taskKey] = null;
        lossKeys.add(lossKey);
      }
      pointMap.set(anchor, current);
    }

    let chartPoints = [...pointMap.values()].sort((a, b) => a.time - b.time);
    if (cutPeak && taskKeys.length > 0) {
      chartPoints = cutPeakValues(chartPoints, taskKeys);
    }
    chartPoints = insertMetricGapSentinels(chartPoints, {
      intervals: new Map(
        tasks
          .filter((task) => typeof task.interval === "number" && task.interval > 0)
          .map((task) => [String(task.id), task.interval] as const),
      ),
      defaultInterval: fallbackInterval,
      matchToleranceRatio: 0.25,
    });
    const times = chartPoints.map((point) => point.time);
    const perTask = taskKeys.map((taskKey) =>
      chartPoints.map((point) => point[taskKey] ?? null),
    );

    return {
      data: [times, ...perTask] as uPlot.AlignedData,
      lossKeys,
    };
  }, [cutPeak, data, taskKeySet, taskKeys, tasks, visibleTasks.length]);

  const chart = useMemo(
    () => (fullChartModel ? sliceChartData(fullChartModel.data, viewRange) : null),
    [fullChartModel, viewRange],
  );

  useEffect(() => {
    if (chart) chartRef.current = chart;
  }, [chart]);

  const yRange = useMemo<[number | null, number | null]>(() => {
    if (!chart) return [null, null];
    const values = tasks
      .flatMap((task, index) =>
        visibleTaskIds.has(task.id)
          ? ((chart[index + 1] as Array<number | null | undefined>) ?? [])
          : [],
      )
      .filter(
        (value): value is number =>
          typeof value === "number" &&
          Number.isFinite(value) &&
          value > 0,
      );
    if (values.length === 0) {
      return [0, 100];
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (min === max) {
      const pad = Math.max(5, min * 0.1);
      return [Math.max(0, min - pad), max + pad];
    }
    const pad = Math.max(5, (max - min) * 0.12);
    return [Math.max(0, min - pad), max + pad];
  }, [chart, tasks, visibleTaskIds]);

  const options = useMemo<uPlot.Options | null>(() => {
    if (!chart) return null;
    const grid = isDark ? "rgba(255,255,255,0.065)" : "rgba(0,0,0,0.08)";
    const text = isDark ? "#a5a5aa" : "#52525b";
    return {
      width: w,
      height: h,
      padding: [10, 14, 12, 2],
      cursor: { drag: { x: true, y: false } },
      legend: { show: false },
      scales: {
        x: { time: true },
        y: { auto: false, range: yRange },
      },
      axes: [
        {
          stroke: text,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid },
          size: 36,
          values: formatHourMinuteAxis,
        },
        {
          stroke: text,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid },
          size: 54,
          values: (_self, splits) =>
            splits.map((value) => {
              if (value === 0) return "";
              return `${Math.round(value)} ms`;
            }),
        },
      ],
      series: [
        { label: "time" },
        ...tasks.map((task, index) => ({
          label: taskLabels.get(task.id) ?? `任务 #${task.id}`,
          stroke: taskColors.get(task.id) ?? colorForTask(index),
          width: 1.7,
          spanGaps: connectNulls,
          show: !hiddenTasks.has(task.id),
          points: { show: false },
        })),
      ],
      hooks: {
        init: [
          (u) => {
            u.root.addEventListener("mouseleave", () => {
              setTooltip((prev) => ({ ...prev, show: false }));
            });
          },
        ],
        setCursor: [
          (u) => {
            const idx = u.cursor.idx;
            if (idx == null || idx < 0 || !chart) {
              setTooltip((prev) => ({ ...prev, show: false }));
              return;
            }
            const currentChart = chartRef.current;
            const timestamp = currentChart[0]?.[idx];
            if (typeof timestamp !== "number") {
              setTooltip((prev) => ({ ...prev, show: false }));
              return;
            }
            const bbox = u.root.getBoundingClientRect();
            const anchorX = u.valToPos(timestamp, "x");
            const rows = visibleTasks.map((task) => {
              const taskIndex = taskIndexById.get(task.id) ?? 0;
              const value = currentChart[taskIndex + 1]?.[idx] as number | null | undefined;
              const isLoss = drawLoss && (fullChartModel?.lossKeys.has(`${timestamp}:${task.id}`) ?? false);
              return {
                label: taskLabels.get(task.id) ?? `任务 #${task.id}`,
                value: isLoss ? "丢包" : formatPingChartValue(value),
                color: taskColors.get(task.id) ?? colorForTask(taskIndex),
              };
            });
            const anchorY = typeof u.cursor.top === "number" ? u.cursor.top : bbox.height * 0.5;
            const position = getChartTooltipPosition({
              containerWidth: bbox.width,
              containerHeight: bbox.height,
              anchorX,
              anchorY,
              rowCount: rows.length,
              estimatedWidth: 196,
            });
            setTooltip({
              show: true,
              left: position.left,
              top: position.top,
              rows,
              time: formatTooltipTime(timestamp),
            });
          },
        ],
        draw: [
          (u) => {
            if (!drawLoss || !fullChartModel) return;
            drawLossMarkers({
              u,
              chart,
              tasks,
              visibleTaskIds,
              taskColors,
              lossKeys: fullChartModel.lossKeys,
            });
          },
        ],
      },
    };
  }, [chart, connectNulls, drawLoss, fullChartModel, h, hiddenTasks, isDark, taskColors, taskIndexById, taskLabels, tasks, visibleTaskIds, visibleTasks, w, yRange]);

  const overviewOptions = useMemo<uPlot.Options | null>(() => {
    if (!fullChartModel) return null;
    return {
      width: w,
      height: BRUSH_HEIGHT,
      padding: [2, 0, 2, 0],
      cursor: { show: false, drag: { x: false, y: false } },
      legend: { show: false },
      scales: {
        x: { time: true },
        y: { auto: true },
      },
      axes: [],
      series: [
        { label: "time" },
        ...tasks.map((task, index) => ({
          label: taskLabels.get(task.id) ?? `任务 #${task.id}`,
          stroke: taskColors.get(task.id) ?? colorForTask(index),
          width: 1.1,
          spanGaps: true,
          show: !hiddenTasks.has(task.id),
          points: { show: false },
        })),
      ],
    };
  }, [fullChartModel, hiddenTasks, taskColors, taskLabels, tasks, w]);

  const taskStats = useMemo(() => {
    const grouped = new Map<number, PingRecord[]>();
    for (const record of data?.records ?? []) {
      const bucket = grouped.get(record.task_id);
      if (bucket) bucket.push(record);
      else grouped.set(record.task_id, [record]);
    }

    for (const records of grouped.values()) {
      records.sort((a, b) => toChartSeconds(a.time) - toChartSeconds(b.time));
    }

    return tasks.map((task, index) => {
      const records = grouped.get(task.id) ?? [];
      const positives = records
        .filter((record) => record.value > 0)
        .map((record) => record.value);
      const latest = [...records].reverse().find((record) => record.value > 0)?.value ?? null;
      const avg = positives.length
        ? positives.reduce((sum, value) => sum + value, 0) / positives.length
        : null;
      const min = positives.length ? Math.min(...positives) : null;
      const max = positives.length ? Math.max(...positives) : null;
      const p50 = percentile(positives, 0.5);
      const p99 = percentile(positives, 0.99);
      const volatility = p50 && p50 > 0 && p99 ? p99 / p50 : null;
      const total = records.length;
      const lost = records.filter((record) => record.value <= 0).length;
      const loss = total > 0 ? (lost / total) * 100 : task.loss;
      return {
        ...task,
        latest,
        avg,
        min,
        max,
        p50,
        p99,
        volatility,
        total,
        lost,
        loss,
        color: taskColors.get(task.id) ?? colorForTask(index),
      };
    });
  }, [data, taskColors, tasks]);

  const toggleTask = (taskId: number) => {
    setHiddenTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const toggleAll = () => {
    setHiddenTasks((prev) => (prev.size === 0 ? new Set(tasks.map((task) => task.id)) : new Set()));
  };

  if (isLoading) {
    return <section className="instance-panel h-[260px] animate-pulse" aria-busy />;
  }

  if (!data?.records.length) {
    return (
      <InstancePanel title="Ping 图表">
        <div className="instance-empty">暂无延迟记录</div>
      </InstancePanel>
    );
  }

  return (
    <InstancePanel title="Ping 图表">
      <div className="instance-ping-toolbar">
        <button
          type="button"
          className="instance-toggle-button instance-switch-button"
          data-active={cutPeak ? "true" : "false"}
          onClick={() => setCutPeak((value) => !value)}
          aria-pressed={cutPeak}
          title="对尖峰值做轻度平滑，仅影响图线显示"
        >
          <span className="instance-switch-copy">削峰平滑</span>
          <span className="instance-switch-track" aria-hidden>
            <span className="instance-switch-thumb" />
          </span>
          <span className="instance-switch-state">
            {cutPeak ? "开启" : "关闭"}
          </span>
        </button>
        <button
          type="button"
          className="instance-toggle-button instance-switch-button"
          data-active={connectNulls ? "true" : "false"}
          onClick={() => setConnectNulls((value) => !value)}
          aria-pressed={connectNulls}
        >
          <span className="instance-switch-copy">断点连线</span>
          <span className="instance-switch-track" aria-hidden>
            <span className="instance-switch-thumb" />
          </span>
          <span className="instance-switch-state">
            {connectNulls ? "开启" : "关闭"}
          </span>
        </button>
        <button
          type="button"
          className="instance-toggle-button instance-switch-button"
          data-active={drawLoss ? "true" : "false"}
          onClick={() => setDrawLoss((value) => !value)}
          aria-pressed={drawLoss}
        >
          <span className="instance-switch-copy">丢包标记</span>
          <span className="instance-switch-track" aria-hidden>
            <span className="instance-switch-thumb" />
          </span>
          <span className="instance-switch-state">
            {drawLoss ? "开启" : "关闭"}
          </span>
        </button>
        <button type="button" className="instance-toggle-button" onClick={toggleAll}>
          {hiddenTasks.size === 0 ? <EyeOff size={14} /> : <Eye size={14} />}
          {hiddenTasks.size === 0 ? "隐藏全部" : "显示全部"}
        </button>
        <button
          type="button"
          className="instance-toggle-button"
          onClick={() => setViewRange({ start: 0, end: 1 })}
          title="恢复显示完整时间范围"
        >
          <RotateCcw size={14} />
          重置范围
        </button>
        <button type="button" className="instance-toggle-button" onClick={() => void refetch()}>
          <RefreshCw size={14} />
          刷新
        </button>
      </div>

      <div className="instance-ping-tasks">
        {taskStats.map((task) => {
          const visible = !hiddenTasks.has(task.id);
          return (
            <button
              key={task.id}
              type="button"
              className="instance-ping-task"
              data-visible={visible ? "true" : "false"}
              aria-pressed={visible}
              onClick={() => toggleTask(task.id)}
              style={{ borderColor: visible ? task.color : "var(--border-subtle)" }}
              title={`最小 ${task.min != null ? `${task.min.toFixed(1)} ms` : "—"} | 最大 ${task.max != null ? `${task.max.toFixed(1)} ms` : "—"} | 样本 ${task.total ?? 0} | 间隔 ${task.interval}s`}
            >
              <div className="instance-ping-task-head">
                <span className="instance-ping-task-name">{taskLabels.get(task.id) ?? `任务 #${task.id}`}</span>
                <span
                  className="instance-ping-task-primary"
                  style={{ color: task.latest != null ? latencyHeatColor(task.latest) : "var(--text-tertiary)" }}
                >
                  {task.latest != null ? `${task.latest.toFixed(1)} ms` : "—"}
                </span>
              </div>
              <div className="instance-ping-task-stats">
                <span>均值 {task.avg != null ? `${task.avg.toFixed(1)} ms` : "—"}</span>
                <span style={{ color: lossHeatColor(task.loss) }}>丢包 {task.loss.toFixed(1)}%</span>
                <span>p99 {task.p99 != null ? `${task.p99.toFixed(0)} ms` : "—"}</span>
                <span>抖动 {task.volatility != null ? task.volatility.toFixed(2) : "—"}</span>
              </div>
              <div className="instance-ping-task-meta">
                <span>min {task.min != null ? `${task.min.toFixed(0)} ms` : "—"}</span>
                <span>max {task.max != null ? `${task.max.toFixed(0)} ms` : "—"}</span>
                <span>样本 {task.total ?? 0}</span>
                <span>{task.interval}s</span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="instance-uplot-wrap is-large">
        {chart && options ? (
          <>
            <UplotReact options={options} data={chart} />
            {tooltip.show && (
              <div
                className="instance-chart-tooltip"
                style={{ left: tooltip.left, top: tooltip.top }}
              >
                <div className="instance-chart-tooltip-time">{tooltip.time}</div>
                {tooltip.rows.map((row) => (
                  <div key={`${row.label}-${row.color}`} className="instance-chart-tooltip-row">
                    <span className="instance-chart-tooltip-dot" style={{ background: row.color }} />
                    <span>{row.label}</span>
                    <strong>{row.value}</strong>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="instance-empty">当前已隐藏全部线路，点击上方按钮可恢复显示</div>
        )}
      </div>
      {fullChartModel && overviewOptions ? (
        <RangeBrush
          data={fullChartModel.data}
          options={overviewOptions}
          range={viewRange}
          onChange={setViewRange}
        />
      ) : null}
    </InstancePanel>
  );
}

function RangeBrush({
  data,
  options,
  range,
  onChange,
}: {
  data: uPlot.AlignedData;
  options: uPlot.Options;
  range: ViewRange;
  onChange: (range: ViewRange) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const times = data[0] as number[];
  const first = times[0];
  const last = times[times.length - 1];
  const span = last - first;
  const startTime = Number.isFinite(span) && span > 0 ? first + span * range.start : first;
  const endTime = Number.isFinite(span) && span > 0 ? first + span * range.end : last;
  const selectionLabel =
    typeof startTime === "number" && typeof endTime === "number"
      ? `${formatTooltipTime(startTime, 24)} - ${formatTooltipTime(endTime, 24)}`
      : "—";

  const startDrag = (
    mode: "move" | "start" | "end",
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;

    const initialX = event.clientX;
    const initialRange = { ...range };
    const spanValue = initialRange.end - initialRange.start;

    const applyPointer = (clientX: number) => {
      const position = clamp((clientX - rect.left) / rect.width, 0, 1);
      if (mode === "start") {
        onChange({
          start: clamp(position, 0, initialRange.end - MIN_VIEW_SPAN),
          end: initialRange.end,
        });
        return;
      }

      if (mode === "end") {
        onChange({
          start: initialRange.start,
          end: clamp(position, initialRange.start + MIN_VIEW_SPAN, 1),
        });
        return;
      }

      const delta = (clientX - initialX) / rect.width;
      const nextStart = clamp(initialRange.start + delta, 0, 1 - spanValue);
      onChange({
        start: nextStart,
        end: nextStart + spanValue,
      });
    };

    const handleMove = (moveEvent: PointerEvent) => {
      applyPointer(moveEvent.clientX);
    };
    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };

  const jumpToPosition = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const spanValue = range.end - range.start;
    const center = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const nextStart = clamp(center - spanValue / 2, 0, 1 - spanValue);
    onChange({ start: nextStart, end: nextStart + spanValue });
  };

  return (
    <div className="instance-range-brush-shell">
      <div className="instance-range-brush-meta">
        <span>显示范围</span>
        <strong>{selectionLabel}</strong>
      </div>
      <div
        ref={trackRef}
        className="instance-range-brush"
        onPointerDown={jumpToPosition}
      >
        <div className="instance-range-brush-chart">
          <UplotReact options={options} data={data} />
        </div>
        <span
          className="instance-range-brush-mask"
          style={{ left: 0, width: `${range.start * 100}%` }}
          aria-hidden
        />
        <span
          className="instance-range-brush-mask"
          style={{ left: `${range.end * 100}%`, width: `${(1 - range.end) * 100}%` }}
          aria-hidden
        />
        <div
          className="instance-range-brush-window"
          style={{
            left: `${range.start * 100}%`,
            width: `${(range.end - range.start) * 100}%`,
          }}
          onPointerDown={(event) => startDrag("move", event)}
        >
          <button
            type="button"
            className="instance-range-brush-handle is-start"
            aria-label="调整开始时间"
            onPointerDown={(event) => startDrag("start", event)}
          />
          <button
            type="button"
            className="instance-range-brush-handle is-end"
            aria-label="调整结束时间"
            onPointerDown={(event) => startDrag("end", event)}
          />
        </div>
      </div>
    </div>
  );
}
