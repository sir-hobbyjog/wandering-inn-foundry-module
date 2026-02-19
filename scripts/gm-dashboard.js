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
    stagedPacket: meta.stagedPacket || null,
    progressionSnapshots: Array.isArray(meta.progressionSnapshots) ? meta.progressionSnapshots : []
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

      return {
        actor,
        actorId: actor.id,
        name: actor.name,
        img: actor.img,
        level: Number(progression.level || 1),
        classSummary: classSummary(progression.classes),
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
      validationIssues,
      highlights,
      playerRequests,
      sessionMarks,
      sessionId,
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

    const overview = selected ? `
<div class="wi-overview-grid">
  <div><label>Current Class Stack</label><p>${escapeHtml(selected.classSummary)}</p></div>
  <div><label>Species</label><p>${escapeHtml(selected.speciesSummary)}</p></div>
  <div><label>Next Unlock Preview</label><p>${escapeHtml(this._nextUnlock(selected.progression))}</p></div>
  <div><label>Suggested Direction</label><p>${escapeHtml(this._suggestedDirection(selected))}</p></div>
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
  <thead><tr><th>Date/Session</th><th>Reason</th><th>Amount</th><th>Tags</th><th>Link</th></tr></thead>
  <tbody>${xpRows || `<tr><td colspan="5">No XP entries</td></tr>`}</tbody>
</table>
` : "";

    const classOptions = selected ? (selected.progression.classes || []).map((c) => `<option value="${escapeHtml(c.classId)}">${escapeHtml(c.name || c.classId)}</option>`).join("") : "";
    const levelUpTab = selected ? `
<div class="wi-form-row"><label>Delta Levels</label><input id="wi-levelup-delta" type="number" min="1" max="20" value="1" /></div>
<div class="wi-form-row"><label>Packet Type</label><select id="wi-levelup-type"><option value="standard" selected>Standard</option><option value="new_class">New Class</option><option value="consolidation">Class Consolidation</option></select></div>
<div class="wi-form-row"><label>Allocate To Class</label><select id="wi-levelup-class">${classOptions}</select></div>
<div class="wi-form-row"><label>Skill Picks JSON (optional)</label><textarea id="wi-levelup-skills" rows="4" placeholder='[{"skillId":"inspire","name":"Inspire","source":"custom"}]'></textarea></div>
<div class="wi-tab-actions">
  <button type="button" data-action="stage-levelup" data-actor-id="${selected.actorId}">Stage Packet</button>
  <button type="button" data-action="apply-levelup" data-actor-id="${selected.actorId}">Apply Level-Up</button>
</div>
` : "";

    const classesTab = selected ? `
<div class="wi-tab-actions">
  <button type="button" data-action="add-class" data-actor-id="${selected.actorId}">Add Class</button>
  <button type="button" data-action="change-class" data-actor-id="${selected.actorId}">Change Class</button>
  <button type="button" data-action="merge-classes" data-actor-id="${selected.actorId}">Consolidate Classes</button>
  <button type="button" data-action="lock-class" data-actor-id="${selected.actorId}">Lock Class</button>
  <button type="button" data-action="feature-audit" data-actor-id="${selected.actorId}">Feature Audit</button>
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
      <button type="button" data-action="bulk-mark-session">Mark Session</button>
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
    <h4>Validation Issues</h4>
    <ul>${issueRows}</ul>
    <h4>Player Requests</h4>
    <button type="button" data-action="create-request">New Request</button>
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

    html.find("#wi-roster-search").on("input", (ev) => {
      this.state.search = String(ev.currentTarget.value || "");
      this.render();
    });
    html.find("#wi-roster-status").on("change", (ev) => {
      this.state.status = String(ev.currentTarget.value || "all");
      this.render();
    });
    html.find("#wi-filter-multi").on("change", (ev) => {
      this.state.filterMulticlass = !!ev.currentTarget.checked;
      this.render();
    });
    html.find("#wi-filter-missing").on("change", (ev) => {
      this.state.filterMissingChoices = !!ev.currentTarget.checked;
      this.render();
    });

    html.on("click", "[data-action]", async (ev) => {
      const el = ev.currentTarget;
      const action = String(el.dataset.action || "");
      const actorId = String(el.dataset.actorId || "");
      const isButton = ev.target?.closest?.("button");
      if (isButton) ev.stopPropagation();

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
      if (action === "stage-levelup") return this._onStageLevelUp(actorId, html);
      if (action === "apply-levelup") return this._onApplyLevelUp(actorId, html);
      if (action === "add-class") return this._onAddClass(actorId);
      if (action === "change-class") return this._onChangeClass(actorId);
      if (action === "merge-classes") return this._onMergeClasses(actorId);
      if (action === "lock-class") return this._onLockClass(actorId);
      if (action === "feature-audit") return this._onFeatureAudit(actorId);
      if (action === "refresh-history") return this._onRefreshHistory(actorId);
      if (action === "rollback-last") return this._onRollbackLast(actorId);
      if (action === "bulk-xp") return this._onBulkXp();
      if (action === "bulk-mark-session") return this._onBulkMarkSession();
      if (action === "bulk-freeze") return this._onBulkFreeze();
      if (action === "create-request") return this._onCreateRequest();
      if (action === "request-status") return this._onSetRequestStatus(el.dataset.requestId, el.dataset.requestStatus);
    });
  }

  async _onAddXp(actorId) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const amountRaw = await Dialog.prompt({ title: "Add XP", content: "<label>Amount <input id='wi-xp-amount' type='number' value='100' /></label>", callback: (h) => h.find("#wi-xp-amount").val() });
    if (amountRaw == null) return;
    const reason = await Dialog.prompt({ title: "XP Reason", content: "<label>Reason <input id='wi-xp-reason' type='text' value='Session reward' /></label>", callback: (h) => h.find("#wi-xp-reason").val() });
    const tags = await Dialog.prompt({ title: "XP Tags", content: "<label>Tags (comma separated) <input id='wi-xp-tags' type='text' value='session' /></label>", callback: (h) => h.find("#wi-xp-tags").val() });
    const link = await Dialog.prompt({ title: "Link (optional)", content: "<label>Chat/Journal/Combat Link <input id='wi-xp-link' type='text' /></label>", callback: (h) => h.find("#wi-xp-link").val() });

    try {
      await appendXp(actor, Number(amountRaw), String(reason || "XP update"), String(tags || ""), String(link || ""));
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
    let last = null;
    try {
      const out = await apiRequest(`/foundry/actor/xp/events?world_id=${encodeURIComponent(game.world.id)}&actor_id=${encodeURIComponent(actor.id)}&session_id=${encodeURIComponent(sessionId)}&limit=1`);
      last = (out.items || [])[0] || null;
    } catch (_err) {
      last = null;
    }
    if (!last) {
      ui.notifications.warn("No XP entry to undo.");
      return;
    }
    try {
      await appendXp(actor, -Number(last.amount || 0), `Undo: ${last.reason || "XP entry"}`, ["undo"], last.linked_ref || "");
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
    const primary = (p.classes || []).find((c) => c.isPrimary) || (p.classes || [])[0];
    if (!primary) {
      ui.notifications.error("No class available for level allocation.");
      return;
    }

    try {
      const out = await applyLevelUp(actor, 1, primary.classId, []);
      const meta = ensureDashboardMeta(actor);
      const snapshots = [...(meta.progressionSnapshots || []), {
        at: new Date().toISOString(),
        progression: out.progression,
        sourceHash: out.source_hash
      }].slice(-30);
      await actor.update({
        [`flags.${MODULE_ID}.progression`]: out.progression,
        [`flags.${MODULE_ID}.dashboard`]: { ...meta, pendingChoices: false, eligibleOverride: false, progressionSnapshots: snapshots }
      });
      await upsertProgressionMeta(actor, { pendingChoices: false }, await resolveSessionId());
      this.historyCache.delete(`${game.world.id}::${actor.id}`);
      ui.notifications.info(`${actor.name} leveled to ${out.progression.level}`);
      this.render();
    } catch (err) {
      ui.notifications.error(String(err.message || err));
    }
  }

  _onOpenSheet(actorId) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    actor.sheet?.render(true);
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
      packet
    };
    const owners = game.users.filter((u) => actor.testUserPermission(u, "OWNER"));
    const content = `<p><strong>Level Packet Ready:</strong> ${escapeHtml(actor.name)}</p>
<p>Type: ${escapeHtml(packet.packetType || "standard")}</p>
<p>Delta: +${Number(packet.deltaLevels || 1)} to ${escapeHtml(packet.classId || "primary")}</p>
<p>Skills: ${escapeHtml(JSON.stringify(packet.skillPicks || []))}</p>
<p>The player will get an accept/reject popup.</p>`;
    await ChatMessage.create({
      content,
      speaker: { alias: "GM Progression Packet" },
      whisper: [...new Set([...ChatMessage.getWhisperRecipients("GM"), ...owners])]
    });
    await actor.setFlag(MODULE_ID, "levelOffer", offer);
    await actor.setFlag(MODULE_ID, "dashboard", {
      ...meta,
      stagedPacket: { ...packet, sentAt: new Date().toISOString() }
    });
    ui.notifications.info(`Sent staged packet for ${actor.name}`);
    this.render();
  }

  async _onStageLevelUp(actorId, html) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const deltaLevels = Number(html.find("#wi-levelup-delta").val() || 1);
    const packetType = String(html.find("#wi-levelup-type").val() || "standard");
    const classId = String(html.find("#wi-levelup-class").val() || "");
    const rawSkills = String(html.find("#wi-levelup-skills").val() || "").trim();
    let skillPicks = [];
    if (rawSkills) {
      try {
        skillPicks = JSON.parse(rawSkills);
      } catch (_err) {
        ui.notifications.error("Skill picks JSON is invalid.");
        return;
      }
    }

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
    let deltaLevels = Number(html.find("#wi-levelup-delta").val() || 1);
    let classId = String(html.find("#wi-levelup-class").val() || "");
    let skillPicks = [];

    if (meta.stagedPacket) {
      deltaLevels = Number(meta.stagedPacket.deltaLevels || deltaLevels);
      classId = String(meta.stagedPacket.classId || classId);
      skillPicks = Array.isArray(meta.stagedPacket.skillPicks) ? meta.stagedPacket.skillPicks : [];
    }

    try {
      const out = await applyLevelUp(actor, deltaLevels, classId, skillPicks);
      const snapshots = [...(meta.progressionSnapshots || []), {
        at: new Date().toISOString(),
        progression: out.progression,
        sourceHash: out.source_hash
      }].slice(-30);

      await actor.update({
        [`flags.${MODULE_ID}.progression`]: out.progression,
        [`flags.${MODULE_ID}.dashboard`]: {
          ...meta,
          stagedPacket: null,
          pendingChoices: false,
          eligibleOverride: false,
          progressionSnapshots: snapshots
        }
      });
      await upsertProgressionMeta(actor, { pendingChoices: false }, await resolveSessionId());
      this.historyCache.delete(`${game.world.id}::${actor.id}`);
      ui.notifications.info(`Applied level-up for ${actor.name}`);
      this.render();
    } catch (err) {
      ui.notifications.error(String(err.message || err));
    }
  }

  async _onAddClass(actorId) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const className = await Dialog.prompt({ title: "Add Class", content: "<label>Class Name <input id='wi-class-name' type='text' value='Runner' /></label>", callback: (h) => h.find("#wi-class-name").val() });
    if (!className) return;
    const track = await Dialog.prompt({ title: "Class Track", content: "<label>Track <input id='wi-class-track' type='text' value='support' /></label>", callback: (h) => h.find("#wi-class-track").val() }) || "";

    const meta = ensureDashboardMeta(actor);
    await actor.setFlag(MODULE_ID, "dashboard", {
      ...meta,
      pendingChoices: true,
      stagedPacket: {
        packetType: "new_class",
        deltaLevels: 1,
        classId: normKey(className),
        skillPicks: [],
        newClass: {
          classId: normKey(className),
          name: String(className),
          track: normKey(track),
          isPrimary: false,
          isCustom: true
        },
        stagedAt: new Date().toISOString(),
        stagedBy: game.user?.id || ""
      }
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
    const newTrack = await Dialog.prompt({ title: "New Track", content: "<label>Track <input id='wi-change-track' type='text' value='warrior' /></label>", callback: (h) => h.find("#wi-change-track").val() });

    try {
      await mutateProgression(actor, (prog) => {
        const cls = (prog.classes || []).find((c) => normKey(c.classId) === normKey(target));
        if (!cls) throw new Error("Class not found");
        cls.track = normKey(newTrack);
      });
      ui.notifications.info(`Updated class ${target} for ${actor.name}`);
      this.render();
    } catch (err) {
      ui.notifications.error(String(err.message || err));
    }
  }

  async _onMergeClasses(actorId) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const p = actor.getFlag(MODULE_ID, "progression") || buildProgressionFromActor(actor);
    const names = (p.classes || []).map((c) => c.classId).join(", ");
    const from = await Dialog.prompt({ title: "Merge Classes", content: `<label>From class (${escapeHtml(names)}) <input id='wi-merge-from' type='text' /></label>`, callback: (h) => h.find("#wi-merge-from").val() });
    const to = await Dialog.prompt({ title: "Merge Classes", content: `<label>To class (${escapeHtml(names)}) <input id='wi-merge-to' type='text' /></label>`, callback: (h) => h.find("#wi-merge-to").val() });
    if (!from || !to || normKey(from) === normKey(to)) return;

    const meta = ensureDashboardMeta(actor);
    await actor.setFlag(MODULE_ID, "dashboard", {
      ...meta,
      pendingChoices: true,
      stagedPacket: {
        packetType: "consolidation",
        deltaLevels: 0,
        classId: normKey(to),
        skillPicks: [],
        consolidation: { from: normKey(from), to: normKey(to) },
        stagedAt: new Date().toISOString(),
        stagedBy: game.user?.id || ""
      }
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
    const amountRaw = await Dialog.prompt({ title: "Party XP", content: "<label>XP Amount <input id='wi-bulk-xp' type='number' value='100' /></label>", callback: (h) => h.find("#wi-bulk-xp").val() });
    if (amountRaw == null) return;
    const reason = await Dialog.prompt({ title: "Party XP Reason", content: "<label>Reason <input id='wi-bulk-xp-reason' type='text' value='Session complete' /></label>", callback: (h) => h.find("#wi-bulk-xp-reason").val() });
    const tags = await Dialog.prompt({ title: "Party XP Tags", content: "<label>Tags <input id='wi-bulk-xp-tags' type='text' value='session' /></label>", callback: (h) => h.find("#wi-bulk-xp-tags").val() });
    const actors = collectPartyActors();
    for (const actor of actors) {
      try {
        await appendXp(actor, Number(amountRaw), String(reason || "Party XP"), String(tags || ""), "");
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
