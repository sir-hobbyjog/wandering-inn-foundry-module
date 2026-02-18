import { apiRequest } from "./api-client.js";
import { resolveSessionId } from "./session.js";

const MODULE_ID = "wi-core-foundry";
const pushTimers = new Map();

function debounceMs() {
  return Number(game.settings.get(MODULE_ID, "syncDebounceMs") || 800);
}

function actorPath(path, fallback) {
  return (game.settings.get(MODULE_ID, path) || fallback || "").trim();
}

function readNested(obj, path) {
  if (!path) return undefined;
  return foundry.utils.getProperty(obj, path);
}

function writeNested(update, path, value) {
  if (!path) return;
  foundry.utils.setProperty(update, path, value);
}

export async function bindActorToNpc(actor, payload) {
  return apiRequest("/foundry/actor/bind", {
    method: "POST",
    body: {
      world_id: game.world.id,
      actor_id: actor.id,
      npc_id: payload.npcId,
      is_canon: !!payload.isCanon,
      archetype_id: payload.archetypeId,
      default_level: Number(payload.defaultLevel || 1)
    }
  });
}

export async function pullCombatToActor(actor, { levelOverride = 0, forceRegenerate = false } = {}) {
  const sessionId = await resolveSessionId();
  const out = await apiRequest("/foundry/combat/pull", {
    method: "POST",
    body: {
      world_id: game.world.id,
      actor_id: actor.id,
      session_id: sessionId,
      level_override: Number(levelOverride || 0),
      force_regenerate: !!forceRegenerate
    }
  });

  const update = {
    [`flags.${MODULE_ID}.hpMax`]: out.hp_max,
    [`flags.${MODULE_ID}.ac`]: out.ac,
    [`flags.${MODULE_ID}.resistances`]: out.resistances,
    [`flags.${MODULE_ID}.skills`]: out.skills,
    [`flags.${MODULE_ID}.snapshotId`]: out.snapshot_id
  };

  const hpMaxPath = actorPath("hpMaxPath", "");
  const hpValuePath = actorPath("hpValuePath", "");
  const acPath = actorPath("acPath", "");
  writeNested(update, hpMaxPath, out.hp_max);
  if (hpValuePath) {
    const current = readNested(actor.toObject(), hpValuePath);
    writeNested(update, hpValuePath, current ?? out.hp_max);
  }
  writeNested(update, acPath, out.ac);

  await actor.update(update);
  return out;
}

async function pushActorState(actor) {
  const sessionId = await resolveSessionId();
  const state = actor.toObject();
  const hpValuePath = actorPath("hpValuePath", "");
  const hpTempPath = actorPath("hpTempPath", "");
  const acPath = actorPath("acPath", "");
  await apiRequest("/foundry/combat/push", {
    method: "POST",
    body: {
      world_id: game.world.id,
      scene_id: canvas?.scene?.id || "scene",
      encounter_id: game.combat?.id || "no-combat",
      actor_id: actor.id,
      session_id: sessionId,
      hp_current: Number(readNested(state, hpValuePath) || 0),
      hp_temp: Number(readNested(state, hpTempPath) || 0),
      ac_current: Number(readNested(state, acPath) || 0),
      resistances: actor.getFlag(MODULE_ID, "resistances") || {},
      conditions: (actor.effects || []).map((e) => e.label || e.name).filter(Boolean),
      round: Number(game.combat?.round || 0),
      turn: Number(game.combat?.turn || 0),
      meta: { source: "foundry-updateActor" }
    }
  });
}

export function registerActorSyncHook() {
  Hooks.on("updateActor", (actor) => {
    if (!actor?.id) return;
    const existing = pushTimers.get(actor.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pushActorState(actor).catch((err) => console.error("[wi-core-foundry] push failed", err));
      pushTimers.delete(actor.id);
    }, debounceMs());
    pushTimers.set(actor.id, timer);
  });
}
