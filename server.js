'use strict';
const express = require('express');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 8088;
const HOST_IP = process.env.HOST_IP || '172.16.50.100';
const UID = process.getuid();
const USERENV = `XDG_RUNTIME_DIR=/run/user/${UID} DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${UID}/bus`;
const CONFIG_DIR = path.join(os.homedir(), '.config/spotify-signage');
const ENV_FILE = path.join(CONFIG_DIR, 'stream.env');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token.json');
const SCHED_FILE = path.join(CONFIG_DIR, 'schedules.json');
const AUDIO_ENV = path.join(CONFIG_DIR, 'audio.env');
const OAUTH_PY = path.join(CONFIG_DIR, 'spotify_oauth.py');
const CLIENT_ID = process.env.SIGNAGE_CLIENT_ID || '99aa015e38634f389d6b8d1e16b3a578';
const REDIRECT = process.env.SIGNAGE_REDIRECT || `https://${HOST_IP}:8989/login`;
const DEVICE_NAME = process.env.SIGNAGE_DEVICE || 'Signage';

function loadEnv(file){
  const env={};
  try{ for(const line of fs.readFileSync(file,'utf8').split('\n')){
    const m=line.match(/^([A-Z_]+)=(.*)$/); if(m) env[m[1]]=m[2]; } }catch(e){}
  return env;
}
const ENV = loadEnv(ENV_FILE);
const ICE_PORT = ENV.ICECAST_PORT || '8000';
const ICE_ADMIN_PW = ENV.ICECAST_ADMIN_PW || '';
const MOUNT = ENV.ICECAST_MOUNT || '/spotify.mp3';
const ICE_BASE = `http://localhost:${ICE_PORT}`;
const STREAM_BITRATE = parseInt(ENV.STREAM_BITRATE || '128', 10) || 128; // real configured encoder bitrate (stream.sh default 128)
const VERSION = 'v1.1';
const BOOT_MS = Date.now() - os.uptime() * 1000;   // real host boot time, for accurate "Server uptime"

/* ---- audio processing (librespot volume normalisation; gapless always on) ---- */
function audioSettings(){
  const e=loadEnv(AUDIO_ENV);
  const pg=parseFloat(e.NORMALIZE_PREGAIN);
  return {
    normalize: (e.NORMALIZE==null ? true : e.NORMALIZE==='1'),   // default on
    gainType: e.NORMALIZE_GAIN_TYPE || 'track',
    method: e.NORMALIZE_METHOD || 'dynamic',
    pregain: isNaN(pg) ? 0 : Math.max(-10, Math.min(10, pg)),
    gapless: true
  };
}
function saveAudio(s){
  const content=[
    '# Audio processing for the librespot stream — managed by the dashboard (/api/audio).',
    'NORMALIZE='+(s.normalize?'1':'0'),
    'NORMALIZE_GAIN_TYPE='+s.gainType,
    'NORMALIZE_METHOD='+s.method,
    'NORMALIZE_PREGAIN='+s.pregain
  ].join('\n')+'\n';
  fs.mkdirSync(CONFIG_DIR,{recursive:true});
  fs.writeFileSync(AUDIO_ENV, content, {mode:0o600});
}

function sh(cmd, timeout=8000){
  return new Promise(res=>{
    exec(cmd,{timeout,maxBuffer:1<<20},(err,stdout,stderr)=>
      res({err,stdout:(stdout||'').trim(),stderr:(stderr||'').trim()}));
  });
}

/* ============================ Spotify Web API ============================ */
/* In-memory access-token cache: refresh only when <60s from expiry (≈once/hour)
   instead of per request. Plus a global 429 backoff. This is what keeps us
   from getting rate-limited. */
