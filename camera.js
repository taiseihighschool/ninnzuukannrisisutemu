/*
============================================================
camera.js 完成版
AIカメラ 人数管理システム
============================================================

前提
・p5.js
・TensorFlow.js
・COCO-SSD
・camera.html からこのファイルを読み込む

カメラ画像
  A = 左
  B = 中央
  C = 右

入室
  A → B → C

退出
  C → B → A
  C → A
  ※Bを一瞬しか検出できなくてもAまで戻れば退出

重要な改善
・AIが一瞬人を見失ってもtrackを保持
・trackの速度を0で初期化してNaNを防止
・予測位置で人物IDを追跡
・ゾーン境界の揺れを2フレーム確認
・入室済みの人だけ退出対象
・同じ人物の二重退出を防止
・カメラの実際の描画幅からA/B/Cを計算
・Firebaseは既存の sendPeopleData() があれば自動利用
・FirebaseがなくてもlocalStorageで動作確認可能

Firebaseを使っている場合
既存のFirebase設定を壊さないため、このファイルでは
Firebaseの初期化そのものは行わない。
現在のプロジェクトに sendPeopleData() がある場合は
入室・退出時に自動で呼び出す。

============================================================
*/

// ============================================================
// 基本設定
// ============================================================

const CAMERA_W = 960;
const CAMERA_H = 720;

const PERSON_SCORE = 0.50;

// 人物track
const TRACK_TIMEOUT = 12000;
const MATCH_DISTANCE = 420;
const MAX_MISSED_FRAMES = 18;

// ゾーン変更を連続確認するフレーム数
const ZONE_CONFIRM_FRAMES = 2;

// AI検出間隔
const DETECT_INTERVAL = 120;

// ============================================================
// グローバル変数
// ============================================================

let video;
let model;

let cameraReady = false;
let modelReady = false;
let detecting = false;
let lastDetectTime = 0;

let detections = [];
let tracks = [];
let nextTrackId = 1;

// 人数
let currentPeopleCount = 0;
let enteredCount = 0;
let exitedCount = 0;

// 画面サイズ
let drawW = CAMERA_W;
let drawH = CAMERA_H;

// ステータス
let statusMessage = "カメラを準備しています…";

// ============================================================
// p5.js setup
// ============================================================

function setup() {
  createCanvas(CAMERA_W, CAMERA_H);

  // p5のビデオ表示はcanvasへ直接描画する
  video = createCapture({
    video: {
      facingMode: {
        ideal: "environment"
      },
      width: {
        ideal: CAMERA_W
      },
      height: {
        ideal: CAMERA_H
      }
    },
    audio: false
  }, () => {
    cameraReady = true;
    statusMessage = "カメラOK / AIを読み込んでいます…";
    console.log("Camera ready");
  });

  video.size(CAMERA_W, CAMERA_H);
  video.hide();

  loadPeopleCount();

  loadModel();

  // 既存ページにリセットボタンがある場合にも対応
  setupResetButton();

  // 既存Firebase送信関数が後から定義されても問題ない
  window.addEventListener("beforeunload", () => {
    savePeopleCount();
  });
}

// ============================================================
// COCO-SSD読み込み
// ============================================================

async function loadModel() {
  try {
    statusMessage = "COCO-SSDを読み込んでいます…";

    if (typeof cocoSsd === "undefined") {
      throw new Error(
        "COCO-SSDが読み込まれていません。camera.htmlのscriptタグを確認してください。"
      );
    }

    model = await cocoSsd.load();

    modelReady = true;
    statusMessage = "AI準備完了";

    console.log("COCO-SSD loaded");

  } catch (error) {
    console.error("COCO-SSD load error:", error);
    statusMessage = "AI読み込みエラー";
  }
}

// ============================================================
// p5.js draw
// ============================================================

function draw() {
  background(20);

  // ----------------------------------------------------------
  // カメラ映像
  // ----------------------------------------------------------

  if (video && video.elt && video.elt.readyState >= 2) {
    image(video, 0, 0, width, height);
  } else {
    fill(255);
    textAlign(CENTER, CENTER);
    textSize(28);
    text("カメラ起動中…", width / 2, height / 2);
  }

  drawW = width;
  drawH = height;

  // ----------------------------------------------------------
  // A / B / C ゾーン
  // ----------------------------------------------------------

  drawZones();

  // ----------------------------------------------------------
  // AI検出
  // ----------------------------------------------------------

  if (
    modelReady &&
    video &&
    video.elt &&
    video.elt.readyState >= 2 &&
    millis() - lastDetectTime >= DETECT_INTERVAL &&
    !detecting
  ) {
    lastDetectTime = millis();
    runDetection();
  }

  // ----------------------------------------------------------
  // track表示
  // ----------------------------------------------------------

  drawTracks();

  // ----------------------------------------------------------
  // 上部情報
  // ----------------------------------------------------------

  drawInfo();
}

