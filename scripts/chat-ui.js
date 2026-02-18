import { apiRequest } from "./api-client.js";
import { resolveSessionId } from "./session.js";
import { maybePlayVoice } from "./voice.js";
import { bindActorToNpc, pullCombatToActor } from "./actor-sync.js";

const MODULE_ID = "wi-core-foundry";

function actorOptionsHtml() {
  const actors = game.actors?.contents || [];
  return actors.map((a) => `<option value="${a.id}">${a.name}</option>`).join("\n");
}

export function registerNpcPanel() {
  game.wiCore = game.wiCore || {};
  game.wiCore.openNpcPanel = () => {
    const content = `
<div class="wi-core-grid">
  <label>Actor</label><select id="wi-actor">${actorOptionsHtml()}</select>
  <label>NPC ID</label><input id="wi-npc-id" type="text" placeholder="erin_solstice_early" />
  <label>Archetype</label><input id="wi-arch" type="text" value="innkeeper_npc" />
  <label>Level</label><input id="wi-level" type="number" value="10" />
  <label>Message</label><textarea id="wi-msg" rows="4" placeholder="Ask the NPC..."></textarea>
</div>`;

    new Dialog({
      title: "Wandering Inn NPC Panel",
      content,
      buttons: {
        bind: {
          label: "Bind Actor",
          callback: async (html) => {
            const actor = game.actors.get(html.find("#wi-actor").val());
            if (!actor) return;
            await bindActorToNpc(actor, {
              npcId: html.find("#wi-npc-id").val(),
              archetypeId: html.find("#wi-arch").val(),
              defaultLevel: Number(html.find("#wi-level").val() || 1),
              isCanon: true
            });
            ui.notifications.info("Actor bound to NPC");
          }
        },
        pull: {
          label: "Pull Combat",
          callback: async (html) => {
            const actor = game.actors.get(html.find("#wi-actor").val());
            if (!actor) return;
            await pullCombatToActor(actor, { levelOverride: Number(html.find("#wi-level").val() || 1) });
            ui.notifications.info("Combat profile applied to actor");
          }
        },
        send: {
          label: "Send NPC Prompt",
          callback: async (html) => {
            const npcId = String(html.find("#wi-npc-id").val() || "").trim();
            const msg = String(html.find("#wi-msg").val() || "").trim();
            if (!npcId || !msg) return ui.notifications.warn("NPC ID and message are required");
            const sessionId = await resolveSessionId();
            const voiceId = String(game.settings.get(MODULE_ID, "defaultVoiceId") || "").trim();
            const response = await apiRequest("/npc/respond", {
              method: "POST",
              body: {
                npc_id: npcId,
                message: msg,
                top_k: 4,
                retrieval_backend: "local",
                generation_mode: "openai",
                session_id: sessionId,
                voice_requested: !!voiceId,
                voice_id: voiceId,
                include_combat_profile: false
              }
            });

            const cites = (response.citations || []).slice(0, 4).map((c) => `#${c.chunk_id}`).join(", ");
            await ChatMessage.create({
              content: `<strong>${npcId}</strong>: ${response.response}<br/><small>Citations: ${cites || "none"}</small>`
            });

            if (voiceId) {
              await maybePlayVoice({
                text: response.response,
                npcId,
                sessionId,
                voiceId
              });
            }
          }
        }
      },
      default: "send"
    }).render(true);
  };
}
