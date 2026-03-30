/**
 * Blank detection engine — runs YOLO ONNX model via onnxruntime-web.
 * Ported from worksheet-ai.html for offline use in Obsidian.
 */
import * as ort from "onnxruntime-web";

const MODEL_INPUT_SIZE = 1216;
const CLASSES = ["TextBox", "ChoiceButton", "Signature"];
const CONF_THRESH = 0.05;
const IOU_THRESH = 0.45;

export interface BlankBox {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  page: number;
  canvasW: number;
  canvasH: number;
  answer: string;
  type: string;
  mergedHeights: number[];
  lineHeightPx?: number;
  lineCount?: number;
  // Export helpers
  vw?: number;
  vh?: number;
  displayScale?: number;
  dpr?: number;
  id?: number;
}

let modelSession: ort.InferenceSession | null = null;

export async function loadModel(modelPath: string): Promise<ort.InferenceSession> {
  if (modelSession) return modelSession;

  // In Obsidian/Electron we use the WASM backend
  ort.env.wasm.numThreads = 1;

  modelSession = await ort.InferenceSession.create(modelPath, {
    executionProviders: ["wasm"],
  });
  return modelSession;
}

export function disposeModel(): void {
  modelSession = null;
}

interface PreprocessResult {
  tensor: ort.Tensor;
  scale: number;
  dx: number;
  dy: number;
}

function preprocessPage(canvas: HTMLCanvasElement): PreprocessResult {
  const S = MODEL_INPUT_SIZE;
  const oc = document.createElement("canvas");
  oc.width = S;
  oc.height = S;
  const octx = oc.getContext("2d")!;

  // Letterbox: scale to fit, pad with gray (114/255)
  const scale = Math.min(S / canvas.width, S / canvas.height);
  const nw = Math.round(canvas.width * scale);
  const nh = Math.round(canvas.height * scale);
  const dx = Math.round((S - nw) / 2);
  const dy = Math.round((S - nh) / 2);

  octx.fillStyle = "rgb(114,114,114)";
  octx.fillRect(0, 0, S, S);
  octx.drawImage(canvas, dx, dy, nw, nh);

  const imgData = octx.getImageData(0, 0, S, S).data;
  const float32 = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) {
    float32[i] = imgData[i * 4] / 255;
    float32[S * S + i] = imgData[i * 4 + 1] / 255;
    float32[2 * S * S + i] = imgData[i * 4 + 2] / 255;
  }

  return {
    tensor: new ort.Tensor("float32", float32, [1, 3, S, S]),
    scale,
    dx,
    dy,
  };
}

