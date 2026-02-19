import { apiRequest } from "./api-client.js";
import { resolveSessionId } from "./session.js";
import { buildProgressionFromActor } from "./progression.js";
import { syncActorProgression } from "./actor-sync.js";

const MODULE_ID = "wi-core-foundry";

function normKey(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function escapeHtml(v) {
  return String(v || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function nextLevelXp(level) {
  const l = Math.max(1, Math.min(100, Number(level || 1)));
  return Math.floor((l * l * 180) + (l * 320));
}

function xpCostForLevels(currentLevel, deltaLevels) {
  let total = 0;
  let lvl = Number(currentLevel || 1);
  for (let i = 0; i < Number(deltaLevels || 0); i += 1) {
    total += nextLevelXp(lvl);
    lvl += 1;
  }
  return Math.max(0, total);
}

function skillIdFromName(name) {
  const n = normKey(name || "custom_skill");
  return n || `custom_skill_${Math.random().toString(36).slice(2, 8)}`;
}

function formatDateIso(iso) {
  if (!iso) return "-";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "-";
  return dt.toLocaleString();
}

function ensureDashboardMeta(actor) {
  const meta = actor.getFlag(MODULE_ID, "dashboard") || {};
  return {
    eligibleOverride: !!meta.eligibleOverride,
    pendingChoices: !!meta.pendingChoices,
    needsReview: !!meta.needsReview,
    levelingFrozen: !!meta.levelingFrozen,
    recentActivityTags: Array.isArray(meta.recentActivityTags) ? meta.recentActivityTags : [],
    undoneXpEventIds: Array.isArray(meta.undoneXpEventIds) ? meta.undoneXpEventIds : [],
    stagedPacket: meta.stagedPacket || null,
    progressionSnapshots: Array.isArray(meta.progressionSnapshots) ? meta.progressionSnapshots : [],
    lockedClassIds: Array.isArray(meta.lockedClassIds) ? meta.lockedClassIds : []
  };
}

function classSummary(classes) {
  const list = Array.isArray(classes) ? classes : [];
  if (!list.length) return "Adventurer 1";
  return list.map((c) => `${c.name || c.classId || "Class"} ${Number(c.level || 1)}`).join(" / ");
}

function speciesSummary(species) {
  if (!species) return "Unknown";
  const tags = [species.primary, ...(species.subtypes || [])].filter(Boolean);
  return tags.join(", ") || "Unknown";
}

function statusForActor(progression, meta) {
  if (meta.levelingFrozen) return "Frozen";
  if (meta.needsReview) return "Needs GM review";
  if (meta.pendingChoices) return "Pending choices";
  const xp = Number(progression.xp || 0);
  const needed = nextLevelXp(progression.level || 1);
  if (meta.eligibleOverride || xp >= needed) return "Eligible to level";
  return "On track";
}

function activityTagCounts(rows) {
  const counts = new Map();
  for (const row of rows) {
    for (const tag of row.activityTags || []) {
      const k = String(tag || "").trim();
      if (!k) continue;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
}

function parseCsvList(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => normKey(s))
    .filter(Boolean);
}

function getActorOffers(actor) {
  const list = Array.isArray(actor?.getFlag?.(MODULE_ID, "levelOffers")) ? actor.getFlag(MODULE_ID, "levelOffers") : [];
  const legacy = actor?.getFlag?.(MODULE_ID, "levelOffer");
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

async function mutateProgression(actor, fn) {
  const current = actor.getFlag(MODULE_ID, "progression") || buildProgressionFromActor(actor);
  const next = foundry.utils.deepClone(current);
  fn(next);
  await actor.setFlag(MODULE_ID, "progression", next);
  return syncActorProgression(actor);
}

async function appendXp(actor, amount, reason, tags, link) {
  const n = Number(amount || 0);
  if (!Number.isFinite(n) || n === 0) throw new Error("XP amount must be non-zero");

  const meta = ensureDashboardMeta(actor);
  const evtTags = (Array.isArray(tags) ? tags : String(tags || "").split(",")).map((t) => normKey(t)).filter(Boolean);
  const evtReason = String(reason || "Manual XP award").trim();
  const linkedRef = String(link || "").trim();
  const sessionId = await resolveSessionId();

  await mutateProgression(actor, (p) => {
    p.xp = Math.max(0, Number(p.xp || 0) + n);
  });

  const mergedTags = [...new Set([...(meta.recentActivityTags || []), ...evtTags])].slice(-20);
  await apiRequest("/foundry/actor/xp/add", {
    method: "POST",
    body: {
      world_id: game.world.id,
      actor_id: actor.id,
      session_id: sessionId,
      amount: n,
      reason: evtReason,
      tags: evtTags,
      linked_ref: linkedRef
    }
  });
  await upsertProgressionMeta(actor, {
    recentActivityTags: mergedTags
  }, sessionId);

  await actor.setFlag(MODULE_ID, "dashboard", {
    ...meta,
    recentActivityTags: mergedTags
  });
}

async function upsertProgressionMeta(actor, patch, sessionId = "") {
  const sid = String(sessionId || "").trim() || (await resolveSessionId());
  const local = ensureDashboardMeta(actor);
  const payload = {
    world_id: game.world.id,
    actor_id: actor.id,
    session_id: sid,
    leveling_frozen: patch.levelingFrozen ?? local.levelingFrozen,
    pending_choices: patch.pendingChoices ?? local.pendingChoices,
    needs_gm_review: patch.needsReview ?? local.needsReview,
    recent_activity_tags: patch.recentActivityTags ?? local.recentActivityTags
  };
  await apiRequest("/foundry/actor/progression/meta/upsert", {
    method: "POST",
    body: payload
  });
}

async function syncProgressionPayload(actor, progression) {
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

function applyPacketToProgression(current, packet) {
  const next = foundry.utils.deepClone(current || {});
  const pType = normKey(packet?.packetType || "standard");
  const delta = Number(packet?.deltaLevels || 0);

  if (pType === "consolidation") {
    const fromIds = Array.isArray(packet?.consolidation?.fromClassIds)
      ? packet.consolidation.fromClassIds.map((x) => normKey(x)).filter(Boolean)
      : [normKey(packet?.consolidation?.from)].filter(Boolean);
    const targetClassId = normKey(packet?.consolidation?.targetClassId || packet?.consolidation?.to || "consolidated_class");
    const targetClassName = String(packet?.consolidation?.targetClassName || packet?.consolidation?.to || "Consolidated Class");
    if (fromIds.length < 2) throw new Error("Consolidation needs at least 2 source classes");
    let mergedLevel = 0;
    let primarySeen = false;
    const remaining = [];
    for (const cls of next.classes || []) {
      if (fromIds.includes(normKey(cls.classId))) {
        mergedLevel += Number(cls.level || 1);
        primarySeen = primarySeen || !!cls.isPrimary;
      } else {
        remaining.push(cls);
      }
    }
    if (mergedLevel <= 0) throw new Error("No selected classes found for consolidation");
    remaining.push({
      classId: targetClassId,
      name: targetClassName,
      level: mergedLevel,
      track: "",
      isPrimary: primarySeen || !remaining.some((c) => c.isPrimary),
      isCustom: true
    });
    next.classes = remaining;
    if (!(next.classes || []).some((c) => c.isPrimary) && next.classes.length) next.classes[0].isPrimary = true;
    if (Array.isArray(packet?.consolidation?.skillEdits)) {
      const edits = packet.consolidation.skillEdits;
      const byId = new Map((next.skills || []).map((s) => [normKey(s.skillId || s.name), s]));
      for (const edit of edits) {
        const sid = normKey(edit.skillId || edit.name);
        if (!sid || !byId.has(sid)) continue;
        const target = byId.get(sid);
        target.name = String(edit.name || target.name || sid);
        target.description = String(edit.description || target.description || "");
      }
      next.skills = [...byId.values()];
    }
    return next;
  }

  const appliedDelta = Math.max(1, delta || 1);
  const previousLevel = Number(next.level || 1);
  next.level = previousLevel + appliedDelta;
  next.xp = Math.max(0, Number(next.xp || 0) - xpCostForLevels(previousLevel, appliedDelta));
  next.classes = Array.isArray(next.classes) ? next.classes : [];

  if (pType === "new_class") {
    const newClass = packet.newClass || {};
    next.classes.push({
      classId: normKey(newClass.classId || newClass.name || packet.classId || "new_class"),
      name: String(newClass.name || newClass.classId || "New Class"),
      level: appliedDelta,
      track: "",
      isPrimary: !!newClass.isPrimary,
      isCustom: true
    });
  } else {
    const classId = normKey(packet.classId || "");
    const target = next.classes.find((c) => normKey(c.classId) === classId) || next.classes.find((c) => c.isPrimary) || next.classes[0];
    if (!target) throw new Error("No class available for level allocation");
    target.level = Number(target.level || 1) + appliedDelta;
  }

  const picks = Array.isArray(packet.skillPicks) ? packet.skillPicks : [];
  if (picks.length) {
    next.skills = Array.isArray(next.skills) ? next.skills : [];
    for (const s of picks) {
      if (!String(s.name || "").trim()) continue;
      next.skills.push({
        skillId: skillIdFromName(s.skillId || s.name),
        name: String(s.name || "").trim(),
        source: String(s.source || "llm"),
        tier: String(s.tier || "custom"),
        description: String(s.description || ""),
        tags: Array.isArray(s.tags) ? s.tags.map((t) => normKey(t)).filter(Boolean) : [],
        cooldown: Number(s.cooldown || 0),
        trigger: String(s.trigger || ""),
        effect: String(s.effect || ""),
        counterplay: String(s.counterplay || "")
      });
    }
  }
  return next;
}

async function applyLevelUp(actor, deltaLevels, classId, skillPicks) {
  const sessionId = await resolveSessionId();
  const payload = {
    world_id: game.world.id,
    actor_id: actor.id,
    session_id: sessionId,
    delta_levels: Number(deltaLevels || 1),
    class_allocation: [{ classId: normKey(classId), addLevels: Number(deltaLevels || 1) }],
    skill_picks: Array.isArray(skillPicks) ? skillPicks : []
  };
  try {
    return await apiRequest("/foundry/actor/progression/level-up", {
      method: "POST",
      body: payload
    });
  } catch (err) {
    const msg = String(err?.responseText || err?.message || "");
    if (Number(err?.status || 0) === 404 && msg.includes("progression not found")) {
      await syncActorProgression(actor);
      return apiRequest("/foundry/actor/progression/level-up", {
        method: "POST",
        body: payload
      });
    }
    throw err;
  }
}

function collectPartyActors() {
  const fromScene = new Map();
  for (const token of canvas?.scene?.tokens || []) {
    const actor = game.actors.get(token.actorId);
    if (!actor) continue;
    if (fromScene.has(actor.id)) continue;
    if (actor.type === "character" || actor.hasPlayerOwner) fromScene.set(actor.id, actor);
  }
  if (fromScene.size) return [...fromScene.values()];
  return game.actors.filter((a) => a.type === "character" || a.hasPlayerOwner);
}

async function promptXpEntry({ title = "Add XP", defaultAmount = 100, defaultReason = "GM input", defaultTags = ["combat"] } = {}) {
  return new Promise((resolve) => {
    const content = `
<div class="wi-xp-card">
  <div class="wi-form-row"><label>XP Amount</label><input id="wi-xp-amount" type="number" value="${Number(defaultAmount || 0)}" /></div>
  <div class="wi-form-row"><label>Reason</label><input id="wi-xp-reason" type="text" value="${escapeHtml(defaultReason)}" /></div>
  <div class="wi-chip-row">
    <button type="button" data-action="xp-reason-combat">Combat</button>
    <button type="button" data-action="xp-reason-session">Session End</button>
  </div>
  <div class="wi-form-row">
    <label>Tags</label>
    <div class="wi-check-grid">
      <label><input type="checkbox" class="wi-xp-tag" value="combat" ${defaultTags.includes("combat") ? "checked" : ""}/> Combat</label>
      <label><input type="checkbox" class="wi-xp-tag" value="social" ${defaultTags.includes("social") ? "checked" : ""}/> Social</label>
      <label><input type="checkbox" class="wi-xp-tag" value="near_death" ${defaultTags.includes("near_death") ? "checked" : ""}/> Near Death</label>
      <label><input type="checkbox" class="wi-xp-tag" value="unique" ${defaultTags.includes("unique") ? "checked" : ""}/> Unique</label>
    </div>
  </div>
</div>`;

    const dialog = new Dialog({
      title,
      content,
      buttons: {
        submit: {
          label: "Apply",
          callback: (html) => {
            const amount = Number(html.find("#wi-xp-amount").val() || 0);
            const reason = String(html.find("#wi-xp-reason").val() || "GM input").trim() || "GM input";
            const tags = html
              .find(".wi-xp-tag:checked")
              .map((_, el) => String(el.value || "").trim())
              .get()
              .map(normKey)
              .filter(Boolean);
            resolve({ amount, reason, tags });
          }
        },
        cancel: {
          label: "Cancel",
          callback: () => resolve(null)
        }
      },
      default: "submit",
      render: (html) => {
        html.on("click", "button[data-action='xp-reason-combat']", () => {
          html.find("#wi-xp-reason").val("Combat encounter");
          html.find(".wi-xp-tag[value='combat']").prop("checked", true);
        });
        html.on("click", "button[data-action='xp-reason-session']", () => {
          html.find("#wi-xp-reason").val("Session end");
          html.find(".wi-xp-tag[value='unique']").prop("checked", true);
        });
      },
      close: () => resolve(null)
    });
    dialog.render(true);
  });
}

function collectChatContextForActor(actor, limit = 24) {
  const rows = [];
  const messages = game.messages?.contents || [];
  for (let i = messages.length - 1; i >= 0 && rows.length < limit; i -= 1) {
    const msg = messages[i];
    const speakerActor = String(msg?.speaker?.actor || "");
    const whisperIds = Array.isArray(msg?.whisper) ? msg.whisper.map((u) => String(u.id || u)) : [];
    const actorOwners = game.users.filter((u) => actor.testUserPermission(u, "OWNER")).map((u) => String(u.id));
    const intersectsOwners = whisperIds.some((id) => actorOwners.includes(id));
    if (speakerActor !== actor.id && !intersectsOwners) continue;
    const text = String(msg?.content || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const alias = msg?.speaker?.alias || msg?.user?.name || "msg";
    rows.push(`${alias}: ${text.slice(0, 280)}`);
  }
  return rows;
}

class WICoreGMDashboard extends Application {
  constructor(options = {}) {
    super(options);
    this.state = {
      search: "",
      status: "all",
      filterMulticlass: false,
      filterMissingChoices: false,
      selectedActorId: "",
      activeTab: "overview",
      gmOnly: !!game.user?.isGM,
      includeFrozen: true
    };
    this.historyCache = new Map();
    this.levelDrafts = new Map();
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "wi-core-gm-dashboard",
      title: "WI GM Dashboard",
      template: "",
      width: 1450,
      height: 860,
      resizable: true,
      classes: ["wi-gm-dashboard-app"]
    });
  }

  _getDraft(actor, progression) {
    const key = String(actor?.id || "");
    if (!key) return null;
    if (!this.levelDrafts.has(key)) {
      const classes = Array.isArray(progression?.classes) ? progression.classes : [];
      const primary = classes.find((c) => c.isPrimary) || classes[0] || { classId: "adventurer", name: "Adventurer" };
      this.levelDrafts.set(key, {
        packetType: "standard",
        classId: String(primary.classId || "adventurer"),
        deltaLevels: 1,
        skillRows: [],
        generatedAt: "",
        contextSummary: ""
      });
    }
    return this.levelDrafts.get(key);
  }

  _setDraft(actorId, patch) {
    const key = String(actorId || "");
    const current = this.levelDrafts.get(key) || {
      packetType: "standard",
      classId: "adventurer",
      deltaLevels: 1,
      skillRows: [],
      generatedAt: "",
      contextSummary: ""
    };
    this.levelDrafts.set(key, { ...current, ...patch });
  }

  _readSkillRowsFromUi(root) {
    const rows = [];
    root.find(".wi-skill-row").each((_, el) => {
      const row = $(el);
      const enabled = !!row.find(".wi-skill-enabled").is(":checked");
      const name = String(row.find(".wi-skill-name").val() || "").trim();
      const description = String(row.find(".wi-skill-description").val() || "").trim();
      const cooldown = Number(row.find(".wi-skill-cooldown").val() || 0);
      const source = String(row.find(".wi-skill-source").val() || "llm");
      if (!enabled || !name) return;
      rows.push({
        skillId: skillIdFromName(name),
        name,
        description,
        source,
        cooldown,
        tier: "custom",
        tags: [source === "llm" ? "llm" : "custom"]
      });
    });
    return rows;
  }

  _readAllDraftSkillRowsFromUi(root) {
    return root.find(".wi-skill-row").map((_, el) => {
      const row = $(el);
      return {
        enabled: !!row.find(".wi-skill-enabled").is(":checked"),
        source: String(row.find(".wi-skill-source").val() || "llm"),
        name: String(row.find(".wi-skill-name").val() || ""),
        description: String(row.find(".wi-skill-description").val() || ""),
        cooldown: Number(row.find(".wi-skill-cooldown").val() || 0)
      };
    }).get();
  }

  async _promptPacketRecipients(actor, defaultUserIds = []) {
    const players = game.users.filter((u) => !u.isGM);
    if (!players.length) return [];
    const checked = new Set((defaultUserIds || []).map((x) => String(x)));
    const rows = players.map((u) => {
      const uid = String(u.id || "");
      const isChecked = checked.has(uid) ? "checked" : "";
      const suffix = u.active ? "" : " (offline)";
      return `<label><input type="checkbox" class="wi-packet-recipient" value="${escapeHtml(uid)}" ${isChecked}/> ${escapeHtml(String(u.name || uid))}${suffix}</label>`;
    }).join("<br/>");
    return new Promise((resolve) => {
      new Dialog({
        title: `Select Packet Recipients: ${actor.name}`,
        content: `<div>${rows || "No players found."}</div>`,
        buttons: {
          send: {
            label: "Use Selected",
            callback: (html) => {
              const ids = html.find(".wi-packet-recipient:checked").map((_, el) => String(el.value || "")).get();
              resolve(ids);
            }
          },
          cancel: { label: "Cancel", callback: () => resolve([]) }
        },
        default: "send",
        close: () => resolve([])
      }).render(true);
    });
  }

  async _resolvePacketRecipients(actor, existingUserIds = []) {
    const linkedCharacterUsers = game.users.filter((u) => !u.isGM && String(u.character?.id || "") === actor.id);
    const permissionUsers = game.users.filter((u) => {
      if (u.isGM) return false;
      return actor.testUserPermission(u, "OWNER")
        || actor.testUserPermission(u, "OBSERVER")
        || actor.testUserPermission(u, "LIMITED");
    });
    const preselected = [
      ...existingUserIds.map((x) => String(x)),
      ...linkedCharacterUsers.map((u) => String(u.id || "")),
      ...permissionUsers.map((u) => String(u.id || "")),
    ].filter(Boolean);
    const dedup = [...new Set(preselected)];
    if (dedup.length) return dedup;
    return this._promptPacketRecipients(actor, dedup);
  }

  async _storeOffer(actor, offer) {
    const all = getActorOffers(actor).filter((o) => String(o.offerId || "") !== String(offer.offerId || ""));
    all.push(offer);
    const open = all.find((o) => String(o.status || "open") === "open") || null;
    await actor.setFlag(MODULE_ID, "levelOffers", all);
    await actor.setFlag(MODULE_ID, "levelOffer", open);
  }

  async _removeOffer(actor, offerId) {
    const next = getActorOffers(actor).filter((o) => String(o.offerId || "") !== String(offerId || ""));
    const open = next.find((o) => String(o.status || "open") === "open") || null;
    await actor.setFlag(MODULE_ID, "levelOffers", next);
    await actor.setFlag(MODULE_ID, "levelOffer", open);
    return next;
  }

  async _dispatchOffer(actor, offer, userIds, isResend = false) {
    const packet = offer.packet || {};
    const skillLines = (packet.skillPicks || [])
      .map((s) => `<li><strong>${escapeHtml(s.name || s.skillId || "Skill")}</strong>: ${escapeHtml(s.description || "")}</li>`)
      .join("");
    for (const uid of userIds) {
      const content = `<div class="wi-level-offer-chat">
<p><strong>Level Packet Ready:</strong> ${escapeHtml(actor.name)}</p>
<p>Type: ${escapeHtml(packet.packetType || "standard")}</p>
<p>Delta: +${Number(packet.deltaLevels || 1)} to ${escapeHtml(packet.classId || "primary")}</p>
<details><summary>Skill Picks</summary><ul>${skillLines || "<li>No skill picks</li>"}</ul></details>
<div class="wi-tab-actions">
  <button type="button" data-action="offer-accept" data-actor-id="${actor.id}" data-offer-id="${offer.offerId}">Accept</button>
  <button type="button" data-action="offer-reject" data-actor-id="${actor.id}" data-offer-id="${offer.offerId}">Reject</button>
</div>
</div>`;
      await ChatMessage.create({
        content,
        speaker: { alias: "GM Progression Packet" },
        whisper: [String(uid)],
        flags: {
          [MODULE_ID]: {
            levelOfferChat: {
              actorId: actor.id,
              offerId: offer.offerId,
              packet,
              recipientUserId: String(uid),
            }
          }
        }
      });
    }
    try {
      game.socket?.emit(`module.${MODULE_ID}`, {
        type: "level-offer-notify",
        actorId: actor.id,
        offerId: offer.offerId,
        userIds: userIds.map((x) => String(x)),
      });
    } catch (_err) {
      // no-op
    }
    const action = isResend ? "Re-sent" : "Sent";
    ui.notifications.info(`${action} packet for ${actor.name} to ${userIds.length} player(s).`);
  }

  async _generateSkillSuggestions(actor, classId, deltaLevels) {
    const progression = actor.getFlag(MODULE_ID, "progression") || buildProgressionFromActor(actor);
    const meta = ensureDashboardMeta(actor);
    const sessionId = await resolveSessionId();
    const chatSnippets = collectChatContextForActor(actor, 20);
    let combatSnippets = [];
    try {
      const out = await apiRequest(`/foundry/actor/combat/events?world_id=${encodeURIComponent(game.world.id)}&actor_id=${encodeURIComponent(actor.id)}&session_id=${encodeURIComponent(sessionId)}&limit=20`);
      combatSnippets = (out.items || []).map((e) => {
        const p = e.payload || {};
        return `combat round=${p.round || 0} turn=${p.turn || 0} hp=${p.hp_current || 0} ac=${p.ac_current || 0} conditions=${(p.conditions || []).join(",")}`;
      });
    } catch (_err) {
      combatSnippets = [];
    }
    const payload = {
      world_id: game.world.id,
      actor_id: actor.id,
      session_id: sessionId,
      class_id: normKey(classId),
      level_delta: Number(deltaLevels || 1),
      recent_activity_tags: meta.recentActivityTags || [],
      chat_snippets: chatSnippets,
      combat_snippets: combatSnippets,
      existing_classes: (progression.classes || []).map((c) => String(c.classId || c.name || "")),
      existing_class_levels: (progression.classes || []).map((c) => ({
        class_id: String(c.classId || ""),
        class_name: String(c.name || c.classId || ""),
        level: Number(c.level || 1)
      })),
      existing_skills: (progression.skills || []).map((s) => String(s.skillId || s.name || "")),
      species_primary: String(progression.species?.primary || ""),
      actor_name: String(actor.name || "")
    };
    const out = await apiRequest("/foundry/actor/skill-suggestions", {
      method: "POST",
      body: payload
    });
    const suggestions = Array.isArray(out.suggestions) ? out.suggestions : [];
    return {
      suggestions: suggestions.map((s) => ({
        enabled: true,
        source: String(s.source || "llm"),
        name: String(s.name || ""),
        description: String(s.description || ""),
        cooldown: Number(s.cooldown || 0)
      })),
      contextSummary: `chat:${chatSnippets.length} combat:${combatSnippets.length} tags:${(meta.recentActivityTags || []).length} model:${out.model || ""}`
    };
  }

  async getData() {
    const actors = collectPartyActors();
    const sessionId = await resolveSessionId();
    if (!this.state.selectedActorId && actors.length) this.state.selectedActorId = actors[0].id;

    let metaByActor = new Map();
    try {
      const out = await apiRequest(`/foundry/actor/progression/meta/list?world_id=${encodeURIComponent(game.world.id)}&session_id=${encodeURIComponent(sessionId)}`);
      metaByActor = new Map((out.items || []).map((m) => [String(m.actor_id), m]));
    } catch (_err) {
      metaByActor = new Map();
    }

    const rows = actors.map((actor) => {
      const progression = actor.getFlag(MODULE_ID, "progression") || buildProgressionFromActor(actor);
      const localMeta = ensureDashboardMeta(actor);
      const dbMeta = metaByActor.get(actor.id);
      const meta = {
        ...localMeta,
        pendingChoices: dbMeta ? !!dbMeta.pending_choices : localMeta.pendingChoices,
        needsReview: dbMeta ? !!dbMeta.needs_gm_review : localMeta.needsReview,
        levelingFrozen: dbMeta ? !!dbMeta.leveling_frozen : localMeta.levelingFrozen,
        recentActivityTags: dbMeta && Array.isArray(dbMeta.recent_activity_tags) ? dbMeta.recent_activity_tags : localMeta.recentActivityTags
      };
      const status = statusForActor(progression, meta);
      const needed = nextLevelXp(progression.level || 1);
      const xp = Number(progression.xp || 0);
      const pct = Math.max(0, Math.min(100, Math.round((xp / Math.max(1, needed)) * 100)));
      const pendingClassNote = localMeta?.stagedPacket?.packetType === "new_class" && localMeta?.stagedPacket?.newClass?.name
        ? ` + pending ${String(localMeta.stagedPacket.newClass.name)}`
        : "";

      return {
        actor,
        actorId: actor.id,
        name: actor.name,
        img: actor.img,
        level: Number(progression.level || 1),
        classSummary: `${classSummary(progression.classes)}${pendingClassNote}`,
        speciesSummary: speciesSummary(progression.species),
        status,
        xp,
        nextXp: needed,
        xpPct: pct,
        isMulticlass: (progression.classes || []).length > 1,
        pendingChoices: meta.pendingChoices,
        needsReview: meta.needsReview,
        activityTags: (meta.recentActivityTags || []).slice(-8),
        stagedPacket: meta.stagedPacket,
        progression,
        meta
      };
    });

    const filtered = rows.filter((r) => {
      const s = this.state.search.trim().toLowerCase();
      if (s && !`${r.name} ${r.classSummary} ${r.speciesSummary}`.toLowerCase().includes(s)) return false;
      if (this.state.status !== "all" && normKey(r.status) !== normKey(this.state.status)) return false;
      if (this.state.filterMulticlass && !r.isMulticlass) return false;
      if (this.state.filterMissingChoices && !r.pendingChoices) return false;
      if (!this.state.includeFrozen && r.status === "Frozen") return false;
      return true;
    });

    let selected = filtered.find((r) => r.actorId === this.state.selectedActorId) || rows.find((r) => r.actorId === this.state.selectedActorId) || filtered[0] || rows[0] || null;
    if (selected) this.state.selectedActorId = selected.actorId;
    const levelDraft = selected ? this._getDraft(selected.actor, selected.progression) : null;

    let history = [];
    let xpEvents = [];
    if (selected) {
      const key = `${game.world.id}::${selected.actorId}`;
      if (this.historyCache.has(key)) {
        history = this.historyCache.get(key);
      } else {
        try {
          const out = await apiRequest(`/foundry/actor/progression/history?world_id=${encodeURIComponent(game.world.id)}&actor_id=${encodeURIComponent(selected.actorId)}&limit=50`);
          history = out.events || [];
          this.historyCache.set(key, history);
        } catch (_err) {
          history = [];
        }
      }
      try {
        const out = await apiRequest(`/foundry/actor/xp/events?world_id=${encodeURIComponent(game.world.id)}&actor_id=${encodeURIComponent(selected.actorId)}&session_id=${encodeURIComponent(sessionId)}&limit=80`);
        xpEvents = out.items || [];
      } catch (_err) {
        xpEvents = [];
      }
    }

    const pending = rows.filter((r) => r.pendingChoices || r.stagedPacket);
    const validationIssues = rows.filter((r) => r.pendingChoices || r.needsReview || ((r.progression.classes || []).length && (r.progression.classes || []).filter((c) => c.isPrimary).length !== 1));
    const highlights = activityTagCounts(rows);
    const packetQueue = [];
    for (const r of rows) {
      const offers = getActorOffers(r.actor) || [];
      for (const offer of offers) {
        if (!offer?.packet) continue;
        if (String(offer.status || "open") !== "open") continue;
        const targets = (offer.targetUserIds || []).map((id) => game.users.get(String(id))?.name || String(id));
        packetQueue.push({
          actorId: r.actorId,
          actorName: r.name,
          offerId: String(offer.offerId || ""),
          packetType: String(offer.packet?.packetType || "standard"),
          deltaLevels: Number(offer.packet?.deltaLevels || 1),
          classId: String(offer.packet?.classId || "primary"),
          createdAt: String(offer.createdAt || ""),
          targetNames: targets,
          deliveredCount: Array.isArray(offer.deliveredToUserIds) ? offer.deliveredToUserIds.length : 0,
        });
      }
    }

    let sessionMarks = [];
    try {
      const out = await apiRequest(`/foundry/session/marks?world_id=${encodeURIComponent(game.world.id)}&session_id=${encodeURIComponent(sessionId)}&limit=50`);
      sessionMarks = out.items || [];
    } catch (_err) {
      sessionMarks = [];
    }

    let playerRequests = [];
    try {
      const out = await apiRequest(`/foundry/actor/requests?world_id=${encodeURIComponent(game.world.id)}&session_id=${encodeURIComponent(sessionId)}&limit=100`);
      playerRequests = out.items || [];
    } catch (_err) {
      playerRequests = [];
    }

    return {
      rows,
      filtered,
      selected,
      history,
      xpEvents,
      pending,
      packetQueue,
      validationIssues,
      highlights,
      playerRequests,
      sessionMarks,
      sessionId,
      levelDraft,
      tabs: [
        { id: "overview", label: "Overview" },
        { id: "xp", label: "XP & Progress" },
        { id: "levelup", label: "Level-Up Builder" },
        { id: "classes", label: "Class Tools" },
        { id: "history", label: "History / Logs" }
      ],
      activeTab: this.state.activeTab,
      gmOnly: this.state.gmOnly,
      statusOptions: ["all", "eligible_to_level", "pending_choices", "needs_gm_review", "on_track", "frozen"],
      state: this.state
    };
  }

  async _renderInner(data) {
    return this._buildHtml(data);
  }

  _buildHtml(data) {
    const selected = data.selected;
    const roster = data.filtered.map((r) => {
      const activeCls = r.actorId === data.selected?.actorId ? "is-selected" : "";
      const chips = r.activityTags.map((t) => `<span class="wi-chip">${escapeHtml(t)}</span>`).join("") || `<span class="wi-chip wi-chip-muted">none</span>`;
      const xpLine = data.gmOnly ? `<div class="wi-roster-xp"><div class="wi-bar"><span style="width:${r.xpPct}%"></span></div><small>${r.xp} / ${r.nextXp}</small></div>` : "";
      const sendDisabled = r.stagedPacket ? "" : "disabled";

      return `
<div class="wi-roster-card ${activeCls}" data-action="select-actor" data-actor-id="${r.actorId}">
  <img src="${escapeHtml(r.img)}" class="wi-avatar" />
  <div class="wi-roster-main">
    <div class="wi-roster-head"><strong>${escapeHtml(r.name)}</strong><span class="wi-status">${escapeHtml(r.status)}</span></div>
    <div class="wi-row-sub">Lv ${r.level} - ${escapeHtml(r.classSummary)}</div>
    <div class="wi-row-sub">${escapeHtml(r.speciesSummary)}</div>
    ${xpLine}
    <div class="wi-chip-row">${chips}</div>
    <div class="wi-quick-actions">
      <button type="button" data-action="add-xp" data-actor-id="${r.actorId}">+XP</button>
      <button type="button" data-action="quick-level" data-actor-id="${r.actorId}">Level Up</button>
      <button type="button" data-action="open-sheet" data-actor-id="${r.actorId}">Open Sheet</button>
      <button type="button" data-action="send-packet" data-actor-id="${r.actorId}" ${sendDisabled}>Send Packet</button>
    </div>
  </div>
</div>`;
    }).join("");

    const pendingPacketNote = selected?.stagedPacket
      ? `Pending packet: ${selected.stagedPacket.packetType || "standard"} ${selected.stagedPacket.newClass?.name ? `(${selected.stagedPacket.newClass.name})` : ""}`
      : "No pending packet.";
    const overview = selected ? `
<div class="wi-overview-grid">
  <div><label>Current Class Stack</label><p>${escapeHtml(selected.classSummary)}</p></div>
  <div><label>Species</label><p>${escapeHtml(selected.speciesSummary)}</p><div class="wi-tab-actions"><button type="button" data-action="edit-species" data-actor-id="${selected.actorId}">Edit Species</button></div></div>
  <div><label>Next Unlock Preview</label><p>${escapeHtml(this._nextUnlock(selected.progression))}</p></div>
  <div><label>Suggested Direction</label><p>${escapeHtml(this._suggestedDirection(selected))}</p><p class="wi-mini">${escapeHtml(pendingPacketNote)}</p></div>
</div>
<div><label>Recent Activity Summary</label><p>${escapeHtml(this._activitySummary(data.xpEvents || []))}</p></div>
` : `<p>Select a PC from the roster.</p>`;

    const xpRows = selected ? (data.xpEvents || []).slice(0, 80).map((e) => `
<tr>
  <td>${escapeHtml(formatDateIso(e.created_at))}</td>
  <td>${escapeHtml(e.reason || "-")}</td>
  <td>${Number(e.amount || 0)}</td>
  <td>${escapeHtml((e.tags || []).join(", "))}</td>
  <td>${escapeHtml(e.linked_ref || "")}</td>
</tr>`).join("") : "";
    const xpTab = selected ? `
<div class="wi-xp-topline">
  <div>XP Total: <strong>${selected.xp}</strong></div>
  <div>Next Threshold: <strong>${selected.nextXp}</strong></div>
  <div>Status: <strong>${escapeHtml(selected.status)}</strong></div>
</div>
<div class="wi-tab-actions">
  <button type="button" data-action="add-xp" data-actor-id="${selected.actorId}">Add XP</button>
  <button type="button" data-action="undo-last-xp" data-actor-id="${selected.actorId}">Undo Last XP</button>
  <button type="button" data-action="mark-eligible" data-actor-id="${selected.actorId}">Mark Eligible</button>
</div>
<table class="wi-ledger-table">
  <thead><tr><th>Date/Session</th><th>Reason</th><th>Amount</th><th>Tags</th><th>Ref</th></tr></thead>
  <tbody>${xpRows || `<tr><td colspan="5">No XP entries</td></tr>`}</tbody>
</table>
` : "";

    const classOptions = selected ? (selected.progression.classes || []).map((c) => `<option value="${escapeHtml(c.classId)}" ${(data.levelDraft?.classId || "") === String(c.classId) ? "selected" : ""}>${escapeHtml(c.name || c.classId)} (Lv ${Number(c.level || 1)})</option>`).join("") : "";
    const skillRows = (data.levelDraft?.skillRows || []).map((s, idx) => `
<div class="wi-skill-row">
  <label><input type="checkbox" class="wi-skill-enabled" ${s.enabled ? "checked" : ""}/> Include</label>
  <input type="hidden" class="wi-skill-source" value="${escapeHtml(s.source || "llm")}" />
  <input type="hidden" class="wi-skill-index" value="${idx}" />
  <div class="wi-form-row"><label>Name</label><input class="wi-skill-name" type="text" value="${escapeHtml(s.name || "")}" /></div>
  <div class="wi-form-row"><label>Description</label><textarea class="wi-skill-description" rows="2">${escapeHtml(s.description || "")}</textarea></div>
  <div class="wi-form-row"><label>Cooldown</label><input class="wi-skill-cooldown" type="number" min="0" value="${Number(s.cooldown || 0)}" /></div>
  <div class="wi-tab-actions"><button type="button" data-action="polish-skill" data-actor-id="${selected.actorId}" data-skill-index="${idx}">LLM Polish</button></div>
</div>`).join("");
    const levelUpTab = selected ? `
<div class="wi-form-row"><label>Delta Levels</label><input id="wi-levelup-delta" type="number" min="1" max="20" value="${Number(data.levelDraft?.deltaLevels || 1)}" /></div>
<div class="wi-form-row"><label>Packet Type</label><select id="wi-levelup-type"><option value="standard" ${(data.levelDraft?.packetType || "standard") === "standard" ? "selected" : ""}>Standard</option><option value="new_class" ${(data.levelDraft?.packetType || "") === "new_class" ? "selected" : ""}>New Class</option><option value="consolidation" ${(data.levelDraft?.packetType || "") === "consolidation" ? "selected" : ""}>Class Consolidation</option></select></div>
<div class="wi-form-row"><label>Allocate To Class</label><select id="wi-levelup-class">${classOptions}</select></div>
<div class="wi-form-row"><label>Context</label><div>${escapeHtml(data.levelDraft?.contextSummary || "Click Generate Skills to build suggestions from activity/chat/combat context.")}</div></div>
<div class="wi-tab-actions">
  <button type="button" data-action="generate-skills" data-actor-id="${selected.actorId}">Generate Skills (LLM)</button>
  <button type="button" data-action="add-custom-skill" data-actor-id="${selected.actorId}">Add Custom Skill</button>
  <button type="button" data-action="stage-levelup" data-actor-id="${selected.actorId}">Stage Packet</button>
  <button type="button" data-action="apply-levelup" data-actor-id="${selected.actorId}">Apply Level-Up</button>
</div>
<div class="wi-skill-draft-list">${skillRows || "<p>No skills drafted yet.</p>"}</div>
` : "";

    const classesTab = selected ? `
<div class="wi-tab-actions">
  <button type="button" data-action="add-class" data-actor-id="${selected.actorId}">Add Class (Packet)</button>
  <button type="button" data-action="change-class" data-actor-id="${selected.actorId}">Rename Class</button>
  <button type="button" data-action="merge-classes" data-actor-id="${selected.actorId}">Consolidate Classes</button>
</div>
<div class="wi-class-list">${(selected.progression.classes || []).map((c) => `<div><strong>${escapeHtml(c.name || c.classId)}</strong> Lv ${Number(c.level || 1)} ${c.isPrimary ? "(Primary)" : ""}</div>`).join("") || "No classes"}</div>
` : "";

    const historyRows = selected ? historyRowsHtml(selected, data.history, selected.meta.progressionSnapshots || []) : "";
    const historyTab = selected ? `
<div class="wi-tab-actions">
  <button type="button" data-action="refresh-history" data-actor-id="${selected.actorId}">Refresh</button>
  <button type="button" data-action="rollback-last" data-actor-id="${selected.actorId}">Rollback Last Snapshot</button>
</div>
${historyRows}
` : "";

    const middleTab = {
      overview,
      xp: xpTab,
      levelup: levelUpTab,
      classes: classesTab,
      history: historyTab
    }[data.activeTab] || overview;

    const pendingRows = data.pending.map((r) => `<li><strong>${escapeHtml(r.name)}</strong>: pending level-up choices</li>`).join("") || "<li>No pending level-up packets.</li>";
    const packetRows = (data.packetQueue || []).map((p) => `
<li>
  <strong>${escapeHtml(p.actorName)}</strong> [${escapeHtml(p.packetType)} +${Number(p.deltaLevels || 1)} ${escapeHtml(p.classId)}]
  <div class="wi-mini">to: ${escapeHtml((p.targetNames || []).join(", ") || "unknown")} | delivered: ${Number(p.deliveredCount || 0)} | ${escapeHtml(formatDateIso(p.createdAt))}</div>
  <button type="button" data-action="packet-resend" data-actor-id="${escapeHtml(p.actorId)}" data-offer-id="${escapeHtml(p.offerId)}">Resend</button>
  <button type="button" data-action="packet-clear" data-actor-id="${escapeHtml(p.actorId)}" data-offer-id="${escapeHtml(p.offerId)}">Clear</button>
</li>`).join("") || "<li>No active packet queue.</li>";
    const issueRows = data.validationIssues.map((r) => `<li><strong>${escapeHtml(r.name)}</strong>: ${escapeHtml(r.status)}</li>`).join("") || "<li>No validation issues.</li>";
    const highlightRows = data.highlights.map(([tag, count]) => `<li>${escapeHtml(tag)} (${count})</li>`).join("") || "<li>No highlights yet.</li>";
    const requestRows = (data.playerRequests || []).slice(0, 20).map((r) => `<li><strong>${escapeHtml(r.request_type)}</strong> ${escapeHtml(r.actor_id)} [${escapeHtml(r.status)}] <button type=\"button\" data-action=\"request-status\" data-request-id=\"${escapeHtml(r.request_id)}\" data-request-status=\"resolved\">Resolve</button></li>`).join("") || "<li>No player requests.</li>";
    const markRows = (data.sessionMarks || []).slice(0, 20).map((m) => `<li><strong>${escapeHtml(m.mark_type)}</strong>: ${escapeHtml(m.note || "")}</li>`).join("") || "<li>No session marks.</li>";

    return `
<div class="wi-gm-dashboard">
  <section class="wi-pane wi-pane-left">
    <div class="wi-pane-head">
      <input type="text" id="wi-roster-search" placeholder="Search roster" value="${escapeHtml(data.state.search)}" />
      <select id="wi-roster-status">
        ${data.statusOptions.map((o) => `<option value="${o}" ${data.state.status === o ? "selected" : ""}>${o.replaceAll("_", " ")}</option>`).join("")}
      </select>
      <label><input type="checkbox" id="wi-filter-multi" ${data.state.filterMulticlass ? "checked" : ""}/> Multi-class</label>
      <label><input type="checkbox" id="wi-filter-missing" ${data.state.filterMissingChoices ? "checked" : ""}/> Missing choices</label>
    </div>
    <div class="wi-bulk-actions">
      <button type="button" data-action="bulk-xp">Award XP to Party</button>
      <button type="button" data-action="bulk-freeze">Freeze Leveling</button>
    </div>
    <div class="wi-roster-list">${roster || "<p>No party actors found in the current scene.</p>"}</div>
  </section>

  <section class="wi-pane wi-pane-middle">
    <div class="wi-pane-head wi-tabs">
      ${data.tabs.map((t) => `<button type="button" class="${data.activeTab === t.id ? "is-active" : ""}" data-action="tab" data-tab="${t.id}">${t.label}</button>`).join("")}
    </div>
    <div class="wi-middle-body">${middleTab}</div>
  </section>

  <section class="wi-pane wi-pane-right">
    <h3>Queue & Notifications</h3>
    <h4>Pending Level-Ups</h4>
    <ul>${pendingRows}</ul>
    <h4>Packet Queue</h4>
    <ul>${packetRows}</ul>
    <h4>Validation Issues</h4>
    <ul>${issueRows}</ul>
    <h4>Player Requests</h4>
    <ul>${requestRows}</ul>
    <h4>Session Marks</h4>
    <ul>${markRows}</ul>
    <h4>Recent Session Highlights</h4>
    <ul>${highlightRows}</ul>
  </section>
</div>`;
  }

  _nextUnlock(progression) {
    const p = progression || {};
    const primary = (p.classes || []).find((c) => c.isPrimary) || (p.classes || [])[0] || { name: "Adventurer", level: 1 };
    const next = Number(primary.level || 1) + 1;
    if (next % 10 === 0) return `${primary.name} capstone milestone at class ${next}`;
    if (next % 5 === 0) return `${primary.name} major feature window at class ${next}`;
    return `${primary.name} incremental unlock at class ${next}`;
  }

  _suggestedDirection(selected) {
    const tags = selected?.meta?.recentActivityTags || [];
    if (!tags.length) return "No tagged direction yet."
    const hot = [...new Set(tags.slice(-6))];
    return `Lean into ${hot.join(", ")} in next session rewards.`;
  }

  _activitySummary(events) {
    const list = Array.isArray(events) ? events.slice(-10) : [];
    if (!list.length) return "No recent progression events.";
    const plus = list.reduce((acc, e) => acc + Number(e.amount || 0), 0);
    const tagSet = new Set();
    list.forEach((e) => (e.tags || []).forEach((t) => tagSet.add(t)));
    return `${list.length} XP events, net ${plus >= 0 ? "+" : ""}${plus} XP, tags: ${[...tagSet].slice(0, 8).join(", ") || "none"}.`;
  }

  activateListeners(html) {
    super.activateListeners(html);
    const $root = this.element;
    if (!$root || !$root.length) return;

    // Clear prior delegated handlers to avoid duplicates across renders.
    $root.off(".wicoregm");

    $root.on("input.wicoregm", "#wi-roster-search", (ev) => {
      this.state.search = String(ev.currentTarget.value || "");
      this.render();
    });
    $root.on("change.wicoregm", "#wi-roster-status", (ev) => {
      this.state.status = String(ev.currentTarget.value || "all");
      this.render();
    });
    $root.on("change.wicoregm", "#wi-filter-multi", (ev) => {
      this.state.filterMulticlass = !!ev.currentTarget.checked;
      this.render();
    });
    $root.on("change.wicoregm", "#wi-filter-missing", (ev) => {
      this.state.filterMissingChoices = !!ev.currentTarget.checked;
      this.render();
    });

    $root.on("click.wicoregm", "[data-action]", async (ev) => {
      const el = ev.currentTarget;
      const action = String(el.dataset.action || "");
      const actorId = String(el.dataset.actorId || "");
      const button = ev.target?.closest?.("button");
      if (button) ev.stopPropagation();

      if (action === "select-actor") {
        this.state.selectedActorId = actorId;
        this.render();
        return;
      }
      if (action === "tab") {
        this.state.activeTab = el.dataset.tab || "overview";
        this.render();
        return;
      }
      if (action === "add-xp") return this._onAddXp(actorId);
      if (action === "undo-last-xp") return this._onUndoLastXp(actorId);
      if (action === "mark-eligible") return this._onMarkEligible(actorId);
      if (action === "quick-level") return this._onQuickLevel(actorId);
      if (action === "open-sheet") return this._onOpenSheet(actorId);
      if (action === "send-packet") return this._onSendPacket(actorId);
      if (action === "packet-resend") return this._onResendPacket(actorId, String(el.dataset.offerId || ""));
      if (action === "packet-clear") return this._onClearPacket(actorId, String(el.dataset.offerId || ""));
      if (action === "edit-species") return this._onEditSpecies(actorId);
      if (action === "generate-skills") return this._onGenerateSkills(actorId, $root);
      if (action === "add-custom-skill") return this._onAddCustomSkill(actorId);
      if (action === "stage-levelup") return this._onStageLevelUp(actorId, $root);
      if (action === "apply-levelup") return this._onApplyLevelUp(actorId, $root);
      if (action === "add-class") return this._onAddClass(actorId);
      if (action === "change-class") return this._onChangeClass(actorId);
      if (action === "merge-classes") return this._onMergeClasses(actorId);
      if (action === "polish-skill") return this._onPolishSkill(actorId, Number(el.dataset.skillIndex || -1));
      if (action === "refresh-history") return this._onRefreshHistory(actorId);
      if (action === "rollback-last") return this._onRollbackLast(actorId);
      if (action === "bulk-xp") return this._onBulkXp();
      if (action === "bulk-freeze") return this._onBulkFreeze();
      if (action === "request-status") return this._onSetRequestStatus(el.dataset.requestId, el.dataset.requestStatus);
    });
  }

  async _onAddXp(actorId) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const payload = await promptXpEntry({
      title: `Add XP: ${actor.name}`,
      defaultAmount: 100,
      defaultReason: "GM input",
      defaultTags: ["combat"]
    });
    if (!payload) return;

    try {
      await appendXp(actor, Number(payload.amount || 0), String(payload.reason || "GM input"), payload.tags || [], "");
      ui.notifications.info(`Updated XP for ${actor.name}`);
      this.render();
    } catch (err) {
      ui.notifications.error(String(err.message || err));
    }
  }

  async _onUndoLastXp(actorId) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const sessionId = await resolveSessionId();
    const meta = ensureDashboardMeta(actor);
    const undone = new Set(meta.undoneXpEventIds || []);
    let target = null;
    try {
      const out = await apiRequest(`/foundry/actor/xp/events?world_id=${encodeURIComponent(game.world.id)}&actor_id=${encodeURIComponent(actor.id)}&session_id=${encodeURIComponent(sessionId)}&limit=120`);
      for (const evt of out.items || []) {
        const id = String(evt.xp_event_id || "");
        const tags = Array.isArray(evt.tags) ? evt.tags.map((t) => normKey(t)) : [];
        const reason = String(evt.reason || "");
        const amount = Number(evt.amount || 0);
        if (!id || undone.has(id)) continue;
        if (tags.includes("undo") || reason.startsWith("Undo:")) continue;
        if (amount <= 0) continue;
        target = evt;
        break;
      }
    } catch (_err) {
      target = null;
    }
    if (!target) {
      ui.notifications.warn("No XP entry to undo.");
      return;
    }
    try {
      await appendXp(actor, -Number(target.amount || 0), `Undo: ${target.reason || "XP entry"}`, ["undo"], "");
      await actor.setFlag(MODULE_ID, "dashboard", {
        ...meta,
        undoneXpEventIds: [...undone, String(target.xp_event_id || "")].slice(-300)
      });
      ui.notifications.info(`Reverted last XP entry for ${actor.name}`);
      this.render();
    } catch (err) {
      ui.notifications.error(String(err.message || err));
    }
  }

  async _onMarkEligible(actorId) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const sessionId = await resolveSessionId();
    const meta = ensureDashboardMeta(actor);
    await upsertProgressionMeta(actor, { pendingChoices: true }, sessionId);
    await actor.setFlag(MODULE_ID, "dashboard", { ...meta, eligibleOverride: true });
    this.render();
  }

  async _onQuickLevel(actorId) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const p = actor.getFlag(MODULE_ID, "progression") || buildProgressionFromActor(actor);
    const classes = p.classes || [];
    if (!classes.length) {
      ui.notifications.error("No class available for level allocation.");
      return;
    }
    const options = classes.map((c) => `<option value="${escapeHtml(c.classId)}">${escapeHtml(c.name || c.classId)} (Lv ${Number(c.level || 1)})</option>`).join("");
    const classId = await Dialog.prompt({
      title: `Level Up Class: ${actor.name}`,
      content: `<label>Apply level to class<select id="wi-quick-class">${options}</select></label>`,
      callback: (h) => h.find("#wi-quick-class").val()
    });
    if (!classId) return;
    this._setDraft(actor.id, {
      classId: String(classId),
      deltaLevels: 1,
      packetType: "standard"
    });
    await this._onGenerateSkills(actor.id, this.element);
    this.state.selectedActorId = actor.id;
    this.state.activeTab = "levelup";
    ui.notifications.info(`Prepared level-up draft for ${actor.name}. Review skills and stage packet.`);
    this.render();
  }

  _onOpenSheet(actorId) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    actor.sheet?.render(true);
  }

  async _onEditSpecies(actorId) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const progression = actor.getFlag(MODULE_ID, "progression") || buildProgressionFromActor(actor);
    const currentSpecies = normKey(progression?.species?.primary || "human");

    let catalog = [];
    try {
      const out = await apiRequest("/progression/catalog/species?limit=1000");
      catalog = Array.isArray(out.items) ? out.items : [];
    } catch (_err) {
      catalog = [];
    }

    const byId = new Map(catalog.map((s) => [normKey(s.species_id), s]));
    if (currentSpecies && !byId.has(currentSpecies)) {
      byId.set(currentSpecies, { species_id: currentSpecies, name: currentSpecies, traits: [], tags: ["custom"] });
    }
    const options = [...byId.values()]
      .sort((a, b) => String(a.name || a.species_id).localeCompare(String(b.name || b.species_id)))
      .map((s) => `<option value="${escapeHtml(String(s.species_id || ""))}" ${normKey(s.species_id) === currentSpecies ? "selected" : ""}>${escapeHtml(String(s.name || s.species_id))}</option>`)
      .join("");
    const content = `
<div class="wi-form-row">
  <label>Species</label>
  <select id="wi-species-select">${options}<option value="__custom__">Custom...</option></select>
</div>
<div class="wi-form-row">
  <label>Custom Species ID</label>
  <input id="wi-species-custom" type="text" value="${escapeHtml(currentSpecies)}" />
</div>
<div class="wi-form-row">
  <label>Subtypes (comma-separated)</label>
  <input id="wi-species-subtypes" type="text" value="${escapeHtml((progression?.species?.subtypes || []).join(", "))}" />
</div>
<div class="wi-form-row">
  <label>Traits (comma-separated)</label>
  <input id="wi-species-traits" type="text" value="${escapeHtml((progression?.species?.traits || []).join(", "))}" />
</div>`;

    const values = await new Promise((resolve) => {
      const dialog = new Dialog({
        title: `Edit Species: ${actor.name}`,
        content,
        buttons: {
          save: {
            label: "Save Species",
            callback: (html) => {
              const pick = String(html.find("#wi-species-select").val() || "").trim();
              const custom = String(html.find("#wi-species-custom").val() || "").trim();
              const primary = pick === "__custom__" ? custom : pick;
              resolve({
                primary,
                subtypes: String(html.find("#wi-species-subtypes").val() || ""),
                traits: String(html.find("#wi-species-traits").val() || ""),
              });
            },
          },
          cancel: { label: "Cancel", callback: () => resolve(null) },
        },
        default: "save",
        render: (html) => {
          const syncCustom = () => {
            const pick = String(html.find("#wi-species-select").val() || "").trim();
            const customInput = html.find("#wi-species-custom");
            customInput.prop("disabled", pick !== "__custom__");
            if (pick && pick !== "__custom__") customInput.val(pick);
          };
          html.on("change", "#wi-species-select", syncCustom);
          syncCustom();
        },
        close: () => resolve(null),
      });
      dialog.render(true);
    });
    if (!values) return;
    if (!normKey(values.primary)) {
      ui.notifications.warn("Species ID is required.");
      return;
    }

    try {
      await mutateProgression(actor, (prog) => {
        prog.species = {
          ...(prog.species || {}),
          primary: normKey(values.primary),
          subtypes: parseCsvList(values.subtypes),
          traits: parseCsvList(values.traits),
        };
      });
      ui.notifications.info(`Updated species for ${actor.name}`);
      this.render();
    } catch (err) {
      ui.notifications.error(String(err.message || err));
    }
  }

  async _onSendPacket(actorId) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const meta = ensureDashboardMeta(actor);
    if (!meta.stagedPacket) {
      ui.notifications.warn("No staged packet for this actor.");
      return;
    }
    const packet = meta.stagedPacket;
    const offer = {
      offerId: foundry.utils.randomID(),
      createdAt: new Date().toISOString(),
      packet,
      status: "open",
    };
    const targetUserIds = await this._resolvePacketRecipients(actor, []);
    if (!targetUserIds.length) {
      ui.notifications.warn(`No player recipient selected for ${actor.name}.`);
      return;
    }
    offer.targetUserIds = targetUserIds.map((x) => String(x));
    offer.deliveredToUserIds = [];
    await this._storeOffer(actor, offer);
    await this._dispatchOffer(actor, offer, targetUserIds, false);
    await actor.setFlag(MODULE_ID, "dashboard", {
      ...meta,
      stagedPacket: { ...packet, sentAt: new Date().toISOString() }
    });
    const offlineUsers = targetUserIds.map((id) => game.users.get(id)).filter((u) => u && !u.active);
    if (offlineUsers.length) {
      const names = offlineUsers.map((u) => String(u.name || u.id || "")).join(", ");
      ui.notifications.warn(`Packet queued for offline player(s): ${names}. It will show on next login.`);
    }
    this.render();
  }

  async _onResendPacket(actorId, offerId) {
    const actor = game.actors.get(actorId);
    if (!actor || !offerId) return;
    const offers = getActorOffers(actor);
    const idx = offers.findIndex((o) => String(o.offerId || "") === String(offerId));
    if (idx < 0) {
      ui.notifications.warn("Packet offer not found.");
      return;
    }
    const offer = foundry.utils.deepClone(offers[idx]);
    const recipients = await this._resolvePacketRecipients(actor, offer.targetUserIds || []);
    if (!recipients.length) {
      ui.notifications.warn("No recipients selected.");
      return;
    }
    offer.targetUserIds = recipients.map((x) => String(x));
    offer.lastResentAt = new Date().toISOString();
    offer.status = String(offer.status || "open");
    offers[idx] = offer;
    await actor.setFlag(MODULE_ID, "levelOffers", offers);
    await actor.setFlag(MODULE_ID, "levelOffer", offers.find((o) => String(o.status || "open") === "open") || null);
    await this._dispatchOffer(actor, offer, recipients, true);
    this.render();
  }

  async _onClearPacket(actorId, offerId) {
    const actor = game.actors.get(actorId);
    if (!actor || !offerId) return;
    await this._removeOffer(actor, offerId);
    const remaining = getActorOffers(actor);
    const meta = ensureDashboardMeta(actor);
    await actor.setFlag(MODULE_ID, "dashboard", {
      ...meta,
      stagedPacket: null,
      pendingChoices: remaining.length > 0 ? true : false,
    });
    if (!remaining.length) {
      await upsertProgressionMeta(actor, { pendingChoices: false }, await resolveSessionId());
    } else {
      await upsertProgressionMeta(actor, { pendingChoices: true }, await resolveSessionId());
    }
    ui.notifications.info(`Cleared pending packet ${offerId} for ${actor.name}.`);
    this.render();
  }

  async _onStageLevelUp(actorId, html) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const deltaLevels = Number(html.find("#wi-levelup-delta").val() || 1);
    const packetType = String(html.find("#wi-levelup-type").val() || "standard");
    const classId = String(html.find("#wi-levelup-class").val() || "");
    if (normKey(packetType) === "standard" && !String(classId || "").trim()) {
      ui.notifications.warn("Choose a class for level allocation.");
      return;
    }
    const skillPicks = this._readSkillRowsFromUi(html);
    const draft = this._getDraft(actor, actor.getFlag(MODULE_ID, "progression") || buildProgressionFromActor(actor));
    this._setDraft(actor.id, {
      ...draft,
      classId: normKey(classId),
      deltaLevels: Number(deltaLevels || 1),
      packetType: normKey(packetType),
      skillRows: html.find(".wi-skill-row").map((_, el) => {
        const row = $(el);
        return {
          enabled: !!row.find(".wi-skill-enabled").is(":checked"),
          source: String(row.find(".wi-skill-source").val() || "llm"),
          name: String(row.find(".wi-skill-name").val() || ""),
          description: String(row.find(".wi-skill-description").val() || ""),
          cooldown: Number(row.find(".wi-skill-cooldown").val() || 0)
        };
      }).get()
    });

    const meta = ensureDashboardMeta(actor);
    const sessionId = await resolveSessionId();
    await upsertProgressionMeta(actor, { pendingChoices: true }, sessionId);
    await actor.setFlag(MODULE_ID, "dashboard", {
      ...meta,
      stagedPacket: {
        packetType: normKey(packetType),
        deltaLevels,
        classId: normKey(classId),
        skillPicks,
        stagedAt: new Date().toISOString(),
        stagedBy: game.user?.id || ""
      },
      pendingChoices: true
    });
    ui.notifications.info(`Staged level-up packet for ${actor.name}`);
    this.render();
  }

  async _onApplyLevelUp(actorId, html) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const meta = ensureDashboardMeta(actor);
    const draft = this._getDraft(actor, actor.getFlag(MODULE_ID, "progression") || buildProgressionFromActor(actor));
    const deltaLevels = Number(html.find("#wi-levelup-delta").val() || draft?.deltaLevels || 1);
    const classId = String(html.find("#wi-levelup-class").val() || draft?.classId || "");
    const packetType = String(html.find("#wi-levelup-type").val() || draft?.packetType || "standard");
    if (normKey(packetType) === "standard" && !String(classId || "").trim()) {
      ui.notifications.warn("Choose a class for level allocation.");
      return;
    }
    const skillPicks = this._readSkillRowsFromUi(html);
    let packet = {
      packetType: normKey(packetType),
      deltaLevels: Number(deltaLevels || 1),
      classId: normKey(classId),
      skillPicks
    };
    if (meta.stagedPacket) {
      packet = { ...packet, ...meta.stagedPacket, skillPicks };
    }

    try {
      await actor.setFlag(MODULE_ID, "dashboard", {
        ...meta,
        stagedPacket: {
          ...packet,
          stagedAt: new Date().toISOString(),
          stagedBy: game.user?.id || ""
        },
        pendingChoices: true
      });
      await upsertProgressionMeta(actor, { pendingChoices: true }, await resolveSessionId());
      await this._onSendPacket(actorId);
      ui.notifications.info(`Packet sent to ${actor.name}'s player for acceptance.`);
      this.render();
    } catch (err) {
      ui.notifications.error(String(err.message || err));
    }
  }

  async _onGenerateSkills(actorId, htmlRoot) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const classId = String(htmlRoot.find("#wi-levelup-class").val() || this._getDraft(actor, actor.getFlag(MODULE_ID, "progression") || buildProgressionFromActor(actor))?.classId || "");
    const deltaLevels = Number(htmlRoot.find("#wi-levelup-delta").val() || 1);
    try {
      const out = await this._generateSkillSuggestions(actor, classId, deltaLevels);
      const draft = this._getDraft(actor, actor.getFlag(MODULE_ID, "progression") || buildProgressionFromActor(actor));
      this._setDraft(actor.id, {
        ...draft,
        classId: normKey(classId),
        deltaLevels,
        skillRows: out.suggestions,
        generatedAt: new Date().toISOString(),
        contextSummary: out.contextSummary
      });
      this.render();
    } catch (err) {
      ui.notifications.error(`Skill generation failed: ${String(err.message || err)}`);
    }
  }

  async _onAddCustomSkill(actorId) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const progression = actor.getFlag(MODULE_ID, "progression") || buildProgressionFromActor(actor);
    const name = await Dialog.prompt({
      title: `Custom Skill Name: ${actor.name}`,
      content: "<label>Skill Name <input id='wi-custom-skill-name' type='text' value='' /></label>",
      callback: (h) => h.find("#wi-custom-skill-name").val()
    });
    if (!name) return;
    const notes = await Dialog.prompt({
      title: "Custom Skill Notes (optional)",
      content: "<label>Notes <input id='wi-custom-skill-notes' type='text' value='' /></label>",
      callback: (h) => h.find("#wi-custom-skill-notes").val()
    }) || "";
    let polished = {
      name: String(name),
      description: "",
      cooldown: 0
    };
    try {
      const out = await apiRequest("/foundry/actor/skill-polish", {
        method: "POST",
        body: {
          skill_name: String(name),
          actor_name: String(actor.name || ""),
          species_primary: String(progression.species?.primary || ""),
          class_levels: (progression.classes || []).map((c) => ({ class_id: c.classId, class_name: c.name, level: c.level })),
          notes: String(notes || ""),
          existing_skill_names: (progression.skills || []).map((s) => String(s.name || s.skillId || ""))
        }
      });
      polished = {
        name: String(out.name || name),
        description: String(out.description || ""),
        cooldown: Number(out.cooldown || 0)
      };
    } catch (_err) {
      polished = {
        name: String(name),
        description: String(notes || ""),
        cooldown: 0
      };
    }
    const draft = this._getDraft(actor, actor.getFlag(MODULE_ID, "progression") || buildProgressionFromActor(actor));
    this._setDraft(actor.id, {
      ...draft,
      skillRows: [
        ...(draft?.skillRows || []),
        {
          enabled: true,
          source: "custom",
          name: polished.name,
          description: polished.description,
          cooldown: polished.cooldown
        }
      ]
    });
    this.render();
  }

  async _onPolishSkill(actorId, skillIndex) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    if (Number(skillIndex) < 0) return;
    const progression = actor.getFlag(MODULE_ID, "progression") || buildProgressionFromActor(actor);
    const draft = this._getDraft(actor, progression);
    const liveRows = this._readAllDraftSkillRowsFromUi(this.element);
    const workingRows = liveRows.length ? liveRows : (draft?.skillRows || []);
    if (liveRows.length) {
      this._setDraft(actor.id, { ...draft, skillRows: liveRows });
    }
    const row = workingRows[Number(skillIndex)];
    if (!row) return;
    try {
      const out = await apiRequest("/foundry/actor/skill-polish", {
        method: "POST",
        body: {
          skill_name: String(row.name || "").trim(),
          actor_name: String(actor.name || ""),
          species_primary: String(progression.species?.primary || ""),
          class_levels: (progression.classes || []).map((c) => ({ class_id: c.classId, class_name: c.name, level: c.level })),
          notes: String(row.description || ""),
          existing_skill_names: (progression.skills || []).map((s) => String(s.name || s.skillId || ""))
        }
      });
      const nextRows = [...workingRows];
      nextRows[Number(skillIndex)] = {
        ...nextRows[Number(skillIndex)],
        name: String(nextRows[Number(skillIndex)].name || out.name || ""),
        description: String(out.description || nextRows[Number(skillIndex)].description || ""),
        cooldown: Number(out.cooldown || nextRows[Number(skillIndex)].cooldown || 0),
        source: "llm"
      };
      this._setDraft(actor.id, {
        ...draft,
        skillRows: nextRows
      });
      this.render();
    } catch (err) {
      ui.notifications.error(`Skill polish failed: ${String(err.message || err)}`);
    }
  }

  async _onAddClass(actorId) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const className = await Dialog.prompt({ title: "Add Class", content: "<label>Class Name <input id='wi-class-name' type='text' value='Runner' /></label>", callback: (h) => h.find("#wi-class-name").val() });
    if (!className) return;

    const meta = ensureDashboardMeta(actor);
    const draft = this._getDraft(actor, actor.getFlag(MODULE_ID, "progression") || buildProgressionFromActor(actor));
    await actor.setFlag(MODULE_ID, "dashboard", {
      ...meta,
      pendingChoices: true,
      stagedPacket: {
        packetType: "new_class",
        deltaLevels: 1,
        classId: normKey(className),
        skillPicks: this._readSkillRowsFromUi(this.element),
        newClass: {
          classId: normKey(className),
          name: String(className),
          track: "",
          isPrimary: false,
          isCustom: true
        },
        stagedAt: new Date().toISOString(),
        stagedBy: game.user?.id || ""
      }
    });
    this._setDraft(actor.id, {
      ...draft,
      packetType: "new_class",
      classId: normKey(className),
      deltaLevels: 1
    });
    await upsertProgressionMeta(actor, { pendingChoices: true }, await resolveSessionId());
    ui.notifications.info(`Staged NEW CLASS offer for ${actor.name}. Send packet to player.`);
    this.render();
  }

  async _onChangeClass(actorId) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const p = actor.getFlag(MODULE_ID, "progression") || buildProgressionFromActor(actor);
    const list = (p.classes || []).map((c) => c.classId).join(", ");
    const target = await Dialog.prompt({ title: "Change Class", content: `<label>Class ID (${escapeHtml(list)}) <input id='wi-change-class-id' type='text' /></label>`, callback: (h) => h.find("#wi-change-class-id").val() });
    if (!target) return;
    const newName = await Dialog.prompt({ title: "Rename Class", content: "<label>New Name <input id='wi-change-class-name' type='text' value='' /></label>", callback: (h) => h.find("#wi-change-class-name").val() });
    if (!newName) return;

    try {
      await mutateProgression(actor, (prog) => {
        const cls = (prog.classes || []).find((c) => normKey(c.classId) === normKey(target));
        if (!cls) throw new Error("Class not found");
        cls.name = String(newName);
      });
      ui.notifications.info(`Renamed class ${target} for ${actor.name}`);
      this.render();
    } catch (err) {
      ui.notifications.error(String(err.message || err));
    }
  }

  async _onMergeClasses(actorId) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const p = actor.getFlag(MODULE_ID, "progression") || buildProgressionFromActor(actor);
    const classRows = (p.classes || [])
      .map((c) => `<label><input type="checkbox" class="wi-merge-class" value="${escapeHtml(c.classId)}" /> ${escapeHtml(c.name || c.classId)} (Lv ${Number(c.level || 1)})</label>`)
      .join("<br/>");
    const skillRows = (p.skills || [])
      .map((s) => `
<div class="wi-merge-skill-row" data-skill-id="${escapeHtml(s.skillId || s.name)}">
  <label>${escapeHtml(s.name || s.skillId)}</label>
  <input type="text" class="wi-merge-skill-name" value="${escapeHtml(s.name || s.skillId || "")}" />
  <textarea class="wi-merge-skill-desc" rows="2">${escapeHtml(s.description || "")}</textarea>
</div>`)
      .join("");
    const content = `
<div class="wi-merge-dialog">
  <h4>Select 2+ Classes</h4>
  <div>${classRows || "No classes"}</div>
  <div class="wi-form-row"><label>Consolidated Class Name</label><input id="wi-merge-name" type="text" value="Hybrid Class" /></div>
  <div class="wi-form-row"><label>Notes (optional)</label><input id="wi-merge-notes" type="text" value="" /></div>
  <div class="wi-tab-actions">
    <button type="button" data-action="generate-merge-name">Generate Name (LLM)</button>
  </div>
  <h4>Skill Consolidation / Edits</h4>
  <div>${skillRows || "<p>No skills found.</p>"}</div>
</div>`;

    const run = await new Promise((resolve) => {
      const dialog = new Dialog({
        title: `Consolidate Classes: ${actor.name}`,
        content,
        buttons: {
          stage: {
            label: "Stage Consolidation",
            callback: (html) => {
              const selectedIds = html.find(".wi-merge-class:checked").map((_, el) => String(el.value || "")).get().map(normKey).filter(Boolean);
              const targetName = String(html.find("#wi-merge-name").val() || "").trim();
              const notes = String(html.find("#wi-merge-notes").val() || "").trim();
              const skillEdits = html.find(".wi-merge-skill-row").map((_, el) => {
                const row = $(el);
                return {
                  skillId: String(row.data("skillId") || ""),
                  name: String(row.find(".wi-merge-skill-name").val() || ""),
                  description: String(row.find(".wi-merge-skill-desc").val() || "")
                };
              }).get();
              resolve({ selectedIds, targetName, notes, skillEdits });
            }
          },
          cancel: { label: "Cancel", callback: () => resolve(null) }
        },
        default: "stage",
        render: (html) => {
          html.on("click", "button[data-action='generate-merge-name']", async () => {
            const names = html.find(".wi-merge-class:checked").map((_, el) => String(el.value || "")).get();
            const note = String(html.find("#wi-merge-notes").val() || "");
            const skillNames = (p.skills || []).map((s) => String(s.name || s.skillId || ""));
            try {
              const out = await apiRequest("/foundry/actor/class-merge-suggest", {
                method: "POST",
                body: {
                  class_names: names,
                  class_levels: (p.classes || []).map((c) => ({ class_id: c.classId, class_name: c.name, level: c.level })),
                  species_primary: String(p.species?.primary || ""),
                  actor_name: String(actor.name || ""),
                  skill_names: skillNames,
                  notes: note
                }
              });
              html.find("#wi-merge-name").val(String(out.name || "Hybrid Class"));
            } catch (err) {
              ui.notifications.error(`Name suggestion failed: ${String(err.message || err)}`);
            }
          });
        },
        close: () => resolve(null)
      });
      dialog.render(true);
    });

    if (!run) return;
    if ((run.selectedIds || []).length < 2) {
      ui.notifications.warn("Select at least 2 classes to consolidate.");
      return;
    }
    if (!String(run.targetName || "").trim()) {
      ui.notifications.warn("Consolidated class name is required.");
      return;
    }

    const meta = ensureDashboardMeta(actor);
    await actor.setFlag(MODULE_ID, "dashboard", {
      ...meta,
      pendingChoices: true,
      stagedPacket: {
        packetType: "consolidation",
        deltaLevels: 0,
        classId: normKey(run.targetName),
        skillPicks: [],
        consolidation: {
          fromClassIds: run.selectedIds,
          targetClassId: normKey(run.targetName),
          targetClassName: String(run.targetName),
          notes: String(run.notes || ""),
          skillEdits: run.skillEdits || []
        },
        stagedAt: new Date().toISOString(),
        stagedBy: game.user?.id || ""
      }
    });
    this._setDraft(actor.id, {
      packetType: "consolidation",
      classId: normKey(run.targetName),
      deltaLevels: 0
    });
    await upsertProgressionMeta(actor, { pendingChoices: true }, await resolveSessionId());
    ui.notifications.info(`Staged CONSOLIDATION offer for ${actor.name}. Send packet to player.`);
    this.render();
  }

  async _onLockClass(actorId) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const p = actor.getFlag(MODULE_ID, "progression") || buildProgressionFromActor(actor);
    const available = (p.classes || []).map((c) => c.classId).join(", ");
    const cid = await Dialog.prompt({ title: "Lock Class", content: `<label>Class ID (${escapeHtml(available)}) <input id='wi-lock-class-id' type='text' /></label>`, callback: (h) => h.find("#wi-lock-class-id").val() });
    if (!cid) return;

    const meta = ensureDashboardMeta(actor);
    const locked = new Set(meta.lockedClassIds || []);
    locked.add(normKey(cid));
    await actor.setFlag(MODULE_ID, "dashboard", { ...meta, lockedClassIds: [...locked] });
    ui.notifications.info(`Locked class ${cid}`);
    this.render();
  }

  async _onFeatureAudit(actorId) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const p = actor.getFlag(MODULE_ID, "progression") || buildProgressionFromActor(actor);

    const findings = [];
    const primaryCount = (p.classes || []).filter((c) => c.isPrimary).length;
    if (primaryCount !== 1) findings.push(`Primary class count is ${primaryCount}; expected 1.`);
    const classTotal = (p.classes || []).reduce((acc, c) => acc + Number(c.level || 0), 0);
    if (classTotal !== Number(p.level || 1)) findings.push(`Class levels sum is ${classTotal}; expected ${p.level}.`);

    const seenSkills = new Set();
    for (const s of p.skills || []) {
      const k = normKey(s.skillId || s.name);
      if (seenSkills.has(k)) findings.push(`Duplicate skill detected: ${k}`);
      seenSkills.add(k);
    }

    const msg = findings.length ? `<ul>${findings.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>` : "<p>No obvious stacking conflicts found.</p>";
    new Dialog({ title: `Feature Audit: ${actor.name}`, content: msg, buttons: { ok: { label: "Close" } } }).render(true);
  }

  async _onRefreshHistory(actorId) {
    this.historyCache.delete(`${game.world.id}::${actorId}`);
    this.render();
  }

  async _onRollbackLast(actorId) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const meta = ensureDashboardMeta(actor);
    const snapshots = meta.progressionSnapshots || [];
    if (!snapshots.length) {
      ui.notifications.warn("No snapshots available for rollback.");
      return;
    }
    const prior = snapshots[snapshots.length - 1];
    await actor.update({
      [`flags.${MODULE_ID}.progression`]: prior.progression,
      [`flags.${MODULE_ID}.dashboard`]: { ...meta, progressionSnapshots: snapshots.slice(0, -1) }
    });
    await syncActorProgression(actor);
    this.historyCache.delete(`${game.world.id}::${actor.id}`);
    ui.notifications.info(`Rolled back ${actor.name} to previous snapshot.`);
    this.render();
  }

  async _onBulkXp() {
    const payload = await promptXpEntry({
      title: "Party XP",
      defaultAmount: 100,
      defaultReason: "GM input",
      defaultTags: ["unique"]
    });
    if (!payload) return;
    const actors = collectPartyActors();
    for (const actor of actors) {
      try {
        await appendXp(actor, Number(payload.amount || 0), String(payload.reason || "Party XP"), payload.tags || [], "");
      } catch (err) {
        console.error("[wi-core-foundry] bulk xp failed", actor.name, err);
      }
    }
    ui.notifications.info(`Awarded XP to ${actors.length} actors.`);
    this.render();
  }

  async _onBulkMarkSession() {
    const raw = await Dialog.prompt({ title: "Mark Session", content: "<label>Tag <input id='wi-mark-tag' type='text' value='session' /></label>", callback: (h) => h.find("#wi-mark-tag").val() });
    if (!raw) return;
    const tag = normKey(raw);
    const note = await Dialog.prompt({ title: "Session Note", content: "<label>Note <input id='wi-mark-note' type='text' value='Session marker' /></label>", callback: (h) => h.find("#wi-mark-note").val() }) || "";
    const sessionId = await resolveSessionId();
    await apiRequest("/foundry/session/mark", {
      method: "POST",
      body: {
        world_id: game.world.id,
        session_id: sessionId,
        mark_type: "session",
        note: String(note),
        tags: [tag],
        created_by: game.user?.id || ""
      }
    });
    const actors = collectPartyActors();
    for (const actor of actors) {
      const meta = ensureDashboardMeta(actor);
      const next = [...new Set([...(meta.recentActivityTags || []), tag])].slice(-20);
      await upsertProgressionMeta(actor, { recentActivityTags: next }, sessionId);
      await actor.setFlag(MODULE_ID, "dashboard", { ...meta, recentActivityTags: next });
    }
    ui.notifications.info(`Session tag '${tag}' applied to ${actors.length} actors.`);
    this.render();
  }

  async _onBulkFreeze() {
    const actors = collectPartyActors();
    const freeze = await Dialog.confirm({ title: "Freeze Leveling", content: `<p>Apply leveling freeze to ${actors.length} actors?</p>` });
    if (!freeze) return;
    const sessionId = await resolveSessionId();
    for (const actor of actors) {
      const meta = ensureDashboardMeta(actor);
      await upsertProgressionMeta(actor, { levelingFrozen: true }, sessionId);
      await actor.setFlag(MODULE_ID, "dashboard", { ...meta, levelingFrozen: true });
    }
    ui.notifications.info("Leveling frozen for current party.");
    this.render();
  }

  async _onCreateRequest() {
    const actor = game.actors.get(this.state.selectedActorId || "");
    if (!actor) {
      ui.notifications.warn("Select a PC first.");
      return;
    }
    const requestType = await Dialog.prompt({ title: "Player Request Type", content: "<label>Type <input id='wi-req-type' type='text' value='level_path' /></label>", callback: (h) => h.find("#wi-req-type").val() });
    if (!requestType) return;
    const note = await Dialog.prompt({ title: "Request Details", content: "<label>Notes <input id='wi-req-note' type='text' value='' /></label>", callback: (h) => h.find("#wi-req-note").val() }) || "";
    const sessionId = await resolveSessionId();
    await apiRequest("/foundry/actor/request", {
      method: "POST",
      body: {
        world_id: game.world.id,
        actor_id: actor.id,
        session_id: sessionId,
        request_type: normKey(requestType),
        payload: { note: String(note) },
        priority: 50,
        status: "open"
      }
    });
    ui.notifications.info(`Player request added for ${actor.name}.`);
    this.render();
  }

  async _onSetRequestStatus(requestId, status) {
    if (!requestId) return;
    await apiRequest(`/foundry/actor/request/${encodeURIComponent(requestId)}/status`, {
      method: "POST",
      body: {
        status: String(status || "resolved"),
        gm_notes: "Updated from GM dashboard"
      }
    });
    this.render();
  }
}

