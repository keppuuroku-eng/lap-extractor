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

// =========== STEP 2: 抽出ボタン ===========
document.getElementById('btnExtract').addEventListener('click', () => {
  if (!state.imgEl) {
    setStatus('まず画像を選んでください', 'error');
    return;
  }

  const topValue = parseFloat(document.getElementById('topValue').value);
  const bottomValue = parseFloat(document.getElementById('bottomValue').value);
  const pointCount = parseInt(document.getElementById('pointCount').value, 10);
  const intervalWidth = parseInt(document.getElementById('intervalWidth').value, 10);

  if (!isFinite(topValue) || !isFinite(bottomValue) || topValue >= bottomValue) {
    setStatus('Y軸の値が正しくありません', 'error');
    return;
  }
  if (pointCount < 2 || pointCount > 50) {
    setStatus('点の数を確認してください', 'error');
    return;
  }

  try {
    extractPoints(topValue, bottomValue, pointCount, intervalWidth);
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
function extractPoints(topValue, bottomValue, pointCount, intervalWidth) {
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

  // === 3. erosion を増やしながら、最も多くの「揃った正方形成分」が取れるサイズを探す ===
  let bestEr = 0;
  let bestEroded = mask;
  let bestN = 0;
  for (let er = 0; er <= 10; er++) {
    const eroded = (er === 0) ? mask : erode(mask, W, H, er);
    if (sumMask(eroded) === 0) break;

    const comps = getSquareComponents(eroded, W, H, 5);
    const cluster = getDominantCluster(comps, 0.3);
    if (cluster.length > bestN && cluster.length >= 3) {
      bestN = cluster.length;
      bestEr = er;
      bestEroded = eroded;
    }
  }
  console.log('Best erosion:', bestEr, 'Cluster size:', bestN);

  if (bestN < 2) {
    throw new Error('点が見つかりませんでした (検出数: ' + bestN + ')。画像のトリミングを確認してください');
  }

  // === 4. erosion 後の連結成分の中心を「点」として使う ===
  // 端の点は erosion で消えていることがあるので、元マスクの連結成分で復元する
  const erodedComps = getSquareComponents(bestEroded, W, H, 5);
  // 元マスクのラベル
  const origLabels = labelComponents(mask, W, H);
  const seenOrig = new Set();
  const points = [];
  for (const ec of erodedComps) {
    const cx = Math.round(ec.cx);
    const cy = Math.round(ec.cy);
    const origLabel = origLabels[cy * W + cx];
    if (origLabel === 0 || !seenOrig.has(origLabel)) {
      seenOrig.add(origLabel);
      points.push({ x: ec.cx, y: ec.cy });
    } else {
      // 元マスクの同じ成分内に複数のerosion成分がある場合 (点が線でつながっている場合)
      // → erosion後の中心位置をそのまま採用
      points.push({ x: ec.cx, y: ec.cy });
    }
  }

  console.log('Final points:', points.length);

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

  // 7. Y → 値の変換
  const yTop = state.detected.gridYTop;
  const yBot = state.detected.gridYBottom;
  const yToValue = (y) => topValue + (y - yTop) / (yBot - yTop) * (bottomValue - topValue);

  state.results = selected.map((p, i) => ({
    x: p.x,
    y: p.y,
    start: i * intervalWidth,
    end: (i + 1) * intervalWidth,
    sec: yToValue(p.y),
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
      if (aspect < 0.5 || aspect > 2.0) continue;
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

// =========== 結果描画 ===========
function renderResult() {
  const img = state.imgEl;
  const canvas = document.getElementById('resultCanvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  // 画像サイズに応じてサイズ調整
  const scale = Math.max(1, Math.min(canvas.width, canvas.height) / 400);
  const radius = 10 * scale;
  const fontSize = Math.max(11, Math.round(13 * scale));

  state.results.forEach(p => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = '#EF4444';
    ctx.lineWidth = Math.max(2, 2 * scale);
    ctx.stroke();

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

  const lines = state.results.map(p =>
    `・${p.start}-${p.end}：${p.sec.toFixed(1)}`
  );
  document.getElementById('resultText').value = lines.join('\n');
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
