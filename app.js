/**
 * ラップグラフ数値抽出 (シンプル版)
 *  - クロップなし: スマホ側で事前にトリミングする想定
 *  - 外部ライブラリなし: Pure JavaScript で動作
 *  - Service Worker なし: シンプルなWebページとして動作
 */

// 過去のSWとキャッシュをクリーンアップ (古い版を使った人のため)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(regs => {
    regs.forEach(reg => reg.unregister());
  }).catch(()=>{});
  if (window.caches) {
    caches.keys().then(keys => keys.forEach(k => caches.delete(k))).catch(()=>{});
  }
}

const state = {
  imgEl: null,        // 元画像 HTMLImageElement
  detected: {},       // gridYTop, gridYBottom など
  calibration: {},    // 編集機能用にユーザー入力値を保存
  results: [],
};

// =========== ステータス表示 ===========
function setStatus(msg, type = '') {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = type;
}

// =========== STEP 1: 画像選択 ===========
document.getElementById('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setStatus('画像を読み込んでいます...');

  // ファイルから直接 Image オブジェクトを作る (DataURL経由を避ける)
  const objectUrl = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    state.imgEl = img;
    setStatus(`読み込み成功 (${img.naturalWidth}×${img.naturalHeight}px)`, 'success');

    // プレビュー表示
    const canvas = document.getElementById('previewCanvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    document.getElementById('previewBox').classList.remove('hidden');

    // Y軸グリッド線を自動検出して値の初期推定
    detectGrid();
    buildGridValueInputs();

    // ② のセクションを表示
    document.getElementById('paramSection').classList.remove('hidden');

    // ObjectURLを解放
    URL.revokeObjectURL(objectUrl);
  };
  img.onerror = (err) => {
    console.error('Image load error:', err);
    setStatus('画像の読み込みに失敗しました。別の画像を試してください', 'error');
    URL.revokeObjectURL(objectUrl);
  };
  img.src = objectUrl;
});

// =========== Y軸グリッド検出 ===========
function detectGrid() {
  const img = state.imgEl;
  const W = img.naturalWidth;
  const H = img.naturalHeight;

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, W, H).data;

  // 灰色のグリッド線 (R≈G≈B かつ 200-245)
  const threshold = W * 0.4;  // 幅の40%以上が灰色なら水平線
  const candidateRows = [];
  // 各候補行のグリッド線のX座標範囲も記録
  const rowXRange = {};  // y -> [xMin, xMax]
  for (let y = 0; y < H; y++) {
    let count = 0;
    let xMin = W, xMax = 0;
    const off = y * W * 4;
    for (let x = 0; x < W; x++) {
      const i = off + x * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      if (r >= 200 && r <= 245 &&
          Math.abs(r - g) < 10 && Math.abs(g - b) < 10) {
        count++;
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
      }
    }
    if (count > threshold) {
      candidateRows.push(y);
      rowXRange[y] = [xMin, xMax];
    }
  }

  // 連続行のグループ化
  const groups = [];
  if (candidateRows.length > 0) {
    let cur = [candidateRows[0]];
    for (let i = 1; i < candidateRows.length; i++) {
      const r = candidateRows[i];
      if (r - cur[cur.length - 1] <= 3) cur.push(r);
      else {
        groups.push(Math.round(cur.reduce((a,b)=>a+b) / cur.length));
        cur = [r];
      }
    }
    groups.push(Math.round(cur.reduce((a,b)=>a+b) / cur.length));
  }

  // グリッド線のX座標範囲 (主要グリッド線の最小/最大)
  if (candidateRows.length > 0) {
    let xMins = [], xMaxs = [];
    for (const y of candidateRows) {
      if (rowXRange[y]) {
        xMins.push(rowXRange[y][0]);
        xMaxs.push(rowXRange[y][1]);
      }
    }
    // 中央値を使う
    xMins.sort((a, b) => a - b);
    xMaxs.sort((a, b) => a - b);
    state.detected.gridXLeft = xMins[Math.floor(xMins.length / 2)];
    state.detected.gridXRight = xMaxs[Math.floor(xMaxs.length / 2)];
  } else {
    state.detected.gridXLeft = 0;
    state.detected.gridXRight = W;
  }

  if (groups.length >= 2) {
    state.detected.gridYTop = groups[0];
    state.detected.gridYBottom = groups[groups.length - 1];
    state.detected.gridYAll = groups;
  } else {
    // フォールバック
    state.detected.gridYTop = Math.round(H * 0.05);
    state.detected.gridYBottom = Math.round(H * 0.85);
    state.detected.gridYAll = [];
  }
  console.log('Grid detected:', state.detected);
}

