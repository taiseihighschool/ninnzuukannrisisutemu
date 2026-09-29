// ============================================================
// AI人数管理システム
// camera.js 完成版
//
// 【ゾーン】
// A = 左
// B = 中央
// C = 右
//
// 【入室】
// A → B → C
//
// 【退出】
// C → B → A
// C → A
//
// Firebase対応
// リセット対応
// 人物追跡対応
// ============================================================


// ============================================================
// 基本変数
// ============================================================

let video;
let model;

let predictions = [];


// ============================================================
// 人数
// ============================================================

let visiblePeopleCount = 0;
let enteredCount = 0;
let exitedCount = 0;
let currentPeopleCount = 0;


// ============================================================
// カメラ・AI状態
// ============================================================

let cameraReady = false;
let modelReady = false;
let detecting = false;


// ============================================================
// 人物追跡
// ============================================================

let tracks = [];

let nextTrackId = 1;


// ============================================================
// AI設定
// ============================================================

// 人物検出の最低信頼度
const PERSON_CONFIDENCE = 0.35;

// 一時的に見失っても同じ人物として保持する時間
const TRACK_TIMEOUT = 4000;

// 同じ人物と判断する最大距離
const MATCH_DISTANCE = 220;

// 同じ人物の連続カウント防止
const COUNT_COOLDOWN = 1200;


// ============================================================
// ゾーン設定
//
// ★ここが重要
//
// 左  = A
// 中央 = B
// 右  = C
// ============================================================

const ZONE_A_END = 0.33;
const ZONE_B_END = 0.66;


// ============================================================
// Canvas
// ============================================================

let canvasWidth = 1280;
let canvasHeight = 720;


// ============================================================
// setup
// ============================================================

function setup() {

  updateCanvasSize();

  const canvas = createCanvas(
    canvasWidth,
    canvasHeight
  );

  canvas.parent("app");

  // ========================================================
  // 背面カメラ
  // ========================================================

  video = createCapture(
    {
      video: {
        facingMode: {
          ideal: "environment"
        },

        width: {
          ideal: 1280
        },

        height: {
          ideal: 720
        }
      },

      audio: false
    },

    function () {

      cameraReady = true;

      console.log(
        "背面カメラ接続成功"
      );

      sendPeopleData();

    }
  );

  video.hide();


  // ========================================================
  // AIモデル読み込み
  // ========================================================

  loadAIModel();

}


// ============================================================
// Canvasサイズ
// ============================================================

function updateCanvasSize() {

  canvasWidth = windowWidth;
  canvasHeight = windowHeight;

}


// ============================================================
// 画面サイズ変更
// ============================================================

function windowResized() {

  updateCanvasSize();

  resizeCanvas(
    canvasWidth,
    canvasHeight
  );

}


// ============================================================
// AIモデル読み込み
// ============================================================

async function loadAIModel() {

  console.log(
    "COCO-SSDを読み込んでいます..."
  );

  try {

    model =
      await cocoSsd.load();

    modelReady = true;

    console.log(
      "AIモデル読み込み完了"
    );

    sendPeopleData();

    detectPeople();

  }

  catch (error) {

    console.error(
      "AIモデル読み込みエラー:",
      error
    );

  }

}


// ============================================================
// 人物検出
// ============================================================

async function detectPeople() {

  if (detecting) {
    return;
  }

  if (!modelReady || !cameraReady) {
    return;
  }

  detecting = true;

  try {

    // ======================================================
    // AI人物検出
    // ======================================================

    predictions =
      await model.detect(
        video.elt
      );


    // ======================================================
    // personだけ抽出
    // ======================================================

    const persons = [];

    for (
      let i = 0;
      i < predictions.length;
      i++
    ) {

      const prediction =
        predictions[i];

      if (
        prediction.class === "person" &&
        prediction.score >= PERSON_CONFIDENCE
      ) {

        persons.push(
          prediction
        );

      }

    }


    // ======================================================
    // カメラ内人数
    // ======================================================

    visiblePeopleCount =
      persons.length;


    // ======================================================
    // 人物追跡
    // ======================================================

    updateTracks(
      persons
    );


    // ======================================================
    // Firebase
    // ======================================================

    sendPeopleData();

  }

  catch (error) {

    console.error(
      "AI認識エラー:",
      error
    );

  }

  detecting = false;

}


