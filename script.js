/*
  RGS VAULT — Application Engine
  Vanilla JS • File System Access API • local-first

  Expected library layout:

    selected-folder/
      .username/
        thumbnails/
          001.jpg
          002.jpg
        index.json
        links.txt

  index.json is preferred because it preserves the exact thumbnail ↔ URL
  relationship. links.txt is used as a fallback.

  IMPORTANT:
  A browser cannot freely enumerate arbitrary Android storage. The user
  must explicitly choose the library directory with showDirectoryPicker().
  Chrome/Chromium on supported platforms is recommended.

  PWA:
  This file creates the web app manifest dynamically. True service-worker
  offline caching requires a same-origin service-worker file supplied by the
  host. With only these three files, the local library itself remains
  available offline after the page is loaded, but the browser cannot
  manufacture a same-origin service-worker script from this JS file.
*/

(() => {
  "use strict";

  const APP = {
    name: "RGS Vault",
    version: "1.0.0",
    dbName: "rgs-vault",
    storeName: "handles",
    handleKey: "library-root",
    currentView: "folder",
    rootHandle: null,
    currentUser: null,
    objectUrls: [],
    deferredInstallPrompt: null,
    busy: false
  };

  const $ = (id) => document.getElementById(id);

  const views = {
    folder: $("folderView"),
    users: $("usersView"),
    collection: $("collectionView"),
    loading: $("loadingView")
  };

  // ----------------------------------------------------------
  // PWA manifest
  // ----------------------------------------------------------

  function installManifest() {
    // The real manifest is manifest.webmanifest in the project root.
    const link = $("app-manifest");
    if (link) link.href = "./manifest.webmanifest";
  }

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    try {
      await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    } catch (err) {
      console.warn("Service worker registration failed:", err);
    }
  }

  // ----------------------------------------------------------
  // IndexedDB: persist the directory handle when the browser
  // allows it. The user still has to re-authorize when required.
  // ----------------------------------------------------------

  function openDB() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("IndexedDB is unavailable."));
        return;
      }

      const request = indexedDB.open(APP.dbName, 1);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(APP.storeName)) {
          db.createObjectStore(APP.storeName);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB error."));
    });
  }

  async function saveHandle(handle) {
    try {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(APP.storeName, "readwrite");
        tx.objectStore(APP.storeName).put(handle, APP.handleKey);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch (_) {
      // Non-fatal. The user can simply pick the folder again.
    }
  }

  async function loadHandle() {
    try {
      const db = await openDB();
      const value = await new Promise((resolve, reject) => {
        const tx = db.transaction(APP.storeName, "readonly");
        const req = tx.objectStore(APP.storeName).get(APP.handleKey);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      db.close();
      return value;
    } catch (_) {
      return null;
    }
  }

  async function verifyPermission(handle, write = false) {
    if (!handle || !handle.queryPermission || !handle.requestPermission) return true;

    const mode = write ? "readwrite" : "read";
    const options = { mode };

    if (await handle.queryPermission(options) === "granted") {
      return true;
    }

    return (await handle.requestPermission(options)) === "granted";
  }

  // ----------------------------------------------------------
  // Navigation
  // ----------------------------------------------------------

  function showView(name) {
    Object.entries(views).forEach(([key, el]) => {
      if (key === name) el.classList.add("active");
      else el.classList.remove("active");
    });

    APP.currentView = name;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function setLoading(title, text) {
    $("loadingTitle").textContent = title;
    $("loadingText").textContent = text;
  }

  function showLoading(title, text) {
    Object.values(views).forEach((v) => v.classList.remove("active"));
    setLoading(title, text);
    views.loading.hidden = false;
  }

  function hideLoading() {
    views.loading.hidden = true;
  }

  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove("show"), 2800);
  }

  // ----------------------------------------------------------
  // Folder selection
  // ----------------------------------------------------------

  async function chooseRoot() {
    if (!("showDirectoryPicker" in window)) {
      toast("This browser does not support folder picking.");
      return;
    }

    try {
      const handle = await window.showDirectoryPicker({
        id: "rgs-vault-library",
        mode: "read"
      });

      const allowed = await verifyPermission(handle, false);
      if (!allowed) {
        toast("Folder permission was not granted.");
        return;
      }

      APP.rootHandle = handle;
      await saveHandle(handle);

      await loadUsers();
    } catch (err) {
      if (err && err.name === "AbortError") return;
      console.error(err);
      toast("Could not open that folder.");
    }
  }

  async function tryRestoreRoot() {
    const handle = await loadHandle();
    if (!handle) return;

    try {
      const allowed = await verifyPermission(handle, false);
      if (!allowed) return;

      APP.rootHandle = handle;
      await loadUsers();
    } catch (_) {
      // The browser may have discarded the permission/handle.
    }
  }

  // ----------------------------------------------------------
  // Directory reading
  // ----------------------------------------------------------

  async function readDirectoryEntries(dirHandle) {
    const entries = [];

    for await (const [name, handle] of dirHandle.entries()) {
      entries.push({ name, handle });
    }

    return entries;
  }

  async function findUsernameDirectories(rootHandle) {
    const entries = await readDirectoryEntries(rootHandle);

    return entries
      .filter((entry) => entry.handle.kind === "directory")
      .filter((entry) => entry.name.startsWith("."))
      .filter((entry) => entry.name !== "." && entry.name !== "..")
      .sort((a, b) => a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: "base"
      }));
  }

  async function readTextFile(dirHandle, name) {
    try {
      const fileHandle = await dirHandle.getFileHandle(name);
      const file = await fileHandle.getFile();
      return await file.text();
    } catch (_) {
      return null;
    }
  }

  async function getChildFile(dirHandle, names) {
    for (const name of names) {
      try {
        return await dirHandle.getFileHandle(name);
      } catch (_) {}
    }
    return null;
  }

  async function collectThumbnailFiles(userHandle) {
    let thumbDir;

    try {
      thumbDir = await userHandle.getDirectoryHandle("thumbnails");
    } catch (_) {
      thumbDir = userHandle;
    }

    const entries = await readDirectoryEntries(thumbDir);

    return entries
      .filter((entry) => entry.handle.kind === "file")
      .filter((entry) => /\.(jpe?g|png|webp|gif|avif)$/i.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: "base"
      }));
  }

  // ----------------------------------------------------------
  // Parse index.json / links.txt
  // ----------------------------------------------------------

  function normalizeUrl(value) {
    if (!value) return "";
    try {
      return new URL(value.trim()).href;
    } catch (_) {
      return "";
    }
  }

  function parseIndexJson(text) {
    if (!text) return [];

    try {
      const data = JSON.parse(text);
      if (!Array.isArray(data)) return [];

      return data.map((item, i) => ({
        number: Number(item.number || item.id || i + 1),
        videoId: String(item.video_id || ""),
        thumbnail: String(item.thumbnail || ""),
        thumbnailUrl: String(item.thumbnail_url || ""),
        videoUrl: normalizeUrl(item.video_url || item.url || ""),
        status: String(item.status || "unknown")
      }));
    } catch (err) {
      console.warn("index.json parse error:", err);
      return [];
    }
  }

  function parseLinksTxt(text) {
    if (!text) return [];

    const result = [];

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      // Current engine format:
      // 001 | thumbnails/001.jpg | https://... | downloaded
      const parts = line.split("|").map((x) => x.trim());

      if (parts.length >= 3) {
        const number = parseInt(parts[0], 10) || result.length + 1;
        const thumbnail = parts[1] === "-" ? "" : parts[1];
        const videoUrl = normalizeUrl(parts[2]);

        if (videoUrl) {
          result.push({
            number,
            videoId: "",
            thumbnail,
            thumbnailUrl: "",
            videoUrl,
            status: parts[3] || "unknown"
          });
        }
        continue;
      }

      // More permissive fallback:
      // 001 https://...
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (match) {
        const videoUrl = normalizeUrl(match[2]);
        if (videoUrl) {
          result.push({
            number: Number(match[1]),
            videoId: "",
            thumbnail: "",
            thumbnailUrl: "",
            videoUrl,
            status: "unknown"
          });
        }
      }
    }

    return result;
  }

  function buildLookup(records) {
    const map = new Map();

    for (const item of records) {
      const number = Number(item.number);
      if (Number.isFinite(number)) {
        map.set(number, item);
      }
    }

    return map;
  }

  // ----------------------------------------------------------
  // Load user cards
  // ----------------------------------------------------------

  async function loadUsers() {
    if (!APP.rootHandle) return;

    APP.busy = true;
    showLoading("Scanning library", "Finding hidden collections…");

    try {
      const dirs = await findUsernameDirectories(APP.rootHandle);

      $("libraryPath").textContent =
        APP.rootHandle.name || "Selected library";

      $("usersGrid").replaceChildren();
      $("usersEmpty").hidden = dirs.length !== 0;

      const template = $("userCardTemplate");

      for (const entry of dirs) {
        const fragment = template.content.cloneNode(true);
        const card = fragment.querySelector(".user-card");
        const nameEl = fragment.querySelector(".user-name");
        const statEl = fragment.querySelector(".user-stat");
        const avatar = fragment.querySelector(".user-avatar");

        nameEl.textContent = entry.name;
        avatar.textContent = (entry.name.replace(/^\./, "").charAt(0) || "R").toUpperCase();

        const count = await estimateItemCount(entry.handle);
        statEl.textContent = `${count} thumbnail${count === 1 ? "" : "s"}`;

        card.addEventListener("click", () => openCollection(entry.name, entry.handle));
        $("usersGrid").appendChild(fragment);
      }

      hideLoading();
      showView("users");
      $("changeFolderBtn").hidden = false;
    } catch (err) {
      console.error(err);
      hideLoading();
      showView("folder");
      toast("Could not read the selected library.");
    } finally {
      APP.busy = false;
    }
  }

  async function estimateItemCount(userHandle) {
    const indexText = await readTextFile(userHandle, "index.json");
    const indexRecords = parseIndexJson(indexText);

    if (indexRecords.length) return indexRecords.length;

    const linksText = await readTextFile(userHandle, "links.txt");
    const linkRecords = parseLinksTxt(linksText);

    if (linkRecords.length) return linkRecords.length;

    try {
      return (await collectThumbnailFiles(userHandle)).length;
    } catch (_) {
      return 0;
    }
  }

  // ----------------------------------------------------------
  // Open collection
  // ----------------------------------------------------------

  async function openCollection(name, userHandle) {
    APP.currentUser = { name, handle: userHandle };

    APP.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    APP.objectUrls = [];

    showLoading("Opening collection", name);

    try {
      const [indexText, linksText, thumbFiles] = await Promise.all([
        readTextFile(userHandle, "index.json"),
        readTextFile(userHandle, "links.txt"),
        collectThumbnailFiles(userHandle)
      ]);

      let records = parseIndexJson(indexText);

      if (!records.length) {
        records = parseLinksTxt(linksText);
      }

      const recordMap = buildLookup(records);

      // If index/link records are absent or incomplete, generate records
      // from thumbnail filenames. Links remain empty instead of being guessed.
      if (!records.length) {
        records = thumbFiles.map((entry, i) => ({
          number: extractNumber(entry.name) || i + 1,
          videoId: "",
          thumbnail: `thumbnails/${entry.name}`,
          thumbnailUrl: "",
          videoUrl: "",
          status: "local"
        }));
      }

      $("collectionTitle").textContent = name;
      $("collectionEyebrow").textContent =
        `${name.replace(/^\./, "").toUpperCase()} • COLLECTION`;
      $("collectionMeta").textContent =
        `${records.length} item${records.length === 1 ? "" : "s"}`;

      await renderMediaCards(records, thumbFiles, recordMap, userHandle);

      hideLoading();
      showView("collection");
    } catch (err) {
      console.error(err);
      hideLoading();
      toast("Could not open this collection.");
      showView("users");
    }
  }

  function extractNumber(filename) {
    const match = filename.match(/(\d+)/);
    return match ? Number(match[1]) : null;
  }

  function normalizeThumbName(value) {
    if (!value) return "";
    return value.replaceAll("\\", "/").split("/").pop();
  }

  async function findThumbnailHandle(userHandle, thumbFiles, record) {
    const preferred = normalizeThumbName(record.thumbnail);

    if (preferred) {
      const direct = thumbFiles.find(
        (entry) => entry.name.toLowerCase() === preferred.toLowerCase()
      );
      if (direct) return direct.handle;
    }

    const number = Number(record.number);
    if (Number.isFinite(number)) {
      const candidates = [
        `${String(number).padStart(3, "0")}.jpg`,
        `${String(number).padStart(3, "0")}.jpeg`,
        `${String(number).padStart(3, "0")}.png`,
        `${String(number).padStart(3, "0")}.webp`,
        `${number}.jpg`,
        `${number}.jpeg`,
        `${number}.png`,
        `${number}.webp`
      ];

      for (const candidate of candidates) {
        const found = thumbFiles.find(
          (entry) => entry.name.toLowerCase() === candidate.toLowerCase()
        );
        if (found) return found.handle;
      }
    }

    return null;
  }

  async function renderMediaCards(records, thumbFiles, recordMap, userHandle) {
    const grid = $("cardsGrid");
    grid.replaceChildren();
    $("cardsEmpty").hidden = records.length !== 0;

    const template = $("mediaCardTemplate");

    // Keep the exact order from index.json / links.txt.
    for (const record of records) {
      const fragment = template.content.cloneNode(true);
      const card = fragment.querySelector(".media-card");
      const img = fragment.querySelector(".thumb");
      const badge = fragment.querySelector(".number-badge");
      const label = fragment.querySelector(".media-label");
      const go = fragment.querySelector(".go-btn");

      const number = Number(record.number) || 0;

      badge.textContent = `#${String(number).padStart(3, "0")}`;
      label.textContent = record.videoId
        ? `ID ${record.videoId}`
        : record.videoUrl
          ? "VIDEO LINK"
          : "THUMBNAIL";

      if (record.videoUrl) {
        go.href = record.videoUrl;
        go.style.display = "inline-block";
      } else {
        go.removeAttribute("href");
        go.style.display = "none";
      }

      const fileHandle = await findThumbnailHandle(userHandle, thumbFiles, record);

      if (fileHandle) {
        try {
          const file = await fileHandle.getFile();
          const url = URL.createObjectURL(file);
          APP.objectUrls.push(url);
          img.src = url;
          img.alt = `Thumbnail ${String(number).padStart(3, "0")}`;
          img.addEventListener("load", () => img.classList.add("loaded"), { once: true });
        } catch (_) {
          showThumbFallback(img, number);
        }
      } else if (record.thumbnailUrl) {
        // Remote thumbnail URLs are not fetched automatically for privacy
        // and offline reliability. The local thumbnail file is preferred.
        showThumbFallback(img, number);
      } else {
        showThumbFallback(img, number);
      }

      grid.appendChild(fragment);
    }
  }

  function showThumbFallback(img, number) {
    img.classList.add("loaded");
    img.src =
      "data:image/svg+xml;charset=UTF-8," +
      encodeURIComponent(`
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500">
          <defs>
            <linearGradient id="g" x1="0" x2="1">
              <stop stop-color="#151a32"/>
              <stop offset="1" stop-color="#10101d"/>
            </linearGradient>
          </defs>
          <rect width="800" height="500" fill="url(#g)"/>
          <circle cx="400" cy="225" r="58" fill="#ffffff" fill-opacity=".04"/>
          <text x="400" y="238" text-anchor="middle"
            fill="#777f98" font-family="Arial" font-size="22">
            THUMBNAIL ${String(number).padStart(3, "0")}
          </text>
        </svg>
      `);
  }

  // ----------------------------------------------------------
  // Events
  // ----------------------------------------------------------

  $("pickFolderBtn").addEventListener("click", chooseRoot);
  $("changeFolderBtn").addEventListener("click", chooseRoot);

  $("refreshBtn").addEventListener("click", async () => {
    if (APP.rootHandle) await loadUsers();
  });

  $("collectionRefreshBtn").addEventListener("click", async () => {
    if (APP.currentUser) {
      await openCollection(APP.currentUser.name, APP.currentUser.handle);
    }
  });

  $("backToUsersBtn").addEventListener("click", () => {
    APP.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    APP.objectUrls = [];
    APP.currentUser = null;
    showView("users");
  });

  $("brandHome").addEventListener("click", () => {
    if (APP.rootHandle) showView("users");
    else showView("folder");
  });

  // Browser back button: collection -> users -> folder.
  window.addEventListener("popstate", () => {
    if (APP.currentView === "collection") {
      APP.objectUrls.forEach((url) => URL.revokeObjectURL(url));
      APP.objectUrls = [];
      APP.currentUser = null;
      showView("users");
    } else if (APP.currentView === "users") {
      showView("folder");
    }
  });

  // Make browser history cooperate with in-app navigation.
  const originalOpenCollection = openCollection;

  // External link clicks naturally open a new tab. Back returns to the
  // unchanged collection because the current view remains mounted.

  // ----------------------------------------------------------
  // Install prompt
  // ----------------------------------------------------------

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    APP.deferredInstallPrompt = event;
    $("installBtn").hidden = false;
  });

  $("installBtn").addEventListener("click", async () => {
    if (!APP.deferredInstallPrompt) return;

    APP.deferredInstallPrompt.prompt();
    await APP.deferredInstallPrompt.userChoice;
    APP.deferredInstallPrompt = null;
    $("installBtn").hidden = true;
  });

  window.addEventListener("appinstalled", () => {
    $("installBtn").hidden = true;
    toast("RGS Vault installed.");
  });

  // ----------------------------------------------------------
  // Startup
  // ----------------------------------------------------------

  async function init() {
    installManifest();
    registerServiceWorker();

    // File System Access is HTTPS/localhost in normal browsers.
    if (!("showDirectoryPicker" in window)) {
      $("pickFolderBtn").textContent = "Choose Library Folder";
      toast("Use Chrome/Chromium on HTTPS or localhost for folder access.");
    }

    await tryRestoreRoot();
  }

  init().catch((err) => {
    console.error(err);
    showView("folder");
  });
})();
