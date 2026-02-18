# Wandering Inn Core Bridge (Foundry Module)

Install URL (Foundry):

`https://raw.githubusercontent.com/sir-hobbyjog/wandering-inn-foundry-module/main/module.json`

## Required backend settings
- `apiBaseUrl` (default `http://127.0.0.1:8000`)
- `apiKey` (must match backend `FOUNDRY_API_KEY`)

## Optional settings
- `defaultVoiceId` for ElevenLabs
- `autoPlayVoice`
- actor path mappings: `hpMaxPath`, `hpValuePath`, `hpTempPath`, `acPath`

## Runtime flow
1. Bind actor to NPC.
2. Pull combat profile to actor flags/paths.
3. Prompt NPC via panel.
4. Actor updates sync back to backend combat events.
