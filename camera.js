/*
 * AI人数管理システム camera.js
 * 修正版
 *
 * 修正ポイント
 * 1. カメラ表示とAI座標の変換を統一
 * 2. 人物追跡を強化（予測位置・動的距離・一時的な検出欠落に対応）
 * 3. A→B→C の入室を安定化
 * 4. C→B→A / C→A の退出を安定化
 * 5. 境界付近のゾーン判定を数フレーム確認
 * 6. 同じ人の二重カウントを防止
 * 7. Firebaseへの送信を間引き
 * 8. people/reset を監視してリモートリセット対応
 *
 * Firebase側で camera.html が以下を用意している想定:
 * window.firebaseDB
 * window.firebaseRef
 * window.firebaseSet
 * window.firebaseOnValue
 * window.firebaseReady
 *
 * データ:
 * people/current
 * people/reset
 */

let video;
let model = null;
let modelReady = false;
let cameraReady = false;
let detecting = false;

const CAMERA_W = 1280;
const CAMERA_H = 720;

// AI判定
const PERSON_CONFIDENCE = 0.45;

// 人物追跡
const MATCH_DISTANCE = 260;
const MAX_MATCH_DISTANCE = 420;
const TRACK_TIMEOUT = 9000;
const MAX_MISSED_FRAMES = 45;

// ゾーン判定
const ZONE_A_END = 0.33;
const ZONE_B_END = 0.66;
const ZONE_CONFIRM_FRAMES = 2;

// 検出間隔
const DETECT_INTERVAL = 100;
let lastDetectTime = 0;

// Firebase送信
const FIREBASE_SEND_INTERVAL = 350;
let lastFirebaseSendTime = 0;
let firebaseSendQueued = false;

// カウント
let currentPeopleCount = 0;
let enteredCount = 0;
let exitedCount = 0;

// 表示用
let predictions = [];
let tracks = [];
let nextTrackId = 1;

let lastResetTime = 0;
let lastPayload = "";

function setup() {
  const canvas = createCanvas(CAMERA_W, CAMERA_H);
  canvas.parent("app");

  textFont("sans-serif");

  video = createCapture(
    {
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: CAMERA_W },
        height: { ideal: CAMERA_H }
      },
      audio: false
    },
    () => {
      cameraReady = true;
      console.log("カメラ準備完了");
      startModel();
    }
  );

  video.size(CAMERA_W, CAMERA_H);
  video.hide();

  // Firebaseの準備を待つ
  waitForFirebase();
}

async function startModel() {
  try {
    console.log("COCO-SSD読み込み中...");
    model = await cocoSsd.load();
    modelReady = true;
    console.log("COCO-SSD準備完了");
  } catch (error) {
    console.error("モデル読み込み失敗:", error);
  }
}

function draw() {
  background(0);

  if (cameraReady && video) {
    drawCamera();
  } else {
    drawMessage("カメラ準備中...");
  }

  drawZones();
  drawPersonBoxes();
  drawStatus();

  const now = performance.now();

  if (
    cameraReady &&
    modelReady &&
    model &&
    !detecting &&
    now - lastDetectTime >= DETECT_INTERVAL
  ) {
    lastDetectTime = now;
    detectPeople();
  }

  // Firebaseの接続待ち・リセット監視
  setupFirebaseHooks();
}

/* =========================================================
 * カメラ表示
 * ========================================================= */

function getCameraTransform() {
  if (!video || !video.elt || !video.elt.videoWidth || !video.elt.videoHeight) {
    return {
      scaleX: width / CAMERA_W,
      scaleY: height / CAMERA_H,
      offsetX: 0,
      offsetY: 0,
      videoWidth: CAMERA_W,
      videoHeight: CAMERA_H
    };
  }

  const videoWidth = video.elt.videoWidth;
  const videoHeight = video.elt.videoHeight;

  const videoRatio = videoWidth / videoHeight;
  const canvasRatio = width / height;

  let drawWidth;
  let drawHeight;
  let offsetX;
  let offsetY;

  // drawCamera() とAI枠描画で同じ変換を使う
  if (videoRatio > canvasRatio) {
    drawHeight = height;
    drawWidth = height * videoRatio;
    offsetX = (width - drawWidth) / 2;
    offsetY = 0;
  } else {
    drawWidth = width;
    drawHeight = width / videoRatio;
    offsetX = 0;
    offsetY = (height - drawHeight) / 2;
  }

  return {
    scaleX: drawWidth / videoWidth,
    scaleY: drawHeight / videoHeight,
    offsetX,
    offsetY,
    videoWidth,
    videoHeight
  };
}