// =========== グリッド線の値入力欄を動的生成 ===========
function buildGridValueInputs() {
  const container = document.getElementById('gridValuesContainer');
  container.innerHTML = '';

  const gridYAll = state.detected.gridYAll || [];

  // フォールバック: グリッド線が検出されなければ 2 本の入力欄
  let lines;
  if (gridYAll.length >= 2) {
    lines = gridYAll;
  } else {
    lines = [state.detected.gridYTop, state.detected.gridYBottom];
  }

  // 競馬ラップグラフでよくある 10〜14秒、1秒刻みを初期値として推定
  // 線の本数に応じてデフォルト値を算出 (上から 10, 11, 12, ...)
  const defaultStart = 10;
  const defaultStep = 1;

  lines.forEach((y, i) => {
    const row = document.createElement('div');
    row.className = 'gridline-row';

    const idx = document.createElement('div');
    idx.className = 'index';
    idx.textContent = (i + 1) + '本目';

    const desc = document.createElement('div');
    desc.className = 'desc';
    if (i === 0) desc.textContent = '一番上の線';
    else if (i === lines.length - 1) desc.textContent = '一番下の線';
    else desc.textContent = '';

    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.1';
    input.inputMode = 'decimal';
    input.value = defaultStart + i * defaultStep;
    input.dataset.gridY = y;
    input.dataset.gridIdx = i;

    const unit = document.createElement('span');
    unit.className = 'unit';
    unit.textContent = '秒';

    row.appendChild(idx);
    row.appendChild(desc);
    row.appendChild(input);
    row.appendChild(unit);
    container.appendChild(row);
  });

  console.log('Built', lines.length, 'gridline inputs');
}

// =========== グリッド線の値からY軸キャリブレーションを取得 ===========
function getCalibrationFromInputs() {
  const inputs = document.querySelectorAll('#gridValuesContainer input');
  const points = [];
  inputs.forEach(inp => {
    const y = parseFloat(inp.dataset.gridY);
    const v = parseFloat(inp.value);
    if (isFinite(y) && isFinite(v)) {
      points.push({ y, v });
    }
  });
  return points;  // [{y: 21, v: 10}, {y: 269, v: 11}, ...]
}

// =========== Y座標から秒数を計算 (補間) ===========
function yToSecondsFromCalibration(y, calibPoints) {
  if (calibPoints.length < 2) return NaN;
  // y は通常、calibPoints の y_min 〜 y_max 内
  // 最も近い 2 点で線形補間
  let p1 = calibPoints[0], p2 = calibPoints[calibPoints.length - 1];
  for (let i = 0; i < calibPoints.length - 1; i++) {
    if (calibPoints[i].y <= y && y <= calibPoints[i+1].y) {
      p1 = calibPoints[i]; p2 = calibPoints[i+1];
      break;
    }
  }
  // 範囲外 (上端より上、下端より下) は両端の2点で外挿
  if (y < calibPoints[0].y) { p1 = calibPoints[0]; p2 = calibPoints[1]; }
  else if (y > calibPoints[calibPoints.length-1].y) {
    p1 = calibPoints[calibPoints.length-2]; p2 = calibPoints[calibPoints.length-1];
  }
  return p1.v + (y - p1.y) / (p2.y - p1.y) * (p2.v - p1.v);
}

