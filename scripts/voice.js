import { apiRequest } from "./api-client.js";

const MODULE_ID = "wi-core-foundry";

export async function maybePlayVoice({ text, npcId, sessionId, voiceId }) {
  if (!voiceId) return null;
  const out = await apiRequest("/voice/tts", {
    method: "POST",
    body: {
      voice_id: voiceId,
      text,
      npc_id: npcId,
      session_id: sessionId
    }
  });

  const shouldPlay = !!game.settings.get(MODULE_ID, "autoPlayVoice");
  if (shouldPlay && out.audio_url) {
    const apiBase = (game.settings.get(MODULE_ID, "apiBaseUrl") || "http://127.0.0.1:8000").replace(/\/$/, "");
    const audio = new Audio(`${apiBase}${out.audio_url}`);
    await audio.play().catch(() => null);
  }
  return out;
}