let accessTok=null, accessExp=0, backoffUntil=0;
function readTokenFile(){ try{ return JSON.parse(fs.readFileSync(TOKEN_FILE,'utf8')); }catch(e){ return null; } }
function authStatus(){
  const t=readTokenFile();
  if(!t || !t.refresh_token) return {connected:false};
  return {connected:true, scopes:t.scope||null, expires_at:t.expires_at||null};
}
async function getAccessToken(){
  if(accessTok && Date.now() < accessExp-60000) return accessTok;
  const t=readTokenFile();
  if(!t || !t.refresh_token){ const e=new Error('not-authenticated'); e.unlinked=true; throw e; }
  const body=new URLSearchParams({grant_type:'refresh_token',refresh_token:t.refresh_token,client_id:CLIENT_ID});
  const r=await fetch('https://accounts.spotify.com/api/token',
    {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(15000)});
  if(!r.ok){ const txt=await r.text(); const e=new Error('refresh-failed:'+r.status); e.body=txt.slice(0,160);
    if(r.status===400) e.unlinked=true; throw e; }
  const j=await r.json();
  accessTok=j.access_token; accessExp=Date.now()+((j.expires_in||3600)*1000);
  const merged=Object.assign({},t,j); if(!j.refresh_token) merged.refresh_token=t.refresh_token;
  merged.expires_at=new Date(accessExp).toISOString();
  try{ fs.writeFileSync(TOKEN_FILE,JSON.stringify(merged),{mode:0o600}); }catch(e){}
  return accessTok;
}
async function api(pathq,{method='GET',body=null}={}){
  if(Date.now()<backoffUntil){ const e=new Error('rate-limited'); e.rate=true; throw e; }
  const tok=await getAccessToken();
  const headers={Authorization:'Bearer '+tok};
  if(body) headers['Content-Type']='application/json';
  const r=await fetch('https://api.spotify.com/v1'+pathq,
    {method,headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(12000)});
  if(r.status===429){ const ra=parseInt(r.headers.get('retry-after')||'10',10);
    backoffUntil=Date.now()+(ra+1)*1000; const e=new Error('rate-limited'); e.rate=true; e.retryAfter=ra; throw e; }
  return r;
}

/* ------- playback controls ------- */
function normPlaylist(x){
  if(!x) return null;
  let id=String(x).trim();
  const m=id.match(/playlist[/:]([A-Za-z0-9]+)/); if(m) id=m[1];
  return id.replace(/\?.*$/,'').replace(/[^A-Za-z0-9]/g,'') || null;
}
async function findDevice(){
  const r=await api('/me/player/devices'); const j=await r.json();
  return (j.devices||[]).find(d=>d.name===DEVICE_NAME) || null;
}
async function playPlaylist(playlist, shuffle){
  const id=normPlaylist(playlist);
  if(!id) throw new Error('bad-playlist');
  const dev=await findDevice();
  if(!dev){ const e=new Error('device-offline'); e.code='device-offline'; throw e; }
  try{ await api(`/me/player/shuffle?state=${shuffle?'true':'false'}&device_id=${dev.id}`,{method:'PUT'}); }catch(e){}
  const pr=await api(`/me/player/play?device_id=${dev.id}`,{method:'PUT',body:{context_uri:'spotify:playlist:'+id}});
  // Spotify relays player commands to Connect devices and answers 200/202/204 — accept any 2xx, not just 204/202.
  if(!pr.ok){ const t=await pr.text(); throw new Error('play-failed:'+pr.status+':'+t.slice(0,120)); }
  // loop the playlist forever: when it reaches the end, repeat the whole context (essential for 24/7 signage)
  try{ await api(`/me/player/repeat?state=context&device_id=${dev.id}`,{method:'PUT'}); }catch(e){}
  npAt=0; queueAt=0; // invalidate now-playing + queue caches so the UI reflects the new track/queue next tick
  return {ok:true, device:dev.name, playlist:id, shuffle:!!shuffle};
}
async function pausePlayback(){
  const dev=await findDevice(); const q=dev?('?device_id='+dev.id):''; // target the Signage device explicitly
  const r=await api('/me/player/pause'+q,{method:'PUT'});
  const ok=r.ok; if(ok) npAt=0; return {ok};
}
async function resumePlayback(){
  const dev=await findDevice(); const q=dev?('?device_id='+dev.id):'';
  const r=await api('/me/player/play'+q,{method:'PUT'});
  const ok=r.ok; if(ok) npAt=0; return {ok};
}
// force repeat=context so a playlist loops back to the start when it ends (24/7 signage never stops)
async function setRepeatContext(){
  try{ const dev=await findDevice(); const q=dev?('&device_id='+dev.id):'';
    await api('/me/player/repeat?state=context'+q,{method:'PUT'}); }catch(e){}
}
// Pull playback onto the Signage device WITHOUT restarting the context (keeps current track + position).
// Used when playback has drifted to another device — e.g. a phone that joined a Spotify Jam on the account.
async function transferToSignage(){
  const dev=await findDevice(); if(!dev) return false;
  const r=await api('/me/player',{method:'PUT',body:{device_ids:[dev.id],play:true}});
  return r.ok;
}
async function skip(dir){
  const dev=await findDevice(); const q=dev?('?device_id='+dev.id):'';
  const r=await api('/me/player/'+dir+q,{method:'POST'});
  const ok=r.ok; if(ok){ npAt=0; queueAt=0; } return {ok};
}
async function seek(positionMs){
  positionMs=Math.max(0,Math.floor(Number(positionMs)||0));
  const dev=await findDevice(); const q=dev?('&device_id='+dev.id):'';
  const r=await api('/me/player/seek?position_ms='+positionMs+q,{method:'PUT'});
  if(r.status===404){ const e=new Error('device-offline'); e.code='device-offline'; throw e; }
  if(!r.ok){ const t=await r.text().catch(()=>''); throw new Error('seek-failed:'+r.status+':'+t.slice(0,120)); } // accept 200/202/204
  if(np && (np.state==='playing'||np.state==='paused')) np.progress=positionMs; // optimistic base if read before refetch
  npAt=0; // force a fresh read so the bar snaps to the real position, not the pre-seek cached one
  return {ok:true, position_ms:positionMs};
}