// =========== STEP 2: 抽出ボタン ===========
document.getElementById('btnExtract').addEventListener('click', () => {
  if (!state.imgEl) {
    setStatus('まず画像を選んでください', 'error');
    return;
  }

  const calibPoints = getCalibrationFromInputs();
  const pointCount = parseInt(document.getElementById('pointCount').value, 10);
  const intervalWidth = parseInt(document.getElementById('intervalWidth').value, 10);

  if (calibPoints.length < 2) {
    setStatus('Y軸の値が2つ以上必要です', 'error');
    return;
  }
  // ソート (Y座標順)
  calibPoints.sort((a, b) => a.y - b.y);
  if (pointCount < 2 || pointCount > 50) {
    setStatus('点の数を確認してください', 'error');
    return;
  }

  try {
    // 編集機能用に値を保存
    state.calibration = { calibPoints, pointCount, intervalWidth };
    extractPoints(calibPoints, pointCount, intervalWidth);
    renderResult();
    document.getElementById('resultSection').classList.remove('hidden');
    document.getElementById('resultSection').scrollIntoView({ behavior: 'smooth' });
    setStatus('抽出完了', 'success');
  } catch (err) {
    console.error(err);
    setStatus('抽出失敗: ' + err.message, 'error');
  }
});

// =========== 点抽出ロジック ===========
function extractPoints(calibPoints, pointCount, intervalWidth) {
  const img = state.imgEl;
  const W = img.naturalWidth;
  const H = img.naturalHeight;

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  c.getContext('2d').drawImage(img, 0, 0);
  const px = c.getContext('2d').getImageData(0, 0, W, H).data;

  // === 1. グラフ色を自動検出 ===
  const targetColor = detectGraphColor(px, W, H);
  console.log('Detected graph color:', targetColor);

  // === グラフ領域 (グリッド線で囲まれた範囲) ===
  // Y範囲: 一番上のグリッド線から一番下のグリッド線まで (少しマージン)
  // X範囲: グリッド線のX座標範囲 (Y軸ラベルやX軸ラベルを除外)
  const yMin = Math.max(0, (state.detected.gridYTop || 0) - 5);
  const yMax = Math.min(H, (state.detected.gridYBottom || H) + 5);
  const xMin = state.detected.gridXLeft || 0;
  const xMax = state.detected.gridXRight || W;
  console.log('Graph area: X=', xMin, '-', xMax, 'Y=', yMin, '-', yMax);

  // 2. 色マスク作成 (グラフ領域内のみ)
  const mask = new Uint8Array(W * H);
  for (let y = yMin; y < yMax; y++) {
    for (let x = xMin; x < xMax; x++) {
      const i = (y * W + x) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      if (isColorSimilar(r, g, b, targetColor)) {
        mask[y * W + x] = 1;
      }
    }
  }

  // === 3. erosion を増やしながら、X軸方向に等間隔に並んだ正方形成分が取れるサイズを探す ===
  // スコアリング:
  //  - サイズが揃っている (中央値±50%)
  //  - X軸方向の間隔が均等 (CV が小さい)
  //  - 期待される点数 (pointCount) に近い
  let bestEr = 0;
  let bestScore = -1;
  let bestPoints = [];
  for (let er = 0; er <= 8; er++) {
    const eroded = (er === 0) ? mask : erode(mask, W, H, er);
    if (sumMask(eroded) === 0) break;

    // erosion 後は最低 15 px のみを点候補とする (文字断片を除去)
    const comps = getSquareComponents(eroded, W, H, 15);
    const evalResult = evaluateAsDots(comps, pointCount);
    if (evalResult.score > bestScore) {
      bestEr = er;
      bestScore = evalResult.score;
      bestPoints = evalResult.points;
    }
  }
  console.log('Best erosion:', bestEr, 'Score:', bestScore.toFixed(2), 'Points:', bestPoints.length);

  if (bestPoints.length < 2) {
    throw new Error('点が見つかりませんでした (検出数: ' + bestPoints.length + ')。画像のトリミングを確認してください');
  }

  // 検出された点を直接使う (erosion 後の中心位置でOK)
  const points = bestPoints.map(c => ({ x: c.cx, y: c.cy }));

  if (points.length < 2) {
    throw new Error('点が見つかりませんでした (検出数: ' + points.length + ')');
  }

  points.sort((a, b) => a.x - b.x);

  // 6. 期待数を超える場合は等間隔位置に近いものを選ぶ
  let selected = points;
  if (points.length > pointCount) {
    const x0 = points[0].x;
    const xN = points[points.length - 1].x;
    const step = (xN - x0) / (pointCount - 1);
    selected = [];
    const used = new Set();
    for (let i = 0; i < pointCount; i++) {
      const targetX = x0 + step * i;
      let bestIdx = -1, bestDist = Infinity;
      for (let j = 0; j < points.length; j++) {
        if (used.has(j)) continue;
        const d = Math.abs(points[j].x - targetX);
        if (d < bestDist) { bestDist = d; bestIdx = j; }
      }
      if (bestIdx >= 0) { used.add(bestIdx); selected.push(points[bestIdx]); }
    }
    selected.sort((a, b) => a.x - b.x);
  }

  // 7. Y → 値の変換 (キャリブレーション点を使った補間)
  state.results = selected.map((p, i) => ({
    x: p.x,
    y: p.y,
    start: i * intervalWidth,
    end: (i + 1) * intervalWidth,
    sec: yToSecondsFromCalibration(p.y, calibPoints),
  }));
}

