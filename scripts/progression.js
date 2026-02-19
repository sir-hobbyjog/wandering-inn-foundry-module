import { apiRequest } from "./api-client.js";
import { resolveSessionId } from "./session.js";

const MODULE_ID = "wi-core-foundry";

function actorPath(path, fallback) {
  return (game.settings.get(MODULE_ID, path) || fallback || "").trim();
}

function readNested(obj, path) {
  if (!path) return undefined;
  return foundry.utils.getProperty(obj, path);
}

function normKey(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function safeParseJson(raw, fallback) {
  try {
    const v = JSON.parse(String(raw || "").trim() || "");
    return v == null ? fallback : v;
  } catch (_err) {
    return fallback;
  }
}

export function buildProgressionFromActor(actor) {
  const state = actor.toObject();
  const existing = actor.getFlag(MODULE_ID, "progression") || {};

  const levelPath = actorPath("levelPath", "");
  const xpPath = actorPath("xpPath", "");
  const classPath = actorPath("classPath", "");
  const speciesPath = actorPath("speciesPath", "");
  const skillPath = actorPath("skillPath", "");

  const levelFromPath = Number(readNested(state, levelPath) || 0);
  const xpFromPath = Number(readNested(state, xpPath) || 0);

  const level = Math.max(1, Math.min(100, Number(levelFromPath || existing.level || 1)));
  const xp = Math.max(0, Number(xpFromPath || existing.xp || 0));

  const speciesRaw = readNested(state, speciesPath);
  const classesRaw = readNested(state, classPath);
  const skillsRaw = readNested(state, skillPath);

  const species = typeof speciesRaw === "object" && speciesRaw
    ? speciesRaw
    : {
        primary: existing?.species?.primary || "human",
        subtypes: existing?.species?.subtypes || [],
        traits: existing?.species?.traits || []
      };

  let classes = Array.isArray(classesRaw) ? classesRaw : Array.isArray(existing.classes) ? existing.classes : [];
  if (!classes.length) {
    classes = [
      {
        classId: "adventurer",
        name: "Adventurer",
        level,
        track: "warrior",
        isPrimary: true
      }
    ];
  }

  classes = classes.map((c, idx) => ({
    classId: normKey(c.classId || c.name || `class_${idx + 1}`),
    name: String(c.name || c.classId || `Class ${idx + 1}`),
    level: Number(c.level || 1),
    track: normKey(c.track || ""),
    isPrimary: !!c.isPrimary
  }));

  const skills = (Array.isArray(skillsRaw) ? skillsRaw : Array.isArray(existing.skills) ? existing.skills : []).map((s, idx) => ({
    skillId: normKey(s.skillId || s.name || `skill_${idx + 1}`),
    name: String(s.name || s.skillId || `Skill ${idx + 1}`),
    source: String(s.source || "custom"),
    tier: String(s.tier || ""),
    description: String(s.description || ""),
    tags: Array.isArray(s.tags) ? s.tags.map(normKey).filter(Boolean) : [],
    cooldown: Number(s.cooldown || 0),
    trigger: String(s.trigger || ""),
    effect: String(s.effect || ""),
    counterplay: String(s.counterplay || "")
  }));

  const res = actor.getFlag(MODULE_ID, "resistances") || existing.resistances || {};
  const resistances = {};
  Object.entries(res).forEach(([k, v]) => {
    resistances[normKey(k)] = Number(v || 0);
  });

  return {
    schemaVersion: 1,
    level,
    xp,
    species: {
      primary: normKey(species.primary || "human"),
      subtypes: Array.isArray(species.subtypes) ? species.subtypes.map(normKey).filter(Boolean) : [],
      traits: Array.isArray(species.traits) ? species.traits.map(normKey).filter(Boolean) : []
    },
    classes,
    skills,
    resistances
  };
}

export function shouldSyncProgressionChange(changed) {
  if (!changed || typeof changed !== "object") return false;
  const changedJson = JSON.stringify(changed);
  if (changedJson.includes(`"flags":{"${MODULE_ID}"`)) return false;

  const watch = [
    actorPath("levelPath", ""),
    actorPath("xpPath", ""),
    actorPath("classPath", ""),
    actorPath("speciesPath", ""),
    actorPath("skillPath", "")
  ].filter(Boolean);

  if (!watch.length) return false;
  return watch.some((p) => changedJson.includes(`"${p.split(".").join("\":{")}"`) || changedJson.includes(p));
}

async function syncProgression(actor, progression) {
  const sessionId = await resolveSessionId();
  return apiRequest("/foundry/actor/progression/sync", {
    method: "POST",
    body: {
      world_id: game.world.id,
      actor_id: actor.id,
      session_id: sessionId,
      progression
    }
  });
}

export function registerProgressionTools() {
  game.wiCore = game.wiCore || {};

  game.wiCore.openProgressionEditor = async (actor) => {
    const target = actor || canvas?.tokens?.controlled?.[0]?.actor;
    if (!target) {
      ui.notifications.warn("Select a token or pass an actor.");
      return;
    }

    const current = buildProgressionFromActor(target);
    const content = `
<div class="wi-prog-grid">
  <label>Actor</label><div>${target.name}</div>
  <label>Level</label><input id="wi-prog-level" type="number" min="1" max="100" value="${current.level}" />
  <label>XP</label><input id="wi-prog-xp" type="number" min="0" value="${current.xp}" />
  <label>Species (JSON)</label><textarea id="wi-prog-species" rows="4">${JSON.stringify(current.species, null, 2)}</textarea>
  <label>Classes (JSON)</label><textarea id="wi-prog-classes" rows="7">${JSON.stringify(current.classes, null, 2)}</textarea>
  <label>Skills (JSON)</label><textarea id="wi-prog-skills" rows="7">${JSON.stringify(current.skills, null, 2)}</textarea>
  <label>Resistances (JSON)</label><textarea id="wi-prog-res" rows="5">${JSON.stringify(current.resistances, null, 2)}</textarea>
</div>`;

    new Dialog({
      title: `Progression Editor: ${target.name}`,
      content,
      buttons: {
        sync: {
          label: "Recompute + Sync",
          callback: async (html) => {
            const progression = {
              schemaVersion: 1,
              level: Number(html.find("#wi-prog-level").val() || 1),
              xp: Number(html.find("#wi-prog-xp").val() || 0),
              species: safeParseJson(html.find("#wi-prog-species").val(), current.species),
              classes: safeParseJson(html.find("#wi-prog-classes").val(), current.classes),
              skills: safeParseJson(html.find("#wi-prog-skills").val(), current.skills),
              resistances: safeParseJson(html.find("#wi-prog-res").val(), current.resistances)
            };

            const out = await syncProgression(target, progression);
            await target.update({
              [`flags.${MODULE_ID}.progression`]: {
                ...out.progression,
                audit: {
                  lastSyncAt: new Date().toISOString(),
                  lastSyncBy: game.user?.id || "",
                  lastBackendHash: out.source_hash || ""
                }
              },
              [`flags.${MODULE_ID}.resistances`]: out.progression?.resistances || {},
              [`flags.${MODULE_ID}.hpMax`]: Number(out.progression?.derived?.hpMax || 1),
              [`flags.${MODULE_ID}.ac`]: Number(out.progression?.derived?.ac || 1)
            });
            ui.notifications.info(`Progression synced for ${target.name}`);
          }
        },
        levelup: {
          label: "Level +1",
          callback: async () => {
            const sessionId = await resolveSessionId();
            const out = await apiRequest("/foundry/actor/progression/level-up", {
              method: "POST",
              body: {
                world_id: game.world.id,
                actor_id: target.id,
                session_id: sessionId,
                delta_levels: 1,
                class_allocation: []
              }
            });
            await target.update({
              [`flags.${MODULE_ID}.progression`]: out.progression,
              [`flags.${MODULE_ID}.resistances`]: out.progression?.resistances || {},
              [`flags.${MODULE_ID}.hpMax`]: Number(out.progression?.derived?.hpMax || 1),
              [`flags.${MODULE_ID}.ac`]: Number(out.progression?.derived?.ac || 1)
            });
            ui.notifications.info(`${target.name} leveled to ${out.progression?.level || "?"}`);
          }
        }
      },
      default: "sync"
    }).render(true);
  };
}