// ============================================================
// 人物追跡
// ============================================================

function updateTracks(persons) {

  const now =
    Date.now();


  const detections = [];


  // ========================================================
  // 検出された人物の中心座標
  // ========================================================

  for (
    let i = 0;
    i < persons.length;
    i++
  ) {

    const bbox =
      persons[i].bbox;


    const centerX =
      bbox[0] +
      bbox[2] / 2;


    const centerY =
      bbox[1] +
      bbox[3] / 2;


    detections.push({

      prediction:
        persons[i],

      x:
        centerX,

      y:
        centerY,

      matched:
        false

    });

  }


  // ========================================================
  // 既存トラックと照合
  // ========================================================

  for (
    let i = 0;
    i < tracks.length;
    i++
  ) {

    const track =
      tracks[i];


    let bestDetection =
      null;


    let bestDistance =
      MATCH_DISTANCE;


    for (
      let j = 0;
      j < detections.length;
      j++
    ) {

      const detection =
        detections[j];


      if (
        detection.matched
      ) {

        continue;

      }


      const dx =
        detection.x -
        track.x;


      const dy =
        detection.y -
        track.y;


      const distance =
        Math.sqrt(
          dx * dx +
          dy * dy
        );


      if (
        distance <
        bestDistance
      ) {

        bestDistance =
          distance;

        bestDetection =
          detection;

      }

    }


    // ======================================================
    // 同じ人物として更新
    // ======================================================

    if (bestDetection) {

      bestDetection.matched =
        true;


      const oldZone =
        track.currentZone;


      const newZone =
        getZone(
          bestDetection.x,
          bestDetection.y
        );


      // 少し滑らかに移動
      track.x =
        track.x * 0.35 +
        bestDetection.x * 0.65;


      track.y =
        track.y * 0.35 +
        bestDetection.y * 0.65;


      track.lastSeen =
        now;


      track.prediction =
        bestDetection.prediction;


      // ====================================================
      // ゾーンが変わった
      // ====================================================

      if (
        newZone !==
        track.currentZone
      ) {

        updateZoneHistory(
          track,
          oldZone,
          newZone
        );

      }

    }

  }


  // ========================================================
  // 新しい人物
  // ========================================================

  for (
    let i = 0;
    i < detections.length;
    i++
  ) {

    const detection =
      detections[i];


    if (
      detection.matched
    ) {

      continue;

    }


    const initialZone =
      getZone(
        detection.x,
        detection.y
      );


    const newTrack = {

      id:
        nextTrackId++,

      x:
        detection.x,

      y:
        detection.y,

      lastSeen:
        now,

      prediction:
        detection.prediction,


      // 現在ゾーン
      currentZone:
        initialZone,


      // ゾーン履歴
      zoneHistory:
        [initialZone],


      // 入室済みか
      inside:
        false,


      // 入室状態
      entryProgress:
        0,


      // 退出状態
      exitState:
        0,


      // 最後にカウントした時間
      lastCountTime:
        0

    };


    tracks.push(
      newTrack
    );


    console.log(
      "新しい人物",
      newTrack.id,
      "ZONE:",
      initialZone
    );

  }


  // ========================================================
  // 古いトラック削除
  // ========================================================

  tracks =
    tracks.filter(
      function (track) {

        return (
          now -
          track.lastSeen
          <
          TRACK_TIMEOUT
        );

      }
    );

}


// ============================================================
// 実際のカメラ幅
// ============================================================

function getActualVideoWidth() {

  if (
    video &&
    video.elt &&
    video.elt.videoWidth > 0
  ) {

    return video.elt.videoWidth;

  }


  if (
    video &&
    video.width > 0
  ) {

    return video.width;

  }


  return 1280;

}


// ============================================================
// 実際のカメラ高さ
// ============================================================

function getActualVideoHeight() {

  if (
    video &&
    video.elt &&
    video.elt.videoHeight > 0
  ) {

    return video.elt.videoHeight;

  }


  if (
    video &&
    video.height > 0
  ) {

    return video.height;

  }


  return 720;

}


