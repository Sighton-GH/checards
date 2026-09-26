/*
 * Multiplayer lobby adapter contract with ./net.js:
 *   createRoom({visibility:'private'|'public', side:'red'|'black'|'random'})
 *   joinRoom(code), listRooms(), spectate(code) are async exports.
 *   createRoom/joinRoom/spectate return {room|code, token?, side|role?, visibility?, session?}.
 *   listRooms returns {rooms:[{code,registeredAt,...}]} (or a rooms array).
 * On selection we dispatch window 'checards:room-selected' with
 * {room, role, token, session}; board/game glue owns that event.
 * REST source: POST/GET /api/rooms, WS /ws/rooms/:code (welcome/presence).
 */
import * as net from './net.js';

const shell = document.createElement('div');
shell.id = 'mpScrim';
shell.className = 'dlg-scrim hidden';
shell.innerHTML = `<div class="dlg mp-dlg" role="dialog" aria-modal="true" aria-labelledby="mpTitle">
  <div class="dlg-head"><h2 id="mpTitle">Play together</h2><button class="btn ghost dlg-x" id="mpClose" type="button" aria-label="Close multiplayer lobby">&times;</button></div>
  <div class="dlg-body">
    <p class="mp-intro">Make a room for a friend, enter a room code, or find a public game.</p>
    <div class="mp-tabs" role="tablist" aria-label="Multiplayer options">
      <button class="mp-tab" type="button" role="tab" aria-selected="true" aria-controls="mpCreate" id="mpTabCreate" data-mp-tab="create">Create</button>
      <button class="mp-tab" type="button" role="tab" aria-selected="false" aria-controls="mpJoin" id="mpTabJoin" data-mp-tab="join" tabindex="-1">Join</button>
      <button class="mp-tab" type="button" role="tab" aria-selected="false" aria-controls="mpBrowse" id="mpTabBrowse" data-mp-tab="browse" tabindex="-1">Public rooms</button>
    </div>
    <section class="mp-panel" id="mpCreate" role="tabpanel" aria-labelledby="mpTabCreate">
      <h3>Start a room</h3><p>Private rooms are only found by someone with your code or link.</p>
      <div class="mp-fields">
        <div class="mp-field"><label for="mpVisibility">Who can find it?</label><select id="mpVisibility"><option value="private">Private - invite only</option><option value="public">Public - listed in lobby</option></select></div>
        <div class="mp-field"><label for="mpSide">Your side</label><select id="mpSide"><option value="random">Surprise me</option><option value="red">Red - first move</option><option value="black">Black</option></select></div>
      </div><button class="btn primary" id="mpMake" type="button">Create room</button>
    </section>
    <section class="mp-panel" id="mpJoin" role="tabpanel" aria-labelledby="mpTabJoin" hidden>
      <h3>Join a room</h3><p>Paste an invite link or enter its six-character code.</p>
      <form id="mpJoinForm"><div class="mp-field"><label for="mpJoinCode">Room code or invite link</label><input id="mpJoinCode" autocomplete="off" spellcheck="false" placeholder="e.g. ABC234" required></div>
      <button class="btn primary" type="submit">Join game</button></form>
      <p class="mp-note">If both player seats are taken, you can still watch.</p>
    </section>
    <section class="mp-panel" id="mpBrowse" role="tabpanel" aria-labelledby="mpTabBrowse" hidden>
      <h3>Public rooms</h3><p>Pick a room to play or watch.</p>
      <button class="btn" id="mpRefresh" type="button">Refresh list</button>
      <div class="mp-list" id="mpRooms" aria-live="polite" style="margin-top:10px"></div>
    </section>
    <section class="mp-state" id="mpCreated" hidden>
      <h3>Room ready</h3><p>Share this link to invite another player. Your seat stays yours; do not share your player token.</p>
      <span class="mp-code" id="mpCreatedCode"></span>
      <div class="mp-linkbox" id="mpShareLink"></div>
      <div class="mp-row"><button class="btn" id="mpCopy" type="button">Copy invite link</button><button class="btn primary" id="mpEnter" type="button">Enter room</button><button class="btn ghost" id="mpAgain" type="button">Back to lobby</button></div>
    </section>
    <div class="mp-feedback" id="mpFeedback" role="status" aria-live="polite"></div>
  </div></div>`;
