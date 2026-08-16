/**
 * dsh-rewind：DSH 会话回退插件（完整复刻 Claude Code /rewind 的恢复语义）。
 * S1：三件套 + 命令注册。
 * S2：/rewind（无参数）列出最近 20 条用户消息（编号 + 摘要，1 = 最新）。
 * S3：/rewind <n> 硬回退——把选中的第 n 条用户消息及其后的对话从上下文作废：
 *     先存保险柜，再追加 surface replacement 事件（与 compaction 同款机制）。
 * S4：文件跟着回退 + 三种恢复范围（对应 Claude Code 菜单的三个选项）：
 *     /rewind <n>                  = restore code and conversation（默认）
 *     /rewind <n> --conversation   = restore conversation（只回对话，文件不动）
 *     /rewind <n> --code           = restore code（只回文件，对话不动）
 *     快照语义同 Claude Code：在每条用户消息发送前拍 git 时刻照（HEAD + stash create）；
 *     回退 = 回到选中消息发送之前，选中消息本身也会从对话里移除、原话回显给用户。
 * S5：保险柜找回 /unrewind：
 *     /unrewind           撤回最近一次 /rewind（对话+文件一起找回），无参数、单 Enter 执行
 *     关键设计：找回前先 append 原始用户输入气泡并拍 git 快照——这样 /rewind 能撤回 /unrewind。
 *     切面节点是空 content 的 assistant/message replacement：deriveEventMessage 跳过空 assistant，
 *     所以 rewind/unrewind 的标记文字、保险柜路径绝对不进模型上下文。
 * 数据流（执行分支）：输入框 → 命令分发器 → handler → 参数解析
 *       → surface 名单找目标 seq → 按范围恢复文件 → 保险柜存盘
 *       → append 空 assistant（surfaceOp replace）→ 回执。
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 第一件：名字 —— DSH 用它登记本插件
const name = "dsh-rewind";

// 第二件：要哪些插座 —— commands = 命令注册服务
const inject = ["commands"];

// git 快照账本目录：~/.dsh/rewind-git/<sessionId>.json（每行 { seq, time, head, stash }）
const gitLedgerDir = join(homedir(), ".dsh", "rewind-git");
// 保险柜目录：~/.dsh/rewind-vault/<sessionId>-<timestamp>.json
const vaultDir = join(homedir(), ".dsh", "rewind-vault");

// surface 占位节点：deriveEventMessage 会跳过空 content 的 assistant/message，
// 所以 rewind/unrewind 的“切面事件”用空 assistant 占位，模型上下文绝对看不到
// rewind/unrewind 字样、保险柜路径或任何回退标记。
const PLACEHOLDER_PROVIDER = "dsh-rewind";
const REWIND_PLACEHOLDER_MODEL = "rewind-placeholder";
const UNREWIND_PLACEHOLDER_MODEL = "unrewind-placeholder";
const REPAIR_PLACEHOLDER_MODEL = "repair-placeholder";

function placeholderEventData(id, model) {
  return {
    turn: 0,
    step: 0,
    message: {
      id,
      role: "assistant",
      content: [],
      source: { kind: "model", provider: PLACEHOLDER_PROVIDER, model }
    }
  };
}

function isDshPlaceholder(event, model) {
  const source = event?.data?.message?.source ?? null;
  return event?.type === "assistant/message"
    && source?.kind === "model"
    && source.provider === PLACEHOLDER_PROVIDER
    && source.model === model;
}

// 第三件：通电后干什么 —— 挂消息边界钩子 + 注册 "rewind" / "vault" 命令
function apply(ctx) {
  // S4 消息边界钩子：会话每追加一条事件就广播 session/event（沿作用域树冒泡到根），
  // 真用户消息到达 = 文件状态的一个边界，拍一张 git 时刻照（回退的地基）。
  // 时机与 Claude Code 一致：快照拍在“用户消息发送前”，此刻这条消息对应的改动还没发生。
  ctx.on(
    "session/event",
    (session, event) => {
      if (event.type !== "user/message" || event.data.source.kind !== "user") return;
      try {
        // 自动把非 git 工作区变成可用仓库：git init + baseline commit。
        // 只影响还没有 HEAD 的 cwd；已经是正常 git 仓库的工作区不会动。
        ensureGitBaseline(session.header?.cwd);
        snapshotGit(session, event.seq);
      } catch (error) {
        if (ctx.logger?.warn) ctx.logger.warn(`dsh-rewind: git snapshot failed: ${String(error)}`);
      }
    },
    { global: true }
  );

  // S6：把“当前模型可见 surface”投影成 rewindAnchors，供浏览器端弹层读取。
  // 客户端的人类聊天记录故意保留被 shadow 的气泡，所以弹层不能读客户端 nodes，
  // 必须读宿主按 surface replacement 折叠出来的当前可见回退点。
  ctx.inject(["sessionProjections"], (projectionCtx) => {
    projectionCtx.sessionProjections.register(rewindAnchorsProjection);
  });

  ctx.effect(function* () {
    yield ctx.commands.register({
      name: "rewind",
      description: "Rewind conversation and files to before an earlier user prompt",
      // 必须声明 input：不声明，Web 输入框只认裸命令名，带参数的整行（/rewind 2）
      // 不会进命令，而是漏进对话发给模型（2026-08-14 撞墙，见 S3 学习记录）
      input: { hint: "编号（来自 /rewind 列表，1=最新）；可加 --code 或 --conversation" },
      handler: (invocation) => {
        const session = invocation.agent.session;
        const input = invocation.rawInput.trim();
        if (input === "") return listHistory(session);
        if (input === "repair") return repairOrphanToolResults(session);
        return rewindTo(session, input);
      }
    });
    yield ctx.commands.register({
      name: "unrewind",
      // 纯裸命令：不声明 input，Web 输入框敲 /unrewind 直接 Enter 就执行，
      // 不会再进入“命令已选中、还在等参数”的状态；也不接受任何编号/参数。
      description: "Undo the latest /rewind and hard-overwrite the conversation from its vault backup",
      handler: (invocation) => restoreLatestRewind(invocation.agent.session)
    });
  });
}

/** S2：/rewind（无参数）→ 列出最近 20 条可回退点（真用户消息 + /vault 找回点），1 = 最新。 */
function listHistory(session) {
  const anchors = listRewindAnchors(session).reverse().slice(0, 20);
  if (anchors.length === 0) {
    return { kind: "success", text: "还没有可回退的历史。" };
  }
  const list = anchors.map((a, i) => `${i + 1}. ${previewText(a.text)}`);
  const usage = [
    "",
    "回退 = 回到所选消息发送之前（该消息会从对话移除，原话回显给你重发）。",
    "/rewind <编号>                 对话 + 文件一起回退",
    "/rewind <编号> --conversation  只回对话，文件不动",
    "/rewind <编号> --code          只回文件，对话不动"
  ].join("\n");
  return { kind: "success", text: `${list.join("\n")}\n${usage}` };
}