// ============================================================
// カメラ映像の表示位置・サイズ
// ============================================================

function getVideoGeometry() {

  const videoWidth =
    getActualVideoWidth();

  const videoHeight =
    getActualVideoHeight();


  const videoRatio =
    videoWidth /
    videoHeight;


  const canvasRatio =
    width /
    height;


  let drawWidth;
  let drawHeight;
  let offsetX;
  let offsetY;


  // ========================================================
  // 横長映像
  // ========================================================

  if (
    videoRatio >
    canvasRatio
  ) {

    drawHeight =
      height;


    drawWidth =
      height *
      videoRatio;


    offsetX =
      (
        width -
        drawWidth
      ) / 2;


    offsetY =
      0;

  }


  // ========================================================
  // 縦長映像
  // ========================================================

  else {

    drawWidth =
      width;


    drawHeight =
      width /
      videoRatio;


    offsetX =
      0;


    offsetY =
      (
        height -
        drawHeight
      ) / 2;

  }


  return {

    videoWidth:
      videoWidth,

    videoHeight:
      videoHeight,

    drawWidth:
      drawWidth,

    drawHeight:
      drawHeight,

    offsetX:
      offsetX,

    offsetY:
      offsetY

  };

}


// ============================================================
// ★★★ ゾーン判定 ★★★
//
// カメラ映像の「横方向」を使う
//
// 左        中央        右
// A          B          C
//
// 0%       33%        66%       100%
// |---------|-----------|---------|
//
// A → B → C = 入室
// C → B → A = 退出
// C → A     = 退出
// ============================================================

function getZone(x, y) {

  const videoWidth =
    getActualVideoWidth();


  // ========================================================
  // 人物中心Xを0～1にする
  // ========================================================

  const ratio =
    x /
    videoWidth;


  // ========================================================
  // A = 左33%
  // ========================================================

  if (
    ratio < ZONE_A_END
  ) {

    return "A";

  }


  // ========================================================
  // B = 中央33%
  // ========================================================

  if (
    ratio < ZONE_B_END
  ) {

    return "B";

  }


  // ========================================================
  // C = 右34%
  // ========================================================

  return "C";

}


// ============================================================
// ゾーン履歴
// ============================================================

function updateZoneHistory(
  track,
  oldZone,
  newZone
) {

  console.log(
    "人物",
    track.id,
    ":",
    oldZone,
    "→",
    newZone
  );


  track.zoneHistory.push(
    newZone
  );


  // 履歴が増えすぎないようにする
  if (
    track.zoneHistory.length >
    12
  ) {

    track.zoneHistory.shift();

  }


  track.currentZone =
    newZone;


  // ========================================================
  // 入室判定
  // ========================================================

  checkEntry(
    track,
    oldZone,
    newZone
  );


  // ========================================================
  // 退出判定
  // ========================================================

  checkExit(
    track,
    oldZone,
    newZone
  );

}


// ============================================================
// 入室判定
//
// A → B → C
// ============================================================

function checkEntry(
  track,
  oldZone,
  newZone
) {

  // すでに入室している人は入室処理しない
  if (
    track.inside
  ) {

    return;

  }


  // ========================================================
  // A → B
  // ========================================================

  if (
    oldZone === "A" &&
    newZone === "B"
  ) {

    track.entryProgress =
      1;


    console.log(
      "人物",
      track.id,
      "A → B",
      "入室準備"
    );


    return;

  }


  // ========================================================
  // B → A
  //
  // 戻ったのでキャンセル
  // ========================================================

  if (
    oldZone === "B" &&
    newZone === "A"
  ) {

    track.entryProgress =
      0;


    console.log(
      "人物",
      track.id,
      "B → A",
      "入室キャンセル"
    );


    return;

  }


  // ========================================================
  // B → C
  //
  // A → B → C 完成
  // ========================================================

  if (
    oldZone === "B" &&
    newZone === "C" &&
    track.entryProgress === 1
  ) {

    executeEntry(
      track
    );


    return;

  }


  // ========================================================
  // A → C
  //
  // Bを高速で通過した場合
  // ========================================================

  if (
    oldZone === "A" &&
    newZone === "C"
  ) {

    console.log(
      "人物",
      track.id,
      "A → C",
      "B高速通過"
    );


    executeEntry(
      track
    );


    return;

  }

}