function drawCamera() {
  const t = getCameraTransform();

  image(
    video,
    t.offsetX,
    t.offsetY,
    width - t.offsetX * 2,
    height - t.offsetY * 2
  );
}

/*
 * AIのvideo座標 → 画面座標
 */
function videoToCanvas(x, y) {
  const t = getCameraTransform();

  return {
    x: x * t.scaleX + t.offsetX,
    y: y * t.scaleY + t.offsetY
  };
}

/*
 * 画面座標 → AI/video座標
 */
function canvasToVideo(x, y) {
  const t = getCameraTransform();

  return {
    x: (x - t.offsetX) / t.scaleX,
    y: (y - t.offsetY) / t.scaleY
  };
}

/* =========================================================
 * AI検出
 * ========================================================= */

async function detectPeople() {
  if (!model || !video || !video.elt || detecting) return;

  detecting = true;

  try {
    const result = await model.detect(video.elt);

    const persons = result.filter(
      p => p.class === "person" && p.score >= PERSON_CONFIDENCE
    );

    predictions = persons;

    updateTracks(persons);
  } catch (error) {
    console.error("人物検出エラー:", error);
  } finally {
    detecting = false;
  }
}

/* =========================================================
 * トラッキング
 * ========================================================= */

function createPersonTrack(detection, zone) {
  const [x, y, w, h] = detection.bbox;

  return {
    id: nextTrackId++,

    x,
    y,
    w,
    h,

    centerX: x + w / 2,
    centerY: y + h / 2,

    prevCenterX: x + w / 2,
    prevCenterY: y + h / 2,

    velocityX: 0,
    velocityY: 0,

    lastSeen: Date.now(),
    missedFrames: 0,

    currentZone: zone,
    previousZone: zone,

    pendingZone: zone,
    pendingZoneFrames: 0,

    inside: false,

    // 入室: A → B → C
    entryProgress: zone === "A" ? 1 : 0,

    // 退出:
    // Cを通過したらpassedC=true
    // その後Aへ到達したら退出
    passedC: zone === "C",
    exitState: zone === "C" ? 1 : 0,

    exitCounted: false,

    // 直近のカウント時刻
    lastCountTime: 0,

    // 追跡安定化
    age: 1,
    matchedThisFrame: true
  };
}

function getTrackPredictedPosition(track) {
  const elapsed = Math.min(
    (Date.now() - track.lastSeen) / 1000,
    1.5
  );

  return {
    x: track.centerX + track.velocityX * elapsed,
    y: track.centerY + track.velocityY * elapsed
  };
}

function getDistance(aX, aY, bX, bY) {
  return Math.hypot(aX - bX, aY - bY);
}

function getDynamicMatchDistance(track, detection) {
  const [, , w, h] = detection.bbox;

  // 人物サイズが大きいほど画面上の移動差も大きくなる
  const personSize = Math.max(w, h);

  const dynamicDistance =
    MATCH_DISTANCE +
    personSize * 0.45 +
    Math.min(track.missedFrames, 10) * 18;

  return Math.min(dynamicDistance, MAX_MATCH_DISTANCE);
}