document.body.append(shell);
const q = s => shell.querySelector(s);
const opener = document.createElement('button');
opener.type = 'button'; opener.className = 'btn ghost'; opener.id = 'multiplayerBtn'; opener.textContent = 'Multiplayer';
const actions = document.querySelector('.top-actions');
actions.insertBefore(opener, actions.querySelector('#newgTop'));
let previousFocus, activeTab = 'create', created = null, busy = false, listSeq = 0;
const codeRe = /^[A-Z0-9]{6}$/;
function parseCode(value) {
  const input = String(value || '').trim();
  if (codeRe.test(input.toUpperCase())) return input.toUpperCase();
  try {
    const url = new URL(input);
    const found = url.searchParams.get('room') || url.searchParams.get('code') || url.pathname.match(/\/rooms\/([A-Z0-9]{6})\/?$/i)?.[1];
    if (url.origin === location.origin && codeRe.test((found || '').toUpperCase())) return found.toUpperCase();
  } catch { /* Not a URL. */ }
  return null;
}
function feedback(message) { q('#mpFeedback').textContent = message || ''; }
function tab(name, focus = false) {
  activeTab = name;
  q('#mpCreated').hidden = true;
  shell.querySelectorAll('.mp-tabs, .mp-intro').forEach(el => el.hidden = false);
  for (const btn of shell.querySelectorAll('[data-mp-tab]')) {
    const selected = btn.dataset.mpTab === name;
    btn.setAttribute('aria-selected', String(selected)); btn.tabIndex = selected ? 0 : -1;
    q('#mp' + btn.dataset.mpTab[0].toUpperCase() + btn.dataset.mpTab.slice(1)).hidden = !selected;
    if (selected && focus) btn.focus();
  }
  feedback('');
  if (name === 'browse') refresh();
}
function open() {
  previousFocus = document.activeElement;
  shell.classList.remove('hidden');
  const incoming = new URL(location.href).searchParams.get('room');
  if (incoming && parseCode(incoming)) { q('#mpJoinCode').value = parseCode(incoming); tab('join'); q('#mpJoinCode').focus(); }
  else if (created && !q('#mpCreated').hidden) q('#mpClose').focus();
  else { tab(activeTab); q('#mpClose').focus(); }
}
function close() {
  shell.classList.add('hidden'); feedback('');
  (previousFocus?.isConnected ? previousFocus : opener).focus();
}
function select(session, fallbackCode, desiredRole) {
  const room = session?.room || session?.code || fallbackCode;
  const role = session?.role || session?.side || desiredRole;
  if (!codeRe.test(String(room || ''))) throw new Error('Room response had no valid code.');
  // createRoom/joinRoom/spectate return a result wrapper; hand the board glue the real RoomSession.
  window.dispatchEvent(new CustomEvent('checards:room-selected', {detail:{room, role, token:session?.token, session: session?.session || session}}));
  close();
}
async function act(button, work) {
  if (busy) return;
  busy = true; button.disabled = true; feedback('');
  try { await work(); }
  catch (err) { feedback(err?.message || 'Could not reach the room. Try again.'); }
  finally { busy = false; button.disabled = false; }
}
async function refresh() {
  const seq = ++listSeq, container = q('#mpRooms');
  container.textContent = 'Loading rooms...';
  try {
    const result = await net.listRooms();
    if (seq !== listSeq || shell.classList.contains('hidden') || activeTab !== 'browse') return;
    const rooms = Array.isArray(result) ? result : result?.rooms;
    if (!Array.isArray(rooms)) throw new Error('Could not load public rooms.');
    container.replaceChildren();
    if (!rooms.length) { container.innerHTML = '<div class="mp-empty">No public rooms yet. Make one and invite a friend.</div>'; return; }
    for (const item of rooms) {
      const code = String(item?.code || '').toUpperCase();
      if (!codeRe.test(code)) continue;
      const row = document.createElement('div'); row.className = 'mp-room';
      const info = document.createElement('div'); info.className = 'mp-room-info';
      const title = document.createElement('strong'); title.textContent = code;
      const small = document.createElement('small'); small.textContent = item.phase === 'over' ? 'Finished' : 'Open room';
      info.append(title, small);
      const controls = document.createElement('div'); controls.className = 'mp-room-actions';
      for (const [label, method] of [['Join','joinRoom'], ['Watch','spectate']]) {
        const button = document.createElement('button'); button.className = label === 'Join' ? 'btn primary' : 'btn';
        button.type = 'button'; button.textContent = label;
        button.addEventListener('click', () => act(button, async () => select(await net[method](code), code, label === 'Watch' ? 'spec' : undefined)));
        controls.append(button);
      }
      row.append(info, controls); container.append(row);
    }
    if (!container.children.length) container.innerHTML = '<div class="mp-empty">No public rooms yet.</div>';
  } catch (err) { if (seq === listSeq) { container.textContent = ''; feedback(err?.message || 'Could not load public rooms.'); } }
}
opener.addEventListener('click', open);
q('#mpClose').addEventListener('click', close);
shell.addEventListener('click', e => { if (e.target === shell) close(); });
shell.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
  if (e.key === 'Tab') {
    const focusable = [...shell.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled])')]
      .filter(el => el.getClientRects().length && el.tabIndex >= 0);
    const first = focusable[0], last = focusable.at(-1);
    if (e.shiftKey && (document.activeElement === first || !shell.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !shell.contains(document.activeElement))) { e.preventDefault(); first?.focus(); }
  }
});
for (const button of shell.querySelectorAll('[data-mp-tab]')) {
  button.addEventListener('click', () => tab(button.dataset.mpTab));
  button.addEventListener('keydown', e => {
    const tabs = [...shell.querySelectorAll('[data-mp-tab]')];
    const index = tabs.indexOf(button);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault(); tab(tabs[(index + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].dataset.mpTab, true);
    }
  });
}
q('#mpMake').addEventListener('click', () => act(q('#mpMake'), async () => {
  created = await net.createRoom({visibility:q('#mpVisibility').value, side:q('#mpSide').value});
  const code = String(created?.room || created?.code || '').toUpperCase();
  if (!codeRe.test(code)) throw new Error('Room was created, but its code was missing.');
  const link = new URL(location.href); link.search = ''; link.hash = ''; link.searchParams.set('room', code);
  q('#mpCreatedCode').textContent = code;
  q('#mpShareLink').textContent = link.href;
  shell.querySelectorAll('.mp-panel, .mp-tabs, .mp-intro').forEach(el => el.hidden = true);
  q('#mpCreated').hidden = false;
  q('#mpCopy').textContent = 'Copy invite link'; q('#mpCopy').focus();
}));
q('#mpCopy').addEventListener('click', () => act(q('#mpCopy'), async () => {
  await navigator.clipboard.writeText(q('#mpShareLink').textContent);
  q('#mpCopy').textContent = 'Copied!';
}));
q('#mpEnter').addEventListener('click', () => { try { select(created); } catch(err) { feedback(err.message); } });
q('#mpAgain').addEventListener('click', () => {
  created = null; shell.querySelectorAll('.mp-tabs, .mp-intro').forEach(el => el.hidden = false); tab('create');
});
q('#mpJoinForm').addEventListener('submit', e => {
  e.preventDefault(); const code = parseCode(q('#mpJoinCode').value);
  if (!code) { feedback('Enter a six-character room code or an invite link from this site.'); return; }
  const button = q('#mpJoinForm button[type=submit]');
  act(button, async () => select(await net.joinRoom(code), code));
});
q('#mpRefresh').addEventListener('click', refresh);
// A share URL preselects Join, but never claims a player seat without a click.
if (parseCode(new URL(location.href).searchParams.get('room'))) {
  // On a first visit the built-in tutorial may open after engine initialization.
  // Wait for that dialog to close so the room invitation remains the active dialog.
  const help = document.querySelector('#helpScrim');
  if (help && !localStorage.getItem('checardsHelpSeen')) {
    const observer = new MutationObserver(() => {
      if (help.classList.contains('hidden') && localStorage.getItem('checardsHelpSeen')) { observer.disconnect(); open(); }
    });
    observer.observe(help, {attributes:true,attributeFilter:['class']});
  } else open();
}