// ============================================================
// 入室実行
// ============================================================

function executeEntry(
  track
) {

  // 二重入室防止
  if (
    track.inside === true
  ) {

    return;

  }


  const now =
    Date.now();


  // 連続カウント防止
  if (
    now -
    track.lastCountTime
    <
    COUNT_COOLDOWN
  ) {

    return;

  }


  // ========================================================
  // カウント
  // ========================================================

  enteredCount++;


  currentPeopleCount =
    currentPeopleCount + 1;


  // ========================================================
  // 状態変更
  // ========================================================

  track.inside =
    true;


  track.entryProgress =
    0;


  track.exitState =
    0;


  track.lastCountTime =
    now;


  console.log(
    "================================"
  );

  console.log(
    "★ 入室"
  );

  console.log(
    "人物ID:",
    track.id
  );

  console.log(
    "経路:",
    track.zoneHistory.join(
      " → "
    )
  );

  console.log(
    "現在人数:",
    currentPeopleCount
  );

  console.log(
    "================================"
  );


  sendPeopleData();

}


// ============================================================
// 退出判定
//
// C → B → A
// C → A
// ============================================================

function checkExit(
  track,
  oldZone,
  newZone
) {

  // ========================================================
  // 入室していない人は退出できない
  // ========================================================

  if (
    track.inside !== true
  ) {

    return;

  }


  // ========================================================
  // C → B
  // ========================================================

  if (
    oldZone === "C" &&
    newZone === "B"
  ) {

    track.exitState =
      2;


    console.log(
      "人物",
      track.id,
      "C → B",
      "退出準備"
    );


    return;

  }


  // ========================================================
  // C → A
  //
  // Bを飛ばした場合
  // ========================================================

  if (
    oldZone === "C" &&
    newZone === "A"
  ) {

    console.log(
      "人物",
      track.id,
      "C → A",
      "退出"
    );


    executeExit(
      track
    );


    return;

  }


  // ========================================================
  // B → A
  //
  // C → B → A
  // ========================================================

  if (
    oldZone === "B" &&
    newZone === "A"
  ) {

    if (
      track.exitState === 2
    ) {

      console.log(
        "人物",
        track.id,
        "C → B → A",
        "退出"
      );


      executeExit(
        track
      );


      return;

    }


    track.exitState =
      0;


    return;

  }


  // ========================================================
  // B → C
  //
  // 出口へ戻ったので退出キャンセル
  // ========================================================

  if (
    oldZone === "B" &&
    newZone === "C"
  ) {

    track.exitState =
      0;


    console.log(
      "人物",
      track.id,
      "B → C",
      "退出キャンセル"
    );


    return;

  }


  // ========================================================
  // A → B
  // ========================================================

  if (
    oldZone === "A" &&
    newZone === "B"
  ) {

    track.exitState =
      0;


    return;

  }

}


// ============================================================
// 退出実行
// ============================================================

function executeExit(
  track
) {

  // 入室中でなければ退出しない
  if (
    track.inside !== true
  ) {

    return;

  }


  const now =
    Date.now();


  // 二重退出防止
  if (
    now -
    track.lastCountTime
    <
    COUNT_COOLDOWN
  ) {

    return;

  }


  // ========================================================
  // 退出カウント
  // ========================================================

  exitedCount++;


  currentPeopleCount =
    Math.max(
      0,
      currentPeopleCount - 1
    );


  // ========================================================
  // 状態変更
  // ========================================================

  track.inside =
    false;


  track.exitState =
    0;


  track.entryProgress =
    0;


  track.lastCountTime =
    now;


  console.log(
    "================================"
  );

  console.log(
    "★ 退出"
  );

  console.log(
    "人物ID:",
    track.id
  );

  console.log(
    "現在人数:",
    currentPeopleCount
  );

  console.log(
    "================================"
  );


  sendPeopleData();

}


// ============================================================
// Firebaseへ送信
// ============================================================