/* ------- playlists (cached 5 min so the dropdown never rate-limits) ------- */
let plCache=null, plAt=0;
async function getPlaylists(){
  if(plCache && Date.now()-plAt<300000) return plCache;
  const r=await api('/me/playlists?limit=50');
  if(!r.ok) throw new Error('playlists-failed:'+r.status);
  const j=await r.json();
  plCache=(j.items||[]).map(p=>({id:p.id,name:p.name,tracks:(p.tracks||{}).total||0,
    image:((p.images||[])[0]||{}).url||null,owner:(p.owner||{}).display_name||''}));
  plAt=Date.now();
  return plCache;
}

/* Resolve a playback context (playlist) to a display name WITHOUT spamming the Web API:
   prefer the 5-min playlists cache, then a 10-min name cache, then a cheap fields=name fetch. */
let ctxNameCache={};
function cacheCtxName(id,name){   // cap the map so months of unique play contexts can't grow it unbounded
  ctxNameCache[id]={name,at:Date.now()};
  const ks=Object.keys(ctxNameCache);
  if(ks.length>200) ks.sort((a,b)=>ctxNameCache[a].at-ctxNameCache[b].at).slice(0,ks.length-200).forEach(k=>delete ctxNameCache[k]);
}
async function resolveContextName(type,id){
  if(type!=='playlist'||!id) return null;
  if(plCache){ const hit=plCache.find(p=>p.id===id); if(hit) return hit.name; }  // free: already fetched
  const c=ctxNameCache[id]; if(c && Date.now()-c.at<600000) return c.name;
  try{
    const r=await api('/playlists/'+id+'?fields=name');
    if(r.ok){ const j=await r.json(); const nm=j.name||null; cacheCtxName(id,nm); return nm; }
    cacheCtxName(id,null); return null;
  }catch(e){ return null; }
}

/* GET /me once (product tier + display name) — cached 1h, drives the real PREMIUM badge & avatar. */
let meCache=null, meAt=0;
async function meInfo(){
  if(meCache && Date.now()-meAt<3600000) return meCache;
  if(!authStatus().connected){ return null; }
  try{
    const r=await api('/me');
    if(!r.ok) return meCache;
    const j=await r.json();
    meCache={product:j.product||null, name:j.display_name||j.id||null}; meAt=Date.now();
    return meCache;
  }catch(e){ return meCache; }
}

/* ------- up-next queue (cached ~9s so the panel never rate-limits) ------- */
let queue={state:'idle',items:[]}, queueAt=0, queueGood=null;
const QUEUE_TTL=9000;
function mapQItem(it){
  if(!it) return null;
  const imgs=((it.album||{}).images)||it.images||[];
  const artists=(it.artists&&it.artists.length)?it.artists.map(a=>a.name).join(', ')
              :((it.show&&it.show.name)?it.show.name:'');
  return { id:it.id||it.uri||null, name:it.name||null, artists,
    art:(imgs[imgs.length-1]||imgs[0]||{}).url||null, duration:it.duration_ms||0 };
}
async function getQueue(){
  if(queueAt && Date.now()-queueAt<QUEUE_TTL) return queue;
  if(!authStatus().connected){ queue={state:'unlinked',items:[]}; queueAt=Date.now(); queueGood=null; return queue; }
  try{
    const r=await api('/me/player/queue');
    if(r.status===204||!r.ok){ queue={state:'idle',items:[]}; queueAt=Date.now(); queueGood=null; return queue; }
    const j=await r.json();
    const items=(j.queue||[]).map(mapQItem).filter(Boolean).slice(0,20);  // Spotify returns ~20 upcoming; show them all
    queue={state:'ok', current:mapQItem(j.currently_playing), items};
    queueAt=Date.now(); queueGood=queue;
    return queue;
  }catch(e){
    if(e.rate && queueGood) return Object.assign({},queueGood,{warn:'ratelimited'});
    if(e.unlinked){ queue={state:'unlinked',items:[]}; queueAt=Date.now(); queueGood=null; return queue; }
    if(queueGood) return Object.assign({},queueGood,{warn:'stale'});
    queue = e.rate ? {state:'ratelimited',items:[]} : {state:'idle',items:[]}; queueAt=Date.now(); return queue;
  }
}

