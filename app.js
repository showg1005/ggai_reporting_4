"use strict";

/* ===========================================================================
 * 周辺状況アナライザー
 * 日時・緯度経度（または住所）を入力すると、Claude + Web検索で周辺状況を
 * 調査し、サマリー→重要度順のセクションでレポートを表示する。
 * レポートに登場した地名は地図（Leaflet + OpenStreetMap）にピン表示する。
 * セクションは1つずつ「次を表示しますか？」の確認を挟んで開示する。
 * ======================================================================== */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const STORE_KEY = "situation-analyzer:settings";
const MAX_CONTINUATIONS = 6; // pause_turn の継続上限

/* ---- 分析モード別プロンプト --------------------------------------------- */

const SHARED_VALUES = `## 重要な価値観・スタンス
- データに含まれていない要素（イベント・天候・交通・メディア露出など）はWeb情報で補完する。
- 「データで確かに言える事実」と「Web情報からの推定」を明確に区別して記載する。
- 「事実」と「推定（仮説）」を分けて書く。
- レポート読者が落胆しないように、前向きな示唆を含めてください。商業的にマイナスな形では書かないでください（全てが前向きである必要はありません）。`;

const OUTPUT_FORMAT = `## 出力形式（厳守）
- レポートは日本語のMarkdownで書く。
- 必ず「## サマリー」というセクションから始める。サマリーには全体の要点を簡潔にまとめる。
- サマリー以降のセクションは「重要度の高い順」に並べ、各セクションは「## 見出し」で始める。見出しは簡潔にする。
- 各セクション内では「事実」と「推定（仮説）」を明確に区別する。
- 前置きや自己言及（「承知しました」等）は書かず、いきなり「## サマリー」から始める。
- レポート本文の最後に、本文中で言及した実在する主要な地名・施設名・地区名を、次の形式のコードブロックで列挙する（地図表示に利用する）。該当が無ければ空にする。
\`\`\`places
地名1
地名2
\`\`\`
- placesブロックは本文の一番最後に一度だけ。地名は地図検索できる具体的な名称（駅名・施設名・地区名・自治体名など）にすること。`;

const MODE_INSTRUCTIONS = {
  anomaly: `## 指示
あなたは要因を徹底的に深掘りするデータサイエンティスト兼、位置情報に詳しいアナリストです。
指定された「日時」に、指定された「場所」付近で顕著な人流のアノマリー（人出の急増など）が観測されました。
関連する最新ニュース、事象、イベント、災害予報、SNS情報などを検索し、人流増加の原因を分析して、レポートを作成してください。
参考情報として周辺施設や周辺地形情報も活用します。
違和感や注目点があれば必ず「どこで（Where）」「なぜ（Why）」を深掘りし、具体的な要因まで踏み込んでください。深掘りには与えられたデータとWeb調査を用います。
確認は不要で、すぐに調査を開始してください。`,

  disaster: `## 指示
あなたは要因を徹底的に深掘りするデータサイエンティスト兼、位置情報に詳しいアナリストです。
指定された「日時」に、指定された「場所」付近の周辺状況把握を行います。具体的には次の観点を調べます:
- 道路の状況（通行止め・道路の被害・渋滞）
- 断水情報
- 停電
- 斜面崩壊・土砂崩れ
- 建造物被害
- 避難所情報
- 給水所
- 医療機関
関連する最新ニュース、事象、災害予報、SNS情報などを検索し、それらの原因を分析してレポートを作成してください。
参考情報として周辺施設や周辺地形情報も活用します。
違和感や注目点があれば必ず「どこで（Where）」「なぜ（Why）」を深掘りし、具体的な要因まで踏み込んでください。深掘りには与えられたデータとWeb調査を用います。
確認は不要で、すぐに調査を開始してください。`,
};

function buildSystemPrompt(mode) {
  return [MODE_INSTRUCTIONS[mode], SHARED_VALUES, OUTPUT_FORMAT].join("\n\n");
}

function buildUserPrompt(params) {
  const lines = [];
  lines.push("次の条件で調査を開始してください。");
  lines.push(`- 日時: ${params.datetimeLabel}`);
  if (params.address) lines.push(`- 場所（住所・地名）: ${params.address}`);
  if (params.lat != null && params.lon != null) {
    lines.push(`- 緯度経度: ${params.lat}, ${params.lon}`);
  }
  lines.push("");
  lines.push("周辺の状況を、上記の出力形式に厳密に従ってレポートしてください。");
  return lines.join("\n");
}