async function sendPeopleData() {

  try {

    // Firebase初期化を待つ
    if (
      window.firebaseReady
    ) {

      await window.firebaseReady;

    }


    if (
      !window.firebaseDB ||
      !window.firebaseRef ||
      !window.firebaseSet
    ) {

      return;

    }


    const peopleRef =
      window.firebaseRef(
        window.firebaseDB,
        "people/current"
      );


    const data = {

      peopleCount:
        currentPeopleCount,

      visiblePeopleCount:
        visiblePeopleCount,

      enteredCount:
        enteredCount,

      exitedCount:
        exitedCount,

      cameraReady:
        cameraReady,

      modelReady:
        modelReady,

      camera:
        "tablet",

      orientation:
        "horizontal",

      zones:
        "A-left,B-center,C-right",

      updatedAt:
        Date.now(),

      time:
        new Date()
          .toLocaleTimeString()

    };


    await window.firebaseSet(
      peopleRef,
      data
    );


  }

  catch (error) {

    console.error(
      "Firebase送信エラー:",
      error
    );

  }

}


// ============================================================
// リセット
// ============================================================

function resetSystem() {

  console.log(
    "=============================="
  );

  console.log(
    "★ システムリセット"
  );

  console.log(
    "=============================="
  );


  // ========================================================
  // 人数
  // ========================================================

  visiblePeopleCount =
    0;

  enteredCount =
    0;

  exitedCount =
    0;

  currentPeopleCount =
    0;


  // ========================================================
  // 人物追跡
  // ========================================================

  tracks =
    [];


  nextTrackId =
    1;


  predictions =
    [];


  // ========================================================
  // Firebase
  // ========================================================

  sendPeopleData();


  console.log(
    "★ リセット完了"
  );

}


// ============================================================
// draw
// ============================================================

function draw() {

  background(15);


  // ========================================================
  // カメラ
  // ========================================================

  if (
    cameraReady
  ) {

    drawCamera();

  }

  else {

    fill(255);

    textAlign(
      CENTER,
      CENTER
    );

    textSize(28);

    text(
      "背面カメラを起動しています...",
      width / 2,
      height / 2
    );

  }


  // ========================================================
  // ABCゾーン
  // ========================================================

  drawZones();


  // ========================================================
  // 人物枠
  // ========================================================

  for (
    let i = 0;
    i < predictions.length;
    i++
  ) {

    const prediction =
      predictions[i];


    if (
      prediction.class === "person" &&
      prediction.score >= PERSON_CONFIDENCE
    ) {

      drawPersonBox(
        prediction
      );

    }

  }


  // ========================================================
  // 人数
  // ========================================================

  drawPeopleCount();


  // ========================================================
  // 追跡情報
  // ========================================================

  drawTrackingInfo();


  // ========================================================
  // 状態
  // ========================================================

  drawStatus();


  // ========================================================
  // 次のAI認識
  // ========================================================

  if (
    modelReady &&
    cameraReady &&
    !detecting
  ) {

    detectPeople();

  }

}


// ============================================================
// カメラ映像
// ============================================================

function drawCamera() {

  const geometry =
    getVideoGeometry();


  image(
    video,

    geometry.offsetX,
    geometry.offsetY,

    geometry.drawWidth,
    geometry.drawHeight
  );

}


// ============================================================
// ★★★ A/B/C表示 ★★★
//
// 左  = A
// 中央 = B
// 右  = C
// ============================================================

