/* ZCode composer predictions overlay.
 *
 * Injected into the ZCode renderer by inject-main.cjs.  It is intentionally
 * self-contained: no imports, no build step, no host API beyond the DOM.
 *
 * Responsibilities:
 *   - draw a ghost suggestion on the empty Lexical composer;
 *   - accept with Tab (insert through Lexical-compatible input events);
 *   - dismiss with Esc, typing, session switch, or when disabled;
 *   - expose a tiny control surface to the main process:
 *       window.__zcpShowSuggestion({text, sessionId, messageId, ...})
 *       window.__zcpClear()
 *       window.__zcpSetSession(sessionId)
 *       window.__zcpShouldPredict()
 *       window.__zcpStatus()
 */
(function () {
  "use strict";

  var VERSION = "0.1.4";
  var ENABLED_KEY = "zcp.enabled";
  var DEBUG_KEY = "zcp.debug";
  var ZH = /^zh/i.test(navigator.language || "");

  if (window.__zcpOverlay && typeof window.__zcpOverlay.dispose === "function") {
    try {
      window.__zcpOverlay.dispose();
    } catch (e) {}
  }

  var state = {
    text: "",
    sessionId: "",
    messageId: "",
    model: "",
    latencyMs: 0,
    composing: false,
    placeholderEl: null,
    placeholderPrev: "",
    editorMinHeight: "",
    panelOpen: false,
    // Model picker: providers arrive from the main process, the choice is
    // read back by it every 2s and persisted to config.json.
    providers: [],
    choice: { providerId: "", modelId: "" },
    choiceReady: false,
    modelsTimedOut: false,
    // Set when the panel opens so the main process re-reads provider config;
    // cleared once a fresh list arrives.
    modelsDirty: false,
  };

  var els = {};
  var abort = new AbortController();
  var signal = abort.signal;
  var renderTimer = 0;

  function log() {
    if (!isDebug()) return;
    try {
      console.debug.apply(console, ["[zcp]"].concat(Array.prototype.slice.call(arguments)));
    } catch (e) {}
  }

  function storageGet(key, fallback) {
    try {
      var value = localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (e) {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {}
  }

  function isEnabled() {
    return storageGet(ENABLED_KEY, "1") !== "0";
  }

  function isDebug() {
    return storageGet(DEBUG_KEY, "0") === "1";
  }

  function t(zh, en) {
    return ZH ? zh : en;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 8) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.01;
  }

  function editorText(editor) {
    if (!editor) return "";
    var value = editor.innerText || editor.textContent || "";
    return value.replace(/\u200b/g, "").replace(/\u00a0/g, " ").trim();
  }

  function isEditorEmpty(editor) {
    return editorText(editor).length === 0;
  }

  function isEditorFocused(editor) {
    if (!editor) return false;
    var active = document.activeElement;
    return active === editor || editor.contains(active);
  }

  function findEditor() {
    var all = Array.prototype.slice.call(
      document.querySelectorAll('[data-lexical-editor="true"]')
    );
    all = all.filter(function (el) {
      return isVisible(el) && el.getAttribute("contenteditable") !== "false";
    });
    if (!all.length) return null;

    // A focused composer (for example a side chat) wins over the main one.
    for (var i = 0; i < all.length; i++) {
      if (isEditorFocused(all[i])) return all[i];
    }

    var docked = all.filter(function (el) {
      return !!el.closest('[data-v4-composer-dock="true"]');
    });
    var pool = docked.length ? docked : all;
    pool.sort(function (a, b) {
      return b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom;
    });
    return pool[0];
  }

  function findPlaceholder(editor) {
    if (!editor) return null;
    var text = (editor.getAttribute("aria-placeholder") || "").trim();
    if (!text) return null;
    var parent = editor.parentElement;
    if (!parent) return null;

    var children = Array.prototype.slice.call(parent.children);
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (child === editor) continue;
      if ((child.textContent || "").trim() === text) return child;
    }

    var candidates = Array.prototype.slice.call(
      parent.querySelectorAll('[class*="pointer-events-none"]')
    );
    for (var j = 0; j < candidates.length; j++) {
      if ((candidates[j].textContent || "").trim() === text) return candidates[j];
    }
    return null;
  }

  function hidePlaceholder(editor) {
    var el = findPlaceholder(editor);
    if (!el) return;
    if (state.placeholderEl !== el) {
      restorePlaceholder();
      state.placeholderEl = el;
      state.placeholderPrev = el.style.visibility;
    }
    el.style.visibility = "hidden";
  }

  function restorePlaceholder() {
    if (!state.placeholderEl) return;
    try {
      state.placeholderEl.style.visibility = state.placeholderPrev;
    } catch (e) {}
    state.placeholderEl = null;
    state.placeholderPrev = "";
  }

  function restoreEditorHeight(editor) {
    if (!editor) return;
    if (state.editorMinHeight !== "") {
      try {
        editor.style.minHeight = state.editorMinHeight;
      } catch (e) {}
      state.editorMinHeight = "";
    }
  }

  function ensureUI() {
    if (els.ghost && els.ghost.isConnected) return;

    els.ghost = document.createElement("div");
    els.ghost.id = "zcp-ghost";
    els.ghost.setAttribute("aria-hidden", "true");
    els.ghost.style.cssText = [
      "position:fixed",
      "z-index:2147483000",
      "pointer-events:none",
      "user-select:none",
      "white-space:pre-wrap",
      "word-break:break-word",
      "overflow:hidden",
      "opacity:0",
      "transition:opacity .12s ease",
      "color:var(--color-text-ghost,#a3a3a3)",
    ].join(";");

    els.hint = document.createElement("div");
    els.hint.id = "zcp-hint";
    els.hint.setAttribute("aria-hidden", "true");
    els.hint.style.cssText = [
      "position:fixed",
      "z-index:2147483001",
      "pointer-events:none",
      "user-select:none",
      "font:11px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif",
      "color:var(--color-text-ghost,#9ca3af)",
      "background:color-mix(in srgb, var(--color-background,#808080) 82%, transparent)",
      "border:1px solid color-mix(in srgb, var(--color-border,#808080) 55%, transparent)",
      "padding:1px 6px",
      "border-radius:5px",
      "opacity:0",
      "transition:opacity .12s ease",
    ].join(";");

    els.button = document.createElement("button");
    els.button.id = "zcp-settings-button";
    els.button.type = "button";
    els.button.textContent = "\u2726";
    els.button.title = t("输入预测设置", "Composer predictions settings");
    els.button.style.cssText = [
      "position:fixed",
      "right:12px",
      "bottom:12px",
      "z-index:2147483002",
      "width:22px",
      "height:22px",
      "padding:0",
      "border:0",
      "border-radius:50%",
      "background:color-mix(in srgb, var(--color-background,#808080) 70%, transparent)",
      "color:var(--color-text-ghost,#888)",
      "font:12px/22px system-ui,sans-serif",
      "cursor:pointer",
      "opacity:.32",
      "transition:opacity .15s ease",
      "display:none",
    ].join(";");
    els.button.addEventListener(
      "mouseenter",
      function () {
        els.button.style.opacity = "1";
      },
      { signal: signal }
    );
    els.button.addEventListener(
      "mouseleave",
      function () {
        els.button.style.opacity = ".32";
      },
      { signal: signal }
    );

    els.panel = document.createElement("div");
    els.panel.id = "zcp-settings-panel";
    els.panel.style.cssText = [
      "position:fixed",
      "right:12px",
      "bottom:40px",
      "z-index:2147483003",
      "display:none",
      "min-width:250px",
      "max-width:300px",
      "max-height:min(70vh,460px)",
      "overflow-y:auto",
      "padding:10px 12px",
      "border-radius:10px",
      "border:1px solid var(--color-border,rgba(127,127,127,.35))",
      "background:var(--color-background,#1f1f1f)",
      "color:var(--color-foreground,#eee)",
      "font:12px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif",
      "box-shadow:0 8px 28px rgba(0,0,0,.28)",
    ].join(";");

    var title = document.createElement("div");
    title.textContent = t("输入预测", "Composer predictions");
    title.style.cssText = "font-weight:600;margin-bottom:6px";
    els.panel.appendChild(title);

    var label = document.createElement("label");
    label.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer";
    els.check = document.createElement("input");
    els.check.type = "checkbox";
    els.check.checked = isEnabled();
    label.appendChild(els.check);
    label.appendChild(
      document.createTextNode(t("启用建议", "Enable suggestions"))
    );
    els.panel.appendChild(label);

    var debugLabel = document.createElement("label");
    debugLabel.style.cssText =
      "display:flex;align-items:center;gap:6px;cursor:pointer;margin-top:4px;opacity:.75";
    els.debugCheck = document.createElement("input");
    els.debugCheck.type = "checkbox";
    els.debugCheck.checked = isDebug();
    debugLabel.appendChild(els.debugCheck);
    debugLabel.appendChild(
      document.createTextNode(t("显示调试信息", "Show debug info"))
    );
    els.panel.appendChild(debugLabel);

    var modelLabel = document.createElement("div");
    modelLabel.textContent = t("预测模型", "Prediction model");
    modelLabel.style.cssText = "margin-top:8px;opacity:.75;font-size:11px";
    els.panel.appendChild(modelLabel);

    els.modelSelect = document.createElement("select");
    els.modelSelect.style.cssText =
      "width:100%;margin-top:2px;font:inherit;font-size:11px;padding:2px 4px;border-radius:6px;" +
      "border:1px solid var(--color-border,rgba(127,127,127,.35));" +
      "background:var(--color-background,#1f1f1f);color:var(--color-foreground,#eee)";
    els.panel.appendChild(els.modelSelect);

    els.customRow = document.createElement("div");
    els.customRow.style.cssText = "display:none;gap:4px;margin-top:4px";
    els.customProvider = document.createElement("select");
    els.customProvider.style.cssText =
      "flex:1 1 45%;min-width:0;font:inherit;font-size:11px;padding:2px;border-radius:6px;" +
      "border:1px solid var(--color-border,rgba(127,127,127,.35));" +
      "background:var(--color-background,#1f1f1f);color:var(--color-foreground,#eee)";
    els.customModel = document.createElement("input");
    els.customModel.type = "text";
    els.customModel.placeholder = t("模型 id", "model id");
    els.customModel.style.cssText =
      "flex:1 1 55%;min-width:0;font:inherit;font-size:11px;padding:2px 4px;border-radius:6px;" +
      "border:1px solid var(--color-border,rgba(127,127,127,.35));" +
      "background:var(--color-background,#1f1f1f);color:var(--color-foreground,#eee)";
    els.customRow.appendChild(els.customProvider);
    els.customRow.appendChild(els.customModel);
    els.panel.appendChild(els.customRow);

    els.status = document.createElement("div");
    els.status.style.cssText =
      "margin-top:7px;padding-top:7px;border-top:1px solid var(--color-border,rgba(127,127,127,.25));opacity:.65;font-size:11px;white-space:pre-wrap";
    els.panel.appendChild(els.status);

    els.live = document.createElement("div");
    els.live.setAttribute("aria-live", "polite");
    els.live.style.cssText =
      "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap";
    document.body.appendChild(els.live);

    document.body.appendChild(els.ghost);
    document.body.appendChild(els.hint);
    document.body.appendChild(els.button);
    document.body.appendChild(els.panel);

    els.check.addEventListener(
      "change",
      function () {
        storageSet(ENABLED_KEY, els.check.checked ? "1" : "0");
        updateStatus();
        if (!els.check.checked) clearSuggestion("disabled");
        render();
      },
      { signal: signal }
    );
    els.debugCheck.addEventListener(
      "change",
      function () {
        storageSet(DEBUG_KEY, els.debugCheck.checked ? "1" : "0");
        updateStatus();
        render();
      },
      { signal: signal }
    );

    els.modelSelect.addEventListener(
      "change",
      function () {
        var value = els.modelSelect.value;
        if (!value) {
          els.customRow.style.display = "none";
          setChoice("", "");
          return;
        }
        if (value === "__custom__") {
          els.customRow.style.display = "flex";
          if (!els.customProvider.value && state.providers.length) {
            els.customProvider.value =
              state.choice.providerId || state.providers[0].providerId;
          }
          applyCustomChoice();
          return;
        }
        els.customRow.style.display = "none";
        var pair = null;
        try {
          pair = JSON.parse(value);
        } catch (e) {
          pair = null;
        }
        if (pair && pair.length === 2) setChoice(pair[0], pair[1]);
      },
      { signal: signal }
    );
    els.customProvider.addEventListener("change", applyCustomChoice, { signal: signal });
    els.customModel.addEventListener("input", applyCustomChoice, { signal: signal });
    els.button.addEventListener(
      "click",
      function (event) {
        event.preventDefault();
        event.stopPropagation();
        state.panelOpen = !state.panelOpen;
        els.panel.style.display = state.panelOpen ? "block" : "none";
        // Providers may have been added in ZCode since startup; ask the main
        // process for a fresh list (it polls this flag every 2s).
        if (state.panelOpen) state.modelsDirty = true;
        updateStatus();
      },
      { signal: signal }
    );
    els.panel.addEventListener(
      "click",
      function (event) {
        event.stopPropagation();
      },
      { signal: signal }
    );
    document.addEventListener(
      "click",
      function () {
        if (!state.panelOpen) return;
        state.panelOpen = false;
        els.panel.style.display = "none";
      },
      { signal: signal }
    );

    buildModelOptions();
    updateStatus();

    // If the main process never sends the provider list (for example an older
    // inject-main still running after an overlay hot reload), say so instead
    // of showing an empty picker:
    setTimeout(function () {
      if (state.choiceReady) return;
      state.modelsTimedOut = true;
      updateStatus();
    }, 12000);
  }

  function modelValue(providerId, modelId) {
    return JSON.stringify([providerId || "", modelId || ""]);
  }

  function setChoice(providerId, modelId) {
    state.choice = { providerId: providerId || "", modelId: modelId || "" };
    updateStatus();
  }

  function applyCustomChoice() {
    setChoice(els.customProvider.value || "", (els.customModel.value || "").trim());
  }

  function fillCustomProviders() {
    if (!els.customProvider) return;
    els.customProvider.textContent = "";
    state.providers.forEach(function (provider) {
      var option = document.createElement("option");
      option.value = provider.providerId;
      option.textContent = provider.providerName || provider.providerId;
      els.customProvider.appendChild(option);
    });
  }

  function syncModelControls() {
    if (!els.modelSelect) return;
    var choice = state.choice || { providerId: "", modelId: "" };
    if (!choice.providerId && !choice.modelId) {
      els.modelSelect.value = "";
      els.customRow.style.display = "none";
      return;
    }
    var wanted = modelValue(choice.providerId, choice.modelId);
    var matched = false;
    for (var i = 0; i < els.modelSelect.options.length; i++) {
      if (els.modelSelect.options[i].value === wanted) {
        matched = true;
        break;
      }
    }
    if (matched) {
      els.modelSelect.value = wanted;
      els.customRow.style.display = "none";
      return;
    }
    // Not in the list: keep it as a custom provider/model pair.
    els.modelSelect.value = "__custom__";
    els.customRow.style.display = "flex";
    if (choice.providerId) els.customProvider.value = choice.providerId;
    els.customModel.value = choice.modelId || "";
  }

  function buildModelOptions() {
    if (!els.modelSelect) return;
    els.modelSelect.textContent = "";

    var follow = document.createElement("option");
    follow.value = "";
    follow.textContent = t("跟随会话模型（默认）", "Follow session model (default)");
    els.modelSelect.appendChild(follow);

    state.providers.forEach(function (provider) {
      var models = provider.modelIds || [];
      if (!models.length) return;
      var group = document.createElement("optgroup");
      group.label = provider.providerName || provider.providerId;
      models.forEach(function (modelId) {
        var option = document.createElement("option");
        option.value = modelValue(provider.providerId, modelId);
        option.textContent = modelId;
        group.appendChild(option);
      });
      els.modelSelect.appendChild(group);
    });

    var custom = document.createElement("option");
    custom.value = "__custom__";
    custom.textContent = t("自定义…", "Custom…");
    els.modelSelect.appendChild(custom);

    fillCustomProviders();
    syncModelControls();
  }

  function setModelOptions(payload) {
    if (!payload || typeof payload !== "object") return;
    var providers = Array.isArray(payload.providers) ? payload.providers : [];
    var firstLoad = !state.choiceReady;
    var pendingRefresh = state.modelsDirty;
    state.providers = providers.filter(function (provider) {
      return provider && provider.providerId;
    });
    var current = payload.current || {};
    // A refresh triggered by opening the panel must not overwrite a selection
    // the user made in the meantime; only adopt the config value otherwise.
    if (firstLoad || !pendingRefresh) {
      state.choice = {
        providerId: typeof current.providerId === "string" ? current.providerId : "",
        modelId: typeof current.modelId === "string" ? current.modelId : "",
      };
    }
    state.choiceReady = true;
    state.modelsDirty = false;
    buildModelOptions();
    updateStatus();
  }

  function getModelChoice() {
    return {
      ready: state.choiceReady,
      providerId: (state.choice && state.choice.providerId) || "",
      modelId: (state.choice && state.choice.modelId) || "",
      wantRefresh: state.modelsDirty,
    };
  }

  function providerLabel(providerId) {
    for (var i = 0; i < state.providers.length; i++) {
      if (state.providers[i].providerId === providerId) {
        return state.providers[i].providerName || providerId;
      }
    }
    return providerId;
  }

  function updateStatus() {
    if (!els.status) return;
    var parts = [];
    parts.push(isEnabled() ? t("状态：已启用", "Status: enabled") : t("状态：已关闭", "Status: disabled"));
    if (state.sessionId) parts.push("session: " + state.sessionId.slice(0, 18));
    var choice = state.choice || {};
    if (!state.choiceReady) {
      parts.push(
        state.modelsTimedOut
          ? t("模型列表未就绪：请完整重启 ZCode", "model list unavailable: fully restart ZCode")
          : t("模型列表加载中…", "loading model list…")
      );
    } else if (choice.providerId) {
      parts.push(
        t("模型：", "model: ") +
          providerLabel(choice.providerId) +
          " / " +
          (choice.modelId || t("会话模型", "session model"))
      );
    } else {
      parts.push(t("模型：跟随会话", "model: follow session"));
    }
    if (isDebug() && state.text) {
      parts.push("used: " + (state.model || "?"));
      parts.push("latency: " + state.latencyMs + "ms");
    }
    els.status.textContent = parts.join("\n");
  }

  function setGhostVisible(visible) {
    if (els.ghost) els.ghost.style.opacity = visible ? "1" : "0";
    if (els.hint) els.hint.style.opacity = visible ? "1" : "0";
  }

  function render() {
    var editor = findEditor();
    if (!editor) {
      setGhostVisible(false);
      restorePlaceholder();
      if (els.button) els.button.style.display = "none";
      return;
    }
    if (els.button) {
      els.button.style.display = "block";
      els.button.title = isEnabled()
        ? t("输入预测：已启用（点击设置）", "Composer predictions: on (click to configure)")
        : t("输入预测：已关闭（点击设置）", "Composer predictions: off (click to configure)");
    }

    var show = isEnabled() && state.text && !state.composing && isEditorEmpty(editor) && isVisible(editor);
    if (!show) {
      setGhostVisible(false);
      restorePlaceholder();
      restoreEditorHeight(editor);
      return;
    }

    ensureUI();
    hidePlaceholder(editor);
    var rect = editor.getBoundingClientRect();
    var cs = getComputedStyle(editor);
    var padLeft = parseFloat(cs.paddingLeft || "0") || 0;
    var padRight = parseFloat(cs.paddingRight || "0") || 0;
    var padTop = parseFloat(cs.paddingTop || "0") || 0;
    var padBottom = parseFloat(cs.paddingBottom || "0") || 0;

    els.ghost.textContent = state.text;
    els.ghost.style.left = rect.left + padLeft + "px";
    els.ghost.style.top = rect.top + padTop + "px";
    els.ghost.style.width = Math.max(20, rect.width - padLeft - padRight - 2) + "px";
    els.ghost.style.fontFamily = cs.fontFamily;
    els.ghost.style.fontSize = cs.fontSize;
    els.ghost.style.fontWeight = cs.fontWeight;
    els.ghost.style.lineHeight = cs.lineHeight;
    els.ghost.style.letterSpacing = cs.letterSpacing;
    els.ghost.style.textAlign = cs.textAlign;
    els.ghost.style.color = placeholderColor(editor) || "var(--color-text-ghost,#a3a3a3)";

    // Let a multi-line suggestion expand the composer instead of covering the
    // toolbar.  Only capture the original min-height once; comparing against
    // the already-expanded rect would otherwise oscillate every frame.
    var ghostHeight = els.ghost.scrollHeight;
    if (state.editorMinHeight !== "") {
      editor.style.minHeight = ghostHeight + "px";
    } else if (ghostHeight > rect.height + 1) {
      state.editorMinHeight = editor.style.minHeight;
      editor.style.minHeight = ghostHeight + "px";
    }

    els.hint.textContent = t("Tab 接受 · Esc 忽略", "Tab to accept · Esc to dismiss");
    var hintWidth = els.hint.offsetWidth || 130;
    positionHint(rect, padRight, padBottom, hintWidth);
    setGhostVisible(true);
    updateStatus();
  }

  function positionHint(rect, padRight, padBottom, hintWidth) {
    els.hint.style.left = Math.max(4, rect.right - padRight - hintWidth) + "px";
    els.hint.style.top = Math.max(4, rect.bottom - padBottom - 20) + "px";
  }

  function placeholderColor(editor) {
    try {
      var ph = findPlaceholder(editor);
      if (ph) return getComputedStyle(ph).color;
    } catch (e) {}
    return "";
  }

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(function () {
      renderTimer = 0;
      render();
    }, 16);
  }

  function clearSuggestion(reason) {
    if (state.text || state.placeholderEl) log("clear:", reason || "");
    state.text = "";
    state.messageId = "";
    state.model = "";
    state.latencyMs = 0;
    setGhostVisible(false);
    restorePlaceholder();
    var editor = findEditor();
    restoreEditorHeight(editor);
    updateStatus();
  }

  function showSuggestion(payload) {
    if (!payload || typeof payload.text !== "string") return;
    var text = payload.text.replace(/\r\n/g, "\n").trim();
    if (!text) {
      clearSuggestion("empty");
      return;
    }
    ensureUI();
    state.text = text;
    state.sessionId = payload.sessionId || state.sessionId || "";
    state.messageId = payload.messageId || "";
    state.model = payload.model || "";
    state.latencyMs = payload.latencyMs || 0;
    els.live.textContent = text;
    render();
    log("suggestion shown", text.length, state.model);
  }

  function insertText(editor, text) {
    editor.focus();
    var ok = false;
    try {
      ok = document.execCommand("insertText", false, text);
    } catch (e) {
      ok = false;
    }
    if (ok) {
      setTimeout(function () {
        // If Lexical rejected the command, the editor is still empty.  If it
        // inserted anything, do not paste again and risk a duplicate.
        if (!editorText(editor)) pasteFallback(editor, text);
      }, 30);
      return;
    }
    pasteFallback(editor, text);
  }

  function pasteFallback(editor, text) {
    try {
      var dt = new DataTransfer();
      dt.setData("text/plain", text);
      var event;
      try {
        event = new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        });
      } catch (e) {
        event = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", { value: dt });
      }
      editor.dispatchEvent(event);
    } catch (e2) {
      log("paste fallback failed", e2 && e2.message);
    }
  }

  function acceptSuggestion() {
    var editor = findEditor();
    if (!editor || !state.text) return;
    var text = state.text;
    clearSuggestion("accepted");
    insertText(editor, text);
    requestAnimationFrame(function () {
      editor.focus();
    });
  }

  function onKeyDown(event) {
    if (event.isComposing || state.composing) return;
    var editor = findEditor();
    if (!editor) return;

    if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "p" || event.key === "P")) {
      event.preventDefault();
      storageSet(ENABLED_KEY, isEnabled() ? "0" : "1");
      if (els.check) els.check.checked = isEnabled();
      if (!isEnabled()) clearSuggestion("hotkey");
      updateStatus();
      render();
      return;
    }

    if (!state.text) return;
    var focused = isEditorFocused(editor);

    if (focused && event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      acceptSuggestion();
      return;
    }

    if (event.key === "Escape") {
      clearSuggestion("escape");
      if (focused) event.preventDefault();
      return;
    }

    if (focused) {
      var typing =
        event.key.length === 1 ||
        event.key === "Backspace" ||
        event.key === "Delete" ||
        event.key === "Enter";
      if (typing) clearSuggestion("typing");
    }
  }

  function onInput(event) {
    if (!state.text) return;
    var editor = findEditor();
    if (!editor) return;
    var target = event.target;
    if (target === editor || editor.contains(target)) {
      if (!isEditorEmpty(editor)) clearSuggestion("input");
    }
  }

  function onCompositionStart() {
    state.composing = true;
    if (state.text) clearSuggestion("composition");
  }

  function onCompositionEnd() {
    state.composing = false;
    scheduleRender();
  }

  function onFocusChange() {
    scheduleRender();
  }

  function dispose() {
    try {
      abort.abort();
    } catch (e) {}
    if (renderTimer) clearTimeout(renderTimer);
    if (state.followTimer) clearInterval(state.followTimer);
    restorePlaceholder();
    var editor = findEditor();
    restoreEditorHeight(editor);
    ["ghost", "hint", "button", "panel", "live"].forEach(function (key) {
      var el = els[key];
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    els = {};
    state.text = "";
    if (window.__zcpOverlay === api) window.__zcpOverlay = null;
  }

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("compositionstart", onCompositionStart, true);
  document.addEventListener("compositionend", onCompositionEnd, true);
  document.addEventListener("focusin", onFocusChange, true);
  document.addEventListener("focusout", onFocusChange, true);
  window.addEventListener("resize", scheduleRender, { signal: signal });
  document.addEventListener("scroll", scheduleRender, { capture: true, signal: signal });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", scheduleRender, { signal: signal });
    window.visualViewport.addEventListener("scroll", scheduleRender, { signal: signal });
  }

  // Light periodic follow while a suggestion exists; the composer is sticky and
  // can move without a DOM event when the timeline reflows.
  state.followTimer = setInterval(function () {
    if (state.text) render();
  }, 300);

  var api = {
    version: VERSION,
    dispose: dispose,
    showSuggestion: showSuggestion,
    clear: clearSuggestion,
    setSession: function (sessionId) {
      var sid = typeof sessionId === "string" ? sessionId : "";
      if (state.sessionId !== sid) clearSuggestion("session");
      state.sessionId = sid;
      updateStatus();
      scheduleRender();
    },
    shouldPredict: function () {
      var editor = findEditor();
      var enabled = isEnabled();
      var empty = editor ? isEditorEmpty(editor) : false;
      var visible = editor ? isVisible(editor) : false;
      var focused = editor ? isEditorFocused(editor) : false;
      return {
        ok: !!(enabled && editor && empty && visible && !state.composing),
        enabled: enabled,
        empty: empty,
        visible: visible,
        focused: focused,
        composing: state.composing,
        sessionId: state.sessionId,
      };
    },
    status: function () {
      return {
        version: VERSION,
        enabled: isEnabled(),
        debug: isDebug(),
        text: state.text,
        sessionId: state.sessionId,
        messageId: state.messageId,
        model: state.model,
        latencyMs: state.latencyMs,
        hasEditor: !!findEditor(),
        choice: getModelChoice(),
      };
    },
    setModelOptions: setModelOptions,
    getModelChoice: getModelChoice,
  };

  window.__zcpShowSuggestion = showSuggestion;
  window.__zcpClear = clearSuggestion;
  window.__zcpSetSession = api.setSession;
  window.__zcpShouldPredict = api.shouldPredict;
  window.__zcpStatus = api.status;
  window.__zcpSetModelOptions = setModelOptions;
  window.__zcpGetModelChoice = getModelChoice;
  window.__zcpOverlay = api;

  ensureUI();
  scheduleRender();
  log("overlay loaded", VERSION);
})();
