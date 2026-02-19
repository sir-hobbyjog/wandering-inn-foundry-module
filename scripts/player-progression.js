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

function nextLevelXp(level) {
  const l = Math.max(1, Math.min(100, Number(level || 1)));
  return Math.floor((l * l * 180) + (l * 320));
}

function xpCostForLevels(currentLevel, deltaLevels) {
  let cost = 0;
  let lvl = Number(currentLevel || 1);
  for (let i = 0; i < Number(deltaLevels || 0); i += 1) {
    cost += nextLevelXp(lvl);
    lvl += 1;
  }
  return Math.max(0, cost);
}

function getOfferList(actor) {
  const list = Array.isArray(actor.getFlag(MODULE_ID, "levelOffers")) ? actor.getFlag(MODULE_ID, "levelOffers") : [];
  const legacy = actor.getFlag(MODULE_ID, "levelOffer");
  const merged = [...list];
  if (legacy?.offerId && !merged.some((o) => String(o?.offerId || "") === String(legacy.offerId))) {
    merged.push(legacy);
  }
  const byId = new Map();
  for (const row of merged) {
    if (!row || !row.packet) continue;
    const id = String(row.offerId || "");
    if (!id) continue;
    byId.set(id, row);
  }
  return [...byId.values()];
}

async function setOfferList(actor, offers) {
  const next = (Array.isArray(offers) ? offers : []).filter((o) => o && o.packet);
  const open = next.find((o) => String(o.status || "open") === "open") || null;
  await actor.setFlag(MODULE_ID, "levelOffers", next);
  await actor.setFlag(MODULE_ID, "levelOffer", open);
}

function offerTargetsUser(offer, userId) {
  const targets = Array.isArray(offer?.targetUserIds) ? offer.targetUserIds.map((x) => String(x)) : [];
  if (!targets.length) return true;
  return targets.includes(String(userId || ""));
}

async function markOfferDelivered(actor, offer, userId) {
  if (!actor?.isOwner && !game.user?.isGM) return false;
  const all = getOfferList(actor);
  const idx = all.findIndex((o) => String(o.offerId || "") === String(offer?.offerId || ""));
  if (idx < 0) return false;
  const row = foundry.utils.deepClone(all[idx]);
  const delivered = new Set((row.deliveredToUserIds || []).map((x) => String(x)));
  const me = String(userId || "");
  if (!me || delivered.has(me)) return false;
  delivered.add(me);
  row.deliveredToUserIds = [...delivered];
  row.lastDeliveredAt = new Date().toISOString();
  all[idx] = row;
  await setOfferList(actor, all);
  return true;
}

async function requestOfferActionFromGm(actorId, offerId, packet, action) {
  const sid = await resolveSessionId();
  try {
    await apiRequest("/foundry/actor/request", {
      method: "POST",
      body: {
        world_id: game.world.id,
        actor_id: String(actorId || ""),
        session_id: sid,
        request_type: action === "accept" ? "level_offer_accept" : "level_offer_reject",
        payload: {
          offer_id: String(offerId || ""),
          packet_type: String(packet?.packetType || ""),
        },
        priority: 25,
        status: "open",
      },
    });
  } catch (_err) {
    // best effort
  }
  try {
    game.socket?.emit(`module.${MODULE_ID}`, {
      type: "level-offer-action-request",
      actorId: String(actorId || ""),
      offerId: String(offerId || ""),
      action: action === "accept" ? "accept" : "reject",
      userId: String(game.user?.id || ""),
      userName: String(game.user?.name || ""),
    });
  } catch (_err) {
    // no-op
  }
}