function updateTracks(detections) {
  const now = Date.now();

  for (const track of tracks) {
    track.matchedThisFrame = false;
  }

  const candidates = [];

  for (let di = 0; di < detections.length; di++) {
    const detection = detections[di];
    const [x, y, w, h] = detection.bbox;

    const centerX = x + w / 2;
    const centerY = y + h / 2;

    for (let ti = 0; ti < tracks.length; ti++) {
      const track = tracks[ti];

      if (track.matchedThisFrame) continue;

      const predicted = getTrackPredictedPosition(track);
      const distance = getDistance(
        centerX,
        centerY,
        predicted.x,
        predicted.y
      );

      const limit = getDynamicMatchDistance(track, detection);

      if (distance <= limit) {
        candidates.push({
          detectionIndex: di,
          trackIndex: ti,
          distance
        });
      }
    }
  }

  // 近い組み合わせから確定
  candidates.sort((a, b) => a.distance - b.distance);

  const matchedDetections = new Set();
  const matchedTracks = new Set();

  for (const candidate of candidates) {
    if (
      matchedDetections.has(candidate.detectionIndex) ||
      matchedTracks.has(candidate.trackIndex)
    ) {
      continue;
    }

    const detection = detections[candidate.detectionIndex];
    const track = tracks[candidate.trackIndex];

    updateExistingTrack(track, detection, now);

    matchedDetections.add(candidate.detectionIndex);
    matchedTracks.add(candidate.trackIndex);
  }

  // マッチしなかった検出は新しいtrack
  for (let i = 0; i < detections.length; i++) {
    if (matchedDetections.has(i)) continue;

    const detection = detections[i];
    const zone = getZoneFromDetection(detection);

    const track = createPersonTrack(detection, zone);
    tracks.push(track);
  }

  // 一時的に検出が消えた人をすぐ削除しない
  for (const track of tracks) {
    if (!matchedTracks.has(tracks.indexOf(track))) {
      track.missedFrames++;
    }
  }

  // 古すぎるtrackだけ削除
  tracks = tracks.filter(track => {
    const elapsed = now - track.lastSeen;

    return (
      elapsed < TRACK_TIMEOUT &&
      track.missedFrames <= MAX_MISSED_FRAMES
    );
  });
}

function updateExistingTrack(track, detection, now) {
  const [x, y, w, h] = detection.bbox;

  const newCenterX = x + w / 2;
  const newCenterY = y + h / 2;

  const dt = Math.max(
    (now - track.lastSeen) / 1000,
    0.05
  );

  const rawVX = (newCenterX - track.centerX) / dt;
  const rawVY = (newCenterY - track.centerY) / dt;

  // 急激なノイズを抑える
  track.velocityX =
    track.velocityX * 0.65 + rawVX * 0.35;

  track.velocityY =
    track.velocityY * 0.65 + rawVY * 0.35;

  track.prevCenterX = track.centerX;
  track.prevCenterY = track.centerY;

  track.x = x;
  track.y = y;
  track.w = w;
  track.h = h;

  track.centerX = newCenterX;
  track.centerY = newCenterY;

  track.lastSeen = now;
  track.missedFrames = 0;
  track.age++;
  track.matchedThisFrame = true;

  const newZone = getZoneFromX(track.centerX);

  updateStableZone(track, newZone);
}

/* =========================================================
 * ゾーン
 * ========================================================= */

function getZoneFromX(x) {
  const videoWidth =
    video && video.elt && video.elt.videoWidth
      ? video.elt.videoWidth
      : CAMERA_W;

  const ratio = x / videoWidth;

  if (ratio < ZONE_A_END) return "A";
  if (ratio < ZONE_B_END) return "B";
  return "C";
}

function getZoneFromDetection(detection) {
  const [x, , w] = detection.bbox;
  return getZoneFromX(x + w / 2);
}

function updateStableZone(track, newZone) {
  if (newZone === track.currentZone) {
    track.pendingZone = newZone;
    track.pendingZoneFrames = 0;
    return;
  }

  if (newZone !== track.pendingZone) {
    track.pendingZone = newZone;
    track.pendingZoneFrames = 1;
    return;
  }

  track.pendingZoneFrames++;

  if (track.pendingZoneFrames >= ZONE_CONFIRM_FRAMES) {
    const oldZone = track.currentZone;

    track.previousZone = oldZone;
    track.currentZone = newZone;
    track.pendingZoneFrames = 0;

    handleZoneTransition(track, oldZone, newZone);
  }
}

function handleZoneTransition(track, oldZone, newZone) {
  console.log(
    `ID ${track.id}: ${oldZone} → ${newZone}`,
    "inside=", track.inside,
    "entry=", track.entryProgress,
    "passedC=", track.passedC
  );

  checkEntry(track, oldZone, newZone);
  checkExit(track, oldZone, newZone);
}

/* =========================================================
 * 入室
 * ========================================================= */

function checkEntry(track, oldZone, newZone) {
  // すでに中にいる人は入室処理しない
  if (track.inside) return;

  // Aに入った
  if (newZone === "A") {
    track.entryProgress = 1;
    return;
  }

  // A → B
  if (
    track.entryProgress === 1 &&
    newZone === "B"
  ) {
    track.entryProgress = 2;
    return;
  }

  // B → C で入室
  if (
    track.entryProgress >= 2 &&
    newZone === "C"
  ) {
    executeEntry(track);
    return;
  }

  // 逆方向・やり直し
  if (newZone === "A") {
    track.entryProgress = 1;
  }
}