// ============================================================
// A/B/Cゾーン描画
// A = 左
// B = 中央
// C = 右
// ============================================================

function drawZones() {
  const zoneW = drawW / 3;

  // 境界線
  stroke(255, 220);
  strokeWeight(3);

  line(zoneW, 0, zoneW, drawH);
  line(zoneW * 2, 0, zoneW * 2, drawH);

  noStroke();

  // ゾーン名
  fill(255, 255, 255, 180);
  textAlign(CENTER, TOP);
  textSize(30);

  text("A", zoneW / 2, 15);
  text("B", zoneW * 1.5, 15);
  text("C", zoneW * 2.5, 15);

  fill(255, 255, 255, 130);
  textSize(15);

  text("← 入室側", zoneW / 2, 52);
  text("中央", zoneW * 1.5, 52);
  text("退出側 →", zoneW * 2.5, 52);
}

// ============================================================
// AI人物検出
// ============================================================

async function runDetection() {
  if (!model || !video || !video.elt) {
    return;
  }

  detecting = true;

  try {
    const results = await model.detect(video.elt);

    // personだけ
    const people = results.filter((item) => {
      return (
        item.class === "person" &&
        Number(item.score) >= PERSON_SCORE
      );
    });

    detections = people.map((item) => {
      const [x, y, w, h] = item.bbox;

      // 人物の中心点
      const cx = x + w / 2;
      const cy = y + h / 2;

      return {
        x: cx,
        y: cy,
        w,
        h,
        score: item.score,
        prediction: item
      };
    });

    updateTracks(detections);

  } catch (error) {
    console.error("Detection error:", error);
  }

  detecting = false;
}

// ============================================================
// ゾーン判定
// カメラ画像の実際のwidthを使用
// ============================================================

function getZone(x) {
  const zoneW = drawW / 3;

  if (x < zoneW) {
    return "A";
  }

  if (x < zoneW * 2) {
    return "B";
  }

  return "C";
}

// ============================================================
// 新しい人物track
// ============================================================

function createPersonTrack(detection, initialZone) {
  return {
    id: nextTrackId++,

    x: Number(detection.x) || 0,
    y: Number(detection.y) || 0,

    // ★重要
    // 新規trackでは必ず0
    velocityX: 0,
    velocityY: 0,

    lastSeen: Date.now(),
    missedFrames: 0,

    prediction: detection.prediction,

    currentZone: initialZone,

    pendingZone: initialZone,
    pendingZoneFrames: 0,

    zoneHistory: [initialZone],

    // --------------------------
    // 入室状態
    // --------------------------

    inside: false,
    entryProgress: 0,

    // --------------------------
    // 退出状態
    // --------------------------

    exitState: 0,
    passedC: false,
    exitCounted: false,

    lastCountTime: 0
  };
}

// ============================================================
// 予測位置
// ============================================================

function getPredictedPosition(track) {
  const vx = Number(track.velocityX) || 0;
  const vy = Number(track.velocityY) || 0;
  const missed = Number(track.missedFrames) || 0;

  const frames = Math.min(missed + 1, 4);

  return {
    x: (Number(track.x) || 0) + vx * frames,
    y: (Number(track.y) || 0) + vy * frames
  };
}

// ============================================================
// trackと検出結果の距離
// ============================================================

function getTrackDistance(track, detection) {
  const predicted = getPredictedPosition(track);

  const dx = detection.x - predicted.x;
  const dy = detection.y - predicted.y;

  return Math.sqrt(dx * dx + dy * dy);
}

// ============================================================
// track更新
// ============================================================

function updateTrackPosition(track, detection) {
  const oldX = Number(track.x);
  const oldY = Number(track.y);

  track.velocityX =
    Number.isFinite(oldX)
      ? detection.x - oldX
      : 0;

  track.velocityY =
    Number.isFinite(oldY)
      ? detection.y - oldY
      : 0;

  track.x = detection.x;
  track.y = detection.y;

  track.lastSeen = Date.now();
  track.missedFrames = 0;
  track.prediction = detection.prediction;
}

// ============================================================
// 全track更新
// ============================================================

