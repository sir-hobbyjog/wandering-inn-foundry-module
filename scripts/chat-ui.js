import { apiRequest } from "./api-client.js";
import { resolveSessionId } from "./session.js";
import { maybePlayVoice } from "./voice.js";
import { bindActorToNpc, bindActorToPreset, pullCombatToActor } from "./actor-sync.js";

const MODULE_ID = "wi-core-foundry";
let presetCache = [];

function actorOptionsHtml() {
  const actors = game.actors?.contents || [];
  return actors.map((a) => `<option value="${a.id}">${a.name}</option>`).join("\n");
}

async function ensurePresetCache() {
  if (presetCache.length) return presetCache;
  try {
    const out = await apiRequest("/foundry/npc/presets");
    presetCache = Array.isArray(out.presets) ? out.presets : [];
  } catch (_err) {
    presetCache = [];
  }
  return presetCache;
}

function presetOptionsHtml(selectedPresetId = "") {
  const options = [`<option value="">-- Select Core NPC Preset --</option>`];
  for (const p of presetCache) {
    const selected = String(p.preset_id) === String(selectedPresetId || "") ? "selected" : "";
    const label = `${p.preset_id} (${p.npc_id})`;
    options.push(`<option value="${p.preset_id}" ${selected}>${label}</option>`);
  }
  return options.join("\\n");
}

function applyPresetToState(state, presetId) {
  const p = presetCache.find((x) => String(x.preset_id) === String(presetId || ""));
  if (!p) return state;
  return {
    ...state,
    presetId: String(p.preset_id || ""),
    npcId: String(p.npc_id || state.npcId || ""),
    archetypeId: String(p.archetype_id || state.archetypeId || "innkeeper_npc"),
    level: Number(p.default_level || state.level || 10)
  };
}

function panelStateFromHtml(html) {
  return {
    actorId: String(html.find("#wi-actor").val() || ""),
    presetId: String(html.find("#wi-preset").val() || ""),
    npcId: String(html.find("#wi-npc-id").val() || ""),
    archetypeId: String(html.find("#wi-arch").val() || "innkeeper_npc"),
    level: Number(html.find("#wi-level").val() || 10),
    message: String(html.find("#wi-msg").val() || ""),
    debugMode: Boolean(html.find("#wi-debug").is(":checked")),
    lastTraceId: String(html.find("#wi-trace-id").val() || "")
  };
}