function executeEntry(track) {
  if (track.inside) return;

  track.inside = true;
  track.entryProgress = 0;
  track.passedC = false;
  track.exitState = 0;
  track.exitCounted = false;
  track.lastCountTime = Date.now();

  enteredCount++;
  currentPeopleCount++;

  console.log(
    `入室カウント ID=${track.id}`,
    "現在人数=", currentPeopleCount
  );

  queueFirebaseSend();
}

/* =========================================================
 * 退出
 * ========================================================= */

function checkExit(track, oldZone, newZone) {
  // 中にいる人だけ退出候補
  if (!track.inside) return;

  // Cに到達したら退出ルート開始
  if (newZone === "C") {
    track.passedC = true;
    track.exitState = 1;
    return;
  }

  // C → B
  if (
    track.passedC &&
    oldZone === "C" &&
    newZone === "B"
  ) {
    track.exitState = 2;
    return;
  }

  // C → A
  if (
    track.passedC &&
    newZone === "A"
  ) {
    executeExit(track);
    return;
  }

  // Cを通過したあとBからAへ
  if (
    track.passedC &&
    track.exitState >= 2 &&
    newZone === "A"
  ) {
    executeExit(track);
    return;
  }
}

function executeExit(track) {
  if (!track.inside) return;
  if (track.exitCounted) return;

  track.exitCounted = true;

  exitedCount++;

  currentPeopleCount = Math.max(
    0,
    currentPeopleCount - 1
  );

  track.inside = false;
  track.passedC = false;
  track.exitState = 0;
  track.entryProgress = 0;
  track.lastCountTime = Date.now();

  console.log(
    `退出カウント ID=${track.id}`,
    "現在人数=", currentPeopleCount
  );

  queueFirebaseSend();
}

/* =========================================================
 * Firebase
 * ========================================================= */

let firebaseHooksReady = false;

function waitForFirebase() {
  setupFirebaseHooks();
}

function setupFirebaseHooks() {
  if (firebaseHooksReady) return;

  if (
    window.firebaseDB &&
    window.firebaseRef &&
    window.firebaseOnValue
  ) {
    firebaseHooksReady = true;

    setupResetListener();

    console.log("Firebase hooks 準備完了");

    queueFirebaseSend();
  }
}

function setupResetListener() {
  if (
    !window.firebaseDB ||
    !window.firebaseRef ||
    !window.firebaseOnValue
  ) {
    return;
  }

  try {
    const resetRef =
      window.firebaseRef(
        window.firebaseDB,
        "people/reset"
      );

    window.firebaseOnValue(
      resetRef,
      snapshot => {
        const data = snapshot.val();

        if (!data) return;

        const resetTime = Number(
          data.time || data.resetAt || 0
        );

        if (
          data.command === "reset" &&
          resetTime > lastResetTime
        ) {
          console.log(
            "Firebaseからリセット命令を受信",
            data
          );

          lastResetTime = resetTime;
          resetSystem(resetTime);
        }
      }
    );
  } catch (error) {
    console.error(
      "Firebase reset listener error:",
      error
    );
  }
}

function queueFirebaseSend() {
  const now = Date.now();

  if (
    now - lastFirebaseSendTime >=
    FIREBASE_SEND_INTERVAL
  ) {
    sendPeopleData();
    return;
  }

  if (firebaseSendQueued) return;

  firebaseSendQueued = true;

  setTimeout(() => {
    firebaseSendQueued = false;
    sendPeopleData();
  }, FIREBASE_SEND_INTERVAL);
}

function buildPeoplePayload() {
  return {
    peopleCount: currentPeopleCount,
    visiblePeopleCount: tracks.filter(
      t => t.missedFrames <= 2
    ).length,
    enteredCount,
    exitedCount,

    cameraReady,
    modelReady,

    camera: "tablet",
    orientation: "horizontal-ABC",

    updatedAt: Date.now()
  };
}

