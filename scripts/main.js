import { apiRequest } from "./api-client.js";
import { registerActorSyncHook } from "./actor-sync.js";
import { registerNpcPanel } from "./chat-ui.js";

const MODULE_ID = "wi-core-foundry";

function registerSettings() {
  game.settings.register(MODULE_ID, "apiBaseUrl", {
    name: "API Base URL",
    scope: "world",
    config: true,
    type: String,
    default: "http://127.0.0.1:8000"
  });
  game.settings.register(MODULE_ID, "apiKey", {
    name: "API Key",
    scope: "world",
    config: true,
    type: String,
    default: "",
    restricted: true
  });
  game.settings.register(MODULE_ID, "defaultVoiceId", {
    name: "Default ElevenLabs Voice ID",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });
  game.settings.register(MODULE_ID, "autoPlayVoice", {
    name: "Auto-play NPC voice",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "syncDebounceMs", {
    name: "Sync debounce (ms)",
    scope: "world",
    config: true,
    type: Number,
    default: 800
  });
  game.settings.register(MODULE_ID, "partyIdValue", {
    name: "Party ID",
    scope: "world",
    config: true,
    type: String,
    default: "party-main"
  });
  game.settings.register(MODULE_ID, "partyIdSource", {
    name: "Party ID Source (setting|actor-folder|manual)",
    scope: "world",
    config: true,
    type: String,
    default: "setting"
  });

  game.settings.register(MODULE_ID, "hpMaxPath", {
    name: "Actor HP Max Path",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });
  game.settings.register(MODULE_ID, "hpValuePath", {
    name: "Actor HP Current Path",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });
  game.settings.register(MODULE_ID, "hpTempPath", {
    name: "Actor HP Temp Path",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });
  game.settings.register(MODULE_ID, "acPath", {
    name: "Actor AC Path",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });
}

function registerKeybindings() {
  game.keybindings.register(MODULE_ID, "openNpcPanel", {
    name: "Open NPC Panel",
    hint: "Open the Wandering Inn NPC panel.",
    editable: [{ key: "KeyN", modifiers: ["Shift", "Alt"] }],
    onDown: () => {
      game.wiCore.openNpcPanel();
      return true;
    }
  });

  game.keybindings.register(MODULE_ID, "openNpcPanelGM", {
    name: "Open NPC Panel (GM)",
    hint: "GM-only shortcut to open the Wandering Inn NPC panel.",
    restricted: true,
    editable: [{ key: "KeyI", modifiers: ["Control", "Shift"] }],
    onDown: () => {
      game.wiCore.openNpcPanel();
      return true;
    }
  });

  game.keybindings.register(MODULE_ID, "pullCombatSelected", {
    name: "Pull Combat for Selected Token",
    hint: "GM-only shortcut: pull combat snapshot and apply it to selected token actor.",
    restricted: true,
    editable: [{ key: "KeyP", modifiers: ["Shift", "Alt"] }],
    onDown: () => {
      game.wiCore.pullCombatSelected().catch((err) => console.error("[wi-core-foundry] pull hotkey failed", err));
      return true;
    }
  });
}

Hooks.once("init", () => {
  registerSettings();
  registerNpcPanel();
  registerKeybindings();
});

Hooks.once("ready", async () => {
  registerActorSyncHook();

  try {
    const health = await apiRequest("/health");
    console.log("[wi-core-foundry] API health", health);
  } catch (err) {
    console.error("[wi-core-foundry] API health check failed", err);
  }

  game.wiCore = game.wiCore || {};
  game.wiCore.openNpcPanel = game.wiCore.openNpcPanel || (() => {});
  game.wiCore.pullCombatSelected = game.wiCore.pullCombatSelected || (async () => {});
});
