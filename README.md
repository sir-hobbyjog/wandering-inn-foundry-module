# Wandering Inn Core Bridge (Foundry Module)

Install URL (Foundry):

`https://raw.githubusercontent.com/sir-hobbyjog/wandering-inn-foundry-module/main/module.json`

## Required backend settings
- `apiBaseUrl` (default `http://127.0.0.1:8000`)
- `apiKey` (must match backend `FOUNDRY_API_KEY`)

## Optional settings
- `defaultVoiceId` for ElevenLabs
- `autoPlayVoice`
- `gmDebugMode` to request backend prompt traces by default (GM only)
- actor path mappings: `hpMaxPath`, `hpValuePath`, `hpTempPath`, `acPath`

## Keybindings
- `Open NPC Panel` (`Shift+Alt+N` default)
- `Open DM Console` (`Shift+Alt+D` default, GM only)
- `Pull Combat for Selected Token` (`Shift+Alt+P` default, GM only)
- Scene controls (left toolbar, Token controls): `Open WI DM Console` button (GM only)

## Runtime flow
1. Bind actor to NPC.
2. Pull combat profile to actor flags/paths.
3. Prompt NPC via panel.
4. (GM) Enable Debug Mode in the panel and use `Show Prompt Debug` or `Open DM Console`.
5. Actor updates sync back to backend combat events.