/* ============================ scheduler — weekly timeline ============================ */
/* Store: { version:2, enabled:bool, blocks:[{id,day,start,end,playlist,name,shuffle}] }
   `day` = 0..6 (Sun..Sat), `start`/`end` = minutes-from-midnight (0..1440, end>start).
   The timeline is AUTHORITATIVE: whichever block covers "now" (this weekday + minute-of-day)
   is the playlist that should be playing; any moment NOT covered by any block => paused.
   The old fire-at-a-time schedule format is obsolete and migrated to an empty timeline. */
function migrateStore(raw){
  if(raw && !Array.isArray(raw) && typeof raw==='object')
    return {version:2, enabled:raw.enabled!==false, blocks:Array.isArray(raw.blocks)?raw.blocks:[]};
  return {version:2, enabled:true, blocks:[]};   // old array format (or garbage) => fresh timeline
}
function sanitizeBlock(b){
  if(!b) return null;
  const day=Math.max(0,Math.min(6, parseInt(b.day,10)||0));
  const start=Math.max(0,Math.min(1440, Math.round((Number(b.start)||0)/5)*5));
  const end  =Math.max(0,Math.min(1440, Math.round((Number(b.end)||0)/5)*5));
  if(end<=start) return null;
  const pl=normPlaylist(b.playlist); if(!pl) return null;
  return { id:String(b.id||('b'+Date.now().toString(36)+Math.floor(Math.random()*1e6).toString(36))),
    day, start, end, playlist:pl, name:String(b.name||'').slice(0,80), shuffle:!!b.shuffle };
}
function loadStore(){ try{ return migrateStore(JSON.parse(fs.readFileSync(SCHED_FILE,'utf8'))); }catch(e){ return {version:2,enabled:true,blocks:[]}; } }
function saveStore(store){ try{ fs.mkdirSync(CONFIG_DIR,{recursive:true}); fs.writeFileSync(SCHED_FILE,JSON.stringify(store,null,2),{mode:0o600}); }catch(e){} }

let schedLog=[];
function slog(msg){ schedLog.unshift({ts:Date.now(),msg}); schedLog=schedLog.slice(0,25); console.log('[sched]',msg); }

// The block covering `now`, if any (earliest start wins if two overlap — the UI prevents overlaps).
function activeBlock(store, now){
  const dow=now.getDay(), min=now.getHours()*60+now.getMinutes();
  return store.blocks.filter(b=>b.day===dow && b.start<=min && min<b.end)
    .sort((a,b)=>a.start-b.start)[0] || null;
}

/* Reconciler (LEVEL-based): every tick it compares what SHOULD be playing (the block covering now,
   or silence in a gap) against what IS playing, and only issues a command on real DRIFT. Crucially
   it NEVER re-issues a fresh context transfer when the right playlist is already playing — so editing
   the schedule, crossing between adjacent same-playlist blocks, or a startup tick never restart audio
   from track 1. A dashboard play/pause arms a manual-override window (noteManual); it is only cleared
   when the active slot GENUINELY changes (gap<->block or block->different block), never by a mere
   re-evaluation (resetSlot), so a schedule edit can't cancel an in-effect manual pause. */
let lastSlotKey=null, manualUntil=0, reconcileBusy=false;
const MANUAL_WINDOW=4*60*60*1000;
function noteManual(){ manualUntil=Date.now()+MANUAL_WINDOW; }
function resetSlot(){ lastSlotKey=null; }   // force the next tick to re-evaluate (without treating it as a genuine slot change)