function updateTracks(people) {
  const matchedTrackIds = new Set();

  // ------------------------------------------
  // 検出された人物を既存trackに割り当てる
  // ------------------------------------------

  const usedTrackIds = new Set();

  for (const detection of people) {
    let bestTrack = null;
    let bestDistance = Infinity;

    for (const track of tracks) {
      if (usedTrackIds.has(track.id)) {
        continue;
      }

      const distance = getTrackDistance(track, detection);

      if (
        distance < bestDistance &&
        distance <= MATCH_DISTANCE
      ) {
        bestDistance = distance;
        bestTrack = track;
      }
    }

    // 既存trackが見つかった
    if (bestTrack) {
      updateTrackPosition(bestTrack, detection);

      usedTrackIds.add(bestTrack.id);
      matchedTrackIds.add(bestTrack.id);

      const zone = getZone(detection.x);

      updateZoneStable(bestTrack, zone);

    } else {
      // 新しい人物
      const zone = getZone(detection.x);

      const newTrack =
        createPersonTrack(detection, zone);

      tracks.push(newTrack);

      usedTrackIds.add(newTrack.id);
      matchedTrackIds.add(newTrack.id);

      console.log(
        "NEW PERSON TRACK",
        "ID:",
        newTrack.id,
        "ZONE:",
        zone
      );
    }
  }

  // ------------------------------------------
  // 見失ったtrackを保持
  // ------------------------------------------

  markTracksMissed(tracks, matchedTrackIds);
}

// ============================================================
// AIが一瞬人物を見失ってもtrackを保持
// ============================================================

function markTracksMissed(
  trackList,
  matchedTrackIds
) {
  const now = Date.now();

  for (const track of trackList) {
    if (matchedTrackIds.has(track.id)) {
      continue;
    }

    track.missedFrames =
      (Number(track.missedFrames) || 0) + 1;

    // 状態は消さない
    // inside
    // passedC
    // entryProgress
    // を維持する
  }

  // 長時間完全に消えた人物だけ削除
  for (let i = trackList.length - 1; i >= 0; i--) {
    const track = trackList[i];

    if (
      now - track.lastSeen > TRACK_TIMEOUT ||
      track.missedFrames > MAX_MISSED_FRAMES
    ) {
      console.log(
        "TRACK DELETE",
        "ID:",
        track.id
      );

      trackList.splice(i, 1);
    }
  }
}

// ============================================================
// ゾーンを安定させる
// ============================================================

function updateZoneStable(track, detectedZone) {
  if (!track) {
    return;
  }

  const oldZone =
    track.currentZone || detectedZone;

  // 同じゾーン
  if (detectedZone === oldZone) {
    track.pendingZone = detectedZone;
    track.pendingZoneFrames = 0;
    return;
  }

  // 新しいゾーンを検出
  if (track.pendingZone !== detectedZone) {
    track.pendingZone = detectedZone;
    track.pendingZoneFrames = 1;
    return;
  }

  track.pendingZoneFrames =
    (track.pendingZoneFrames || 0) + 1;

  // まだ確定しない
  if (
    track.pendingZoneFrames <
    ZONE_CONFIRM_FRAMES
  ) {
    return;
  }

  // ゾーン変更確定
  track.currentZone = detectedZone;
  track.pendingZoneFrames = 0;

  if (!Array.isArray(track.zoneHistory)) {
    track.zoneHistory = [];
  }

  track.zoneHistory.push(detectedZone);

  if (track.zoneHistory.length > 12) {
    track.zoneHistory.shift();
  }

  // 入退室判定
  checkEntry(
    track,
    oldZone,
    detectedZone
  );

  checkExit(
    track,
    oldZone,
    detectedZone
  );

  console.log(
    "ZONE",
    "ID:",
    track.id,
    oldZone + " → " + detectedZone,
    "inside:",
    track.inside,
    "passedC:",
    track.passedC
  );
}

// ============================================================
// 入室判定
// A → B → C
// ============================================================

function checkEntry(
  track,
  oldZone,
  newZone
) {
  if (!track) {
    return;
  }

  // すでに入室済み
  if (track.inside === true) {
    return;
  }

  // ------------------------------------------
  // A → B
  // ------------------------------------------

  if (
    oldZone === "A" &&
    newZone === "B"
  ) {
    track.entryProgress = 1;

    console.log(
      "入室準備 A→B",
      "ID:",
      track.id
    );

    return;
  }

  // ------------------------------------------
  // A/B境界の揺れ
  // ------------------------------------------

  if (
    track.entryProgress === 1 &&
    oldZone === "B" &&
    newZone === "A"
  ) {
    console.log(
      "A/B境界の揺れ",
      "ID:",
      track.id
    );

    // entryProgressは消さない
    return;
  }

  // ------------------------------------------
  // B → C
  // ------------------------------------------

  if (
    track.entryProgress === 1 &&
    oldZone === "B" &&
    newZone === "C"
  ) {
    if (track.inside !== true) {
      enteredCount++;
      currentPeopleCount++;

      track.inside = true;
      track.entryProgress = 0;

      track.exitState = 0;
      track.passedC = false;
      track.exitCounted = false;

      track.lastCountTime = Date.now();

      console.log(
        "★★ 入室カウント ★★",
        "ID:",
        track.id,
        "現在人数:",
        currentPeopleCount
      );

      savePeopleCount();
      sendPeopleDataSafe();
    }
  }
}