function sendPeopleData() {
  if (
    !window.firebaseDB ||
    !window.firebaseRef ||
    !window.firebaseSet
  ) {
    return;
  }

  const now = Date.now();

  if (
    now - lastFirebaseSendTime <
    FIREBASE_SEND_INTERVAL
  ) {
    return;
  }

  const payload = buildPeoplePayload();
  const serialized = JSON.stringify(payload);

  // 変化がない場合は無駄な書き込みをしない
  if (serialized === lastPayload) {
    return;
  }

  lastPayload = serialized;
  lastFirebaseSendTime = now;

  try {
    const currentRef =
      window.firebaseRef(
        window.firebaseDB,
        "people/current"
      );

    window.firebaseSet(
      currentRef,
      payload
    ).catch(error => {
      console.error(
        "Firebase送信失敗:",
        error
      );
    });
  } catch (error) {
    console.error(
      "Firebase送信エラー:",
      error
    );
  }
}

/* =========================================================
 * リセット
 * ========================================================= */

function resetSystem(resetTime = Date.now()) {
  console.log("システムリセット");

  currentPeopleCount = 0;
  enteredCount = 0;
  exitedCount = 0;

  predictions = [];
  tracks = [];

  nextTrackId = 1;
  lastResetTime = resetTime;

  lastPayload = "";

  queueFirebaseSend();
}

/*
 * HTMLのボタンからも呼べるようにする
 */
window.resetSystem = resetSystem;

/* =========================================================
 * 描画
 * ========================================================= */

function drawZones() {
  const aEnd = width * ZONE_A_END;
  const bEnd = width * ZONE_B_END;

  stroke(255);
  strokeWeight(3);
  line(aEnd, 0, aEnd, height);
  line(bEnd, 0, bEnd, height);

  noStroke();

  fill(255);
  textSize(30);
  textAlign(CENTER, TOP);

  text("A", aEnd / 2, 20);
  text("B", (aEnd + bEnd) / 2, 20);
  text("C", (bEnd + width) / 2, 20);
}

function drawPersonBoxes() {
  for (const track of tracks) {
    // 一時的に消えた人も短時間は予測位置を表示
    let boxX = track.x;
    let boxY = track.y;

    if (track.missedFrames > 0) {
      const predicted =
        getTrackPredictedPosition(track);

      boxX =
        predicted.x - track.w / 2;
      boxY =
        predicted.y - track.h / 2;
    }

    const topLeft =
      videoToCanvas(boxX, boxY);

    const bottomRight =
      videoToCanvas(
        boxX + track.w,
        boxY + track.h
      );

    const drawW =
      bottomRight.x - topLeft.x;

    const drawH =
      bottomRight.y - topLeft.y;

    strokeWeight(4);
    stroke(
      track.inside
        ? 80
        : 80,
      track.inside
        ? 255
        : 255,
      80
    );
    noFill();

    rect(
      topLeft.x,
      topLeft.y,
      drawW,
      drawH
    );

    noStroke();
    fill(0, 180);
    rect(
      topLeft.x,
      Math.max(0, topLeft.y - 42),
      190,
      40
    );

    fill(255);
    textAlign(LEFT, CENTER);
    textSize(20);

    const state =
      track.inside
        ? "IN"
        : "WAIT";

    text(
      `ID:${track.id}  ${track.currentZone}  ${state}`,
      topLeft.x + 8,
      Math.max(20, topLeft.y - 22)
    );

    // デバッグ情報
    fill(255);
    textSize(15);

    text(
      `miss:${track.missedFrames} C:${track.passedC ? "Y" : "N"}`,
      topLeft.x + 8,
      topLeft.y + drawH + 18
    );
  }
}

function drawStatus() {
  noStroke();

  fill(0, 170);
  rect(15, height - 125, 390, 110);

  fill(255);
  textAlign(LEFT, TOP);
  textSize(24);

  text(
    `現在人数: ${currentPeopleCount}`,
    30,
    height - 112
  );

  textSize(18);

  text(
    `入室: ${enteredCount}   退出: ${exitedCount}`,
    30,
    height - 78
  );

  text(
    `AI: ${modelReady ? "OK" : "読み込み中"}  ` +
    `Camera: ${cameraReady ? "OK" : "待機中"}  ` +
    `Firebase: ${window.firebaseDB ? "OK" : "待機中"}`,
    30,
    height - 48
  );
}

function drawMessage(message) {
  fill(255);
  textAlign(CENTER, CENTER);
  textSize(32);
  text(message, width / 2, height / 2);
}

/* =========================================================
 * キーボード操作
 * ========================================================= */

function keyPressed() {
  // Rキーでローカルリセット
  if (
    key === "r" ||
    key === "R"
  ) {
    resetSystem();
  }
}
