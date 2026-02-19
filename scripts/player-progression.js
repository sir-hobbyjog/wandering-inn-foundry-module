import { apiRequest } from "./api-client.js";
import { resolveSessionId } from "./session.js";

const MODULE_ID = "wi-core-foundry";
const openOfferMap = new Map();

function normKey(v) {
  return String(v || "").trim().toLowerCase().replace(/\s+/g, "_");
}

function escapeHtml(v) {
  return String(v || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ensureTrackers(actor, progression) {
  const existing = actor.getFlag(MODULE_ID, "skillTrackers") || {};
  const out = foundry.utils.deepClone(existing);
  for (const skill of progression?.skills || []) {
    const sid = normKey(skill.skillId || skill.name);
    if (!sid) continue;
    const maxUses = Number(skill.maxUses || skill.limitedUsesMax || 0);
    const per = normKey(skill.per || skill.limitedUsesPer || "scene") || "scene";
    const cooldown = Number(skill.cooldown || 0);
    if (!out[sid]) {
      out[sid] = {
        usesMax: maxUses,
        usesRemaining: maxUses,
        per,
        cooldownBase: cooldown,
        cooldownRemaining: 0,
        updatedAt: new Date().toISOString()
      };
    } else {
      out[sid].usesMax = maxUses;
      if (typeof out[sid].usesRemaining !== "number") out[sid].usesRemaining = maxUses;
      out[sid].per = per;
      out[sid].cooldownBase = cooldown;
      if (typeof out[sid].cooldownRemaining !== "number") out[sid].cooldownRemaining = 0;
    }
  }
  return out;
}

function buildSkillTableRows(progression, trackers) {
  return (progression?.skills || []).map((skill) => {
    const sid = normKey(skill.skillId || skill.name);
    const t = trackers[sid] || { usesMax: 0, usesRemaining: 0, per: "scene", cooldownBase: Number(skill.cooldown || 0), cooldownRemaining: 0 };
    return `
<tr data-skill-id="${escapeHtml(sid)}">
  <td><strong>${escapeHtml(skill.name || sid)}</strong><div class="wi-mini">${escapeHtml(skill.description || "")}</div></td>
  <td>${Number(t.cooldownRemaining || 0)} / ${Number(t.cooldownBase || 0)}</td>
  <td>${Number(t.usesRemaining || 0)} / ${Number(t.usesMax || 0)}</td>
  <td>${escapeHtml(t.per || "scene")}</td>
  <td class="wi-skill-actions">
    <button type="button" data-action="skill-use" data-skill-id="${escapeHtml(sid)}">Use</button>
    <button type="button" data-action="skill-recharge" data-skill-id="${escapeHtml(sid)}">Recharge</button>
    <button type="button" data-action="skill-gm-refresh" data-skill-id="${escapeHtml(sid)}">Ask GM Refresh</button>
  </td>
</tr>`;
  }).join("");
}

function applyPacketToProgression(current, packet) {
  const next = foundry.utils.deepClone(current);
  const pType = normKey(packet.packetType || "standard");
  const delta = Number(packet.deltaLevels || 0);

  if (pType === "consolidation") {
    const from = normKey(packet?.consolidation?.from);
    const to = normKey(packet?.consolidation?.to);
    const fromIdx = (next.classes || []).findIndex((c) => normKey(c.classId) === from);
    const toIdx = (next.classes || []).findIndex((c) => normKey(c.classId) === to);
    if (fromIdx < 0 || toIdx < 0) throw new Error("Invalid consolidation classes");
    next.classes[toIdx].level = Number(next.classes[toIdx].level || 1) + Number(next.classes[fromIdx].level || 1);
    next.classes.splice(fromIdx, 1);
    if (!(next.classes || []).some((c) => c.isPrimary) && next.classes.length) next.classes[0].isPrimary = true;
    return next;
  }

  if (pType === "new_class") {
    const newClass = packet.newClass || {
      classId: normKey(packet.classId),
      name: packet.classId,
      track: "",
      isPrimary: false,
      isCustom: true
    };
    next.level = Number(next.level || 1) + Math.max(0, delta || 1);
    next.classes = Array.isArray(next.classes) ? next.classes : [];
    next.classes.push({
      classId: normKey(newClass.classId || newClass.name || "new_class"),
      name: String(newClass.name || newClass.classId || "New Class"),
      level: Math.max(1, delta || 1),
      track: normKey(newClass.track || ""),
      isPrimary: !!newClass.isPrimary,
      isCustom: true
    });
  } else {
    const addTo = normKey(packet.classId || "");
    next.level = Number(next.level || 1) + Math.max(1, delta || 1);
    const target = (next.classes || []).find((c) => normKey(c.classId) === addTo) || (next.classes || []).find((c) => c.isPrimary) || (next.classes || [])[0];
    if (!target) throw new Error("No class found for level allocation");
    target.level = Number(target.level || 1) + Math.max(1, delta || 1);
  }

  const picks = Array.isArray(packet.skillPicks) ? packet.skillPicks : [];
  if (picks.length) {
    next.skills = Array.isArray(next.skills) ? next.skills : [];
    for (const s of picks) {
      next.skills.push({
        skillId: normKey(s.skillId || s.name || `skill_${Math.random().toString(36).slice(2, 8)}`),
        name: String(s.name || s.skillId || "Skill"),
        source: String(s.source || "custom"),
        tier: String(s.tier || ""),
        description: String(s.description || ""),
        tags: Array.isArray(s.tags) ? s.tags.map(normKey).filter(Boolean) : [],
        cooldown: Number(s.cooldown || 0),
        trigger: String(s.trigger || ""),
        effect: String(s.effect || ""),
        counterplay: String(s.counterplay || "")
      });
    }
  }

  return next;
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

async function askGmRequest(actor, requestType, payload) {
  const sessionId = await resolveSessionId();
  return apiRequest("/foundry/actor/request", {
    method: "POST",
    body: {
      world_id: game.world.id,
      actor_id: actor.id,
      session_id: sessionId,
      request_type: normKey(requestType),
      payload: payload || {},
      priority: 40,
      status: "open"
    }
  });
}

async function openLevelOffer(actor, offer) {
  const key = `${game.user?.id || "u"}:${actor.id}:${offer.offerId || "offer"}`;
  if (openOfferMap.get(key)) return;
  openOfferMap.set(key, true);

  const progression = actor.getFlag(MODULE_ID, "progression") || {};
  const packet = offer.packet || {};
  const pType = normKey(packet.packetType || "standard");
  let trackers = ensureTrackers(actor, progression);
  await actor.setFlag(MODULE_ID, "skillTrackers", trackers);

  const content = () => {
    const rows = buildSkillTableRows(progression, trackers) || `<tr><td colspan="5">No skills found.</td></tr>`;
    return `
<div class="wi-level-offer">
  <p><strong>Level Granted:</strong> ${escapeHtml(actor.name)}</p>
  <p>Type: <strong>${escapeHtml(pType)}</strong> | Delta Levels: <strong>${Number(packet.deltaLevels || 1)}</strong></p>
  <p>Class Target: <strong>${escapeHtml(packet.classId || "primary")}</strong></p>
  <p>You can accept or reject this grant. If rejected, no level change is applied.</p>
  <div class="wi-offer-actions">
    <button type="button" data-action="refresh-scene">Refresh Scene Uses</button>
    <button type="button" data-action="refresh-rest">Refresh Rest Uses</button>
    <button type="button" data-action="refresh-day">Refresh Day Uses</button>
  </div>
  <h4>Current Skills</h4>
  <table class="wi-ledger-table wi-skill-table">
    <thead><tr><th>Skill</th><th>Cooldown</th><th>Limited Uses</th><th>Reset</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
  };

  const attachSkillHandlers = (html, dialogRef) => {
    html.on("click", "button[data-action='skill-use']", async (ev) => {
      const sid = String(ev.currentTarget.dataset.skillId || "");
      const t = trackers[sid] || { usesMax: 0, usesRemaining: 0, per: "scene", cooldownBase: 0, cooldownRemaining: 0 };
      if (Number(t.usesMax || 0) > 0 && Number(t.usesRemaining || 0) <= 0) {
        ui.notifications.warn("No uses remaining for this skill.");
        return;
      }
      if (Number(t.usesMax || 0) > 0) t.usesRemaining = Math.max(0, Number(t.usesRemaining || 0) - 1);
      t.cooldownRemaining = Math.max(Number(t.cooldownRemaining || 0), Number(t.cooldownBase || 0));
      t.updatedAt = new Date().toISOString();
      trackers[sid] = t;
      actor.setFlag(MODULE_ID, "skillTrackers", trackers);
      dialogRef.data.content = content();
      dialogRef.render(true);
    });

    html.on("click", "button[data-action='skill-recharge']", async (ev) => {
      const sid = String(ev.currentTarget.dataset.skillId || "");
      const t = trackers[sid] || { usesMax: 0, usesRemaining: 0, per: "scene", cooldownBase: 0, cooldownRemaining: 0 };
      t.cooldownRemaining = 0;
      if (Number(t.usesMax || 0) > 0) t.usesRemaining = Number(t.usesMax || 0);
      t.updatedAt = new Date().toISOString();
      trackers[sid] = t;
      actor.setFlag(MODULE_ID, "skillTrackers", trackers);
      dialogRef.data.content = content();
      dialogRef.render(true);
    });

    html.on("click", "button[data-action='skill-gm-refresh']", async (ev) => {
      const sid = String(ev.currentTarget.dataset.skillId || "");
      await askGmRequest(actor, "skill_refresh", { skill_id: sid, offer_id: offer.offerId || "" });
      ui.notifications.info(`Sent GM refresh request for ${sid}.`);
    });

    html.on("click", "button[data-action='refresh-scene'], button[data-action='refresh-rest'], button[data-action='refresh-day']", async (ev) => {
      const action = String(ev.currentTarget.dataset.action || "refresh-scene");
      const per = action.replace("refresh-", "");
      Object.keys(trackers).forEach((sid) => {
        const t = trackers[sid];
        if (!t) return;
        if (per === "scene" || normKey(t.per) === per) {
          if (Number(t.usesMax || 0) > 0) t.usesRemaining = Number(t.usesMax || 0);
          t.cooldownRemaining = 0;
          t.updatedAt = new Date().toISOString();
        }
      });
      await actor.setFlag(MODULE_ID, "skillTrackers", trackers);
      dialogRef.data.content = content();
      dialogRef.render(true);
    });
  };

  let renderHook = null;
  const dialog = new Dialog({
    title: `Level Offer: ${actor.name}`,
    content: content(),
    buttons: {
      accept: {
        label: "Accept",
        callback: async () => {
          try {
            const next = applyPacketToProgression(progression, packet);
            const out = await syncProgression(actor, next);
            await actor.update({
              [`flags.${MODULE_ID}.progression`]: out.progression,
              [`flags.${MODULE_ID}.levelOffer`]: null,
              [`flags.${MODULE_ID}.dashboard.pendingChoices`]: false,
              [`flags.${MODULE_ID}.dashboard.stagedPacket`]: null
            });
            ui.notifications.info(`Accepted level offer for ${actor.name}`);
          } catch (err) {
            ui.notifications.error(String(err?.message || err));
          }
        }
      },
      reject: {
        label: "Reject",
        callback: async () => {
          await askGmRequest(actor, "level_offer_rejected", { offer_id: offer.offerId || "", packet_type: pType });
          await actor.setFlag(MODULE_ID, "levelOffer", null);
          ui.notifications.warn(`Rejected level offer for ${actor.name}; no level granted.`);
        }
      },
      ask: {
        label: "Ask GM To Refresh",
        callback: async () => {
          await askGmRequest(actor, "refresh_level_offer", { offer_id: offer.offerId || "" });
          ui.notifications.info("Sent refresh request to GM queue.");
        }
      }
    },
    default: "accept",
    close: () => {
      if (renderHook != null) Hooks.off("renderDialog", renderHook);
      openOfferMap.delete(key);
    }
  });

  renderHook = Hooks.on("renderDialog", (app, html) => {
    if (app !== dialog) return;
    attachSkillHandlers(html, dialog);
  });
  dialog.render(true);
}

async function scanAndOpenOffers() {
  if (!game.user) return;
  for (const actor of game.actors.contents) {
    if (!actor?.id) continue;
    if (!actor.isOwner) continue;
    const offer = actor.getFlag(MODULE_ID, "levelOffer");
    if (offer && offer.packet) {
      openLevelOffer(actor, offer).catch((err) => console.error("[wi-core-foundry] level offer dialog failed", err));
    }
  }
}

export function registerPlayerProgression() {
  Hooks.once("ready", () => {
    scanAndOpenOffers().catch((err) => console.error("[wi-core-foundry] offer scan failed", err));
  });

  Hooks.on("updateActor", (actor, changed) => {
    const levelOfferChanged = JSON.stringify(changed || {}).includes(`"flags":{"${MODULE_ID}":{"levelOffer"`);
    if (!levelOfferChanged) return;
    const offer = actor.getFlag(MODULE_ID, "levelOffer");
    if (offer && actor.isOwner) {
      openLevelOffer(actor, offer).catch((err) => console.error("[wi-core-foundry] offer open failed", err));
    }
  });
}