function drawZones() {

  const geometry =
    getVideoGeometry();


  // ========================================================
  // A/B境界
  // ========================================================

  const lineAB =
    geometry.offsetX +
    geometry.drawWidth *
    ZONE_A_END;


  // ========================================================
  // B/C境界
  // ========================================================

  const lineBC =
    geometry.offsetX +
    geometry.drawWidth *
    ZONE_B_END;


  // ========================================================
  // 境界線
  // ========================================================

  stroke(
    255,
    255,
    0
  );

  strokeWeight(4);


  // A | B
  line(
    lineAB,
    geometry.offsetY,
    lineAB,
    geometry.offsetY +
      geometry.drawHeight
  );


  // B | C
  line(
    lineBC,
    geometry.offsetY,
    lineBC,
    geometry.offsetY +
      geometry.drawHeight
  );


  noStroke();


  // ========================================================
  // 上部背景
  // ========================================================

  fill(
    0,
    0,
    0,
    170
  );


  rect(
    0,
    0,
    width,
    75
  );


  // ========================================================
  // A
  // ========================================================

  fill(
    255,
    255,
    0
  );

  textAlign(
    CENTER,
    CENTER
  );

  textSize(
    Math.max(
      24,
      width * 0.025
    )
  );


  text(
    "A：入口",
    geometry.offsetX +
      geometry.drawWidth *
      0.165,
    geometry.offsetY +
      35
  );


  // ========================================================
  // B
  // ========================================================

  text(
    "B：中間",
    geometry.offsetX +
      geometry.drawWidth *
      0.50,
    geometry.offsetY +
      35
  );


  // ========================================================
  // C
  // ========================================================

  text(
    "C：出口",
    geometry.offsetX +
      geometry.drawWidth *
      0.835,
    geometry.offsetY +
      35
  );


  // ========================================================
  // 下部説明
  // ========================================================

  fill(
    0,
    0,
    0,
    180
  );


  rect(
    0,
    height - 65,
    width,
    65
  );


  fill(255);

  textSize(18);


  text(
    "入室：A → B → C",
    width / 2,
    height - 42
  );


  text(
    "退出：C → B → A / C → A",
    width / 2,
    height - 18
  );

}


// ============================================================
// 人物枠
// ============================================================

function drawPersonBox(
  prediction
) {

  const bbox =
    prediction.bbox;


  const x =
    bbox[0];

  const y =
    bbox[1];

  const w =
    bbox[2];

  const h =
    bbox[3];


  const geometry =
    getVideoGeometry();


  // ========================================================
  // カメラ座標→画面座標
  // ========================================================

  const drawX =
    geometry.offsetX +
    x *
    geometry.drawWidth /
    geometry.videoWidth;


  const drawY =
    geometry.offsetY +
    y *
    geometry.drawHeight /
    geometry.videoHeight;


  const drawW =
    w *
    geometry.drawWidth /
    geometry.videoWidth;


  const drawH =
    h *
    geometry.drawHeight /
    geometry.videoHeight;


  // ========================================================
  // 人物の中心
  // ========================================================

  const centerX =
    x +
    w / 2;


  const centerY =
    y +
    h / 2;


  // ========================================================
  // ★ゾーン判定
  //
  // 人物の中心Xで判定
  // ========================================================

  const zone =
    getZone(
      centerX,
      centerY
    );


  // ========================================================
  // 対応する追跡ID
  // ========================================================

  const track =
    findTrackForPrediction(
      prediction
    );


  let trackId =
    "--";


  let status =
    "外";


  if (track) {

    trackId =
      track.id;


    if (
      track.inside
    ) {

      status =
        "入室中";

    }

  }


  // ========================================================
  // 緑色の人物枠
  // ========================================================

  noFill();

  stroke(
    0,
    255,
    0
  );

  strokeWeight(4);


  rect(
    drawX,
    drawY,
    drawW,
    drawH
  );


  noStroke();


  // ========================================================
  // ラベル背景
  // ========================================================

  fill(
    0,
    0,
    0,
    210
  );


  rect(
    drawX,
    Math.max(
      75,
      drawY - 58
    ),
    210,
    58
  );


  // ========================================================
  // ID
  // ========================================================

  fill(255);

  textAlign(
    LEFT,
    CENTER
  );

  textSize(15);


  text(
    "ID: " +
    trackId,
    drawX + 8,
    Math.max(
      90,
      drawY - 42
    )
  );


  // ========================================================
  // ZONE
  // ========================================================

  text(
    "ZONE: " +
    zone +
    " / " +
    status,
    drawX + 8,
    Math.max(
      112,
      drawY - 20
    )
  );


  // ========================================================
  // 信頼度
  // ========================================================

  fill(
    0,
    255,
    0
  );


  text(
    Math.round(
      prediction.score * 100
    ) + "%",
    drawX +
      Math.max(
        0,
        drawW - 45
      ),
    drawY + 20
  );

}


