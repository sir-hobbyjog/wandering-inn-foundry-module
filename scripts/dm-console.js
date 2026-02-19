import { apiRequest } from "./api-client.js";

function esc(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function pretty(value) {
  return esc(JSON.stringify(value ?? {}, null, 2));
}

function tabsHtml(trace) {
  const policy = trace?.request?.policy_mode || "strict";
  return `
<div class="wi-dm-console" data-trace-id="${esc(trace.trace_id)}">
  <div class="wi-dm-head">
    <div><strong>Trace:</strong> ${esc(trace.trace_id)}</div>
    <div><strong>Event:</strong> ${esc(trace.event_id)}</div>
    <div><strong>NPC:</strong> ${esc(trace.npc_id)}</div>
    <div><strong>Policy Mode:</strong> ${esc(policy)}</div>
  </div>
  <div class="wi-dm-tabs">
    <button type="button" class="wi-tab-btn" data-tab="prompt">Prompt Trace</button>
    <button type="button" class="wi-tab-btn" data-tab="pins">Pins</button>
    <button type="button" class="wi-tab-btn" data-tab="retrieval">Retrieval</button>
    <button type="button" class="wi-tab-btn" data-tab="memory">Memory</button>
    <button type="button" class="wi-tab-btn" data-tab="policy">Policy</button>
  </div>
  <div class="wi-dm-pane" data-pane="prompt"><pre>${pretty(trace.compiled_messages)}</pre></div>
  <div class="wi-dm-pane" data-pane="pins" style="display:none"><pre>${pretty(trace.pins)}</pre></div>
  <div class="wi-dm-pane" data-pane="retrieval" style="display:none"><pre>${pretty(trace.retrieval)}</pre></div>
  <div class="wi-dm-pane" data-pane="memory" style="display:none"><pre>${pretty(trace.memory)}</pre></div>
  <div class="wi-dm-pane" data-pane="policy" style="display:none"><pre>${pretty({ policy_mode: trace?.request?.policy_mode, location_city: trace?.request?.location_city, party_species: trace?.request?.party_species })}</pre></div>
</div>`;
}

function wireTabs(html) {
  const root = html.find(".wi-dm-console");
  const openTab = (tab) => {
    root.find(".wi-dm-pane").hide();
    root.find(`.wi-dm-pane[data-pane='${tab}']`).show();
  };
  root.find(".wi-tab-btn").on("click", (ev) => openTab($(ev.currentTarget).data("tab")));
}

async function requestTraceIdDialog() {
  return new Promise((resolve) => {
    new Dialog({
      title: "Open DM Console",
      content: `
<div class="wi-core-grid">
  <label>Trace ID</label>
  <input id="wi-dm-trace-input" type="text" placeholder="Paste debug_trace_id" />
</div>`,
      buttons: {
        open: {
          label: "Open",
          callback: (html) => resolve(String(html.find("#wi-dm-trace-input").val() || "").trim())
        },
        cancel: {
          label: "Cancel",
          callback: () => resolve("")
        }
      },
      default: "open"
    }).render(true);
  });
}

export function registerDmConsole() {
  game.wiCore = game.wiCore || {};
  game.wiCore.openDmConsole = async (traceId = "") => {
    if (!game.user?.isGM) {
      ui.notifications.warn("DM Console is GM-only.");
      return;
    }
    let resolvedTraceId = String(traceId || game.wiCore?.lastDebugTraceId || "").trim();
    if (!resolvedTraceId) {
      resolvedTraceId = await requestTraceIdDialog();
    }
    if (!resolvedTraceId) {
      ui.notifications.warn("Trace ID is required.");
      return;
    }

    let trace;
    try {
      trace = await apiRequest(`/dm/prompt-debug/${encodeURIComponent(resolvedTraceId)}?redaction_level=0`);
    } catch (err) {
      console.error("[wi-core-foundry] Failed loading prompt trace", err);
      ui.notifications.error(`Failed loading trace ${resolvedTraceId}`);
      return;
    }

    game.wiCore.lastDebugTraceId = String(trace.trace_id || resolvedTraceId);
    new Dialog({
      title: `WI DM Console: ${game.wiCore.lastDebugTraceId}`,
      content: tabsHtml(trace),
      render: (html) => wireTabs(html),
      buttons: {
        close: {
          label: "Close"
        }
      }
    }).render(true);
  };
}