// === Helper Functions for Erosion/Dilation ===
function sumMask(m) {
  let s = 0;
  for (let i = 0; i < m.length; i++) s += m[i];
  return s;
}

/**
 * erosion: 構造要素は (2r+1) x (2r+1) の正方形
 * 入力画素の (2r+1)^2 近傍が全て 1 のときだけ出力 1
 */
function erode(mask, W, H, r) {
  // 効率化: 縦方向のerosion → 横方向のerosionに分解 (separable)
  const tmp = new Uint8Array(W * H);
  // 縦
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let allOne = 1;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H || !mask[yy * W + x]) { allOne = 0; break; }
      }
      tmp[y * W + x] = allOne;
    }
  }
  // 横
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const off = y * W;
    for (let x = 0; x < W; x++) {
      let allOne = 1;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= W || !tmp[off + xx]) { allOne = 0; break; }
      }
      out[off + x] = allOne;
    }
  }
  return out;
}

/**
 * dilation: 構造要素の近傍に1があれば1
 */
function dilate(mask, W, H, r) {
  const tmp = new Uint8Array(W * H);
  // 縦
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let any = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy >= 0 && yy < H && mask[yy * W + x]) { any = 1; break; }
      }
      tmp[y * W + x] = any;
    }
  }
  // 横
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const off = y * W;
    for (let x = 0; x < W; x++) {
      let any = 0;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < W && tmp[off + xx]) { any = 1; break; }
      }
      out[off + x] = any;
    }
  }
  return out;
}

/**
 * 連結成分から「正方形に近い」(アスペクト比 0.5-2.0) のもののみを返す
 */
function getSquareComponents(mask, W, H, minSize) {
  const visited = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  const comps = [];

  for (let sy = 0; sy < H; sy++) {
    for (let sx = 0; sx < W; sx++) {
      const sIdx = sy * W + sx;
      if (!mask[sIdx] || visited[sIdx]) continue;

      let head = 0, tail = 0;
      queue[tail++] = sIdx;
      visited[sIdx] = 1;
      let sumX = 0, sumY = 0, count = 0;
      let minX = sx, maxX = sx, minY = sy, maxY = sy;

      while (head < tail) {
        const idx = queue[head++];
        const x = idx % W;
        const y = (idx - x) / W;
        sumX += x; sumY += y; count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        if (x > 0 && mask[idx-1] && !visited[idx-1]) { visited[idx-1] = 1; queue[tail++] = idx-1; }
        if (x < W-1 && mask[idx+1] && !visited[idx+1]) { visited[idx+1] = 1; queue[tail++] = idx+1; }
        if (y > 0 && mask[idx-W] && !visited[idx-W]) { visited[idx-W] = 1; queue[tail++] = idx-W; }
        if (y < H-1 && mask[idx+W] && !visited[idx+W]) { visited[idx+W] = 1; queue[tail++] = idx+W; }
      }

      if (count < minSize) continue;
      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      const aspect = w / Math.max(h, 1);
      if (aspect < 0.4 || aspect > 2.5) continue;
      comps.push({ cx: sumX / count, cy: sumY / count, w, h, count });
    }
  }
  return comps;
}

/**
 * 成分のサイズの中で「最頻クラスタ」のサイズを返す
 * (各成分のcountに対して、その±30%以内に何個成分があるかをカウントし、最大値を返す)
 */
function countDominantSizeGroup(comps) {
  if (comps.length < 3) return 0;
  let best = 0;
  for (const c of comps) {
    const lo = c.count * 0.7;
    const hi = c.count * 1.3;
    let n = 0;
    for (const c2 of comps) {
      if (c2.count >= lo && c2.count <= hi) n++;
    }
    if (n > best) best = n;
  }
  return best;
}