// ============================================================
// predictionから追跡IDを探す
// ============================================================

function findTrackForPrediction(
  prediction
) {

  const bbox =
    prediction.bbox;


  const x =
    bbox[0] +
    bbox[2] / 2;


  const y =
    bbox[1] +
    bbox[3] / 2;


  let bestTrack =
    null;


  let bestDistance =
    MATCH_DISTANCE;


  for (
    let i = 0;
    i < tracks.length;
    i++
  ) {

    const track =
      tracks[i];


    const dx =
      x -
      track.x;


    const dy =
      y -
      track.y;


    const distance =
      Math.sqrt(
        dx * dx +
        dy * dy
      );


    if (
      distance <
      bestDistance
    ) {

      bestDistance =
        distance;

      bestTrack =
        track;

    }

  }


  return bestTrack;

}


// ============================================================
// 人数表示
// ============================================================

function drawPeopleCount() {

  noStroke();


  fill(
    0,
    0,
    0,
    190
  );


  rect(
    20,
    95,
    315,
    185,
    15
  );


  fill(255);


  textAlign(
    LEFT,
    CENTER
  );


  textSize(20);


  text(
    "AI入退室管理",
    40,
    125
  );


  textSize(34);


  text(
    "現在：" +
    currentPeopleCount +
    "人",
    40,
    170
  );


  textSize(19);


  text(
    "入室：" +
    enteredCount +
    "人",
    40,
    210
  );


  text(
    "退出：" +
    exitedCount +
    "人",
    170,
    210
  );


  textSize(16);


  text(
    "カメラ内：" +
    visiblePeopleCount +
    "人",
    40,
    245
  );


  text(
    "追跡中：" +
    tracks.length +
    "人",
    40,
    268
  );

}


// ============================================================
// 追跡情報
// ============================================================

function drawTrackingInfo() {

  if (
    tracks.length === 0
  ) {

    return;

  }


  const startX =
    width - 270;


  let y =
    120;


  noStroke();


  fill(
    0,
    0,
    0,
    190
  );


  rect(
    startX - 15,
    95,
    255,
    75 +
      tracks.length * 40,
    12
  );


  fill(255);


  textAlign(
    LEFT,
    CENTER
  );


  textSize(16);


  text(
    "人物追跡",
    startX,
    y
  );


  y += 30;


  for (
    let i = 0;
    i < tracks.length;
    i++
  ) {

    const track =
      tracks[i];


    const status =
      track.inside
      ? "入室中"
      : "外";


    text(
      "ID " +
      track.id +
      " : " +
      track.currentZone +
      " / " +
      status,
      startX,
      y
    );


    y += 38;

  }

}


// ============================================================
// 状態表示
// ============================================================

function drawStatus() {

  textAlign(
    RIGHT
  );


  textSize(17);


  // ========================================================
  // Camera
  // ========================================================

  if (
    cameraReady
  ) {

    fill(
      0,
      255,
      0
    );


    text(
      "Camera：背面",
      width - 20,
      30
    );

  }

  else {

    fill(
      255,
      100,
      100
    );


    text(
      "Camera：起動中",
      width - 20,
      30
    );

  }


  // ========================================================
  // AI
  // ========================================================

  if (
    modelReady
  ) {

    fill(
      0,
      255,
      0
    );


    text(
      "AI：稼働中",
      width - 20,
      55
    );

  }

  else {

    fill(255);


    text(
      "AI：読み込み中",
      width - 20,
      55
    );

  }


  // ========================================================
  // Firebase
  // ========================================================

  if (
    window.firebaseDB
  ) {

    fill(
      0,
      255,
      0
    );


    text(
      "Firebase：接続OK",
      width - 20,
      80
    );

  }

  else {

    fill(
      255,
      100,
      100
    );


    text(
      "Firebase：接続待ち",
      width - 20,
      80
    );

  }


  // ========================================================
  // ゾーン方向
  // ========================================================

  fill(255);


  text(
    "A ← 左 ｜ B ← 中央 → ｜ C → 右",
    width - 20,
    105
  );

}