function historyRowsHtml(selected, apiHistory, snapshots) {
  const apiRows = (apiHistory || []).map((e) => `
<tr>
  <td>${escapeHtml(formatDateIso(e.created_at))}</td>
  <td>${escapeHtml(e.action || "sync")}</td>
  <td>${escapeHtml(JSON.stringify(e.payload || {}))}</td>
</tr>`).join("");

  const snapRows = (snapshots || []).slice().reverse().map((s) => `
<tr>
  <td>${escapeHtml(formatDateIso(s.at))}</td>
  <td>snapshot</td>
  <td>level ${Number(s.progression?.level || 1)} / hash ${escapeHtml(String(s.sourceHash || "").slice(0, 10))}</td>
</tr>`).join("");

  const rows = apiRows || snapRows ? `${apiRows}${snapRows}` : `<tr><td colspan="3">No history found.</td></tr>`;
  return `<table class="wi-ledger-table"><thead><tr><th>Time</th><th>Type</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table>`;
}

let dashboardInstance = null;

export function registerGmDashboard() {
  game.wiCore = game.wiCore || {};

  game.wiCore.openGmDashboard = async () => {
    if (!game.user?.isGM) {
      ui.notifications.warn("GM Dashboard is GM-only.");
      return;
    }
    if (!dashboardInstance) dashboardInstance = new WICoreGMDashboard();
    dashboardInstance.render(true);
  };
}