async function reconcile(){
  if(reconcileBusy) return; reconcileBusy=true;
  try{
    const store=loadStore();
    // automation off, OR an empty timeline (nothing scheduled yet) => hands off entirely, so a blank
    // grid never mutes manual playback. Gap-silence only applies once at least one block exists.
    if(!store.enabled || !store.blocks.length){ lastSlotKey=null; return; }
    if(!authStatus().connected){ return; }                 // can't control playback while unlinked
    const now=new Date();
    const block=activeBlock(store, now);
    const slotKey=block?('blk:'+block.id):'gap';
    const changed = slotKey!==lastSlotKey;
    // a genuine slot change reclaims control from any manual override — but only when we already had a
    // real prior slot (lastSlotKey!==null); after resetSlot()/startup we re-evaluate without clearing it.
    if(changed && lastSlotKey!==null) manualUntil=0;
    lastSlotKey=slotKey;

    if(Date.now()<manualUntil) return;                     // inside a manual-override window — leave playback alone
    const p=await nowPlaying();                            // cached (~3s) — cheap; used only to detect drift
    if(block){
      const onSignage = !!(p && p.device===DEVICE_NAME);   // is playback actually on OUR device (not a phone)?
      const ctxMatch  = !!(p && p.contextId===block.playlist);
      if(ctxMatch && onSignage && p.state==='playing'){ if(p.repeat!=='context') await setRepeatContext(); return; }  // correct — ensure it loops, never restart
      if(ctxMatch && onSignage && p.state==='paused'){ try{ await resumePlayback(); }catch(e){} return; }             // resume in place, keep position
      if(ctxMatch && !onSignage){                          // right playlist but drifted to another device (Spotify Jam / phone) => reclaim it, keeping position
        try{ if(await transferToSignage()){ await setRepeatContext(); slog(`▶ reclaimed playback on Signage (was on "${(p&&p.device)||'another device'}")`); } }catch(e){}
        return;
      }
      try{ const r=await playPlaylist(block.playlist, block.shuffle); if(changed) slog(`▶ "${block.name||r.playlist}" started (scheduled)`); } // idle / wrong context => start the scheduled playlist
      catch(e){ if(changed) slog(`✗ block "${block.name||block.playlist}" failed: ${e.code||e.message}`); }
    } else {
      if(p && p.state==='playing'){ try{ await pausePlayback(); if(changed) slog('⏸ paused — no block scheduled'); }catch(e){} }  // gap: keep it silent
    }
  } finally { reconcileBusy=false; }
}
setInterval(()=>{ reconcile().catch(()=>{}); }, 15000);
reconcile().catch(()=>{});   // assert the correct state on startup (restores the schedule after a reboot)

/* ============================ web login (spawns oauth helper) ============================ */
let authProc=null, authUrl=null;
function startAuth(){
  return new Promise((resolve,reject)=>{
    if(authProc && authUrl && !authStatus().connected){ return resolve({login_url:authUrl, reused:true}); }
    try{ if(authProc) authProc.kill('SIGKILL'); }catch(e){}
    authProc=null; authUrl=null;
    const env=Object.assign({},process.env,{
      XDG_RUNTIME_DIR:`/run/user/${UID}`, SIGNAGE_REDIRECT:REDIRECT, SIGNAGE_BIND:'0.0.0.0', SIGNAGE_CLIENT_ID:CLIENT_ID });
    const p=spawn('/usr/bin/python3',[OAUTH_PY,'auth'],{env,stdio:['ignore','pipe','pipe']});
    authProc=p; let buf='';
    const onData=d=>{ buf+=d.toString(); const m=buf.match(/LOGIN_URL (\S+)/);
      if(m && !authUrl){ authUrl=m[1]; resolve({login_url:authUrl, redirect:REDIRECT}); } };
    p.stdout.on('data',onData); p.stderr.on('data',onData);
    p.on('exit',()=>{ if(authProc===p){ authProc=null; } });
    setTimeout(()=>{ if(!authUrl){ try{p.kill('SIGKILL');}catch(e){} reject(new Error('no-login-url')); } },8000);
  });
}

