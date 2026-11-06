// KuGou Music plugin for MyGo Music.
//
// Talks to the KuGou Android gateway (gateway.kugou.com), which signs every
// request: MD5(salt + sorted key=value params + request body + salt). Signing
// in uses KuGou's QR-code login, and guests can still search, browse charts
// and playlists, read lyrics, and play the free songs.

const t = host.t;

// ---------------------------------------------------------------- constants

const ANDROID_SALT = "OIlwieks28dk2k092lksi2UIkp";
const WEB_SALT = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";
const APPID = 1005;
const CLIENTVER = 20489;
const SRCAPPID = 2919;
const USER_AGENT = "Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi";
const PAGE_SIZE = 30;

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ------------------------------------------------------------- tiny stdlib
// The plugin sandbox has fetch, timers and host.crypto.md5; base64 and UTF-8
// decoding and a decimal big-int are done by hand so the plugin needs nothing
// beyond them.

function b64ToUtf8(s) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  s = String(s || "").replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const bytes = [];
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    if (ch === "=") break;
    const v = chars.indexOf(ch);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b < 0xe0) out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if (b < 0xf0)
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    else {
      const cp =
        ((b & 0x07) << 18) |
        ((bytes[i++] & 0x3f) << 12) |
        ((bytes[i++] & 0x3f) << 6) |
        (bytes[i++] & 0x3f);
      const c = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
    }
  }
  return out;
}