/** 从消息投影或原始事件里取纯文本（兼容 deriveMessages 的 message 和 session.events[seq]）。 */
function messageText(messageOrEvent) {
  const content = messageOrEvent?.content ?? messageOrEvent?.data?.content ?? [];
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
}

function previewText(text) {
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/**
 * 等当前正在跑的模型回合收口，再执行 rewind/unrewind。
 * 为什么必须等：rewind 的 surface replacement 会在回合中间把 assistant 消息 shadow 掉；
 * 随后落盘的 tool/result 会 append 到 surface 尾部，模型上下文里就出现
 * 没有前置 assistant tool_calls 的 tool 消息，provider 直接 400，
 * 下一个回合永远卡在 Deep diving（v0.11.8 实锤 bug）。
 */
function waitForTurnSettle(session, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const events = session.events ?? [];
      const start = events.findLast((event) => event.type === "turn/start");
      if (start === undefined) return resolve(true);
      const ended = events.findLast(
        (event) => event.type === "turn/end" && event.data?.turn === start.data?.turn
      );
      if (ended !== undefined && ended.seq > start.seq) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

/**
 * /rewind repair：清理“回合中间被 rewind shadow 掉 assistant tool_calls 后”
 * 残留在 surface 上的孤儿 tool/result。它们会让 provider 报
 * “Messages with role 'tool' must be a response to a preceding message with 'tool_calls'”，
 * 会话从此发消息无响应。逐条用空 assistant 占位替换（derive 跳过，模型看不见）。
 */
async function repairOrphanToolResults(session) {
  const settled = await waitForTurnSettle(session);
  if (!settled) {
    return { kind: "error", text: "当前回合还没结束，稍等它跑完再执行 /rewind repair。" };
  }
  const nodes = session.surface.nodes;
  const toolCallIds = new Set();
  for (const seq of nodes) {
    const event = session.events[seq];
    if (event?.type !== "assistant/message") continue;
    for (const block of event.data.message.content ?? []) {
      if (block?.type === "tool-call") {
        const id = block.id ?? block.callId;
        if (typeof id === "string") toolCallIds.add(id);
      }
    }
  }
  const orphanSeqs = [];
  for (const seq of nodes) {
    const event = session.events[seq];
    if (event?.type !== "tool/result") continue;
    const callId = event.data.message.source?.callId;
    if (typeof callId === "string" && !toolCallIds.has(callId)) orphanSeqs.push(seq);
  }
  if (orphanSeqs.length === 0) {
    return { kind: "success", text: "没有发现需要修复的孤儿工具结果。" };
  }
  for (const seq of orphanSeqs) {
    session.append(
      "assistant/message",
      placeholderEventData(`repair-${randomUUID()}`, REPAIR_PLACEHOLDER_MODEL),
      {
        surfaceOp: { op: "replace", start: seq, end: seq },
        sourceEventSeqs: [seq]
      }
    );
  }
  return {
    kind: "success",
    text: `已清掉 ${orphanSeqs.length} 条孤儿工具结果，会话可以继续发消息了。`
  };
}

/**
 * rewindAnchors 投影：把会话日志折叠成“当前模型可见的 surface 节点”，
 * 再挑出可回退点（真用户消息 + /vault 找回点）。
 * 客户端弹层读这个投影，回退后重新打开弹层拿到的就是新 surface，不会残留旧目标。
 */
const rewindAnchorsProjection = {
  key: "rewindAnchors",
  // 宿主要求 schema.parse；我们自己做轻量校验，不引入 zod 依赖
  schema: { parse(value) { return value; } },
  stateVersion: 4,
  init: () => ({ nodes: [], shadowedRanges: [], shadowedTurns: [] }),
  apply: (state, event) => {
    const op = event.surfaceOp;
    if (op === "append") {
      // /vault 重放旧消息时 turn 号是历史值：一旦同名 turn 以 append 身份重新出现，
      // 说明它已经从保险柜找回，不能再按旧 rewind 的 shadowedTurns 隐藏。
      const replayTurn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : null;
      const shadowedTurns = replayTurn !== null && state.shadowedTurns.includes(replayTurn)
        ? state.shadowedTurns.filter((turn) => turn !== replayTurn)
        : state.shadowedTurns;
      return {
        nodes: [...state.nodes, surfaceNodeFor(event)],
        shadowedRanges: state.shadowedRanges,
        shadowedTurns
      };
    }
    if (op !== null && typeof op === "object" && op.op === "replace") {
      const startIdx = state.nodes.findIndex((n) => n.seq === op.start);
      const endIdx = state.nodes.findIndex((n) => n.seq === op.end);
      if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return state;
      const removedNodes = state.nodes.slice(startIdx, endIdx + 1);
      // rewind 和 unrewind 的空 assistant 占位替换都会硬切对话，都要记录
      // shadowedRanges/turns（客户端据此隐藏气泡、turn-tail、tool-call）。
      // 兼容旧版本：旧日志里是 plugin user/message 替换，也一并算上。
      const isDshReplacement = (
        event.type === "user/message"
        && event.data?.source?.plugin === "dsh-rewind"
      ) || (
        event.type === "assistant/message"
        && event.data?.message?.source?.provider === PLACEHOLDER_PROVIDER
      );
      const removedTurns = removedNodes
        .map((n) => n.turn)
        .filter((turn) => Number.isSafeInteger(turn));
      const shadowedRanges = isDshReplacement
        ? [...state.shadowedRanges, { start: op.start, end: op.end }]
        : state.shadowedRanges;
      const shadowedTurns = isDshReplacement
        ? [...new Set([...state.shadowedTurns, ...removedTurns])]
        : state.shadowedTurns;
      return {
        nodes: [
          ...state.nodes.slice(0, startIdx),
          surfaceNodeFor(event),
          ...state.nodes.slice(endIdx + 1)
        ],
        shadowedRanges,
        shadowedTurns
      };
    }
    return state;
  },
  view: (state) => ({
    anchors: state.nodes
      .filter((n) => n.anchor)
      .slice(-20)
      .reverse()
      .map((n, index) => ({
        n: index + 1,
        seq: n.seq,
        time: n.time,
        text: n.text,
        checkpoint: n.checkpoint === true
      })),
    // 给浏览器端气泡渲染器用：落在这些区间里的聊天节点就是被 /rewind shadow 掉的；
    // turn-tail 这类节点锚点 seq 可能在区间外，再按 turn 补一刀
    shadowedRanges: state.shadowedRanges,
    shadowedTurns: state.shadowedTurns
  })
};

function surfaceNodeFor(event) {
  const source = event.data?.source ?? null;
  const text = event.type === "user/message" ? messageText(event) : "";
  const checkpoint = source?.kind === "plugin"
    && source.plugin === "dsh-rewind"
    && isRewindAnchorEvent(event);
  return {
    seq: event.seq,
    time: event.time,
    type: event.type,
    text,
    turn: Number.isSafeInteger(event.data?.turn) ? event.data.turn : null,
    anchor: isRewindAnchorEvent(event),
    checkpoint: checkpoint === true
  };
}

/** 一条事件能不能当 /rewind 回退点：真用户消息，或本插件插入的 /vault 找回点。 */
function isRewindAnchorEvent(event) {
  if (event === undefined || event.type !== "user/message") return false;
  const source = event.data.source;
  if (source?.kind === "user") return true;
  const text = messageText(event);
  // ↩ /rewind 标记不是回退点；旧的 🔖 /vault、🔖 /unrewind 特殊标记也不再当回退点展示。
  if (text.startsWith("↩ /rewind") || text.startsWith("🔖 /vault") || text.startsWith("🔖 /unrewind")) return false;
  // 其余 dsh-rewind 插件消息（新 /unrewind 锚点，内容是原始用户输入）都是回退点；
  // 但硬覆盖时那个空内容的 surface 占位节点不是回退点，真正锚点是它后面那条原始输入气泡。
  return source?.kind === "plugin" && source.plugin === "dsh-rewind" && text.trim() !== "";
}

/** 当前可见 surface 上的全部回退点（时间序）。 */
function listRewindAnchors(session) {
  return session.surface.nodes
    .map((seq) => ({ seq, event: session.events[seq] }))
    .filter(({ event }) => isRewindAnchorEvent(event))
    .map(({ seq, event }) => ({
      seq,
      text: messageText(event),
      checkpoint: false
    }));
}

/**
 * 解析 /rewind <n> [--code | --conversation]。
 * 完整复刻 Claude Code /rewind 的三个恢复范围：
 *   默认 both（对话+文件）｜--conversation 只回对话｜--code 只回文件。
 */
function parseRewind(input) {
  const match = input.match(/^(\d+)(?:\s+(.*))?$/);
  if (match === null) {
    return {
      error: "用法：/rewind <编号>（编号来自 /rewind 列表，1=最新）；也可带 --code（只回文件）或 --conversation（只回对话）。"
    };
  }
  const n = Number(match[1]);
  if (!Number.isSafeInteger(n) || n < 1) {
    return { error: `编号必须是正整数，收到的是 ${match[1]}。` };
  }
  // --no-git 是早期草案的叫法，保留为 --conversation 的别名
  const aliases = {
    "--code-only": "--code",
    "--conversation-only": "--conversation",
    "--no-git": "--conversation"
  };
  const flags = (match[2] ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((f) => aliases[f] ?? f);
  const allowed = new Set(["--code", "--conversation"]);
  const unknown = flags.filter((f) => !allowed.has(f));
  if (unknown.length > 0) {
    return {
      error: `不认识的参数：${unknown.join("、")}。可用参数：--code（只回文件）、--conversation（只回对话）。`
    };
  }
  if (flags.includes("--code") && flags.includes("--conversation")) {
    return {
      error: "--code 和 --conversation 不能同时用；不加参数就是对话 + 文件一起回退。"
    };
  }
  const scope = flags.includes("--code") ? "code" : flags.includes("--conversation") ? "conversation" : "both";
  return { n, scope };
}

/**
 * S3+S4：/rewind <n> [范围] → 回到第 n 个回退点（1 = 最新）之前。
 * 与 Claude Code 一致：选中消息本身也作废，原文回显；文件按范围决定动不动。
 */
async function rewindTo(session, input) {
  const parsed = parseRewind(input);
  if (parsed.error !== undefined) {
    return { kind: "error", text: parsed.error };
  }
  const { n, scope } = parsed;

  // 先让当前模型回合跑完：回合中间做 replacement 会把后续 tool/result 变成
  // 没有前置 tool_calls 的孤儿消息，provider 直接 400，会话从此卡死。
  const settled = await waitForTurnSettle(session);
  if (!settled) {
    return { kind: "error", text: "当前回合还没结束，稍等它跑完再试 /rewind。" };
  }

  // ⑧ 找目标：surface 名单（当前可见 seq，时间序）+ 事件账本定位回退点。
  // 账本数组按绝对 seq 从 0 编号（恢复会话也是全量重放），直接 events[seq]；
  // firstLiveSeq 是本进程第一条新追加事件的 seq，不是数组下标基准（2026-08-14 撞墙）。
  const nodes = session.surface.nodes;
  const anchors = listRewindAnchors(session);
  if (n > anchors.length) {
    return {
      kind: "error",
      text: `只有 ${anchors.length} 个可回退点，没有第 ${n} 个。`
    };
  }
  const targetSeq = anchors[anchors.length - n].seq; // 1 = 最新
  const targetIdx = nodes.indexOf(targetSeq);
  const start = targetSeq; // 选中消息本身也作废：回到“发送前”
  const end = nodes[nodes.length - 1];
  const shadowedSeqs = nodes.slice(targetIdx);
  const removedPrompt = messageText(session.events[targetSeq]);

  // Restore code only：只动文件，不追加作废标记，保险柜也不用（没有消息被移除）
  if (scope === "code") {
    const fileRestore = restoreFiles(session, targetSeq);
    return {
      kind: "success",
      text: `已把文件恢复到第 ${n} 个回退点之前。对话没有动。\n文件：${fileRestore.report}`
    };
  }

  // 其余两个范围都要作废对话（--conversation 不动文件）
  const fileRestore = scope === "conversation" ? null : restoreFiles(session, targetSeq);
  const gitReport = scope === "conversation" ? "文件未动（只回对话）" : fileRestore.report;

  // ⑨ 保险柜：先存盘再作废（顺序不可反，作废了就没得存了）
  const vaultFile = saveVault(session, {
    n,
    scope,
    targetSeq,
    start,
    end,
    shadowedSeqs,
    removedPrompt,
    gitBackupFile: fileRestore?.backupFile ?? null
  });

  // ⑩ 作废标记：append 空 content 的 assistant/message replacement。
  //    deriveEventMessage 会跳过空 assistant，因此模型上下文里不会出现
  //    “↩ /rewind”、保险柜路径或任何回退字样；回执文本只存在于 command/done（log-only）。
  const replacement = session.append(
    "assistant/message",
    placeholderEventData(`rewind-${randomUUID()}`, REWIND_PLACEHOLDER_MODEL),
    {
      surfaceOp: { op: "replace", start, end },
      sourceEventSeqs: [...shadowedSeqs]
    }
  );

  return {
    kind: "success",
    text: [
      `已回退到第 ${n} 个回退点之前，该消息已从对话移除。`,
      `作废消息数：${shadowedSeqs.length}`,
      `原话（可复制重发）：${removedPrompt || "(无文字)"}`,
      `保险柜：${vaultFile}`,
      `文件：${gitReport}`
    ].join("\n"),
    sourceEventSeq: replacement.seq
  };
}

/** 读当前会话的全部保险柜备份，按时间从新到旧排。 */
function currentSessionBackups(session) {
  let files = [];
  try {
    files = readdirSync(vaultDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const rows = [];
  for (const file of files) {
    try {
      const payload = JSON.parse(readFileSync(join(vaultDir, file), "utf8"));
      if (payload.sessionId !== String(session.id)) continue;
      rows.push({ file, payload });
    } catch {
      // 读不了/不认识的备份不进当前会话列表
    }
  }
  rows.sort((a, b) => String(b.payload.at ?? "").localeCompare(String(a.payload.at ?? "")));
  return rows;
}

/**
 * S5：/unrewind（无参数）→ 只撤回上一次 /rewind，硬覆盖当前对话。
 * 顺序：
 *   ① 在当前 surface 找最新的 rewind 空 assistant 占位（兼容旧 ↩ 标记）；
 *   ② 在“改文件之前”用空 assistant 替换 [rewind 标记 .. 当前末尾]，再 append 原始输入气泡；
 *   ③ 给原始输入气泡拍 git 快照（这就是以后 /rewind 撤回本次 /unrewind 的锚点）；
 *   ④ 恢复文件；⑤ 重放保险柜消息（跳过第一段 user，因为气泡已经代表它）。
 */
function findLatestRewindMarker(session) {
  const nodes = session.surface.nodes;
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const event = session.events[nodes[i]];
    // 新格式：rewind 切面是空 assistant 占位（model=rewind-placeholder）。
    // 旧格式兼容：plugin user/message 且文本以 ↩ /rewind 开头。
    if (isDshPlaceholder(event, REWIND_PLACEHOLDER_MODEL)
      || (
        event !== undefined
        && event.type === "user/message"
        && event.data.source?.kind === "plugin"
        && event.data.source.plugin === "dsh-rewind"
        && messageText(event).startsWith("↩ /rewind")
      )) {
      return { seq: nodes[i], index: i };
    }
  }
  return null;
}

/** 生成一份可以重新 append 的消息数据：内容不变，稳定 id 全部换新。 */
function replayDataFor(event) {
  const data = JSON.parse(JSON.stringify(event.data ?? {}));
  if (event.type === "user/message") {
    data.id = `vault-replay-${randomUUID()}`;
  } else if (event.type === "assistant/message") {
    if (data.message !== undefined && typeof data.message === "object") {
      data.message = { ...data.message, id: `vault-replay-${randomUUID()}` };
    }
  } else if (event.type === "tool/result") {
    if (data.message !== undefined && typeof data.message === "object") {
      data.message = { ...data.message, id: `vault-replay-${randomUUID()}` };
    }
  }
  return data;
}

/** 取备份代表的原始用户输入文本（优先 removedPrompt，退回第一个 user/message）。 */
function backupPromptText(payload) {
  if (typeof payload.removedPrompt === "string" && payload.removedPrompt.trim() !== "") {
    return payload.removedPrompt;
  }
  const firstUser = (payload.events ?? []).find((e) => e?.type === "user/message");
  return messageText(firstUser) || "(空)";
}

async function restoreLatestRewind(session) {
  // 同 /rewind：先让当前模型回合收口，否则硬覆盖会把进行中的 tool/result 留在
  // 上下文尾部，下一次请求直接 400 卡死。
  const settled = await waitForTurnSettle(session);
  if (!settled) {
    return { kind: "error", text: "当前回合还没结束，稍等它跑完再试 /unrewind。" };
  }
  const marker = findLatestRewindMarker(session);
  if (marker === null) {
    return { kind: "error", text: "当前没有可撤回的 /rewind。" };
  }
  const backups = currentSessionBackups(session);
  if (backups.length === 0) {
    return { kind: "error", text: "保险柜里没有对应的备份。" };
  }
  const payload = backups[0].payload; // 1 = 最新一次 /rewind
  const events = Array.isArray(payload.events) ? payload.events : [];
  // 保险柜里存的是原始事件日志（含早已被更早 /rewind shadow 掉的事件），
  // 直接重放会把历史里已经不存在的消息又捞回对话框（用户看到的“只用回复X 重复”）。
  // 硬覆盖要恢复的是“这次 /rewind 当时正在 surface 上的节点”，
  // shadowedSeqs 正好就是当时被作废的 surface 节点序列，按它过滤即可（新老备份都适用）。
  const eventBySeq = new Map(events.map((event) => [event.seq, event]));
  const backupShadowedSeqs = Array.isArray(payload.shadowedSeqs) ? payload.shadowedSeqs : [];
  const visibleEvents = backupShadowedSeqs.length > 0
    ? backupShadowedSeqs.map((seq) => eventBySeq.get(seq)).filter((event) => event !== undefined)
    : events;
  if (visibleEvents.length === 0) {
    return { kind: "error", text: "这份备份里没有当时可见的消息。" };
  }

  // 硬覆盖范围：从 rewind 标记到当前 surface 末尾（含 rewind 之后新聊的内容）
  const nodes = session.surface.nodes;
  const start = marker.seq;
  const end = nodes[nodes.length - 1];
  const shadowedSeqs = nodes.slice(marker.index);
  const prompt = backupPromptText(payload);

  // ① 先替换对话（还不动文件）。
  //    DSH 聊天记录只渲染 append 的 user/message；surface replace 节点本身不会变成气泡。
  //    所以拆成两步：空 assistant 占位节点负责把 [rewind 标记 .. 当前末尾] 硬覆盖掉
  //    （deriveEventMessage 会跳过空 assistant，模型上下文仍然干净），
  //    后面再 append 一条原始用户输入气泡——对话框里看到的就是原话，不是找回点备注。
  let anchor;
  try {
    session.append(
      "assistant/message",
      placeholderEventData(`unrewind-${randomUUID()}`, UNREWIND_PLACEHOLDER_MODEL),
      {
        surfaceOp: { op: "replace", start, end },
        sourceEventSeqs: [...shadowedSeqs]
      }
    );
    anchor = session.append(
      "user/message",
      {
        id: `unrewind-${randomUUID()}`,
        role: "user",
        content: [{ type: "text", text: prompt }],
        source: { kind: "plugin", plugin: "dsh-rewind" }
      },
      { surfaceOp: "append" }
    );
    snapshotGit(session, anchor.seq); // 快照必须在文件恢复之前，且挂在真正回退点气泡上
  } catch (error) {
    return { kind: "error", text: `硬覆盖对话失败：${String(error)}` };
  }

  // ② 文件找回
  const fileReport = restoreVaultFiles(session, payload);

  // ③ 重放保险柜内容；第一段 user 已经由替换节点代表，跳过
  let replayed = 0;
  const failures = [];
  let firstUserSkipped = false;
  for (const event of visibleEvents) {
    if (event.type !== "user/message" && event.type !== "assistant/message" && event.type !== "tool/result") continue;
    if (event.type === "user/message" && !firstUserSkipped) {
      firstUserSkipped = true;
      continue;
    }
    try {
      const data = replayDataFor(event);
      session.append(event.type, data, {
        surfaceOp: "append",
        ...(Array.isArray(event.sourceEventSeqs) ? { sourceEventSeqs: event.sourceEventSeqs } : {})
      });
      replayed += 1;
    } catch (error) {
      failures.push(String(error));
    }
  }

  // ④ 计算如果后悔该敲哪个 /rewind
  const anchors = listRewindAnchors(session);
  const anchorIdx = anchors.findIndex((a) => a.seq === anchor.seq);
  const undoN = anchorIdx === -1 ? null : anchors.length - anchorIdx;

  const lines = [
    "已撤回上一次 /rewind，对话已硬覆盖。",
    `对话：重放了 ${replayed} 条消息${failures.length > 0 ? `，失败 ${failures.length} 条` : ""}`,
    `文件：${fileReport}`
  ];
  if (undoN !== null) {
    lines.push(`如果这次撤回错了，敲 /rewind ${undoN} 可以再撤回。`);
  }
  return { kind: "success", text: lines.join("\n"), sourceEventSeq: anchor.seq };
}

/** 把要作废的日志段（含选中的用户消息）原样存进保险柜，返回保险柜文件路径。 */
function saveVault(session, info) {
  mkdirSync(vaultDir, { recursive: true });
  const file = join(vaultDir, `${String(session.id)}-${Date.now()}.json`);
  const payload = {
    sessionId: String(session.id),
    at: new Date().toISOString(),
    scope: info.scope,
    rewindTo: info.n,
    targetSeq: info.targetSeq,
    removedPrompt: info.removedPrompt,
    shadowedRange: { start: info.start, end: info.end },
    shadowedSeqs: info.shadowedSeqs,
    gitBackupFile: info.gitBackupFile,
    // 账本按绝对 seq 编号，直接 slice（同 ⑧ 的教训，勿用 firstLiveSeq 当偏移）
    events: session.events.slice(info.start, info.end + 1)
  };
  writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

/** 在 cwd 下跑一条 git 命令并返回输出；失败（非仓库等）返回 null。 */
function gitOutput(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"] // 非 git 仓库时别把 git 的 fatal 漏进 DSH 日志
    }).trim();
  } catch {
    return null;
  }
}

/**
 * 自动初始化：cwd 不是 git 仓库或还没有 HEAD 时，创建仓库并把当前文件
 * 做成一次 baseline commit。之后 /rewind 才可能回退文件。
 * 已经是正常 git 仓库（有 HEAD）时不做任何事，绝不改动用户现有仓库。
 */
function ensureGitBaseline(cwd) {
  if (typeof cwd !== "string" || cwd === "") return false;
  if (gitOutput(cwd, ["rev-parse", "HEAD"]) !== null) return true;
  // 有 .git 但还没有 commit（unborn branch）→ 不要重复 init
  if (gitOutput(cwd, ["rev-parse", "--show-toplevel"]) === null) {
    if (gitOutput(cwd, ["init"]) === null) return false;
  }
  if (gitOutput(cwd, ["add", "-A"]) === null) return false;
  const commit = gitOutput(cwd, [
    "-c", "user.name=dsh-rewind",
    "-c", "user.email=dsh-rewind@local",
    "commit", "--allow-empty", "-m", "dsh-rewind baseline"
  ]);
  if (commit === null) return false;
  return gitOutput(cwd, ["rev-parse", "HEAD"]) !== null;
}

/** 读某会话的 git 快照账本（不存在/损坏 → 空数组）。 */
function readLedger(sessionId) {
  try {
    const parsed = JSON.parse(readFileSync(join(gitLedgerDir, `${String(sessionId)}.json`), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 给一个事件 seq 拍 git 时刻照（HEAD + 未提交改动）。 */
function snapshotGit(session, seq) {
  const cwd = session.header?.cwd;
  if (typeof cwd !== "string" || cwd === "") return;
  const head = gitOutput(cwd, ["rev-parse", "HEAD"]);
  if (head === null) return; // 不是 git 仓库：只回对话，文件部分安静跳过
  const stashRaw = gitOutput(cwd, ["stash", "create"]);
  const entry = {
    seq,
    time: Date.now(),
    head,
    stash: stashRaw === "" ? null : stashRaw
  };
  mkdirSync(gitLedgerDir, { recursive: true });
  const ledger = readLedger(session.id);
  ledger.push(entry);
  writeFileSync(join(gitLedgerDir, `${String(session.id)}.json`), JSON.stringify(ledger, null, 2), "utf8");
}

/**
 * S4 执行：把文件恢复到目标回退点之前的状态。
 * 顺序 = 先备份当前（stash create + 存盘），再 reset --hard 目标 HEAD，最后 apply 目标 stash。
 * @returns { report, backupFile } —— report 给用户看；backupFile 供 /vault 找回文件用。
 */
function restoreFiles(session, targetSeq) {
  const cwd = session.header?.cwd;
  if (typeof cwd !== "string" || cwd === "") return { report: "工作目录未知，文件未动", backupFile: null };
  if (gitOutput(cwd, ["rev-parse", "HEAD"]) === null) return { report: "不是 git 仓库，文件未动", backupFile: null };
  const entry = readLedger(session.id).findLast((e) => e.seq === targetSeq);
  if (entry === undefined) {
    return { report: "快照账本未覆盖到目标消息（可能早于插件安装），文件未动", backupFile: null };
  }

  // 先备份当前文件状态（先备份后动刀，S3 已学）
  const currentHead = gitOutput(cwd, ["rev-parse", "HEAD"]);
  const currentStashRaw = gitOutput(cwd, ["stash", "create"]);
  const backup = {
    sessionId: String(session.id),
    at: new Date().toISOString(),
    targetSeq,
    current: { head: currentHead, stash: currentStashRaw === "" ? null : currentStashRaw },
    restoredTo: { head: entry.head, stash: entry.stash }
  };
  const backupFile = join(gitLedgerDir, `${String(session.id)}-backup-${Date.now()}.json`);
  writeFileSync(backupFile, JSON.stringify(backup, null, 2), "utf8");

  // 动刀：回到目标 HEAD，再铺回目标时刻未提交的改动
  const resetOut = gitOutput(cwd, ["reset", "--hard", entry.head]);
  if (resetOut === null) return { report: `reset 到目标 HEAD ${entry.head.slice(0, 7)} 失败，文件未动`, backupFile };
  let note = "";
  if (entry.stash !== null) {
    const applied = gitOutput(cwd, ["stash", "apply", entry.stash]);
    note = applied === null ? "；当时未提交的改动铺回失败" : "；已铺回当时的未提交改动";
  }
  return {
    report: `文件已恢复到该消息发送前（HEAD ${entry.head.slice(0, 7)}${note}）。文件备份：${backupFile}`,
    backupFile
  };
}

/** S5 执行：按保险柜里记录的 git 备份，把文件恢复到回退之前。 */
function restoreVaultFiles(session, payload) {
  if (typeof payload.gitBackupFile !== "string" || payload.gitBackupFile === "") {
    return "这份备份没有文件状态，文件未动";
  }
  let backup;
  try {
    backup = JSON.parse(readFileSync(payload.gitBackupFile, "utf8"));
  } catch {
    return "文件备份读不到，文件未动";
  }
  const target = backup.current;
  if (target === undefined || typeof target.head !== "string" || target.head === "") {
    return "文件备份内容不完整，文件未动";
  }
  const cwd = session.header?.cwd;
  if (typeof cwd !== "string" || cwd === "") return "工作目录未知，文件未动";
  if (gitOutput(cwd, ["rev-parse", "HEAD"]) === null) return "不是 git 仓库，文件未动";
  const resetOut = gitOutput(cwd, ["reset", "--hard", target.head]);
  if (resetOut === null) return `reset 到备份 HEAD ${target.head.slice(0, 7)} 失败，文件未动`;
  let note = "";
  if (typeof target.stash === "string" && target.stash !== "") {
    const applied = gitOutput(cwd, ["stash", "apply", target.stash]);
    note = applied === null ? "；回退前未提交的改动铺回失败" : "；已铺回回退前的未提交改动";
  }
  return `文件已恢复到回退前（HEAD ${target.head.slice(0, 7)}${note}）`;
}

// 三件套交付出口 —— DSH 认的就是这三个
export { apply, inject, name };
