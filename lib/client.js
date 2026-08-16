window.__ModuleLoader__.load({
  id: "dsh-rewind",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require("react");

    function anchorText(node) {
      const content = node && node.content;
      if (!Array.isArray(content)) return "";
      return content
        .filter((b) => b && b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
    }

    function preview(text) {
      return text.length > 60 ? text.slice(0, 60) + "…" : text;
    }

    function timeLabel(time) {
      const d = new Date(time || 0);
      const pad = (n) => String(n).padStart(2, "0");
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    const inject = ["commandUi", "sessions", "slots", "conversation", "conversationEvents"];

    let turnTailStyleEl = null;
    function syncTurnTailStyle(turns) {
      if (typeof document === "undefined") return;
      if (turnTailStyleEl === null) {
        turnTailStyleEl = document.createElement("style");
        turnTailStyleEl.setAttribute("data-dsh-rewind-hide", "turn-tail");
        document.head.appendChild(turnTailStyleEl);
      }
      const rules = (turns ?? [])
        .filter((turn) => Number.isSafeInteger(turn))
        .map((turn) => `[data-turn-tail="${turn}"]{display:none !important;}`)
        .join("\n");
      turnTailStyleEl.textContent = rules;
    }

    function shouldHideOwnNode(el) {
      const kind = el.getAttribute("data-chat-flow-kind");
      const text = (el.textContent || "").trim();
      if (kind === "command") {
        return /^(rewind|unrewind|vault)/.test(text)
          || text.includes("已回退到")
          || text.includes("已找回备份")
          || (text.startsWith("Failed") && /rewind|unrewind|vault/.test(text))
          || (text.startsWith("Command") && (text.includes("已回退到") || text.includes("已找回备份")));
      }
      if (kind === "context") return text.includes("dsh-rewind");
      if (kind === "user") {
        return text.startsWith("↩ /rewind")
          || text.startsWith("🔖 /unrewind")
          || text.startsWith("🔖 /vault");
      }
      return false;
    }

    // tool-call 内置组件带 renderSlot 子槽，不能用包装器；改用 DOM 清扫：
    // 外层 flow 的 data-chat-anchor-key 形如 "9:tool-callcall_..."，前缀就是 anchorSeq。
    function currentShadowedRanges(sessions) {
    try {
      const current = sessions.list?.getSnapshot?.()?.current;
      if (current === undefined) return [];
      const live = sessions.binding?.(current)?.session;
      const face = live?.projections?.faceOf?.("rewindAnchors");
      const value = face?.getSnapshot?.();
      return Array.isArray(value?.shadowedRanges) ? value.shadowedRanges : [];
    } catch {
      return [];
    }
  }

  function sweepShadowedToolCalls(sessions) {
    if (typeof document === "undefined") return;
    const ranges = currentShadowedRanges(sessions);
    for (const el of document.querySelectorAll('[data-chat-flow-kind="tool-call"]')) {
      const key = el.getAttribute("data-chat-anchor-key") ?? el.getAttribute("data-chat-flow-key") ?? "";
      const match = /^(\d+):/.exec(key);
      const seq = match === null ? null : Number(match[1]);
      const shadowed = seq !== null && ranges.some((range) => seq >= range.start && seq <= range.end);
      if (shadowed && el.style.display !== "none") {
        el.style.display = "none";
      } else if (!shadowed && el.style.display === "none") {
        el.style.display = "";
      }
    }
  }

  function sweepOwnNodes(sessions) {
    if (typeof document === "undefined") return;
    for (const el of document.querySelectorAll("[data-chat-flow-kind]")) {
      if (shouldHideOwnNode(el)) {
        if (el.style.display !== "none") el.style.display = "none";
      }
    }
    sweepShadowedToolCalls(sessions);
  }

  function installOwnNodeSweeper(sessions) {
    if (typeof document === "undefined") return;
    sweepOwnNodes(sessions);
    new MutationObserver(() => sweepOwnNodes(sessions)).observe(document.body, { childList: true, subtree: true });
    setInterval(() => sweepOwnNodes(sessions), 1000);
  }

    /**
   * instruction-hint 插件用「会话级固定 id」注入 workspace 提示；
   * rewind 把它 shadow 掉之后，下一回合它又用同一个 id 再注入一次。
   * 原始日志里就出现多个同 id 的 start Match，conversation 装配器直接
   * 抛 "received more than one start Match"，整个会话历史都加载不出来。
   * 这里给每个 instruction-hint 事件的 match id 拼上 seq，让它唯一。
   */
  const patchedInstructionHintDefinitions = new WeakSet();
  function patchInstructionHintDedup(conversationEvents) {
    if (conversationEvents?.entries === undefined) return;
    for (const definition of conversationEvents.entries()) {
      if (definition.kind !== "input-message" || patchedInstructionHintDefinitions.has(definition)) continue;
      const originalMatch = definition.match;
      if (typeof originalMatch !== "function") continue;
      definition.match = (event) => {
        const result = originalMatch(event);
        if (result !== null
          && event?.type === "user/message"
          && event.data?.source?.kind === "instruction-hint") {
          return { ...result, id: `${result.id}@${event.seq}` };
        }
        return result;
      };
      patchedInstructionHintDefinitions.add(definition);
    }
  }

  function apply(ctx) {
      const commandUi = ctx.get("commandUi");
      const sessions = ctx.sessions;
      const slots = ctx.slots;

      // 先修补 instruction-hint 重复 id 造成的会话历史加载崩溃；定义可能晚到，订阅一次。
      const conversationEvents = ctx.get("conversationEvents") ?? ctx.conversationEvents;
      if (conversationEvents?.subscribe !== undefined) {
        const patch = () => patchInstructionHintDedup(conversationEvents);
        patch();
        const unsubscribe = conversationEvents.subscribe(patch);
        ctx.effect(() => unsubscribe);
      }

      const prefillRewindPrompt = (sessionId, prompt) => {
        if (typeof prompt !== "string" || prompt.trim() === "") return;
        const text = prompt.trim();
        // 等命令提交事务清空输入框后再写入
        setTimeout(() => {
          try {
            const conversation = ctx.get("conversation") ?? ctx.conversation;
            const shell = conversation?.input?.shell?.(sessionId);
            if (shell?.setDraft !== undefined) shell.setDraft(text);
            else console.warn("dsh-rewind: no input shell for prefill");
          } catch (error) {
            console.warn("dsh-rewind: setDraft failed", error);
          }
          // 回退完成后光标回到输入框
          const textarea = document.querySelector("textarea");
          textarea?.focus();
        }, 100);
      };

      // /rewind 弹层：每次打开读宿主投影 rewindAnchors，回退后列表跟着当前 surface 更新
      // 命令回执卡 / 系统节点清理：rewind、unrewind 的回执不要留在对话框
      installOwnNodeSweeper(sessions);

      // Claude Code 行为：/rewind 成功后，把被回退的用户原话填回输入框
      ctx.on("command/executed", (sessionId, name, result) => {
        if (name === "rewind" && result.kind === "success") {
          const match = String(result.text ?? "").match(/原话（可复制重发）：([^\n]+)/);
          if (match !== null) prefillRewindPrompt(sessionId, match[1]);
        }
        setTimeout(() => sweepOwnNodes(sessions), 0);
        setTimeout(() => sweepOwnNodes(sessions), 300);
      });

      ctx.effect(() => commandUi.decorate({
        name: "rewind",
        available: (sessionCtx) => sessions.binding(sessionCtx.sessionId)?.session !== undefined,
        ui: {
          kind: "popupSelect",
          options: async (sessionCtx) => {
            const live = sessions.binding(sessionCtx.sessionId)?.session;
            if (live === undefined) return [];
            const face = live.projections?.faceOf?.("rewindAnchors");
            const value = face?.getSnapshot?.();
            const anchors = Array.isArray(value?.anchors) ? value.anchors : [];
            return anchors.map((a) => ({
              id: String(a.n),
              label: `${a.n}. ${preview(a.text || "")}`,
              detail: timeLabel(a.time),
              prompt: a.text || ""
            }));
          },
          onSelect: async (option, sessionCtx) => {
            const live = sessions.binding(sessionCtx.sessionId)?.session;
            if (live === undefined) throw new Error("当前会话还没有完全打开，稍后再试");
            // 必须在执行前记住选中项：rewind 成功后投影会变，按编号回查会拿到“前一条”，提前一格。
            const face = live.projections?.faceOf?.("rewindAnchors");
            const before = face?.getSnapshot?.();
            const anchorBefore = Array.isArray(before?.anchors)
              ? before.anchors.find((a) => String(a.n) === String(option.id))
              : undefined;
            const selectedPrompt = option.prompt || anchorBefore?.text || "";

            const result = await live.command(`/rewind ${option.id}`);
            if (!result.ok) {
              throw new Error(`执行 /rewind 失败：${result.error.code}: ${result.error.message}`);
            }
            if (!result.value.matched) {
              throw new Error("宿主没有 /rewind 命令，弹层不能用");
            }
            // 弹层选择走的是 Session.command，不会发 command/executed，所以要在这里补一次自动填入。
            prefillRewindPrompt(sessionCtx.sessionId, selectedPrompt);
          }
        }
      }), "dsh-rewind: /rewind popup decoration");

      // 用低优先级 shadow 掉没有子槽依赖的内置聊天节点。
      // command / turn-tail / tool-call 的内置组件需要 renderSlot(Chain) 注入，
      // 包装器拿不到这些注入 props，强行委托会 crash 并被 slot 系统踢回内置实现。
      // 所以这三个 key 不走包装器；turn-tail 残留用全局 CSS 按 data-turn-tail 隐藏。
      const builtinFor = (key) => {
        const entries = slots.entries("conversation.chat.node");
        const entry = entries.find((e) => e.options?.key === key && (e.options?.priority ?? 0) === 0);
        return entry?.component ?? null;
      };

      function isPlainRewindAnchor(node) {
        const source = node?.data?.source ?? node?.source ?? null;
        if (source?.kind !== "plugin" || source.plugin !== "dsh-rewind") return false;
        const text = anchorText(node?.data ?? node);
        return text !== ""
          && !text.startsWith("↩ /rewind")
          && !text.startsWith("🔖 /vault")
          && !text.startsWith("🔖 /unrewind");
      }

      function makeRewindNodeView(key) {
        return react.memo(function RewindNodeView(props) {
          // /unrewind 的锚点是 append 的 plugin user/message，宿主路由成 context 气泡；
          // 借 user 渲染器画成普通用户气泡，对话框里显示原始输入，不显示“找回点”样式。
          const renderKey = key === "context" && isPlainRewindAnchor(props.node) ? "user" : key;
          const [builtin, setBuiltin] = react.useState(() => builtinFor(renderKey));
          react.useEffect(() => {
            if (builtin === null) setBuiltin(builtinFor(renderKey));
          }, [builtin, renderKey]);

          const ranges = props.useProjection("rewindAnchors", (value) => (
            Array.isArray(value?.shadowedRanges) ? value.shadowedRanges : null
          ));
          const turns = props.useProjection("rewindAnchors", (value) => (
            Array.isArray(value?.shadowedTurns) ? value.shadowedTurns : null
          ));

          // 顺便维护 turn-tail 的 CSS 隐藏规则：command/turn-tail/tool-call 不归这个包装器管
          react.useEffect(() => {
            syncTurnTailStyle(turns ?? []);
            return () => {
              if (turnTailStyleEl !== null) turnTailStyleEl.textContent = "";
            };
          }, [turns]);

          const seq = props.node?.anchorSeq ?? props.node?.data?.seq ?? null;
          const turn = props.node?.data?.turn ?? null;
          const shadowedBySeq = ranges !== null && seq !== null
            && ranges.some((range) => seq >= range.start && seq <= range.end);
          const shadowedByTurn = turns !== null && turn !== null
            && turns.includes(turn);
          if (shadowedBySeq || shadowedByTurn || builtin === null) return null;
          return react.createElement(builtin, props);
        });
      }

      // 只包那些直接委托不会 crash 的 key
      const NODE_KEYS = [
        "user", "steering", "context", "assistant-step",
        "manual-compaction", "compaction", "model-retry", "turn-error",
        "turn-max-tokens", "unknown"
      ];

      ctx.effect(() => {
        const disposers = NODE_KEYS.map((key) => slots.inject(
          "conversation.chat.node",
          () => slots.register({
            name: "conversation.chat.node",
            key,
            priority: -1,
            locale: "conversation"
          }, makeRewindNodeView(key))
        ));
        return () => {
          for (const dispose of disposers) dispose();
        };
      }, "dsh-rewind: shadowed-node renderers");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