/* ============================ status/monitor (unchanged core) ============================ */
let svcCache=null, svcAt=0;
async function serviceState(){
  if(svcCache && Date.now()-svcAt<4000) return svcCache;   // don't spawn systemctl twice per status tick
  const [stream, icecast] = await Promise.all([
    sh(`${USERENV} systemctl --user is-active spotify-stream.service`),
    sh(`systemctl is-active icecast2`)
  ]);
  svcCache={ stream: stream.stdout==='active', icecast: icecast.stdout==='active' }; svcAt=Date.now();
  return svcCache;
}
let lrCache=null, lrAt=0, lrAuthed=null;
async function librespotInfo(){
  if(lrCache && Date.now()-lrAt<30000) return lrCache;
  // Scan the whole unit journal (not just the last 300 lines) — librespot logs "Authenticated as"
  // once at startup, which scrolls out of a tail window after a few hours and made the UI show
  // "not linked" despite a live stream. Once seen, remember it stickily for the process lifetime.
  const r=await sh(`${USERENV} journalctl --user -u spotify-stream --no-pager 2>/dev/null | grep -i 'Authenticated as' | tail -1`);
  const m=r.stdout.match(/Authenticated as '([^']+)'/);
  if(m) lrAuthed={authed:true, user:m[1]};
  lrCache = lrAuthed || {authed:false};
  lrAt=Date.now(); return lrCache;
}
let iceCache=null, iceAt=0;
async function icecastStatus(){
  if(iceCache && Date.now()-iceAt<2000) return iceCache;   // fullStatus hits this on every SSE tick; dedupe
  try{
    const r=await fetch(`${ICE_BASE}/status-json.xsl`,{signal:AbortSignal.timeout(4000)});
    const j=await r.json(); const s=j.icestats||{};
    let src=s.source?(Array.isArray(s.source)?s.source:[s.source]):[];
    iceCache={ up:true, serverStart:s.server_start_iso8601, sources: src.map(x=>({
      mount:(x.listenurl||'').replace(/^https?:\/\/[^/]+/,'')||x.server_name,
      bitrate:x.bitrate||x.ice_bitrate||null, listeners:x.listeners||0,
      title:x.title||x.yp_currently_playing||null })) }; iceAt=Date.now();
    return iceCache;
  }catch(e){ return {up:false, sources:[]}; }   // don't cache failures -> outages/recovery surface immediately
}
function classify(ua){
  const u=(ua||'').toLowerCase();
  if(u.includes('brightsign')) return 'brightsign';
  if(u.includes('sonos')) return 'sonos';
  if(u.includes('vlc')) return 'vlc';
  if(u.includes('lavf')||u.includes('ffmpeg')) return 'ffmpeg';
  if(u.includes('mozilla')||u.includes('applewebkit')||u.includes('chrome')) return 'browser';
  return 'other';
}
async function listeners(){
  if(!ICE_ADMIN_PW) return [];
  try{
    const auth='Basic '+Buffer.from('admin:'+ICE_ADMIN_PW).toString('base64');
    const r=await fetch(`${ICE_BASE}/admin/listclients?mount=${encodeURIComponent(MOUNT)}`,
      {headers:{Authorization:auth},signal:AbortSignal.timeout(4000)});
    if(!r.ok) return [];
    const xml=await r.text(); const out=[]; const re=/<listener[^>]*>([\s\S]*?)<\/listener>/g; let m;
    while((m=re.exec(xml))){
      const b=m[1];
      const ip=(b.match(/<IP>([^<]*)<\/IP>/)||[])[1]||'';
      const ua=(b.match(/<UserAgent>([^<]*)<\/UserAgent>/)||[])[1]||'';
      const conn=parseInt((b.match(/<Connected>([^<]*)<\/Connected>/)||[])[1]||'0',10);
      out.push({ip, ua, connected:conn, kind:classify(ua)});
    }
    return out;
  }catch(e){ return []; }
}
let np={state:'unknown'}, npAt=0, npGood=null;
const NP_TTL=3000; // short TTL: track changes surface within one status tick; progress stays smooth via liveNp()
/* Extrapolate a cached now-playing snapshot forward by the wall-clock elapsed since it was
   sampled, so the progress the client receives keeps advancing between real API reads instead
   of being frozen (the root cause of the progress-bar sawtooth). Clones — never mutates the base. */
function liveNp(p){
  if(p && p.state==='playing' && p.duration && npAt)
    return Object.assign({},p,{progress:Math.min(p.duration,(p.progress||0)+(Date.now()-npAt))});
  return p;
}
async function nowPlaying(){
  if(npAt && Date.now()-npAt<NP_TTL) return liveNp(np);
  if(!authStatus().connected){ np={state:'unlinked'}; npAt=Date.now(); npGood=null; return np; }
  try{
    const r=await api('/me/player');
    if(r.status===204){ np={state:'idle'}; npAt=Date.now(); npGood=null; return np; }
    if(!r.ok){ np={state:'idle'}; npAt=Date.now(); npGood=null; return np; }
    const j=await r.json(); const it=j.item||{};
    const imgs=((it.album||{}).images||[]);
    const ctx=j.context||{}; let contextType=ctx.type||null, contextId=null;
    if(ctx.uri){ const cm=String(ctx.uri).match(/spotify:playlist:([A-Za-z0-9]+)/); if(cm){ contextType='playlist'; contextId=cm[1]; } }
    const contextName=await resolveContextName(contextType,contextId);
    np={ state:j.is_playing?'playing':'paused', track:it.name||null,
      artists:(it.artists||[]).map(a=>a.name).join(', '), album:(it.album||{}).name||null,
      art:(imgs[0]||{}).url||null, progress:j.progress_ms||0, duration:it.duration_ms||0,
      device:(j.device||{}).name||null, shuffle:!!j.shuffle_state, repeat:j.repeat_state||'off',
      contextType, contextId, contextName };
    npAt=Date.now(); npGood=np;
    return np;
  }catch(e){
    // A transient 429/timeout must NOT blank the card — keep showing the last good track, extrapolated.
    if(e.rate && npGood) return liveNp(Object.assign({},npGood,{warn:'ratelimited'}));
    if(e.unlinked){ np={state:'unlinked'}; npAt=Date.now(); npGood=null; return np; }
    if(npGood) return liveNp(Object.assign({},npGood,{warn:'stale'}));
    np = e.rate ? {state:'ratelimited'} : {state:'idle'}; npAt=Date.now(); return np;
  }
}