/* ---- DOM 参照 ------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);
const el = {
  settingsToggle: $("settingsToggle"),
  settingsPanel: $("settingsPanel"),
  apiKey: $("apiKey"),
  model: $("model"),
  saveSettings: $("saveSettings"),
  clearKey: $("clearKey"),
  datetime: $("datetime"),
  coordsInputs: $("coordsInputs"),
  addressInput: $("addressInput"),
  lat: $("lat"),
  lon: $("lon"),
  address: $("address"),
  mode: $("mode"),
  runBtn: $("runBtn"),
  formError: $("formError"),
  progress: $("progress"),
  progressStatus: $("progressStatus"),
  progressTimer: $("progressTimer"),
  results: $("results"),
  summaryCard: $("summaryCard"),
  mapWrap: $("mapWrap"),
  mapNote: $("mapNote"),
  sections: $("sections"),
  reveal: $("reveal"),
};

let mapInstance = null;

/* ---- 設定の保存・読み込み ------------------------------------------------ */

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    if (s.apiKey) el.apiKey.value = s.apiKey;
    if (s.model) el.model.value = s.model;
  } catch (_) {
    /* ignore */
  }
}

function saveSettings() {
  const s = { apiKey: el.apiKey.value.trim(), model: el.model.value };
  localStorage.setItem(STORE_KEY, JSON.stringify(s));
}

/* ---- 進捗表示 ------------------------------------------------------------ */

let timerHandle = null;
let statusHandle = null;

const STATUS_MESSAGES = [
  "最新のニュースを検索しています…",
  "周辺施設・地形情報を確認しています…",
  "事実と推定を整理しています…",
  "レポートを組み立てています…",
];

function startProgress() {
  el.progress.classList.remove("hidden");
  el.results.classList.add("hidden");
  const started = Date.now();
  el.progressStatus.textContent = "調査を開始しています…";
  el.progressTimer.textContent = "経過 0 秒";
  timerHandle = setInterval(() => {
    const sec = Math.round((Date.now() - started) / 1000);
    el.progressTimer.textContent = `経過 ${sec} 秒`;
  }, 1000);
  let i = 0;
  statusHandle = setInterval(() => {
    el.progressStatus.textContent = STATUS_MESSAGES[i % STATUS_MESSAGES.length];
    i += 1;
  }, 4000);
}

function stopProgress() {
  clearInterval(timerHandle);
  clearInterval(statusHandle);
  el.progress.classList.add("hidden");
}

/* ---- Claude 呼び出し ----------------------------------------------------- */

async function callClaude({ apiKey, model, system, userPrompt }) {
  const tools = [{ type: "web_search_20260209", name: "web_search" }];
  const messages = [{ role: "user", content: userPrompt }];
  const collectedText = [];

  for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system,
        tools,
        messages,
      }),
    });

    if (!res.ok) {
      let detail = "";
      try {
        const err = await res.json();
        detail = err?.error?.message || JSON.stringify(err);
      } catch (_) {
        detail = await res.text();
      }
      throw new Error(`APIエラー (${res.status}): ${detail}`);
    }

    const data = await res.json();

    for (const block of data.content || []) {
      if (block.type === "text" && block.text) collectedText.push(block.text);
    }

    if (data.stop_reason === "pause_turn") {
      // サーバーツールが継続を要求。アシスタント応答を積んで再送する。
      messages.push({ role: "assistant", content: data.content });
      continue;
    }
    if (data.stop_reason === "refusal") {
      throw new Error("安全上の理由でリクエストが拒否されました。入力内容を見直してください。");
    }
    break; // end_turn / max_tokens など
  }

  return collectedText.join("\n").trim();
}

/* ---- レポート解析 -------------------------------------------------------- */