/**
 * 成分から「最頻サイズクラスタ」(中心サイズ ±ratio) を抽出
 */
function getDominantCluster(comps, ratio) {
  if (!comps.length) return [];
  let bestCenter = comps[0].count;
  let bestN = 0;
  for (const c of comps) {
    const lo = c.count * (1 - ratio);
    const hi = c.count * (1 + ratio);
    let n = 0;
    for (const c2 of comps) {
      if (c2.count >= lo && c2.count <= hi) n++;
    }
    if (n > bestN) { bestN = n; bestCenter = c.count; }
  }
  const lo = bestCenter * (1 - ratio);
  const hi = bestCenter * (1 + ratio);
  return comps.filter(c => c.count >= lo && c.count <= hi);
}

/**
 * 成分の集合を「等間隔に並んだ点群」として評価する
 * - サイズが揃っている (中央値±50%) ものを候補にする
 * - X軸方向の間隔が均等であるほど高得点
 * - 期待される点数 (expectedN) に近いほど高得点
 *
 * 戻り値: { score: 数値, points: 候補となる成分の配列 }
 */
function evaluateAsDots(comps, expectedN) {
  if (comps.length < 3) return { score: 0, points: [] };
  // サイズの中央値
  const counts = comps.map(c => c.count).sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)];
  // 中央値 ±50% に収まる成分のみ (文字断片や巨大成分を除外)
  const candidates = comps.filter(c => c.count >= median * 0.5 && c.count <= median * 1.5);
  if (candidates.length < 3) return { score: 0, points: [] };

  // X座標でソート
  candidates.sort((a, b) => a.cx - b.cx);

  // X軸の間隔の均等性
  const xs = candidates.map(c => c.cx);
  const diffs = [];
  for (let i = 1; i < xs.length; i++) diffs.push(xs[i] - xs[i-1]);
  if (!diffs.length) return { score: 0, points: candidates };
  const meanDiff = diffs.reduce((a, b) => a + b) / diffs.length;
  let varDiff = 0;
  diffs.forEach(d => { varDiff += (d - meanDiff) ** 2; });
  varDiff /= diffs.length;
  const stdDiff = Math.sqrt(varDiff);
  const cv = meanDiff > 0 ? stdDiff / meanDiff : 1.0;  // 変動係数

  // 期待数との近さ
  const nScore = 1.0 - Math.abs(candidates.length - expectedN) / Math.max(expectedN, candidates.length);

  // 等間隔スコア (CVが小さいほど良い)
  const evenScore = Math.max(0, 1.0 - cv * 2);

  // 総合スコア
  const score = candidates.length * 0.5 + nScore * 5 + evenScore * 5;
  return { score, points: candidates };
}

/**
 * mask の各画素にラベル番号を割り当て、ラベル配列を返す (BFS)
 * 0 = mask が 0 の画素
 */
function labelComponents(mask, W, H) {
  const labels = new Int32Array(W * H);
  const queue = new Int32Array(W * H);
  let nextLabel = 1;
  for (let sy = 0; sy < H; sy++) {
    for (let sx = 0; sx < W; sx++) {
      const sIdx = sy * W + sx;
      if (!mask[sIdx] || labels[sIdx]) continue;
      let head = 0, tail = 0;
      queue[tail++] = sIdx;
      labels[sIdx] = nextLabel;
      while (head < tail) {
        const idx = queue[head++];
        const x = idx % W;
        const y = (idx - x) / W;
        if (x > 0 && mask[idx-1] && !labels[idx-1]) { labels[idx-1] = nextLabel; queue[tail++] = idx-1; }
        if (x < W-1 && mask[idx+1] && !labels[idx+1]) { labels[idx+1] = nextLabel; queue[tail++] = idx+1; }
        if (y > 0 && mask[idx-W] && !labels[idx-W]) { labels[idx-W] = nextLabel; queue[tail++] = idx-W; }
        if (y < H-1 && mask[idx+W] && !labels[idx+W]) { labels[idx+W] = nextLabel; queue[tail++] = idx+W; }
      }
      nextLabel++;
    }
  }
  return labels;
}