function renderNpcPanel(state) {
  const showDebugControls = game.user?.isGM;
  const debugRow = showDebugControls
    ? `
  <label>Debug Mode</label><input id="wi-debug" type="checkbox" ${state.debugMode ? "checked" : ""} />
  <label>Last Trace</label><input id="wi-trace-id" type="text" value="${state.lastTraceId || ""}" />`
    : "";

  const content = `
<div class="wi-core-grid">
  <label>Actor</label><select id="wi-actor">${actorOptionsHtml()}</select>
  <label>Core Preset</label><select id="wi-preset">${presetOptionsHtml(state.presetId)}</select>
  <label>NPC ID</label><input id="wi-npc-id" type="text" placeholder="erin_solstice_early" value="${state.npcId}" />
  <label>Archetype</label><input id="wi-arch" type="text" value="${state.archetypeId}" />
  <label>Level</label><input id="wi-level" type="number" value="${state.level}" />
  <label>Message</label><textarea id="wi-msg" rows="4" placeholder="Ask the NPC...">${state.message}</textarea>
  ${debugRow}
</div>`;

  const buttons = {
    bind: {
      label: "Bind Actor",
      callback: async (html) => {
        const next = panelStateFromHtml(html);
        const actor = game.actors.get(String(html.find("#wi-actor").val() || ""));
        if (!actor) return;
        if (next.presetId) {
          const bound = await bindActorToPreset(actor, next.presetId);
          next.npcId = String(bound.npc_id || next.npcId || "");
          next.archetypeId = String(bound.archetype_id || next.archetypeId || "innkeeper_npc");
          next.level = Number(bound.default_level || next.level || 10);
          ui.notifications.info(`Actor bound using preset ${next.presetId}`);
          renderNpcPanel(next);
          return;
        }
        await bindActorToNpc(actor, {
          npcId: html.find("#wi-npc-id").val(),
          archetypeId: html.find("#wi-arch").val(),
          defaultLevel: Number(html.find("#wi-level").val() || 1),
          isCanon: true
        });
        ui.notifications.info("Actor bound to NPC");
        renderNpcPanel(next);
      }
    },
    pull: {
      label: "Pull Combat",
      callback: async (html) => {
        const next = panelStateFromHtml(html);
        const actor = game.actors.get(String(html.find("#wi-actor").val() || ""));
        if (!actor) return;
        await pullCombatToActor(actor, { levelOverride: Number(html.find("#wi-level").val() || 1) });
        ui.notifications.info("Combat profile applied to actor");
        renderNpcPanel(next);
      }
    },
    send: {
      label: "Send NPC Prompt",
      callback: async (html) => {
        const next = panelStateFromHtml(html);
        const npcId = String(next.npcId || "").trim();
        const msg = String(next.message || "").trim();
        if (!npcId || !msg) return ui.notifications.warn("NPC ID and message are required");

        const sessionId = await resolveSessionId();
        const voiceId = String(game.settings.get(MODULE_ID, "defaultVoiceId") || "").trim();
        const debugMode = Boolean(next.debugMode && game.user?.isGM);
        const actor = game.actors.get(String(next.actorId || ""));
        const progression = actor?.getFlag(MODULE_ID, "progression") || {};
        const actorSpecies = progression?.species?.primary ? [String(progression.species.primary)] : [];
        const actorClasses = Array.isArray(progression?.classes)
          ? progression.classes.map((c) => String(c.classId || "").trim()).filter(Boolean)
          : [];
        const response = await apiRequest("/npc/respond", {
          method: "POST",
          body: {
            npc_id: npcId,
            message: msg,
            top_k: 6,
            retrieval_backend: "local",
            generation_mode: "openai",
            session_id: sessionId,
            location_city: "liscor",
            debug_mode: debugMode,
            policy_mode: "strict",
            response_style: "in_character",
            party_species: actorSpecies,
            party_subject_ids: [],
            foundry_world_id: game.world?.id || "",
            foundry_actor_id: actor?.id || "",
            dm_override: actorClasses.length ? `Actor class tags: ${actorClasses.join(", ")}` : "",
            voice_requested: !!voiceId,
            voice_id: voiceId,
            include_combat_profile: false
          }
        });

        const cites = (response.citations || []).slice(0, 4).map((c) => `#${c.chunk_id}`).join(", ");
        const traceInfo = response.debug_trace_id ? `<br/><small>Trace: ${response.debug_trace_id}</small>` : "";
        await ChatMessage.create({
          content: `<strong>${npcId}</strong>: ${response.response}<br/><small>Citations: ${cites || "none"}</small>${traceInfo}`
        });
        ui.notifications.info("NPC response posted to Chat Log.");

        if (response.debug_trace_id) {
          game.wiCore = game.wiCore || {};
          game.wiCore.lastDebugTraceId = String(response.debug_trace_id);
          next.lastTraceId = String(response.debug_trace_id);
        }

        if (voiceId) {
          await maybePlayVoice({
            text: response.response,
            npcId,
            sessionId,
            voiceId
          });
        }
        next.message = "";
        renderNpcPanel(next);
      }
    }
  };

  if (showDebugControls) {
    buttons.debug = {
      label: "Show Prompt Debug",
      callback: async (html) => {
        const next = panelStateFromHtml(html);
        const traceId = String(next.lastTraceId || game.wiCore?.lastDebugTraceId || "").trim();
        if (!traceId) {
          ui.notifications.warn("No trace ID yet. Send a prompt with Debug Mode enabled first.");
          renderNpcPanel(next);
          return;
        }
        await game.wiCore.openDmConsole(traceId);
        renderNpcPanel(next);
      }
    };
  }

  new Dialog({
    title: "Wandering Inn NPC Panel",
    content,
    render: (html) => {
      if (state.actorId) html.find("#wi-actor").val(state.actorId);
      html.find("#wi-preset").on("change", () => {
        const current = panelStateFromHtml(html);
        const next = applyPresetToState(current, html.find("#wi-preset").val());
        renderNpcPanel(next);
      });
    },
    buttons,
    default: "send"
  }).render(true);
}

export function registerNpcPanel() {
  game.wiCore = game.wiCore || {};
  game.wiCore.openNpcPanel = async (initial = {}) => {
    await ensurePresetCache();
    const state = {
      actorId: String(initial.actorId || ""),
      presetId: String(initial.presetId || ""),
      npcId: String(initial.npcId || ""),
      archetypeId: String(initial.archetypeId || "innkeeper_npc"),
      level: Number(initial.level || 10),
      message: String(initial.message || ""),
      debugMode: Boolean(initial.debugMode || game.settings.get(MODULE_ID, "gmDebugMode") || false),
      lastTraceId: String(initial.lastTraceId || game.wiCore?.lastDebugTraceId || "")
    };
    renderNpcPanel(applyPresetToState(state, state.presetId));
  };

  game.wiCore.pullCombatSelected = async () => {
    const token = canvas?.tokens?.controlled?.[0];
    const actor = token?.actor;
    if (!actor) {
      ui.notifications.warn("Select a token first.");
      return;
    }
    await pullCombatToActor(actor, {});
    ui.notifications.info(`Pulled combat profile for ${actor.name}.`);
  };
}
