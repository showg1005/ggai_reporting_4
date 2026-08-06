/* =========================================================================
   周辺状況把握レポート — PWA
   - 入力: 日時 + (住所 or 緯度経度)
   - OpenAI Responses API (Web検索ツール) で状況を調査しレポート生成
   - Leaflet + OpenStreetMap(Nominatim) で地名を地図表示
   - サマリー → 重要度順のセクションを、確認しながら順に表示
   ========================================================================= */

'use strict';

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses';
const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const STORE_KEY = 'ggai_reporting_settings';

/* ---------------- 状態 ---------------- */
const state = {
  locationMode: 'address', // 'address' | 'latlng'
  report: null,            // 解析済みレポートJSON
  sections: [],            // 重要度順のセクション配列
  currentIndex: -1,        // 直近に表示したセクションの index
  center: null,            // {lat, lng}
  map: null,
  markers: [],
  geocodeCache: new Map(),
};

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id);
const views = {
  input: $('inputView'),
  loading: $('loadingView'),
  report: $('reportView'),
};

/* ---------------- 設定 (localStorage) ---------------- */
function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
}
function saveSettings(s) {
  localStorage.setItem(STORE_KEY, JSON.stringify(s));
}
function getSettings() {
  const s = loadSettings();
  return { apiKey: s.apiKey || '', model: s.model || 'gpt-4o' };
}

/* ---------------- 画面遷移 ---------------- */
function showView(name) {
  Object.entries(views).forEach(([key, el]) => {
    el.hidden = key !== name;
  });
  $('backBtn').hidden = name === 'input';
  window.scrollTo(0, 0);
}

/* ---------------- 初期化 ---------------- */
function init() {
  // 日時の初期値 = 現在時刻
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  $('datetime').value = now.toISOString().slice(0, 16);

  // 場所モード切り替え
  document.querySelectorAll('.toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => setLocationMode(btn.dataset.mode));
  });

  $('reportForm').addEventListener('submit', onSubmit);
  $('backBtn').addEventListener('click', () => showView('input'));

  // 設定モーダル
  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsCancel').addEventListener('click', () => ($('settingsModal').hidden = true));
  $('settingsSave').addEventListener('click', onSaveSettings);

  showView('input');
}