// ============================================================
// 退出判定
//
// C → B → A
// C → A
//
// Bは必須ではない
// ============================================================

function checkExit(
  track,
  oldZone,
  newZone
) {
  if (!track) {
    return;
  }

  // 入室していない人は退出不可
  if (track.inside !== true) {
    return;
  }

  // ------------------------------------------
  // C到達
  // ------------------------------------------

  if (newZone === "C") {
    track.passedC = true;
    track.exitState = 1;

    console.log(
      "退出候補 C到達",
      "ID:",
      track.id
    );

    return;
  }

  // ------------------------------------------
  // C → A
  // Bを飛ばしても退出
  // ------------------------------------------

  if (
    track.passedC === true &&
    newZone === "A" &&
    track.exitCounted !== true
  ) {
    console.log(
      "★★ 退出確定 C→A ★★",
      "ID:",
      track.id
    );

    executeExit(track);

    return;
  }

  // ------------------------------------------
  // C → B
  // ------------------------------------------

  if (
    track.passedC === true &&
    oldZone === "C" &&
    newZone === "B"
  ) {
    track.exitState = 2;

    console.log(
      "退出中 C→B",
      "ID:",
      track.id
    );

    return;
  }

  // ------------------------------------------
  // C → B → A
  // ------------------------------------------

  if (
    track.passedC === true &&
    oldZone === "B" &&
    newZone === "A" &&
    track.exitCounted !== true
  ) {
    console.log(
      "★★ 退出確定 C→B→A ★★",
      "ID:",
      track.id
    );

    executeExit(track);
  }
}

// ============================================================
// 退出実行
// ============================================================

function executeExit(track) {
  if (!track) {
    return;
  }

  // 二重退出防止
  if (track.exitCounted === true) {
    return;
  }

  // 入室済みでなければ退出不可
  if (track.inside !== true) {
    return;
  }

  track.exitCounted = true;

  currentPeopleCount =
    Math.max(
      0,
      Number(currentPeopleCount) - 1
    );

  exitedCount++;

  // この人物は退出済み
  track.inside = false;
  track.entryProgress = 0;
  track.exitState = 0;
  track.passedC = false;

  console.log(
    "★★ EXIT COMPLETE ★★",
    "ID:",
    track.id,
    "現在人数:",
    currentPeopleCount
  );

  savePeopleCount();
  sendPeopleDataSafe();
}

// ============================================================
// Firebase / 外部送信
// ============================================================

function sendPeopleDataSafe() {
  /*
  既存のプロジェクトに sendPeopleData() がある場合だけ呼ぶ。

  例：
  function sendPeopleData() {
    // Firebaseへ currentPeopleCount 等を送信
  }
  */

  try {
    if (
      typeof window.sendPeopleData ===
      "function"
    ) {
      window.sendPeopleData();
      return;
    }

    if (
      typeof sendPeopleData ===
      "function"
    ) {
      sendPeopleData();
      return;
    }

    console.log(
      "Firebase送信関数なし → localStorageのみ更新"
    );

  } catch (error) {
    console.error(
      "sendPeopleData error:",
      error
    );
  }
}

// ============================================================
// localStorage
// ============================================================

const PEOPLE_STORAGE_KEY =
  "AI_PEOPLE_DATA";

function savePeopleCount() {
  const data = {
    currentPeopleCount:
      currentPeopleCount,

    enteredCount:
      enteredCount,

    exitedCount:
      exitedCount,

    updatedAt:
      Date.now()
  };

  try {
    localStorage.setItem(
      PEOPLE_STORAGE_KEY,
      JSON.stringify(data)
    );
  } catch (error) {
    console.error(
      "localStorage save error:",
      error
    );
  }
}