// =========== 結果描画 + 編集機能 ===========
// 編集モードの状態
const editState = {
  scale: 1,
  radius: 10,
  fontSize: 13,
  // ドラッグ管理
  dragIdx: -1,        // ドラッグ中の点のインデックス (-1 なら無し)
  pointerDownPt: null, // タッチ/マウスダウン時の座標
  pointerDownIdx: -1,  // ダウン時にヒットした点のインデックス
  moved: false,        // ダウン後、移動したか
  setupDone: false,    // イベントハンドラ設置済みフラグ
};

function renderResult() {
  const img = state.imgEl;
  const canvas = document.getElementById('resultCanvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;

  // 画像サイズに応じてサイズ調整
  editState.scale = Math.max(1, Math.min(canvas.width, canvas.height) / 400);
  editState.radius = 10 * editState.scale;
  editState.fontSize = Math.max(11, Math.round(13 * editState.scale));

  redrawResult();

  // 初回のみイベントハンドラを設置
  if (!editState.setupDone) {
    setupEditHandlers(canvas);
    editState.setupDone = true;
  }
}

function redrawResult() {
  const img = state.imgEl;
  const canvas = document.getElementById('resultCanvas');
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const radius = editState.radius;
  const fontSize = editState.fontSize;
  const scale = editState.scale;

  state.results.forEach((p, idx) => {
    // ドラッグ中の点はハイライト
    const isDragging = idx === editState.dragIdx;
    ctx.beginPath();
    ctx.arc(p.x, p.y, isDragging ? radius * 1.3 : radius, 0, Math.PI * 2);
    ctx.strokeStyle = isDragging ? '#10B981' : '#EF4444';
    ctx.lineWidth = Math.max(2, 2 * scale);
    ctx.stroke();
    if (isDragging) {
      ctx.fillStyle = 'rgba(16, 185, 129, 0.2)';
      ctx.fill();
    }

    const label = p.sec.toFixed(1);
    ctx.font = 'bold ' + fontSize + 'px sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(p.x - tw/2 - 4, p.y - radius - fontSize - 6, tw + 8, fontSize + 4);
    ctx.fillStyle = '#1F2937';
    ctx.textAlign = 'center';
    ctx.fillText(label, p.x, p.y - radius - 6);
    ctx.textAlign = 'left';
  });

  // テキスト出力を更新
  const lines = state.results.map(p =>
    `・${p.start}-${p.end}：${p.sec.toFixed(1)}`
  );
  document.getElementById('resultText').value = lines.join('\n');
}

/**
 * Y座標を秒数に変換 (再計算用)
 */
function yToSecValue(y) {
  return yToSecondsFromCalibration(y, state.calibration.calibPoints || []);
}

/**
 * 結果配列をX順にソートし、start/end/sec を再計算
 */
function recomputeResults() {
  state.results.sort((a, b) => a.x - b.x);
  const intervalWidth = state.calibration.intervalWidth;
  state.results.forEach((p, i) => {
    p.start = i * intervalWidth;
    p.end = (i + 1) * intervalWidth;
    p.sec = yToSecValue(p.y);
  });
}

/**
 * キャンバス座標 → 画像座標
 */
function canvasToImageCoords(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}

/**
 * 指定座標に最も近い点のインデックスを返す (許容範囲内なら)
 */
function findHitPoint(x, y) {
  // タップしやすいよう、点の半径の 2.5倍まで広めに判定
  const hitRadius = editState.radius * 2.5;
  let bestIdx = -1;
  let bestDist = hitRadius;
  for (let i = 0; i < state.results.length; i++) {
    const p = state.results[i];
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestIdx;
}

function setupEditHandlers(canvas) {
  // 共通: イベントから座標を取得
  function getEventCoords(e) {
    const touch = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    const cx = touch ? touch.clientX : e.clientX;
    const cy = touch ? touch.clientY : e.clientY;
    return canvasToImageCoords(canvas, cx, cy);
  }

  // 最後にタップが終了した時刻と位置 (ダブルタップ判定用)
  let lastTapTime = 0;
  let lastTapPt = null;

  // ダウン: 既存の点をヒットしたか確認
  function onDown(e) {
    e.preventDefault();
    const pt = getEventCoords(e);
    editState.pointerDownPt = pt;
    editState.pointerDownIdx = findHitPoint(pt.x, pt.y);
    editState.moved = false;
    editState.dragIdx = -1;
    // 点をヒットした場合は、ダウン時点で「ドラッグ候補」として表示しておく
    if (editState.pointerDownIdx >= 0) {
      editState.dragIdx = editState.pointerDownIdx;
      redrawResult();
    }
  }

  // ムーブ: 既存の点をドラッグしている場合は位置更新
  function onMove(e) {
    if (editState.pointerDownPt === null) return;
    e.preventDefault();
    const pt = getEventCoords(e);
    const dx = pt.x - editState.pointerDownPt.x;
    const dy = pt.y - editState.pointerDownPt.y;
    const moveDist = Math.hypot(dx, dy);
    // 動いた閾値 (画像座標で):
    //  - 点をヒット中: 3px (すぐ動かしたいので小さめ)
    //  - 空白部分: 12px (ジッターと区別)
    const moveThresh = (editState.pointerDownIdx >= 0 ? 3 : 12) * editState.scale;
    if (moveDist > moveThresh || editState.moved) {
      editState.moved = true;
      if (editState.pointerDownIdx >= 0) {
        // 既存の点をドラッグ
        const p = state.results[editState.pointerDownIdx];
        p.x = pt.x;
        p.y = pt.y;
        p.sec = yToSecValue(p.y);
        redrawResult();
      }
    }
  }

  // アップ: ドラッグ確定 or タップ判定 (ダブルタップ追加 / シングルタップ削除)
  function onUp(e) {
    if (editState.pointerDownPt === null) return;
    e.preventDefault();
    const pt = getEventCoords(e);
    const now = Date.now();

    if (editState.moved) {
      // ドラッグ後: X順序に従って再ソート + start/end/sec を再計算
      recomputeResults();
      // タップ履歴をリセット (ドラッグ後はダブルタップ扱いしない)
      lastTapTime = 0;
      lastTapPt = null;
    } else {
      // 移動なし = タップ
      // ダブルタップ判定: 直前のタップから 350ms 以内 + 同じ位置付近
      const isDoubleTap = lastTapTime > 0
        && (now - lastTapTime) < 350
        && lastTapPt
        && Math.hypot(pt.x - lastTapPt.x, pt.y - lastTapPt.y) < 30 * editState.scale;

      if (isDoubleTap) {
        // ダブルタップ → 点を追加
        // ただし、既存の点の上でダブルタップした場合は削除
        if (editState.pointerDownIdx >= 0) {
          state.results.splice(editState.pointerDownIdx, 1);
        } else {
          state.results.push({
            x: pt.x,
            y: pt.y,
            start: 0,
            end: 0,
            sec: yToSecValue(pt.y),
          });
        }
        recomputeResults();
        // ダブルタップ後はリセット
        lastTapTime = 0;
        lastTapPt = null;
      } else {
        // シングルタップ → 既存点があれば削除
        if (editState.pointerDownIdx >= 0) {
          state.results.splice(editState.pointerDownIdx, 1);
          recomputeResults();
          // シングルタップ後はリセット (連続でダブルタップ判定にならないように)
          lastTapTime = 0;
          lastTapPt = null;
        } else {
          // 空白部分のシングルタップ → 何もしない (誤動作防止)
          // ダブルタップ判定のため、タップ履歴を記録
          lastTapTime = now;
          lastTapPt = pt;
        }
      }
    }

    editState.pointerDownPt = null;
    editState.pointerDownIdx = -1;
    editState.dragIdx = -1;
    editState.moved = false;
    redrawResult();
  }

  // タッチイベント (スマホ)
  // タッチダウンは canvas のみ、ムーブ・アップは document に登録して
  // 指がキャンバスからはみ出してもドラッグ継続できるようにする
  canvas.addEventListener('touchstart', onDown, { passive: false });
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onUp, { passive: false });
  document.addEventListener('touchcancel', onUp, { passive: false });

  // マウスイベント (PC)
  canvas.addEventListener('mousedown', onDown);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// =========== コピーボタン ===========
document.getElementById('btnCopy').addEventListener('click', async () => {
  const text = document.getElementById('resultText').value;
  try {
    await navigator.clipboard.writeText(text);
    setStatus('コピーしました', 'success');
  } catch {
    const ta = document.getElementById('resultText');
    ta.select();
    document.execCommand('copy');
    setStatus('コピーしました', 'success');
  }
});

// =========== グラフ色の自動検出 ===========
/**
 * 画像内で「グラフの色」を自動検出する
 * 戦略: 「白でもグレーでもない、最も多く出現する色」をグラフの色とする
 *
 * 1. 各画素を「白系/灰系/有彩色/黒系」に分類
 * 2. 有彩色 + 黒系の画素について、HSの色相を主成分でクラスタリング
 * 3. 最大クラスタの代表色を返す
 */
function detectGraphColor(px, W, H) {
  // ヒストグラム: 色相(0-359, 1度刻み)に画素数を集計
  // ただし、グレー/白に近いものは除外
  const hueBins = new Int32Array(360);
  let blackCount = 0;
  let blackR = 0, blackG = 0, blackB = 0;

  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const range = max - min;

    // 白に近い (高輝度かつ低彩度) → スキップ
    if (max > 230 && range < 25) continue;
    // 中間グレー (彩度低い) → スキップ
    if (range < 30 && max > 80) continue;

    // 黒系 (全体が暗い)
    if (max < 80) {
      blackCount++;
      blackR += r; blackG += g; blackB += b;
      continue;
    }

    // 色相を計算 (0-359度)
    let hue;
    if (max === min) continue;  // 純グレー
    if (max === r) hue = ((g - b) / range) * 60;
    else if (max === g) hue = ((b - r) / range) * 60 + 120;
    else hue = ((r - g) / range) * 60 + 240;
    if (hue < 0) hue += 360;
    hueBins[Math.floor(hue) % 360]++;
  }

  // 色相ヒストグラムを 10度幅でスムージング
  const smoothBins = new Int32Array(360);
  for (let h = 0; h < 360; h++) {
    let s = 0;
    for (let dh = -5; dh <= 5; dh++) {
      s += hueBins[(h + dh + 360) % 360];
    }
    smoothBins[h] = s;
  }

  // 最大の色相を見つける
  let maxHue = 0, maxCount = 0;
  for (let h = 0; h < 360; h++) {
    if (smoothBins[h] > maxCount) {
      maxCount = smoothBins[h];
      maxHue = h;
    }
  }

  // 黒系画素の方が多い場合は黒をターゲットに
  if (blackCount > maxCount * 1.5) {
    return {
      type: 'black',
      r: blackR / blackCount, g: blackG / blackCount, b: blackB / blackCount,
    };
  }

  // 有彩色: 最大色相 ±15度の画素から代表的なRGBを取得
  let sumR = 0, sumG = 0, sumB = 0, cnt = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const range = max - min;
    if (max > 230 && range < 25) continue;
    if (range < 30 && max > 80) continue;
    if (max < 80) continue;
    if (max === min) continue;

    let hue;
    if (max === r) hue = ((g - b) / range) * 60;
    else if (max === g) hue = ((b - r) / range) * 60 + 120;
    else hue = ((r - g) / range) * 60 + 240;
    if (hue < 0) hue += 360;

    let dh = Math.abs(hue - maxHue);
    if (dh > 180) dh = 360 - dh;
    if (dh <= 15) {
      sumR += r; sumG += g; sumB += b; cnt++;
    }
  }

  return {
    type: 'colored',
    hue: maxHue,
    r: sumR / cnt, g: sumG / cnt, b: sumB / cnt,
  };
}

/**
 * RGB(r,g,b) が targetColor に近いか判定
 */
function isColorSimilar(r, g, b, target) {
  if (target.type === 'black') {
    // 黒系: 全体が暗い
    return Math.max(r, g, b) < 100;
  }
  // 有彩色: 色相が近く、白すぎない
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const range = max - min;
  if (max > 230 && range < 25) return false;  // 白
  if (range < 25) return false;  // グレー
  if (max < 50) return false;  // ほぼ黒

  let hue;
  if (max === min) return false;
  if (max === r) hue = ((g - b) / range) * 60;
  else if (max === g) hue = ((b - r) / range) * 60 + 120;
  else hue = ((r - g) / range) * 60 + 240;
  if (hue < 0) hue += 360;

  let dh = Math.abs(hue - target.hue);
  if (dh > 180) dh = 360 - dh;
  return dh <= 25;  // 色相 ±25度以内
}