function applyPacketToProgression(current, packet) {
  const next = foundry.utils.deepClone(current);
  const pType = normKey(packet.packetType || "standard");
  const delta = Number(packet.deltaLevels || 0);

  if (pType === "consolidation") {
    const fromIds = Array.isArray(packet?.consolidation?.fromClassIds)
      ? packet.consolidation.fromClassIds.map((x) => normKey(x)).filter(Boolean)
      : [normKey(packet?.consolidation?.from)].filter(Boolean);
    const targetClassId = normKey(packet?.consolidation?.targetClassId || packet?.consolidation?.to || "consolidated_class");
    const targetClassName = String(packet?.consolidation?.targetClassName || packet?.consolidation?.to || "Consolidated Class");
    if (fromIds.length < 2) throw new Error("Consolidation needs at least 2 source classes");
    let mergedLevel = 0;
    const remaining = [];
    let keepPrimary = false;
    for (const cls of next.classes || []) {
      if (fromIds.includes(normKey(cls.classId))) {
        mergedLevel += Number(cls.level || 1);
        if (cls.isPrimary) keepPrimary = true;
      } else {
        remaining.push(cls);
      }
    }
    if (mergedLevel <= 0) throw new Error("No source classes found for consolidation");
    remaining.push({
      classId: targetClassId,
      name: targetClassName,
      level: mergedLevel,
      track: "",
      isPrimary: keepPrimary || !remaining.some((c) => c.isPrimary),
      isCustom: true
    });
    next.classes = remaining;
    if (!(next.classes || []).some((c) => c.isPrimary) && next.classes.length) next.classes[0].isPrimary = true;
    if (Array.isArray(packet?.consolidation?.skillEdits) && packet.consolidation.skillEdits.length) {
      const skillById = new Map((next.skills || []).map((s) => [normKey(s.skillId || s.name), s]));
      for (const edit of packet.consolidation.skillEdits) {
        const sid = normKey(edit.skillId || edit.name);
        if (!sid || !skillById.has(sid)) continue;
        const target = skillById.get(sid);
        target.name = String(edit.name || target.name || sid);
        target.description = String(edit.description || target.description || "");
      }
      next.skills = [...skillById.values()];
    }
    return next;
  }

  if (pType === "new_class") {
    const newClass = packet.newClass || {
      classId: normKey(packet.classId),
      name: packet.classId,
      isPrimary: false,
      isCustom: true
    };
    next.level = Number(next.level || 1) + Math.max(0, delta || 1);
    const xpCost = xpCostForLevels(Number(current.level || 1), Math.max(0, delta || 1));
    next.xp = Math.max(0, Number(next.xp || 0) - xpCost);
    next.classes = Array.isArray(next.classes) ? next.classes : [];
    next.classes.push({
      classId: normKey(newClass.classId || newClass.name || "new_class"),
      name: String(newClass.name || newClass.classId || "New Class"),
      level: Math.max(1, delta || 1),
      track: "",
      isPrimary: !!newClass.isPrimary,
      isCustom: true
    });
  } else {
    const addTo = normKey(packet.classId || "");
    const appliedDelta = Math.max(1, delta || 1);
    next.level = Number(next.level || 1) + appliedDelta;
    const xpCost = xpCostForLevels(Number(current.level || 1), appliedDelta);
    next.xp = Math.max(0, Number(next.xp || 0) - xpCost);
    const target = (next.classes || []).find((c) => normKey(c.classId) === addTo) || (next.classes || []).find((c) => c.isPrimary) || (next.classes || [])[0];
    if (!target) throw new Error("No class found for level allocation");
    target.level = Number(target.level || 1) + appliedDelta;
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

async function acceptLevelOffer(actor, offer, packetOverride = null) {
  const packet = packetOverride || offer?.packet || {};
  const progression = actor.getFlag(MODULE_ID, "progression") || {};
  const next = applyPacketToProgression(progression, packet);
  const offerId = String(offer?.offerId || "");
  const remainingOffers = getOfferList(actor).filter((o) => String(o.offerId || "") !== offerId);
  const out = await syncProgression(actor, next);
  await actor.update({
    [`flags.${MODULE_ID}.progression`]: out.progression,
    [`flags.${MODULE_ID}.levelOffer`]: null,
    [`flags.${MODULE_ID}.levelOffers`]: remainingOffers,
    [`flags.${MODULE_ID}.dashboard.pendingChoices`]: false,
    [`flags.${MODULE_ID}.dashboard.stagedPacket`]: null
  });
  return out;
}

async function rejectLevelOffer(actor, offerId, packetType = "") {
  await askGmRequest(actor, "level_offer_rejected", { offer_id: offerId || "", packet_type: packetType || "" });
  const remainingOffers = getOfferList(actor).filter((o) => String(o.offerId || "") !== String(offerId || ""));
  await setOfferList(actor, remainingOffers);
}

async function openLevelOffer(actor, offer) {
  const key = `${game.user?.id || "u"}:${actor.id}:${offer.offerId || "offer"}`;
  if (openOfferMap.get(key)) return;
  openOfferMap.set(key, true);

  const me = String(game.user?.id || "");
  if (!offerTargetsUser(offer, me)) {
    openOfferMap.delete(key);
    return;
  }
  try {
    const delivered = await markOfferDelivered(actor, offer, me);
    if (delivered || !actor.isOwner) {
      game.socket?.emit(`module.${MODULE_ID}`, {
        type: "level-offer-delivered",
        actorId: actor.id,
        actorName: actor.name,
        offerId: String(offer.offerId || ""),
        userId: me,
        userName: String(game.user?.name || ""),
      });
    }
  } catch (_err) {
    // best effort
  }

  const progression = actor.getFlag(MODULE_ID, "progression") || {};
  const packet = offer.packet || {};
  const pType = normKey(packet.packetType || "standard");
  let trackers = ensureTrackers(actor, progression);
  try {
    await actor.setFlag(MODULE_ID, "skillTrackers", trackers);
  } catch (_err) {
    // non-owner players may not have write permission; continue with local state
  }

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
      actor.setFlag(MODULE_ID, "skillTrackers", trackers).catch(() => {});
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
      actor.setFlag(MODULE_ID, "skillTrackers", trackers).catch(() => {});
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
      try {
        await actor.setFlag(MODULE_ID, "skillTrackers", trackers);
      } catch (_err) {
        // non-owner: keep local-only tracker state
      }
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
            if (!actor.isOwner && !game.user?.isGM) {
              await requestOfferActionFromGm(actor.id, offer.offerId || "", packet, "accept");
              ui.notifications.info(`Acceptance sent to GM for ${actor.name}`);
              return;
            }
            await acceptLevelOffer(actor, offer, packet);
            ui.notifications.info(`Accepted level offer for ${actor.name}`);
          } catch (err) {
            ui.notifications.error(String(err?.message || err));
          }
        }
      },
      reject: {
        label: "Reject",
        callback: async () => {
          if (!actor.isOwner && !game.user?.isGM) {
            await requestOfferActionFromGm(actor.id, offer.offerId || "", packet, "reject");
            ui.notifications.warn(`Rejection sent to GM for ${actor.name}`);
            return;
          }
          await rejectLevelOffer(actor, offer.offerId || "", pType);
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
  const me = String(game.user.id || "");
  for (const actor of game.actors.contents) {
    if (!actor?.id) continue;
    const offers = getOfferList(actor);
    for (const offer of offers) {
      if (!offer?.packet) continue;
      if (String(offer.status || "open") !== "open") continue;
      if (!offerTargetsUser(offer, me)) continue;
      openLevelOffer(actor, offer).catch((err) => console.error("[wi-core-foundry] level offer dialog failed", err));
    }
  }
}

function messageTargetsUser(message, flag, userId) {
  if (String(flag?.recipientUserId || "").trim()) {
    return String(flag.recipientUserId) === String(userId || "");
  }
  const whisper = Array.isArray(message?.whisper) ? message.whisper.map((u) => String(u?.id || u)) : [];
  if (!whisper.length) return true;
  return whisper.includes(String(userId || ""));
}

async function scanChatOfferMessages() {
  const me = String(game.user?.id || "");
  if (!me) return;
  const messages = (game.messages?.contents || []).slice().reverse();
  for (const msg of messages) {
    const flag = msg?.getFlag?.(MODULE_ID, "levelOfferChat");
    if (!flag) continue;
    if (!messageTargetsUser(msg, flag, me)) continue;
    const actor = game.actors.get(String(flag.actorId || ""));
    if (!actor) continue;
    const offers = getOfferList(actor);
    const offerId = String(flag.offerId || "");
    const offer = offers.find((o) => String(o.offerId || "") === offerId)
      || {
        offerId,
        packet: flag.packet || {},
        targetUserIds: [me],
        status: "open",
      };
    if (!offer?.packet) continue;
    if (String(offer.status || "open") !== "open") continue;
    if (!offerTargetsUser(offer, me)) continue;
    openLevelOffer(actor, offer).catch((err) => console.error("[wi-core-foundry] chat offer open failed", err));
  }
}

async function notifyGmDeliveredOffers() {
  if (!game.user?.isGM) return;
  for (const actor of game.actors.contents) {
    if (!actor?.id || !actor.isOwner) continue;
    const offers = getOfferList(actor);
    let touched = false;
    for (const offer of offers) {
      const deliveredTo = Array.isArray(offer.deliveredToUserIds) ? offer.deliveredToUserIds.map((x) => String(x)) : [];
      if (!deliveredTo.length) continue;
      if (offer.gmNotifiedAt) continue;
      const names = deliveredTo.map((id) => game.users.get(id)?.name || id).join(", ");
      ui.notifications.info(`Packet delivered to ${names} for ${actor.name}.`);
      offer.gmNotifiedAt = new Date().toISOString();
      touched = true;
    }
    if (touched) await setOfferList(actor, offers);
  }
}

export function registerPlayerProgression() {
  Hooks.once("ready", () => {
    scanAndOpenOffers().catch((err) => console.error("[wi-core-foundry] offer scan failed", err));
    scanChatOfferMessages().catch((err) => console.error("[wi-core-foundry] chat offer scan failed", err));
    notifyGmDeliveredOffers().catch((err) => console.error("[wi-core-foundry] GM delivery notify scan failed", err));
    game.socket?.on(`module.${MODULE_ID}`, (payload) => {
      if (!payload) return;

      if (payload.type === "level-offer-notify") {
        const userIds = Array.isArray(payload.userIds) ? payload.userIds.map((x) => String(x)) : [];
        const me = String(game.user?.id || "");
        if (userIds.length && !userIds.includes(me)) return;
        const actor = game.actors.get(String(payload.actorId || ""));
        if (!actor) return;
        const offers = getOfferList(actor);
        const target = offers.find((o) => String(o.offerId || "") === String(payload.offerId || "")) || offers[offers.length - 1];
        if (target?.packet) {
          openLevelOffer(actor, target).catch((err) => console.error("[wi-core-foundry] socket offer open failed", err));
        } else {
          scanAndOpenOffers().catch((err) => console.error("[wi-core-foundry] socket scan failed", err));
        }
        return;
      }

      if (payload.type === "level-offer-delivered" && game.user?.isGM) {
        const actorName = String(payload.actorName || payload.actorId || "actor");
        const userName = String(payload.userName || payload.userId || "player");
        ui.notifications.info(`Packet delivered to ${userName} for ${actorName}.`);
        const actor = game.actors.get(String(payload.actorId || ""));
        if (actor?.isOwner) {
          const offers = getOfferList(actor);
          const idx = offers.findIndex((o) => String(o.offerId || "") === String(payload.offerId || ""));
          if (idx >= 0) {
            offers[idx] = {
              ...offers[idx],
              gmNotifiedAt: new Date().toISOString(),
            };
            setOfferList(actor, offers).catch(() => {});
          }
        }
        return;
      }

      if (payload.type === "level-offer-action-request" && game.user?.isGM) {
        const actor = game.actors.get(String(payload.actorId || ""));
        if (!actor) return;
        const offers = getOfferList(actor);
        const offer = offers.find((o) => String(o.offerId || "") === String(payload.offerId || "")) || actor.getFlag(MODULE_ID, "levelOffer");
        if (!offer?.packet) return;
        const action = String(payload.action || "");
        if (action === "accept") {
          acceptLevelOffer(actor, offer, offer.packet)
            .then(() => ui.notifications.info(`GM applied accepted packet for ${actor.name}.`))
            .catch((err) => ui.notifications.error(String(err?.message || err)));
          return;
        }
        if (action === "reject") {
          rejectLevelOffer(actor, String(offer.offerId || ""), String(offer.packet?.packetType || ""))
            .then(() => ui.notifications.warn(`GM recorded rejected packet for ${actor.name}.`))
            .catch((err) => ui.notifications.error(String(err?.message || err)));
        }
      }
    });
  });

  Hooks.on("updateActor", (actor, changed) => {
    const levelOfferChanged = foundry.utils.hasProperty(changed || {}, `flags.${MODULE_ID}.levelOffer`)
      || foundry.utils.hasProperty(changed || {}, `flags.${MODULE_ID}.levelOffers`)
      || JSON.stringify(changed || {}).includes(`"flags":{"${MODULE_ID}":{"levelOffer"`);
    if (!levelOfferChanged) return;
    const offers = getOfferList(actor);
    const me = String(game.user?.id || "");
    for (const offer of offers) {
      if (!offer?.packet) continue;
      if (String(offer.status || "open") !== "open") continue;
      if (!offerTargetsUser(offer, me)) continue;
      openLevelOffer(actor, offer).catch((err) => console.error("[wi-core-foundry] offer open failed", err));
    }
  });

  Hooks.on("renderChatMessage", (message, html) => {
    const flag = message?.getFlag?.(MODULE_ID, "levelOfferChat");
    if (!flag) return;
    const actorId = String(flag.actorId || "");
    const offerId = String(flag.offerId || "");
    const packet = flag.packet || null;

    html.on("click", "button[data-action='offer-accept']", async (ev) => {
      const button = ev.currentTarget;
      button.disabled = true;
      try {
        const actor = game.actors.get(actorId);
        if (!actor) {
          ui.notifications.warn("Actor not found.");
          button.disabled = false;
          return;
        }
        const offers = getOfferList(actor);
        const liveOffer = offers.find((o) => String(o.offerId || "") === offerId) || { offerId, packet };
        if (!actor.isOwner && !game.user?.isGM) {
          await requestOfferActionFromGm(actor.id, offerId, liveOffer?.packet || packet || {}, "accept");
          ui.notifications.info(`Acceptance sent to GM for ${actor.name}`);
          return;
        }
        await acceptLevelOffer(actor, liveOffer, liveOffer?.packet || packet || {});
        ui.notifications.info(`Accepted level packet for ${actor.name}`);
      } catch (err) {
        ui.notifications.error(String(err?.message || err));
        button.disabled = false;
      }
    });

    html.on("click", "button[data-action='offer-reject']", async (ev) => {
      const button = ev.currentTarget;
      button.disabled = true;
      try {
        const actor = game.actors.get(actorId);
        if (!actor) {
          ui.notifications.warn("Actor not found.");
          button.disabled = false;
          return;
        }
        if (!actor.isOwner && !game.user?.isGM) {
          await requestOfferActionFromGm(actor.id, offerId, packet || {}, "reject");
          ui.notifications.warn(`Rejection sent to GM for ${actor.name}`);
          return;
        }
        const pType = String(packet?.packetType || "");
        await rejectLevelOffer(actor, offerId, pType);
        ui.notifications.warn(`Rejected level packet for ${actor.name}`);
      } catch (err) {
        ui.notifications.error(String(err?.message || err));
        button.disabled = false;
      }
    });
  });

  Hooks.on("createChatMessage", (message) => {
    const flag = message?.getFlag?.(MODULE_ID, "levelOfferChat");
    if (!flag) return;
    const me = String(game.user?.id || "");
    if (!messageTargetsUser(message, flag, me)) return;
    const actor = game.actors.get(String(flag.actorId || ""));
    if (!actor) return;
    const offers = getOfferList(actor);
    const offer = offers.find((o) => String(o.offerId || "") === String(flag.offerId || ""))
      || {
        offerId: String(flag.offerId || ""),
        packet: flag.packet || {},
        targetUserIds: [me],
        status: "open",
      };
    if (!offer?.packet) return;
    openLevelOffer(actor, offer).catch((err) => console.error("[wi-core-foundry] create chat offer open failed", err));
  });
}