// Decimal value of an MD5 hex digest, without BigInt.
function hexToDecimal(hex) {
  const digits = [0]; // least significant first
  for (const ch of hex) {
    let carry = parseInt(ch, 16);
    for (let i = 0; i < digits.length; i++) {
      const v = digits[i] * 16 + carry;
      digits[i] = v % 10;
      carry = Math.floor(v / 10);
    }
    while (carry > 0) {
      digits.push(carry % 10);
      carry = Math.floor(carry / 10);
    }
  }
  return digits.reverse().join("");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ device setup

function randomString(len) {
  const pool = "1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < len; i++) out += pool[Math.floor(Math.random() * pool.length)];
  return out;
}

function deviceId() {
  let guid = host.storage.get("guid");
  if (!guid) {
    guid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
    host.storage.set("guid", guid);
  }
  return guid;
}

function deviceBits() {
  const guid = deviceId();
  let dfid = host.storage.get("dfid");
  if (!dfid) {
    dfid = randomString(24);
    host.storage.set("dfid", dfid);
  }
  let dev = host.storage.get("dev");
  if (!dev) {
    dev = randomString(10);
    host.storage.set("dev", dev);
  }
  const mid = host.storage.get("mid") || hexToDecimal(host.crypto.md5(guid));
  host.storage.set("mid", mid);
  return { dfid, mid, dev };
}

// ---------------------------------------------------------------- signing

function signAndroid(params, data) {
  const s = Object.keys(params)
    .sort()
    .map((k) => `${k}=${typeof params[k] === "object" ? JSON.stringify(params[k]) : params[k]}`)
    .join("");
  return host.crypto.md5(`${ANDROID_SALT}${s}${data || ""}${ANDROID_SALT}`);
}

function signWeb(params) {
  const s = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("");
  return host.crypto.md5(`${WEB_SALT}${s}${WEB_SALT}`);
}

// The Android gateway signKey: MD5(hash + salt + appid + mid + userid).
function signKey(hash, mid, userid) {
  return host.crypto.md5(`${hash}57ae12eb6890223e355ccfcb74edf70d${APPID}${mid}${userid || 0}`);
}

// ---------------------------------------------------------------- requests

async function jsonOf(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function kg({ url, params = {}, headers = {}, method = "GET", data }) {
  // The gateway occasionally answers with a verification error (its risk
  // control); the same request a moment later usually goes through, so every
  // call retries twice before giving up.
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(400 * attempt);
    try {
      const r = await kgOnce({ url, params, headers, method, data });
      if (r && Number(r.status) !== 0) return r;
      lastErr = new Error(`${url}: ${JSON.stringify(r).slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
    }
  }
  console.error(`kugou: request failed after retries ${url}`, String(lastErr));
  throw lastErr;
}

async function kgOnce({ url, params = {}, headers = {}, method = "GET", data }) {
  const { dfid, mid } = deviceBits();
  const clienttime = Math.floor(Date.now() / 1000);
  const p = {
    dfid,
    mid,
    uuid: "-",
    appid: APPID,
    clientver: CLIENTVER,
    clienttime,
    ...params,
  };
  const token = host.storage.get("token");
  const userid = host.storage.get("userid");
  if (token) p.token = token;
  if (token && userid) p.userid = userid;
  const body = data ? JSON.stringify(data) : "";
  p.signature = signAndroid(p, body);
  const qs = Object.keys(p)
    .map((k) => `${k}=${encodeURIComponent(p[k])}`)
    .join("&");
  const res = await fetch(`https://gateway.kugou.com${url}?${qs}`, {
    method,
    headers: {
      "User-Agent": USER_AGENT,
      dfid,
      mid,
      clienttime: String(clienttime),
      "kg-rc": "1",
      "kg-thash": "5d816a0",
      "kg-rec": "1",
      "kg-rf": "B9EDA08A64250DEFFBCADDEE00F8F25F",
      ...(data ? { "Content-Type": "application/json;charset=utf-8" } : {}),
      ...headers,
    },
    body: body || undefined,
  });
  return jsonOf(res);
}

// The login endpoints sign with the web salt.
async function kgWeb(path, moduleParams) {
  const { dfid, mid } = deviceBits();
  const clienttime = Math.floor(Date.now() / 1000);
  const p = {
    dfid,
    mid,
    uuid: "-",
    appid: APPID,
    clientver: CLIENTVER,
    clienttime,
    ...moduleParams,
  };
  p.signature = signWeb(p);
  const qs = Object.keys(p)
    .map((k) => `${k}=${encodeURIComponent(p[k])}`)
    .join("&");
  const res = await fetch(`https://login-user.kugou.com${path}?${qs}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  return jsonOf(res);
}

async function plainGet(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
    },
  });
  return jsonOf(res);
}

// ------------------------------------------------------------ track ids
// "hash128|hash320|hashFlac|albumId|albumAudioId|durationMs" carries what
// stream and lyrics need with nothing else to look up.

function encodeId(h128, h320, hflac, albumId, audioId, durMs) {
  return [h128 || "", h320 || "", hflac || "", albumId || "", audioId || "", durMs || ""].join("|");
}

function decodeId(id) {
  return String(id || "").split("|");
}

// ------------------------------------------------------------- mappers

function sizeUrl(url, size) {
  return url ? String(url).replace("{size}", String(size || 240)) : "";
}

function artistsFrom(names, ids) {
  const nameList = String(names || "")
    .split(/[、,，/]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const idList = Array.isArray(ids) ? ids : [];
  if (!nameList.length) return undefined;
  return nameList.map((name, i) => ({
    id: String(idList[i] ?? name),
    name,
  }));
}

function trackFromSearch(it) {
  if (!it || !it.FileHash) return null;
  const dur = Number(it.Duration || 0) * 1000;
  return {
    id: encodeId(it.FileHash, it.HQFileHash, it.SQFileHash, it.AlbumID, it.Audioid ?? it.MixSongID, dur),
    name: it.SongName || it.FileName || "",
    artists: artistsFrom(it.SingerName, it.SingerId),
    album: it.AlbumID ? { id: String(it.AlbumID), name: it.AlbumName || "" } : undefined,
    duration: dur,
    url: it.AlbumID && it.Audioid ? `https://www.kugou.com/song/#hash=${it.FileHash}` : undefined,
  };
}

function trackFromRank(s) {
  if (!s) return null;
  const info = s.audio_info || {};
  const dur = Number(s.timelen || info.duration_128 || 0);
  const h128 = info.hash_128 || "";
  const h320 = info.hash_320 || "";
  const hflac = info.hash_flac || "";
  const audioId = s.album_audio_id || s.audio_id || "";
  const albumId = s.album_id || "";
  return {
    id: encodeId(h128, h320, hflac, albumId, audioId, dur),
    name: s.songname || s.name || "",
    artists: (s.authors || []).map((a) => ({ id: String(a.author_id ?? a.name), name: a.author_name || "" })),
    album: albumId
      ? {
          id: String(albumId),
          name: s.album_info?.album_name || "",
          imageUrl: sizeUrl(s.album_info?.sizable_cover || s.album_info?.cover, 240),
        }
      : undefined,
    duration: dur,
  };
}

function trackFromPlaylistSong(m) {
  if (!m || !m.hash) return null;
  const singers = (m.singerinfo || []).map((s) => ({ id: String(s.id ?? s.name), name: s.name || "" }));
  let name = m.name || "";
  const dash = name.indexOf(" - ");
  if (dash > 0 && singers.length && singers.some((s) => name.slice(0, dash).includes(s.name))) {
    name = name.slice(dash + 3).trim();
  }
  const dur = Number(m.timelen || 0);
  return {
    id: encodeId(m.hash, "", "", m.album_id, m.mixsongid || m.audio_id, dur),
    name,
    artists: singers.length ? singers : undefined,
    album: m.album_id
      ? { id: String(m.album_id), name: m.albuminfo?.name || "", imageUrl: sizeUrl(m.albuminfo?.cover || m.cover, 240) }
      : undefined,
    duration: dur,
  };
}

function trackFromAlbumSong(s) {
  if (!s) return null;
  const info = s.audio_info || {};
  const base = s.base || {};
  const dur = Number(info.duration_128 || s.timelen || 0);
  const h128 = info.hash_128 || "";
  const h320 = info.hash_320 || "";
  const hflac = info.hash_flac || "";
  const audioId = base.album_audio_id || base.audio_id || "";
  return {
    id: encodeId(h128, h320, hflac, base.album_id || s.album_id, audioId, dur),
    name: base.audio_name || base.name || s.name || "",
    artists: (s.authors || []).map((a) => ({ id: String(a.author_id ?? a.name), name: a.author_name || "" })),
    album: base.album_id
      ? {
          id: String(base.album_id),
          name: s.album_info?.album_name || "",
          imageUrl: sizeUrl(s.album_info?.cover, 240),
        }
      : undefined,
    duration: dur,
  };
}

function playlistFromSpecial(sp) {
  if (!sp) return null;
  const pl = {
    id: sp.global_collection_id || String(sp.specialid),
    name: sp.specialname || "",
    imageUrl: sizeUrl(sp.imgurl || sp.pic || sp.flexible_cover, 480),
    owner: sp.nickname || "",
  };
  // Remember the card's name and cover for the playlist page.
  const cache = mapGet(PLC);
  cache[pl.id] = { name: pl.name, imageUrl: pl.imageUrl, owner: pl.owner };
  const keys = Object.keys(cache);
  if (keys.length > PLC_MAX) {
    for (const k of keys.slice(0, keys.length - PLC_MAX)) delete cache[k];
  }
  mapSet(PLC, cache);
  return pl;
}

// ------------------------------------------------------------ library (local)

// Liked songs and saved albums are kept on the device. Every track the plugin
// hands out is cached so like/save can store the whole thing, since the app
// only tells them the id.
function mapGet(key) {
  return host.storage.get(key) || {};
}

function mapSet(key, map) {
  host.storage.set(key, map);
}

const LIKED = "likedTracks";
const SAVED = "savedAlbums";
const CACHE = "trackCache";
const CACHE_MAX = 600;
const PLC = "plCache";
const PLC_MAX = 300;

function cacheTracks(tracks) {
  if (!Array.isArray(tracks) || !tracks.length) return;
  const cache = mapGet(CACHE);
  for (const tr of tracks) if (tr?.id) cache[tr.id] = tr;
  const keys = Object.keys(cache);
  if (keys.length > CACHE_MAX) {
    for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cache[k];
  }
  mapSet(CACHE, cache);
}

// ------------------------------------------------------------- sign-in

async function qrCreate() {
  const r = await kgWeb("/v2/qrcode", {
    appid: 1001,
    type: 1,
    plat: 4,
    qrcode_txt: `https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=${APPID}&`,
    srcappid: SRCAPPID,
  });
  return r?.data?.qrcode || "";
}

async function qrCheck(key) {
  const { dev } = deviceBits();
  return kgWeb("/v2/get_userinfo_qrcode", {
    plat: 4,
    appid: APPID,
    srcappid: SRCAPPID,
    qrcode: key,
    dev,
  });
}

export async function signIn() {
  const key = await qrCreate();
  if (!key) throw fail("signIn", t("Could not start the sign-in, try again"));
  const qr = `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${key}`;
  host.signInPrompt({ qr, text: t("Open the KuGou Music app and scan this code to sign in") });
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const r = await qrCheck(key);
    const status = r?.data?.status;
    if (status === 4) {
      const token = r?.data?.token || "";
      const userid = String(r?.data?.userid || "");
      if (!token) throw fail("signIn", t("Sign-in succeeded but no ticket came back, try again"));
      host.storage.set("token", token);
      host.storage.set("userid", userid);
      const name = r?.data?.nickname || `KuGou ${userid}`;
      host.storage.set("nickname", name);
      return { id: userid, name };
    }
    if (status === 0) throw fail("signIn", t("The QR code expired, try signing in again"));
    if (status === 2) host.signInPrompt({ qr, text: t("Scanned — confirm in the KuGou app") });
  }
  throw fail("signIn", t("Timed out waiting for the scan, try again"));
}

export function signOut() {
  host.storage.remove("token");
  host.storage.remove("userid");
  host.storage.remove("nickname");
}

export function account() {
  const token = host.storage.get("token");
  if (!token) return null;
  const userid = String(host.storage.get("userid") || "");
  return { id: userid, name: host.storage.get("nickname") || `KuGou ${userid}` };
}

export function setSetting() {}

// ---------------------------------------------------------------- home

export async function home() {
  const [ranksRes, spRes] = await Promise.allSettled([rankList(), specialRecommend(1, 6)]);
  const sections = [];
  let anyOk = false;
  const errors = [];
  if (ranksRes.status === "fulfilled") {
    anyOk = true;
    sections.push({
      title: t("Top Charts"),
      links: ranksRes.value.slice(0, 6).map((r) => ({
        title: r.rankname,
        subtitle: r.update_frequency || "",
        imageUrl: sizeUrl(r.img_9 || r.imgurl || r.album_img_9, 480),
        page: `rank:${r.rankid}`,
      })),
      morePage: "charts",
    });
  } else {
    errors.push(ranksRes.reason);
  }
  if (spRes.status === "fulfilled") {
    anyOk = true;
    sections.push({
      title: t("Recommended Playlists"),
      playlists: spRes.value.list.map(playlistFromSpecial),
      morePage: "playlists",
    });
  } else {
    errors.push(spRes.reason);
  }
  if (!anyOk) throw errors[0];
  return { title: t("KuGou Music"), sections };
}

export async function browse({ page }) {
  const name = String(page || "");
  if (name === "charts") {
    const ranks = await rankList();
    return {
      title: t("Charts"),
      sections: [
        {
          links: ranks.map((r) => ({
            title: r.rankname,
            subtitle: r.update_frequency || "",
            imageUrl: sizeUrl(r.img_9 || r.imgurl || r.album_img_9, 480),
            page: `rank:${r.rankid}`,
          })),
        },
      ],
    };
  }
  if (name === "playlists" || name.startsWith("playlists@")) {
    const pageNo = Number(name.split("@")[1] || 1) || 1;
    const sp = await specialRecommend(pageNo, PAGE_SIZE);
    return {
      title: t("Playlists"),
      sections: [
        {
          playlists: sp.list.map(playlistFromSpecial),
          morePage: sp.hasMore ? `playlists@${pageNo + 1}` : undefined,
        },
      ],
    };
  }
  if (name.startsWith("rank:")) {
    const rankId = name.slice(5);
    const ranks = await rankList();
    const rank = ranks.find((r) => String(r.rankid) === rankId);
    const songs = await rankSongs(rankId, 1, 100);
    const tracks = songs.map(trackFromRank);
    cacheTracks(tracks);
    return {
      title: rank?.rankname || t("Charts"),
      subtitle: rank?.update_frequency || "",
      sections: [{ tracks }],
    };
  }
  if (name.startsWith("playlist:")) {
    const rest = name.slice(9);
    const [gcid, pageNoStr] = rest.split("@");
    const pageNo = Number(pageNoStr || 1) || 1;
    const out = await playlistSongs(gcid, pageNo, 100);
    const tracks = out.songs.map(trackFromPlaylistSong);
    cacheTracks(tracks);
    return {
      title: out.title || t("Playlists"),
      subtitle: pageNo === 1 ? out.subtitle : "",
      sections: [
        {
          tracks,
          morePage: out.hasMore ? `playlist:${gcid}@${pageNo + 1}` : undefined,
        },
      ],
    };
  }
  throw fail("unavailable", t("No such page"));
}

// ------------------------------------------------------------- search

export async function search({ query, kind, offset }) {
  if (kind !== "tracks") return {};
  const page = Math.floor((offset || 0) / PAGE_SIZE) + 1;
  const r = await kg({
    url: "/v2/search/song",
    headers: { "x-router": "complexsearch.kugou.com" },
    params: {
      keyword: query,
      page,
      pagesize: PAGE_SIZE,
      platform: "AndroidFilter",
      iscorrection: 1,
      privilegefilter: 0,
      area_code: 1,
      dopicfull: 1,
    },
  });
  const lists = r?.data?.lists || [];
  const total = Number(r?.data?.total || 0);
  const tracks = lists.map(trackFromSearch);
  cacheTracks(tracks);
  return {
    tracks,
    more: page * PAGE_SIZE < total,
  };
}

export async function suggest({ query }) {
  const r = await kg({
    url: "/v2/getSearchTip",
    headers: { "x-router": "searchtip.kugou.com" },
    params: {
      keyword: query,
      AlbumTipCount: 10,
      CorrectTipCount: 10,
      MVTipCount: 10,
      MusicTipCount: 10,
      radiotip: 1,
    },
  });
  const out = [];
  for (const block of r?.data || []) {
    for (const rec of block?.RecordDatas || []) {
      if (rec?.HintInfo) out.push(rec.HintInfo);
    }
  }
  return out.slice(0, 10);
}

// The app's Playlists page asks every source for the listener's playlists.
// KuGou cloud playlists need the cloud-list protocol, so for now none are
// listed from here.
export async function playlists() {
  return [];
}

// A playlist's page: what its card was clicked for. The cover and name come
// from wherever the card was listed (kept in a small cache), the tracks from
// the playlist endpoint.
export async function playlist({ id }) {
  const meta = mapGet(PLC)[String(id)] || {};
  const out = await playlistSongs(id, 1, 200);
  const tracks = out.songs.map(trackFromPlaylistSong);
  cacheTracks(tracks);
  return {
    id: String(id),
    name: meta.name || out.title || "",
    imageUrl: meta.imageUrl || "",
    owner: meta.owner || "",
    tracks,
  };
}

// ------------------------------------------------------------ likes (local)

export async function liked({ offset }) {
  const map = mapGet(LIKED);
  const tracks = Object.values(map);
  const start = offset || 0;
  return { tracks: tracks.slice(start, start + PAGE_SIZE), more: tracks.length > start + PAGE_SIZE };
}

export async function isLiked({ ids }) {
  const map = mapGet(LIKED);
  return Object.fromEntries(ids.map((id) => [id, !!map[id]]));
}

export async function like({ id, on, track }) {
  const map = mapGet(LIKED);
  if (on) map[id] = track || mapGet(CACHE)[id] || { id, name: "", album: {} };
  else delete map[id];
  mapSet(LIKED, map);
}

// ------------------------------------------------------------- albums (local)

export async function saveAlbum({ id, on, album }) {
  const map = mapGet(SAVED);
  if (on) map[id] = album || mapGet(CACHE)["album:" + id] || { id, name: "" };
  else delete map[id];
  mapSet(SAVED, map);
}

export async function savedAlbums({ offset }) {
  const map = mapGet(SAVED);
  const albums = Object.values(map);
  const start = offset || 0;
  return { albums: albums.slice(start, start + PAGE_SIZE), more: albums.length > start + PAGE_SIZE };
}

export async function album({ id }) {
  const saved = !!mapGet(SAVED)[String(id)];
  const [info, songs] = await Promise.all([albumInfo(id), albumSongs(id, 50)]);
  const a0 = info?.[0] || {};
  const album = {
    id: String(id),
    name: a0.album_name || a0.albumname || a0.name || "",
    imageUrl: sizeUrl(a0.sizable_cover || a0.cover || a0.imgurl, 480),
    released: a0.publish_date || a0.publish_time || "",
    artists: a0.author_name ? [{ id: a0.author_name, name: a0.author_name }] : undefined,
    saved,
  };
  const cache = mapGet(CACHE);
  cache["album:" + String(id)] = album;
  mapSet(CACHE, cache);
  const tracks = (songs || []).map(trackFromAlbumSong);
  cacheTracks(tracks);
  return { album, tracks };
}

// ------------------------------------------------------------ the audio

export async function stream({ id, quality }) {
  const [h128, h320, hflac, albumId, audioId] = decodeId(id);
  const want = String(quality || "standard");
  const cap = String(host.setting("quality") || "").trim().toLowerCase();

  let hash = h128;
  let ext = "mp3";
  let qv = "128";
  const allowHigh = cap !== "128";
  const allowLossless = allowHigh && cap !== "320";
  if (allowLossless && /lossless/i.test(want) && hflac) {
    hash = hflac;
    ext = "flac";
    qv = "flac";
  } else if (allowHigh && /high|lossless/i.test(want) && h320) {
    hash = h320;
    ext = "mp3";
    qv = "320";
  }
  if (!hash) throw fail("unavailable");

  const signed = !!host.storage.get("token");
  if (signed) {
    const { mid } = deviceBits();
    const baseParams = {
      album_id: Number(albumId || 0) || 0,
      area_code: 1,
      // The tracker wants the hash lowercased, and the key must be computed
      // over exactly the hash that's sent.
      hash: String(hash).toLowerCase(),
      ssa_flag: "is_fromtrack",
      version: 11430,
      page_id: 151369488,
      quality: qv,
      album_audio_id: Number(audioId || 0) || 0,
      behavior: "play",
      pid: 2,
      cmd: 26,
      pidversion: 3001,
      ppage_id: "463467626,350369493,788954147",
      cdnBackup: 1,
      module: "",
      clientver: 11430,
      key: signKey(String(hash).toLowerCase(), mid, host.storage.get("userid") || 0),
    };
    // Full play first; if the account can't have it, ask for the free part
    // (a preview) before falling back to the guest endpoint.
    for (const freePart of [0, 1]) {
      try {
        const r = await kg({
          url: "/v5/url",
          headers: { "x-router": "trackercdn.kugou.com" },
          params: { ...baseParams, IsFreePart: freePart },
        });
        const d = Array.isArray(r?.data) ? r.data[0] : r?.data;
        let url = d?.url;
        if (Array.isArray(url)) url = url.find(Boolean) || null;
        if (!url && d?.backupUrl) {
          url = Array.isArray(d.backupUrl) ? d.backupUrl.find(Boolean) : d.backupUrl;
        }
        if (r?.status === 1 && url) {
          return {
            url,
            type: String(d?.ext || ext) === "flac" ? "flac" : "mp3",
            quality: want,
            bitRate: d?.bitrate || undefined,
            size: d?.size || undefined,
          };
        }
        console.error(`kugou: v5/url no url (IsFreePart=${freePart})`, JSON.stringify(r || {}).slice(0, 200));
      } catch (e) {
        console.error(`kugou: v5/url error (IsFreePart=${freePart})`, String(e).slice(0, 200));
      }
    }
  }

  const info = await plainGet(`https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${h128}`);
  if (info?.url) {
    return {
      url: info.url,
      type: String(info.extName || ext) === "flac" ? "flac" : "mp3",
      quality: want,
      bitRate: info.bitRate || undefined,
      size: info.fileSize || undefined,
    };
  }
  console.error(`kugou: no play url anywhere for ${h128} (signed=${signed})`);
  if (!signed) throw fail("signIn", t("Sign in to your KuGou account to play this song"));
  throw fail("unavailable", t("This song needs a KuGou VIP"));
}

// ------------------------------------------------------------ lyrics

export async function lyrics({ id }) {
  const h128 = (decodeId(id)[0] || "").toUpperCase();
  if (!h128) return {};
  const s = await plainGet(`https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=&hash=${h128}`);
  const cand = s?.candidates?.[0];
  if (!cand) return {};
  const d = await plainGet(
    `https://lyrics.kugou.com/download?ver=1&client=mobi&id=${cand.id}&accesskey=${encodeURIComponent(cand.accesskey)}&fmt=lrc&charset=utf8&cmd=123`
  );
  const lrc = b64ToUtf8(d?.content || "");
  return lrc ? { lrc } : {};
}

// ------------------------------------------------------------ backend calls

async function rankList() {
  const r = await kg({ url: "/ocean/v6/rank/list", params: { plat: 2, withsong: 0, parentid: 0 } });
  return r?.data?.info || [];
}

async function rankSongs(rankId, page, pagesize) {
  const r = await kg({
    url: "/openapi/kmr/v2/rank/audio",
    method: "POST",
    headers: { "kg-tid": "369" },
    data: {
      show_portrait_mv: 1,
      show_type_total: 1,
      filter_original_remarks: 1,
      area_code: 1,
      pagesize: pagesize || 100,
      rank_cid: 0,
      type: 1,
      page: page || 1,
      rank_id: rankId,
    },
  });
  return r?.data?.songlist || [];
}

async function specialRecommend(page, pagesize) {
  const { mid } = deviceBits();
  const clienttime = Math.floor(Date.now() / 1000);
  const key = host.crypto.md5(`${APPID}${ANDROID_SALT}${CLIENTVER}${clienttime}`);
  const r = await kg({
    url: "/v2/special_recommend",
    method: "POST",
    headers: { "x-router": "specialrec.service.kugou.com" },
    data: {
      appid: APPID,
      mid,
      clientver: CLIENTVER,
      platform: "android",
      clienttime,
      userid: Number(host.storage.get("userid") || 0),
      module_id: 1,
      page: page || 1,
      pagesize: pagesize || PAGE_SIZE,
      key,
      special_recommend: {
        withtag: 1,
        withsong: 1,
        sort: 1,
        ugc: 1,
        is_selected: 0,
        withrecommend: 1,
        area_code: 1,
        categoryid: 0,
      },
      req_multi: 1,
      retrun_min: 5,
      return_special_falg: 1,
    },
  });
  return {
    list: r?.data?.special_list || [],
    hasMore: r?.data?.has_next === 1,
  };
}

async function playlistSongs(gcid, page, pagesize) {
  const r = await kg({
    url: "/pubsongs/v2/get_other_list_file_nofilt",
    params: {
      area_code: 1,
      begin_idx: ((page || 1) - 1) * (pagesize || 100),
      plat: 1,
      type: 1,
      mode: 1,
      personal_switch: 1,
      extend_fields: "abtags,hot_cmt,popularization",
      pagesize: pagesize || 100,
      global_collection_id: gcid,
    },
  });
  const d = r?.data || {};
  return {
    title: d.list_info?.name || "",
    subtitle: d.list_info?.tags || "",
    songs: d.songs || d.musics || [],
    hasMore: (d.count || 0) > (page || 1) * (pagesize || 100),
  };
}

async function albumInfo(id) {
  const { dfid, mid } = deviceBits();
  const clienttimeMs = Date.now();
  const key = host.crypto.md5(`${APPID}${ANDROID_SALT}${CLIENTVER}${clienttimeMs}`);
  const dataMap = {
    appid: APPID,
    clienttime: clienttimeMs,
    clientver: CLIENTVER,
    data: [{ album_id: String(id), album_name: "", author_name: "" }],
    dfid,
    fields: "",
    key,
    mid,
  };
  const r = await kg({
    url: "/v1/album",
    method: "POST",
    headers: { "x-router": "kmr.service.kugou.com" },
    params: dataMap,
    data: dataMap,
  });
  return r?.data || [];
}

async function albumSongs(id, pagesize) {
  // The album endpoint rejects pagesize above 50.
  const r = await kg({
    url: "/v1/album_audio/lite",
    method: "POST",
    headers: { "x-router": "openapi.kugou.com", "kg-tid": "255" },
    data: { album_id: String(id), is_buy: "", page: 1, pagesize: pagesize || 50 },
  });
  return r?.data?.songs || [];
}