// live SSE dashboard connections (drives the shared status broadcaster). The on-screen VU meter and its
// ffmpeg ebur128 loudness-meter subprocess were removed — nothing consumes an audio "level" anymore.
const sseClients=new Set();

async function fullStatus(){
  const [svc,ice,lis,lr,me]=await Promise.all([serviceState(),icecastStatus(),listeners(),librespotInfo(),meInfo()]);
  const playing=await nowPlaying();
  const src=ice.sources.find(s=>(s.mount||'').includes('spotify'));
  const audience=lis.filter(l=>l.kind!=='ffmpeg');
  const auth=Object.assign({}, authStatus(), me?{product:me.product, user:me.name}:{});
  const store=loadStore(); const sAct=activeBlock(store,new Date());
  const schedule={ enabled:store.enabled, count:store.blocks.length,
    active: sAct?{id:sAct.id, name:sAct.name, playlist:sAct.playlist}:null };
  return {
    ts:Date.now(), services:svc, librespot:lr, auth, schedule, audio:audioSettings(),
    icecast:{up:ice.up, serverStart:ice.serverStart},
    source: src?{active:true, bitrate:src.bitrate||STREAM_BITRATE, mount:src.mount}:{active:false},
    streamBitrate:STREAM_BITRATE, hostStart:new Date(BOOT_MS).toISOString(), version:VERSION,
    audience, audienceCount:audience.length, nowplaying:playing,
    host:HOST_IP, streamUrl:`http://${HOST_IP}:${ICE_PORT}${MOUNT}`
  };
}

const app=express();
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

app.get('/api/status', async (req,res)=>{ try{ res.json(await fullStatus()); }catch(e){ res.status(500).json({error:String(e)}); } });
// ---- shared SSE broadcaster: ONE status timer for ALL clients (was a per-connection timer, so fullStatus()
//      + its subprocess spawns ran once PER viewer every 2.5s). Now O(1) regardless of viewer count. ----
let sseStatusTimer=null;
function sseWrite(res,frame){ if(res.writableEnded||res.destroyed){ sseClients.delete(res); return; } try{ res.write(frame); }catch(e){ sseClients.delete(res); } }
function sseBroadcast(frame){ for(const res of sseClients) sseWrite(res,frame); }
function sseEnsureTimers(){
  if(sseStatusTimer) return;
  sseStatusTimer=setInterval(async ()=>{ if(!sseClients.size) return; let s; try{ s=await fullStatus(); }catch(e){ return; }
    sseBroadcast(`event: status\ndata: ${JSON.stringify(s)}\n\n`); },2500);
}
function sseStopTimers(){ if(sseStatusTimer){clearInterval(sseStatusTimer);sseStatusTimer=null;} }
app.get('/api/stream',(req,res)=>{
  res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive','X-Accel-Buffering':'no'});
  res.flushHeaders();
  sseClients.add(res);
  sseEnsureTimers();
  fullStatus().then(s=>sseWrite(res,`event: status\ndata: ${JSON.stringify(s)}\n\n`)).catch(()=>{});  // immediate first frame
  req.on('close',()=>{ sseClients.delete(res); if(!sseClients.size) sseStopTimers(); });  // last viewer left -> stop the status timer
});

// auth
app.get('/api/auth/status',(req,res)=>res.json(authStatus()));
app.post('/api/auth/start',async(req,res)=>{ try{ res.json(await startAuth()); }catch(e){ res.status(500).json({error:String(e.message||e)}); } });

// playlists + playback
app.get('/api/playlists',async(req,res)=>{ try{ res.json({playlists:await getPlaylists()}); }
  catch(e){ res.status(e.rate?429:(e.unlinked?401:500)).json({error:String(e.message||e)}); } });
app.get('/api/queue',async(req,res)=>{ try{ res.json(await getQueue()); }
  catch(e){ res.status(e.rate?429:(e.unlinked?401:500)).json({error:String(e.message||e)}); } });