function nms(
  boxes: number[][],
  scores: number[],
  iouThresh: number
): number[] {
  const order = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const keep: number[] = [];
  const suppressed = new Uint8Array(order.length);

  for (let i = 0; i < order.length; i++) {
    if (suppressed[i]) continue;
    const idx = order[i];
    keep.push(idx);
    const [ax1, ay1, ax2, ay2] = boxes[idx];

    for (let j = i + 1; j < order.length; j++) {
      if (suppressed[j]) continue;
      const jdx = order[j];
      const [bx1, by1, bx2, by2] = boxes[jdx];
      const ix1 = Math.max(ax1, bx1),
        iy1 = Math.max(ay1, by1),
        ix2 = Math.min(ax2, bx2),
        iy2 = Math.min(ay2, by2);
      const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
      const union =
        (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter;
      if (inter / union > iouThresh) suppressed[j] = 1;
    }
  }
  return keep;
}

export async function detectBlanks(
  canvas: HTMLCanvasElement,
  pageNum: number,
  modelPath: string
): Promise<BlankBox[]> {
  const session = await loadModel(modelPath);
  const { tensor, scale, dx, dy } = preprocessPage(canvas);
  const results = await session.run({ images: tensor });

  const output = results[Object.keys(results)[0]];
  const data = output.data as Float32Array;
  const dims = output.dims;
  const numPreds = dims[2];
  const numAttrs = dims[1]; // 4 + numClasses
  const numClasses = numAttrs - 4;

  const boxes: number[][] = [];
  const scores: number[] = [];
  const classIds: number[] = [];

  for (let i = 0; i < numPreds; i++) {
    let maxScore = 0,
      maxCls = 0;
    for (let c = 0; c < numClasses; c++) {
      const s = data[(4 + c) * numPreds + i];
      if (s > maxScore) {
        maxScore = s;
        maxCls = c;
      }
    }
    if (maxScore < CONF_THRESH) continue;

    const cx = data[0 * numPreds + i],
      cy = data[1 * numPreds + i];
    const w = data[2 * numPreds + i],
      h = data[3 * numPreds + i];
    const x1 = (cx - w / 2 - dx) / scale,
      y1 = (cy - h / 2 - dy) / scale;
    const x2 = (cx + w / 2 - dx) / scale,
      y2 = (cy + h / 2 - dy) / scale;
    boxes.push([x1, y1, x2, y2]);
    scores.push(maxScore);
    classIds.push(maxCls);
  }

  const keep = nms(boxes, scores, IOU_THRESH);
  const blanks: BlankBox[] = [];

  for (const k of keep) {
    const cls = classIds[k];
    if (cls === 2) continue; // Skip Signature
    const [x1, y1, x2, y2] = boxes[k];
    blanks.push({
      x: x1,
      y: y1,
      width: x2 - x1,
      height: y2 - y1,
      confidence: scores[k],
      page: pageNum,
      canvasW: canvas.width,
      canvasH: canvas.height,
      answer: "",
      type: CLASSES[cls],
      mergedHeights: [y2 - y1],
    });
  }

  // Merge vertically adjacent TextBox detections
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < blanks.length; i++) {
      const a = blanks[i];
      if (a.type !== "TextBox") continue;
      for (let j = i + 1; j < blanks.length; j++) {
        const b = blanks[j];
        if (b.type !== "TextBox") continue;
        const ox1 = Math.max(a.x, b.x),
          ox2 = Math.min(a.x + a.width, b.x + b.width);
        const hOverlap = Math.max(0, ox2 - ox1);
        const minW = Math.min(a.width, b.width);
        if (hOverlap / minW < 0.6) continue;
        const aBot = a.y + a.height,
          bBot = b.y + b.height;
        const vGap = Math.max(a.y, b.y) - Math.min(aBot, bBot);
        const smallerH = Math.min(a.height, b.height);
        if (vGap > smallerH * 0.2) continue;
        a.x = Math.min(a.x, b.x);
        a.y = Math.min(a.y, b.y);
        const newX2 = Math.max(a.x + a.width, b.x + b.width);
        const newY2 = Math.max(aBot, bBot);
        a.width = newX2 - a.x;
        a.height = newY2 - a.y;
        a.confidence = Math.max(a.confidence, b.confidence);
        a.mergedHeights = (a.mergedHeights || []).concat(
          b.mergedHeights || [b.height]
        );
        blanks.splice(j, 1);
        merged = true;
        break;
      }
      if (merged) break;
    }
  }

  // Filter out wrapper boxes containing many smaller boxes
  for (let i = blanks.length - 1; i >= 0; i--) {
    const a = blanks[i];
    let contained = 0;
    for (let j = 0; j < blanks.length; j++) {
      if (i === j) continue;
      const b = blanks[j];
      const cx = b.x + b.width / 2,
        cy = b.y + b.height / 2;
      if (cx > a.x && cx < a.x + a.width && cy > a.y && cy < a.y + a.height)
        contained++;
    }
    if (contained >= 2) blanks.splice(i, 1);
  }

  blanks.sort((a, b) => a.y - b.y || a.x - b.x);
  tensor.dispose();
  return blanks;
}

/**
 * Find enclosing box from a click point by scanning for borders.
 */
export function findEnclosingBox(
  canvas: HTMLCanvasElement,
  cx: number,
  cy: number
): { x: number; y: number; width: number; height: number } | null {
  const w = canvas.width,
    h = canvas.height;
  const ctx = canvas.getContext("2d")!;
  const imgData = ctx.getImageData(0, 0, w, h).data;
  const darkThresh = 180;

  function isDark(x: number, y: number): boolean {
    if (x < 0 || x >= w || y < 0 || y >= h) return true;
    const i = (y * w + x) * 4;
    return (imgData[i] + imgData[i + 1] + imgData[i + 2]) / 3 < darkThresh;
  }

  const bandSize = 3;
  function scanDir(
    startX: number,
    startY: number,
    ddx: number,
    ddy: number,
    maxDist: number
  ): number {
    for (let d = 1; d < maxDist; d++) {
      const x = startX + ddx * d,
        y = startY + ddy * d;
      if (x < 0 || x >= w || y < 0 || y >= h) return d;
      let darkCount = 0;
      for (let b = -bandSize; b <= bandSize; b++) {
        const bx = x + (ddy !== 0 ? b : 0),
          by = y + (ddx !== 0 ? b : 0);
        if (isDark(bx, by)) darkCount++;
      }
      if (darkCount >= bandSize) return d;
    }
    return maxDist;
  }

  const maxScan = Math.max(w, h);
  const distUp = scanDir(cx, cy, 0, -1, maxScan);
  const distDown = scanDir(cx, cy, 0, 1, maxScan);
  const distLeft = scanDir(cx, cy, -1, 0, maxScan);
  const distRight = scanDir(cx, cy, 1, 0, maxScan);

  const x1 = cx - distLeft + 1,
    y1 = cy - distUp + 1;
  const x2 = cx + distRight - 1,
    y2 = cy + distDown - 1;
  const bw = x2 - x1,
    bh = y2 - y1;

  if (bw < 15 || bh < 15) return null;
  if (bw > w * 0.9 && bh > h * 0.9) return null;
  return { x: x1, y: y1, width: bw, height: bh };
}