function parseReport(raw) {
  let text = raw;
  const places = [];

  // places コードブロックを抽出して本文から除去
  const placesMatch = text.match(/```places\s*([\s\S]*?)```/i);
  if (placesMatch) {
    placesMatch[1]
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((p) => places.push(p));
    text = text.replace(placesMatch[0], "").trim();
  }

  // 念のため他のコードフェンス残骸を除去しない（本文にコードがある可能性は低い）
  // "## 見出し" で分割
  const chunks = text.split(/^##[ \t]+/m);
  const sections = chunks
    .slice(1)
    .map((chunk) => {
      const nl = chunk.indexOf("\n");
      const heading = (nl === -1 ? chunk : chunk.slice(0, nl)).trim();
      const body = (nl === -1 ? "" : chunk.slice(nl + 1)).trim();
      return { heading, body };
    })
    .filter((s) => s.heading);

  // 見出しが取れなかった場合のフォールバック
  if (sections.length === 0 && text) {
    sections.push({ heading: "レポート", body: text });
  }

  return { sections, places: [...new Set(places)] };
}

function renderMarkdown(md) {
  const html = marked.parse(md || "", { breaks: true, gfm: true });
  return DOMPurify.sanitize(html);
}

/* ---- ジオコーディング（Nominatim） --------------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function geocode(query, center) {
  const params = new URLSearchParams({
    format: "json",
    q: query,
    limit: "1",
    "accept-language": "ja",
  });
  if (center) {
    const { lat, lon } = center;
    const d = 0.5;
    // 中心付近を優先（bounded=0 で制限はしない）
    params.set("viewbox", `${lon - d},${lat + d},${lon + d},${lat - d}`);
    params.set("bounded", "0");
  }
  try {
    const res = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const arr = await res.json();
    if (Array.isArray(arr) && arr.length > 0) {
      return {
        name: query,
        lat: parseFloat(arr[0].lat),
        lon: parseFloat(arr[0].lon),
        label: arr[0].display_name,
      };
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

async function geocodePlaces(places, center) {
  const results = [];
  for (const p of places) {
    const hit = await geocode(p, center);
    if (hit) results.push(hit);
    await sleep(1100); // Nominatim の利用ポリシー（<=1req/sec）を尊重
  }
  return results;
}

/* ---- 地図描画 ------------------------------------------------------------ */

function renderMap(center, points) {
  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }
  const start = center || (points[0] ? { lat: points[0].lat, lon: points[0].lon } : { lat: 35.681, lon: 139.767 });
  mapInstance = L.map("map").setView([start.lat, start.lon], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(mapInstance);

  const bounds = [];

  if (center) {
    const c = L.circleMarker([center.lat, center.lon], {
      radius: 9,
      color: "#c0392b",
      fillColor: "#c0392b",
      fillOpacity: 0.9,
    }).addTo(mapInstance);
    c.bindPopup("<b>指定地点</b>");
    bounds.push([center.lat, center.lon]);
  }

  for (const pt of points) {
    const m = L.marker([pt.lat, pt.lon]).addTo(mapInstance);
    m.bindPopup(`<b>${escapeHtml(pt.name)}</b>`);
    bounds.push([pt.lat, pt.lon]);
  }

  if (bounds.length >= 2) {
    mapInstance.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
  } else if (bounds.length === 1) {
    mapInstance.setView(bounds[0], 14);
  }
  // タブ切替やレイアウト確定後のズレ対策
  setTimeout(() => mapInstance && mapInstance.invalidateSize(), 200);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

/* ---- 結果描画・段階的開示 ------------------------------------------------- */

function renderResults(parsed) {
  el.summaryCard.innerHTML = "";
  el.sections.innerHTML = "";
  el.reveal.innerHTML = "";
  el.results.classList.remove("hidden");

  const [summary, ...rest] = parsed.sections;

  // サマリー
  const badge = `<span class="summary-badge">サマリー</span>`;
  el.summaryCard.innerHTML =
    badge +
    `<h2 class="card-title">${escapeHtml(summary ? summary.heading : "サマリー")}</h2>` +
    `<div class="md">${renderMarkdown(summary ? summary.body : "")}</div>`;

  // 段階的開示
  setupReveal(rest);
}

function setupReveal(sections) {
  let index = 0;

  function showPrompt() {
    el.reveal.innerHTML = "";
    if (index >= sections.length) {
      const done = document.createElement("div");
      done.className = "reveal-card";
      done.innerHTML = `<p>すべてのセクションを表示しました。</p>`;
      el.reveal.appendChild(done);
      return;
    }
    const next = sections[index];
    const card = document.createElement("div");
    card.className = "reveal-card";
    card.innerHTML =
      `<p>このあとに <span class="next-name">${escapeHtml(next.heading)}</span> というセクションがありますが、表示しますか？</p>` +
      `<div class="row" style="justify-content:center">
         <button class="btn primary" data-act="yes">はい</button>
         <button class="btn ghost" data-act="no">いいえ</button>
       </div>`;
    card.querySelector('[data-act="yes"]').addEventListener("click", () => {
      appendSection(sections[index]);
      index += 1;
      showPrompt();
    });
    card.querySelector('[data-act="no"]').addEventListener("click", () => {
      el.reveal.innerHTML = "";
      const resume = document.createElement("div");
      resume.className = "reveal-card";
      resume.innerHTML = `<button class="btn primary" data-act="resume">続きを表示</button>`;
      resume.querySelector('[data-act="resume"]').addEventListener("click", showPrompt);
      el.reveal.appendChild(resume);
    });
    el.reveal.appendChild(card);
  }

  function appendSection(section) {
    const div = document.createElement("div");
    div.className = "panel";
    div.innerHTML =
      `<h2 class="card-title">${escapeHtml(section.heading)}</h2>` +
      `<div class="md">${renderMarkdown(section.body)}</div>`;
    el.sections.appendChild(div);
    div.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  showPrompt();
}

/* ---- 実行フロー ----------------------------------------------------------- */

function readForm() {
  const apiKey = el.apiKey.value.trim();
  const model = el.model.value;
  const locmode = document.querySelector('input[name="locmode"]:checked').value;
  const datetimeRaw = el.datetime.value;
  const mode = el.mode.value;

  if (!apiKey) throw new Error("設定でAnthropic APIキーを入力してください。");
  if (!datetimeRaw) throw new Error("日時を入力してください。");

  const params = { mode, datetimeRaw, datetimeLabel: formatDateTime(datetimeRaw) };

  if (locmode === "coords") {
    const lat = parseFloat(el.lat.value);
    const lon = parseFloat(el.lon.value);
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      throw new Error("緯度・経度を数値で入力してください。");
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new Error("緯度・経度の範囲が不正です。");
    }
    params.lat = lat;
    params.lon = lon;
    params.center = { lat, lon };
  } else {
    const address = el.address.value.trim();
    if (!address) throw new Error("住所・地名を入力してください。");
    params.address = address;
  }

  return { apiKey, model, params };
}

function formatDateTime(v) {
  // "2026-08-06T14:30" → "2026年8月6日 14:30"
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return v;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日 ${m[4]}:${m[5]}`;
}

async function run() {
  el.formError.classList.add("hidden");
  let input;
  try {
    input = readForm();
  } catch (e) {
    el.formError.textContent = e.message;
    el.formError.classList.remove("hidden");
    return;
  }

  el.runBtn.disabled = true;
  startProgress();

  try {
    // 住所指定なら中心座標を先に解決（地図中心＆プロンプト補強）
    if (!input.params.center && input.params.address) {
      const c = await geocode(input.params.address, null);
      if (c) {
        input.params.center = { lat: c.lat, lon: c.lon };
        input.params.lat = c.lat;
        input.params.lon = c.lon;
      }
    }

    const system = buildSystemPrompt(input.params.mode);
    const userPrompt = buildUserPrompt(input.params);
    const raw = await callClaude({
      apiKey: input.apiKey,
      model: input.model,
      system,
      userPrompt,
    });

    if (!raw) throw new Error("レポートを取得できませんでした。もう一度お試しください。");

    const parsed = parseReport(raw);
    renderResults(parsed);

    // 地図（地名が有れば表示）
    el.mapWrap.classList.add("hidden");
    if (parsed.places.length > 0 || input.params.center) {
      el.progressStatus.textContent = "地名を地図に変換しています…";
      el.mapWrap.classList.remove("hidden");
      const points = await geocodePlaces(parsed.places, input.params.center);
      renderMap(input.params.center || null, points);
      const found = points.length;
      const total = parsed.places.length;
      el.mapNote.textContent =
        total > 0
          ? `レポート中の地名 ${total} 件のうち ${found} 件を地図に表示しました。赤い点は指定地点です。`
          : "指定地点を表示しています。";
    }
  } catch (e) {
    el.formError.textContent = e.message || String(e);
    el.formError.classList.remove("hidden");
  } finally {
    stopProgress();
    el.runBtn.disabled = false;
  }
}

/* ---- イベント・初期化 ----------------------------------------------------- */

function toggleLocMode() {
  const mode = document.querySelector('input[name="locmode"]:checked').value;
  const coords = mode === "coords";
  el.coordsInputs.classList.toggle("hidden", !coords);
  el.addressInput.classList.toggle("hidden", coords);
}

function initDefaults() {
  // 日時の初期値を現在時刻に
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  el.datetime.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
    now.getDate()
  )}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function init() {
  loadSettings();
  initDefaults();
  toggleLocMode();

  el.settingsToggle.addEventListener("click", () =>
    el.settingsPanel.classList.toggle("hidden")
  );
  el.saveSettings.addEventListener("click", () => {
    saveSettings();
    el.settingsPanel.classList.add("hidden");
  });
  el.clearKey.addEventListener("click", () => {
    el.apiKey.value = "";
    saveSettings();
  });
  document
    .querySelectorAll('input[name="locmode"]')
    .forEach((r) => r.addEventListener("change", toggleLocMode));
  el.runBtn.addEventListener("click", run);

  // 設定未保存でもキー入力があれば実行時に使えるよう、実行時に都度保存
  el.runBtn.addEventListener("click", saveSettings);
}

document.addEventListener("DOMContentLoaded", init);