// manual control from the dashboard suspends timeline enforcement — but only after the command actually
// SUCCEEDS, so a failed Play (e.g. device offline) doesn't silence the schedule for 4h (noteManual).
app.post('/api/play',async(req,res)=>{ try{ const r=await playPlaylist((req.body||{}).playlist,(req.body||{}).shuffle); noteManual(); res.json(r); }
  catch(e){ res.status(e.rate?429:(e.code==='device-offline'?409:(e.unlinked?401:400))).json({error:String(e.code||e.message||e)}); } });
app.post('/api/pause',async(req,res)=>{ try{ const r=await pausePlayback(); if(r.ok) noteManual(); res.json(r); }catch(e){ res.status(400).json({error:String(e.message||e)}); } });
app.post('/api/resume',async(req,res)=>{ try{ const r=await resumePlayback(); if(r.ok) noteManual(); res.json(r); }catch(e){ res.status(e.code==='device-offline'?409:(e.unlinked?401:400)).json({error:String(e.code||e.message||e)}); } });
app.post('/api/next',async(req,res)=>{ try{ const r=await skip('next'); if(r.ok) noteManual(); res.json(r); }catch(e){ res.status(400).json({error:String(e.message||e)}); } });
app.post('/api/previous',async(req,res)=>{ try{ const r=await skip('previous'); if(r.ok) noteManual(); res.json(r); }catch(e){ res.status(400).json({error:String(e.message||e)}); } });
app.post('/api/seek',async(req,res)=>{
  const pos=(req.body||{}).position_ms;
  if(pos==null||isNaN(+pos)) return res.status(400).json({error:'position_ms required'});
  try{ res.json(await seek(+pos)); }
  catch(e){ res.status(e.rate?429:(e.code==='device-offline'?409:(e.unlinked?401:400))).json({error:String(e.code||e.message||e)}); }
});

// schedules — weekly timeline (blocks). GET reads, PUT replaces the whole timeline.
function schedPayload(store){
  const now=new Date(); const act=activeBlock(store,now);
  return { enabled:store.enabled, blocks:store.blocks, activeId:act?act.id:null,
    now:{dow:now.getDay(), min:now.getHours()*60+now.getMinutes()} };
}
app.get('/api/schedules',(req,res)=>{ const store=loadStore(); res.json(Object.assign(schedPayload(store),{log:schedLog})); });
app.put('/api/schedules',(req,res)=>{
  const b=req.body||{}; const store=loadStore();
  if(Array.isArray(b.blocks)) store.blocks=b.blocks.map(sanitizeBlock).filter(Boolean);
  if(typeof b.enabled==='boolean') store.enabled=b.enabled;
  saveStore(store);
  resetSlot();                        // re-evaluate against the edited timeline; applied by the next tick (≤15s), no mid-edit audio thrash
  res.json(Object.assign({ok:true}, schedPayload(store)));
});
app.post('/api/schedules/enabled',(req,res)=>{
  const store=loadStore(); store.enabled=!!(req.body||{}).enabled; saveStore(store);
  resetSlot(); if(store.enabled) reconcile().catch(()=>{});   // turning automation ON applies immediately
  res.json({ok:true, enabled:store.enabled});
});

// audio processing (loudness normalisation). Changing it relaunches the stream so librespot picks up
// the new flags — a brief re-buffer; the scheduler then resumes playback automatically.
app.get('/api/audio',(req,res)=>res.json(audioSettings()));
app.post('/api/audio',(req,res)=>{
  const b=req.body||{}, cur=audioSettings();
  const next={
    normalize: typeof b.normalize==='boolean' ? b.normalize : cur.normalize,
    gainType: ['track','album','auto'].includes(b.gainType) ? b.gainType : cur.gainType,
    method: ['basic','dynamic'].includes(b.method) ? b.method : cur.method,
    pregain: (b.pregain!=null && !isNaN(+b.pregain)) ? Math.max(-10,Math.min(10,Math.round(+b.pregain*10)/10)) : cur.pregain
  };
  try{ saveAudio(next); }catch(e){ return res.status(500).json({error:'write-failed'}); }
  sh(`${USERENV} systemctl --user restart spotify-stream.service`).then(()=>{
    resetSlot();                                             // re-assert the schedule once librespot is back
    setTimeout(()=>reconcile().catch(()=>{}), 6000);
    setTimeout(()=>reconcile().catch(()=>{}), 12000);
  });
  res.json(Object.assign({ok:true, applied:true}, audioSettings()));
});

app.listen(PORT,'0.0.0.0',()=>console.log(`Signage dashboard on http://0.0.0.0:${PORT}`));
