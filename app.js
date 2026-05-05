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
  const threshold = W * 0.5;  // 幅の半分以上が灰色なら水平線
  const candidateRows = [];
  for (let y = 0; y < H; y++) {
    let count = 0;
    const off = y * W * 4;
    for (let x = 0; x < W; x++) {
      const i = off + x * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      if (r >= 200 && r <= 245 &&
          Math.abs(r - g) < 10 && Math.abs(g - b) < 10) {
        count++;
      }
    }
    if (count > threshold) candidateRows.push(y);
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

  // 1. 青色マスク
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      if (b > 150 && r < 200 && g > 130 && g < 220 && b > r + 20) {
        mask[y * W + x] = 1;
      }
    }
  }

  // 2. 縦8px以上連続のみ残す (線除去)
  const filt = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    let y = 0;
    while (y < H) {
      if (mask[y * W + x]) {
        const start = y;
        while (y < H && mask[y * W + x]) y++;
        if (y - start >= 8) {
          for (let yy = start; yy < y; yy++) filt[yy * W + x] = 1;
        }
      } else y++;
    }
  }

  // 3. 横6px以上連続のみ残す (細い縦線除去)
  const filt2 = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let x = 0;
    const off = y * W;
    while (x < W) {
      if (filt[off + x]) {
        const start = x;
        while (x < W && filt[off + x]) x++;
        if (x - start >= 6) {
          for (let xx = start; xx < x; xx++) filt2[off + xx] = 1;
        }
      } else x++;
    }
  }

  // 4. 連結成分分析 (BFS)
  const visited = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  const components = [];

  for (let sy = 0; sy < H; sy++) {
    for (let sx = 0; sx < W; sx++) {
      const sIdx = sy * W + sx;
      if (!filt2[sIdx] || visited[sIdx]) continue;

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

        if (x > 0 && filt2[idx-1] && !visited[idx-1]) { visited[idx-1] = 1; queue[tail++] = idx-1; }
        if (x < W-1 && filt2[idx+1] && !visited[idx+1]) { visited[idx+1] = 1; queue[tail++] = idx+1; }
        if (y > 0 && filt2[idx-W] && !visited[idx-W]) { visited[idx-W] = 1; queue[tail++] = idx-W; }
        if (y < H-1 && filt2[idx+W] && !visited[idx+W]) { visited[idx+W] = 1; queue[tail++] = idx+W; }
      }

      components.push({
        cx: sumX / count, cy: sumY / count,
        count,
        w: maxX - minX + 1, h: maxY - minY + 1,
      });
    }
  }

  // 5. 「点」だけ抽出
  // 画像サイズが異なっても対応できるようにスケーラブルなフィルタ
  // 標準サイズ前提: 幅・高さが 8-30px、画素数 30-600
  const points = components.filter(c =>
    c.w >= 8 && c.w <= 30 &&
    c.h >= 8 && c.h <= 30 &&
    c.count >= 30 && c.count <= 600
  ).map(c => ({ x: c.cx, y: c.cy }));

  if (points.length < 2) {
    throw new Error('点が見つかりませんでした (検出数: ' + points.length + ')。画像のトリミングを確認してください');
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

// =========== 結果描画 ===========
function renderResult() {
  const img = state.imgEl;
  const canvas = document.getElementById('resultCanvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  state.results.forEach(p => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
    ctx.strokeStyle = '#EF4444';
    ctx.lineWidth = 3;
    ctx.stroke();

    const label = p.sec.toFixed(1);
    ctx.font = 'bold 14px sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(p.x - tw/2 - 4, p.y - 32, tw + 8, 18);
    ctx.fillStyle = '#1F2937';
    ctx.textAlign = 'center';
    ctx.fillText(label, p.x, p.y - 18);
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