function setLocationMode(mode) {
  state.locationMode = mode;
  document.querySelectorAll('.toggle-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  $('addressField').hidden = mode !== 'address';
  $('latlngField').hidden = mode !== 'latlng';
}

/* ---------------- 設定モーダル ---------------- */
function openSettings() {
  const s = getSettings();
  $('apiKeyInput').value = s.apiKey;
  $('modelInput').value = s.model;
  $('settingsModal').hidden = false;
}
function onSaveSettings() {
  saveSettings({
    apiKey: $('apiKeyInput').value.trim(),
    model: $('modelInput').value.trim() || 'gpt-4o',
  });
  $('settingsModal').hidden = true;
}

/* ---------------- 送信 ---------------- */
async function onSubmit(e) {
  e.preventDefault();
  const hint = $('formHint');
  hint.textContent = '';
  hint.classList.remove('error');

  const settings = getSettings();
  if (!settings.apiKey) {
    hint.textContent = '先に設定(⚙)から OpenAI API キーを入力してください。';
    hint.classList.add('error');
    openSettings();
    return;
  }

  const datetime = $('datetime').value;
  if (!datetime) {
    hint.textContent = '日時を入力してください。';
    hint.classList.add('error');
    return;
  }

  // 場所の決定
  let center = null;
  let locationText = '';
  try {
    if (state.locationMode === 'address') {
      const address = $('address').value.trim();
      if (!address) throw new Error('住所 / 地名を入力してください。');
      locationText = address;
      setLoadingText('住所から位置を特定しています…');
      showView('loading');
      center = await geocode(address);
      if (!center) {
        // 位置が取れなくても住所テキストで続行
        center = null;
      }
    } else {
      const lat = parseFloat($('lat').value);
      const lng = parseFloat($('lng').value);
      if (Number.isNaN(lat) || Number.isNaN(lng)) throw new Error('緯度・経度を数値で入力してください。');
      center = { lat, lng };
      locationText = `緯度 ${lat}, 経度 ${lng}`;
    }
  } catch (err) {
    showView('input');
    hint.textContent = err.message;
    hint.classList.add('error');
    return;
  }

  state.center = center;

  // レポート生成
  showView('loading');
  setLoadingText('周辺状況を調査中です…');
  try {
    const report = await generateReport({ datetime, locationText, center, settings });
    state.report = report;
    renderReport(report);
    showView('report');
  } catch (err) {
    console.error(err);
    showView('input');
    hint.textContent = 'レポート作成に失敗しました: ' + (err.message || err);
    hint.classList.add('error');
  }
}

function setLoadingText(t) {
  $('loadingText').textContent = t;
}

/* ---------------- ジオコーディング (Nominatim) ---------------- */
async function geocode(query, biasCenter) {
  const key = query.toLowerCase();
  if (state.geocodeCache.has(key)) return state.geocodeCache.get(key);

  const params = new URLSearchParams({
    q: query,
    format: 'json',
    limit: '1',
    'accept-language': 'ja',
  });
  if (biasCenter) {
    // 中心付近を優先
    const d = 0.4;
    params.set(
      'viewbox',
      [biasCenter.lng - d, biasCenter.lat + d, biasCenter.lng + d, biasCenter.lat - d].join(',')
    );
  }

  try {
    const res = await fetch(`${NOMINATIM_ENDPOINT}?${params.toString()}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data && data[0]
      ? { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), label: data[0].display_name }
      : null;
    state.geocodeCache.set(key, result);
    return result;
  } catch {
    return null;
  }
}

/* ---------------- OpenAI 呼び出し ---------------- */
function buildSystemPrompt() {
  return [
    'あなたは要因を徹底的に深掘りするデータサイエンティスト兼、位置情報に詳しいアナリストです。',
    '「ある日時」に「ある地点（緯度経度または住所）」付近の周辺状況把握を行います。',
    '具体的な観点は次の通りです。',
    '- 道路の状況（通行止め・道路の被害・渋滞）',
    '- 断水情報',
    '- 停電',
    '- 斜面崩壊・土砂崩れ',
    '- 建造物被害',
    '- 避難所情報',
    '- 給水所',
    '- 医療機関',
    '関連する最新ニュース、事象、災害予報、SNS情報などもWeb検索で調べ、それらの原因を分析してください。',
    '違和感や注目点があれば必ず「どこで（Where）」「なぜ（Why）」を深掘りし、具体的な要因まで踏み込んでください。',
    '',
    '## 重要な価値観・スタンス',
    '- データに含まれていない要素（イベント・天候・交通・メディア露出など）はWeb情報で補完する。',
    '- 「データで確かに言える事実」と「Web情報からの推定」を明確に区別する。',
    '- 「事実」と「推定（仮説）」を分けて書く。本文中では該当箇所に **[事実]** または **[推定]** を付す。',
    '- レポート読者が落胆しないよう、前向きな示唆を含める（すべてが前向きである必要はないが、商業的にマイナスな書き方は避ける）。',
    '- 調査前の確認は不要。すぐに調査を始める。',
  ].join('\n');
}

function buildUserPrompt({ datetime, locationText, center }) {
  const coordLine = center
    ? `緯度経度: ${center.lat}, ${center.lng}`
    : '緯度経度: 不明（住所から特定できず）';
  return [
    '# 対象',
    `日時: ${datetime}`,
    `場所: ${locationText}`,
    coordLine,
    '',
    '上記地点の周辺状況を調査し、レポートを作成してください。',
    '',
    '# 出力形式（重要）',
    '必ず次のスキーマの JSON オブジェクトのみを返してください（前後に説明文やコードフェンスを付けない）。',
    'すべての文字列は日本語。body は Markdown（見出し・箇条書き・リンク可）で記述します。',
    '',
    '{',
    '  "location_label": "解決した地点の分かりやすい名称",',
    '  "summary": "全体サマリー(Markdown)。最も重要な結論を冒頭に。",',
    '  "sections": [',
    '    {',
    '      "id": "roads など識別子",',
    '      "title": "セクション見出し(例: 道路の状況)",',
    '      "importance": 1,',
    '      "body": "本文(Markdown)。[事実]/[推定] を明示。Where/Why を深掘り。前向きな示唆も。",',
    '      "places": ["本文に登場する地名(地図表示用, 具体的な場所名のみ)"]',
    '    }',
    '  ],',
    '  "sources": [ { "title": "情報源のタイトル", "url": "https://..." } ]',
    '}',
    '',
    '# ルール',
    '- sections は重要度が高い順に並べ、importance は 1(最重要) から昇順の整数にする。',
    '- 観点（道路/断水/停電/土砂崩れ/建造物被害/避難所/給水所/医療機関）に加え、必要なら「最新ニュース・事象の分析」等のセクションを追加してよい。',
    '- 情報が乏しい観点も、Web検索の結果と「現時点で特筆すべき被害情報は確認されていない」等の推定を添えて必ず1セクションとして残す。',
    '- places には市区町村名・施設名・道路名など地図に落とせる固有名詞のみを入れる。該当がなければ空配列。',
    '- 実際に参照したWebページを sources に列挙する。',
  ].join('\n');
}

async function generateReport({ datetime, locationText, center, settings }) {
  const body = {
    model: settings.model,
    tools: [{ type: 'web_search' }],
    text: { format: { type: 'json_object' } },
    input: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: buildUserPrompt({ datetime, locationText, center }) },
    ],
  };

  const res = await fetch(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const err = await res.json();
      detail = err.error?.message || JSON.stringify(err);
    } catch {
      detail = await res.text();
    }
    throw new Error(`OpenAI API エラー (${res.status}): ${detail}`);
  }

  const data = await res.json();
  const text = extractOutputText(data);
  if (!text) throw new Error('モデルから有効な出力が得られませんでした。');

  const parsed = parseReportJson(text);
  if (!parsed) throw new Error('レポートJSONの解析に失敗しました。');
  return normalizeReport(parsed);
}

/* Responses API の出力からテキストを取り出す */
function extractOutputText(data) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text;
  }
  let text = '';
  const output = Array.isArray(data.output) ? data.output : [];
  for (const item of output) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.type === 'output_text' && typeof part.text === 'string') {
          text += part.text;
        }
      }
    }
  }
  return text.trim();
}

/* JSON をできるだけ寛容に解析 */
function parseReportJson(text) {
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function normalizeReport(r) {
  const sections = Array.isArray(r.sections) ? r.sections : [];
  sections.forEach((s, i) => {
    if (typeof s.importance !== 'number') s.importance = i + 1;
    if (!Array.isArray(s.places)) s.places = [];
    s.body = s.body || '';
    s.title = s.title || `セクション ${i + 1}`;
  });
  sections.sort((a, b) => a.importance - b.importance);
  return {
    location_label: r.location_label || '',
    summary: r.summary || '',
    sections,
    sources: Array.isArray(r.sources) ? r.sources : [],
  };
}

/* ---------------- レポート描画 ---------------- */
function renderReport(report) {
  state.sections = report.sections;
  state.currentIndex = -1;
  state.markers = [];

  $('reportBody').innerHTML = '';
  $('reportControls').innerHTML = '';

  initMap();

  // サマリー
  const summaryEl = document.createElement('div');
  summaryEl.className = 'report-section summary';
  const label = report.location_label ? `（${escapeHtml(report.location_label)}）` : '';
  summaryEl.innerHTML =
    `<div class="section-head"><span class="section-badge">要</span>` +
    `<h2 class="section-title">サマリー${label}</h2></div>` +
    `<div class="md">${renderMarkdown(report.summary)}</div>`;
  $('reportBody').appendChild(summaryEl);

  // 最初のセクションへの誘導
  showNextPrompt();
}

function initMap() {
  const mapEl = $('map');
  if (state.map) {
    state.map.remove();
    state.map = null;
  }
  const center = state.center || { lat: 35.681, lng: 139.767 };
  mapEl.classList.remove('hidden-map');
  state.map = L.map('map').setView([center.lat, center.lng], state.center ? 13 : 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(state.map);

  if (state.center) {
    L.marker([center.lat, center.lng])
      .addTo(state.map)
      .bindPopup('対象地点')
      .openPopup();
  }
  setTimeout(() => state.map && state.map.invalidateSize(), 200);
}

/* 次セクションへの確認プロンプト or 終了 */
function showNextPrompt() {
  const controls = $('reportControls');
  controls.innerHTML = '';
  const nextIndex = state.currentIndex + 1;

  if (nextIndex >= state.sections.length) {
    renderEnd();
    return;
  }

  const next = state.sections[nextIndex];
  const prompt = document.createElement('div');
  prompt.className = 'next-prompt';
  prompt.innerHTML =
    `<p>このあとは「<span class="next-name">${escapeHtml(next.title)}</span>」というセクションがありますが、表示しますか？</p>` +
    `<div class="next-actions">` +
    `<button class="primary-btn" id="revealYes">はい、表示する</button>` +
    `<button class="ghost-btn" id="revealNo">ここで終了</button>` +
    `</div>`;
  controls.appendChild(prompt);

  $('revealYes').addEventListener('click', revealNextSection);
  $('revealNo').addEventListener('click', renderEnd);
  prompt.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function revealNextSection() {
  state.currentIndex += 1;
  const section = state.sections[state.currentIndex];

  const el = document.createElement('div');
  el.className = 'report-section';
  el.innerHTML =
    `<div class="section-head"><span class="section-badge">${state.currentIndex + 1}</span>` +
    `<h2 class="section-title">${escapeHtml(section.title)}</h2></div>` +
    `<div class="md">${renderMarkdown(section.body)}</div>`;

  // 地名チップ
  if (section.places.length) {
    const row = document.createElement('div');
    row.className = 'places-row';
    section.places.forEach((place) => {
      const chip = document.createElement('button');
      chip.className = 'place-chip';
      chip.textContent = '📍 ' + place;
      chip.addEventListener('click', () => focusPlace(place));
      row.appendChild(chip);
    });
    el.appendChild(row);
  }

  $('reportBody').appendChild(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // 地名を地図へ
  addPlacesToMap(section.places);

  // 次の確認へ
  showNextPrompt();
}

function renderEnd() {
  const controls = $('reportControls');
  controls.innerHTML = '';

  const report = state.report;
  if (report.sources && report.sources.length) {
    const sources = document.createElement('div');
    sources.className = 'sources';
    const items = report.sources
      .filter((s) => s && (s.url || s.title))
      .map((s) => {
        if (s.url) {
          return `<li><a href="${escapeAttr(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title || s.url)}</a></li>`;
        }
        return `<li>${escapeHtml(s.title)}</li>`;
      })
      .join('');
    sources.innerHTML = `<h3>情報源</h3><ul>${items}</ul>`;
    controls.appendChild(sources);
  }

  const end = document.createElement('div');
  end.className = 'report-end';
  const remaining = state.sections.length - (state.currentIndex + 1);
  const msg =
    remaining > 0
      ? `表示を終了しました。（未表示のセクションが ${remaining} 件あります）`
      : 'すべてのセクションを表示しました。';
  end.innerHTML =
    `<p>${msg}</p>` +
    `<button class="primary-btn" id="newReportBtn">新しいレポートを作成</button>`;
  controls.appendChild(end);
  $('newReportBtn').addEventListener('click', () => showView('input'));
}

