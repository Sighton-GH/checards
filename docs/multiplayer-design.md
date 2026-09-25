# Checards multiplayer - design (draft v1, integration anchor)

## Constraints from the game
- Hidden information is core: stacks hide unrevealed cards, draw piles are secret.
  => Server is authoritative. Clients never receive the full state, only their own view.
- Turn structure: atomic actions, N moves per turn (engine: moves left 3 at T1),
  combat at turn end, no-legal-action pass. Real-time sync is not latency-critical;
  100-300ms round trips are invisible. WebSocket (not WebRTC) is correct.

## Architecture
- Cloudflare Worker + one Durable Object per game room (all of *.sighton.ca is
  already Cloudflare-fronted; bananasaurs MCP endpoint suggests Workers in use).
- Engine: the same C++ built with em++ (SINGLE_FILE, ENVIRONMENT web,worker,node -
  already verified running outside the browser: native smoke game + jsdom WASM run).
  Worker instantiates the wasm once per DO; 64MB initial memory fits DO limits.
- Rooms: 6-char code or shareable link. Creator picks colour (or random).
  No accounts; a per-client random player token stored in localStorage authorizes
  rejoin. Spectators: later, not v1.
- Single-player vs AI stays: the existing all-client mode remains untouched as
  "Play vs computer"; multiplayer is "Play a friend".

## Protocol (JSON over WSS)
Client -> server:
  {t:"create", side?:"red"|"black"|"random"}        -> {t:"created", room, token, side}
  {t:"join", room}                                   -> {t:"joined", token, side} | {t:"error"}
  {t:"act", room, token, action}                     -> {t:"state", ...} broadcast (below)
  {t:"resign", room, token}
  {t:"ping"}
Server -> client:
  {t:"state", view, status, legal?, log_append, turn, moves_left, result?}
    view = per-player filtered board (own hidden cards visible to owner only as
    facedown to opponent; server strips what the engine marks hidden)
  {t:"error", code, msg}
  {t:"opponent", online:bool}
Reconnect: client resends {t:"join", room} + token; server resumes stream.

## Server internals
- DO state: engine game handle (cg_new via the play_api bindings), both player
  tokens/sides, sockets, plies counter, last-activity for hibernation.
- Every action: validate via engine legal list (never trust client), apply,
  compute both filtered views, broadcast. Server keeps the authoritative log.
- Draw offers / rematch: v1 = rematch button sends {t:"create"} with same players;
  draw offers deferred.

## Workstream seams (parallel build)
- WS1 mp-server: worker, DO, protocol, engine server-side, room lifecycle.
- WS2 mp-client: lobby UI (create/join/code share), ws client, state rendering into
  the WS3 shell, reconnect + opponent-presence UX.
- WS3 ui-redesign: chess.com-grade board + card presentation, move feedback,
  instructions/how-to-play overlay, responsive. Owns HTML shell + CSS; exposes a
  small render API (renderView(view), showStatus(), animateMove()) that WS2/WS1's
  protocol output feeds. WS2 must not restyle; WS3 must not touch networking.
- Integration (this agent): protocol conformance tests (two headless clients over
  ws against a local worker via miniflare), e2e game to completion, screenshots
  desktop+mobile per Connor's review gate before any merge.

## Decisions (Connor, 2026-09-25)
1. Deploy: Connor runs the Cloudflare deploy himself from server/DEPLOY.md.
2. Matchmaking: BOTH private room codes and a public lobby; games spectateable.
   Spectators get the neutral view (cs_state_spec / spec log) - only revealed
   cards, both sides' hidden cards stay hidden.
3. Public repo confirmed fine.

## Room model
- POST /api/rooms {visibility: private|public, side} -> {room, side, token}
- Public rooms register with the Lobby DO (GET /api/rooms lists them).
- Players hold per-side bearer tokens (rejoin + act authorization); spectators
  connect without a token and receive the neutral view only.
- GameRoom DO persists the seed + accepted action log and rebuilds engine state
  by replay after hibernation (event sourcing; legal indexing is deterministic).

## Test plan for multiplayer
- Protocol fuzz: illegal actions rejected; hidden-info leak test (inspect wire
  messages, assert opponent never receives unrevealed cards).
- Two-client e2e game to completion; disconnect/rejoin mid-game; simultaneous
  connect race on join.
- Load: trivial (2 clients/room), but DO hibernation/resume correctness matters.
