import { apiRequest } from "./api-client.js";

const MODULE_ID = "wi-core-foundry";

function partyId() {
  const source = (game.settings.get(MODULE_ID, "partyIdSource") || "setting").trim();
  if (source === "manual" || source === "setting") {
    const configured = (game.settings.get(MODULE_ID, "partyIdValue") || "party").trim();
    return configured || "party";
  }
  if (source === "actor-folder") {
    const folder = game.actors?.folders?.contents?.find((f) => f.name?.toLowerCase().includes("party"));
    if (folder?.id) return `folder-${folder.id}`;
  }
  const configured = (game.settings.get(MODULE_ID, "partyIdValue") || "party").trim();
  return configured || "party";
}

export async function resolveSessionId() {
  const worldId = game.world?.id || "world";
  const sceneId = canvas?.scene?.id || game.scenes?.current?.id || "scene";
  const body = { world_id: worldId, scene_id: sceneId, party_id: partyId() };
  const data = await apiRequest("/foundry/session/resolve", { method: "POST", body });
  return data.session_id;
}