function loadPeopleCount() {
  try {
    const raw =
      localStorage.getItem(
        PEOPLE_STORAGE_KEY
      );

    if (!raw) {
      return;
    }

    const data =
      JSON.parse(raw);

    if (
      Number.isFinite(
        Number(data.currentPeopleCount)
      )
    ) {
      currentPeopleCount =
        Math.max(
          0,
          Number(data.currentPeopleCount)
        );
    }

    if (
      Number.isFinite(
        Number(data.enteredCount)
      )
    ) {
      enteredCount =
        Math.max(
          0,
          Number(data.enteredCount)
        );
    }

    if (
      Number.isFinite(
        Number(data.exitedCount)
      )
    ) {
      exitedCount =
        Math.max(
          0,
          Number(data.exitedCount)
        );
    }

  } catch (error) {
    console.error(
      "localStorage load error:",
      error
    );
  }
}

// ============================================================
// リセット
// ============================================================

function resetPeopleCount() {
  currentPeopleCount = 0;
  enteredCount = 0;
  exitedCount = 0;

  // trackも全部リセット
  tracks = [];
  detections = [];

  savePeopleCount();

  sendPeopleDataSafe();

  console.log(
    "★★ 人数データをリセットしました ★★"
  );
}

// グローバルから呼べるようにする
window.resetPeopleCount =
  resetPeopleCount;

// ============================================================
// リセットボタン自動接続
// ============================================================

function setupResetButton() {
  const ids = [
    "resetButton",
    "resetBtn",
    "reset",
    "reset-count",
    "resetCountButton"
  ];

  for (const id of ids) {
    const button =
      document.getElementById(id);

    if (!button) {
      continue;
    }

    // 同じボタンへの二重登録防止
    if (
      button.dataset.cameraResetBound ===
      "true"
    ) {
      continue;
    }

    button.dataset.cameraResetBound = "true";

    button.addEventListener(
      "click",
      () => {
        const ok =
          confirm(
            "現在の人数・入退室カウントをリセットしますか？"
          );

        if (ok) {
          resetPeopleCount();
        }
      }
    );

    console.log(
      "Reset button connected:",
      id
    );

    break;
  }
}

// ============================================================
// 画面表示
// ============================================================

function drawInfo() {
  noStroke();

  // 情報背景
  fill(0, 0, 0, 175);
  rect(15, drawH - 110, 430, 95, 12);

  fill(255);
  textAlign(LEFT, TOP);

  textSize(22);
  text(
    "現在人数: " +
      currentPeopleCount,
    30,
    drawH - 98
  );

  textSize(16);
  text(
    "入室: " +
      enteredCount +
      "    退出: " +
      exitedCount,
    30,
    drawH - 67
  );

  textSize(14);
  text(
    statusMessage,
    30,
    drawH - 42
  );
}

// ============================================================
// trackの描画
// ============================================================

function drawTracks() {
  for (const track of tracks) {
    // 長時間見失っているtrackは表示しない
    if (track.missedFrames > 0) {
      continue;
    }

    const x = track.x;
    const y = track.y;

    const prediction =
      track.prediction;

    let boxX = x - 40;
    let boxY = y - 80;
    let boxW = 80;
    let boxH = 160;

    if (
      prediction &&
      prediction.bbox &&
      prediction.bbox.length >= 4
    ) {
      boxX = prediction.bbox[0];
      boxY = prediction.bbox[1];
      boxW = prediction.bbox[2];
      boxH = prediction.bbox[3];
    }

    // p5 canvasとvideoのサイズが違う場合の補正
    const scaleX =
      drawW / CAMERA_W;

    const scaleY =
      drawH / CAMERA_H;

    boxX *= scaleX;
    boxY *= scaleY;
    boxW *= scaleX;
    boxH *= scaleY;

    // 内部状態によって線の太さを変更
    if (track.inside) {
      strokeWeight(5);
    } else {
      strokeWeight(3);
    }

    stroke(0, 255, 0);
    noFill();

    rect(
      boxX,
      boxY,
      boxW,
      boxH
    );

    // ラベル
    noStroke();
    fill(0, 0, 0, 190);

    rect(
      boxX,
      Math.max(0, boxY - 48),
      190,
      45,
      5
    );

    fill(255);

    textAlign(LEFT, TOP);
    textSize(15);

    const state =
      track.inside
        ? "INSIDE"
        : "OUTSIDE";

    const exitState =
      track.passedC
        ? "C済"
        : "";

    text(
      "ID " +
        track.id +
        " / " +
        track.currentZone +
        " / " +
        state +
        " " +
        exitState,
      boxX + 7,
      Math.max(2, boxY - 43)
    );

    text(
      "miss:" +
        track.missedFrames,
      boxX + 7,
      Math.max(2, boxY - 24)
    );
  }
}

// ============================================================
// キーボードリセット
// Rキーでリセット
// ============================================================

function keyPressed() {
  if (
    key === "r" ||
    key === "R"
  ) {
    resetPeopleCount();
  }
}