/* ---------------- 地図: 地名 ---------------- */
async function addPlacesToMap(places) {
  for (const place of places) {
    const query = queryForPlace(place);
    const loc = await geocode(query, state.center);
    if (loc) {
      const marker = L.marker([loc.lat, loc.lng]).addTo(state.map).bindPopup(escapeHtml(place));
      state.markers.push({ place, marker });
      fitToMarkers();
    }
    await sleep(1100); // Nominatim 利用規約: 1req/sec
  }
}

function queryForPlace(place) {
  // 住所モードで中心付近に寄せたい場合、地名だけだと曖昧になりやすいので中心ラベルを軽く補う
  return place;
}

function focusPlace(place) {
  const found = state.markers.find((m) => m.place === place);
  if (found) {
    state.map.setView(found.marker.getLatLng(), 15);
    found.marker.openPopup();
    $('map').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function fitToMarkers() {
  const latlngs = state.markers.map((m) => m.marker.getLatLng());
  if (state.center) latlngs.push(L.latLng(state.center.lat, state.center.lng));
  if (latlngs.length > 1) {
    state.map.fitBounds(L.latLngBounds(latlngs).pad(0.2), { maxZoom: 14 });
  }
}

/* ---------------- Markdown (簡易) ---------------- */
function renderMarkdown(md) {
  if (!md) return '';
  const lines = String(md).split('\n');
  let html = '';
  let inList = false;

  const closeList = () => {
    if (inList) {
      html += '</ul>';
      inList = false;
    }
  };

  for (let raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      closeList();
      continue;
    }
    if (/^###\s+/.test(line)) {
      closeList();
      html += `<h3>${inline(line.replace(/^###\s+/, ''))}</h3>`;
    } else if (/^##\s+/.test(line)) {
      closeList();
      html += `<h2>${inline(line.replace(/^##\s+/, ''))}</h2>`;
    } else if (/^#\s+/.test(line)) {
      closeList();
      html += `<h2>${inline(line.replace(/^#\s+/, ''))}</h2>`;
    } else if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      html += `<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`;
    } else {
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
  }
  closeList();
  return html;
}

function inline(text) {
  let t = escapeHtml(text);
  // リンク [text](url)
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, url) => {
    return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener">${label}</a>`;
  });
  // 事実 / 推定タグ
  t = t.replace(/\[事実\]/g, '<span class="tag-fact" style="background:#dcfce7;color:#166534">事実</span>');
  t = t.replace(/\[推定\]/g, '<span class="tag-guess" style="background:#fef3c7;color:#92400e">推定</span>');
  // 太字
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // インラインコード
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  // 素のURL
  t = t.replace(/(^|[^"'>])(https?:\/\/[^\s<]+)/g, (m, pre, url) => {
    return `${pre}<a href="${escapeAttr(url)}" target="_blank" rel="noopener">${url}</a>`;
  });
  return t;
}

/* ---------------- ユーティリティ ---------------- */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------------- Service Worker ---------------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

document.addEventListener('DOMContentLoaded', init);
