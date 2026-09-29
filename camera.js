// ======================================================
// AI人数管理システム
// 縦方向A・B・C + 高感度 + 安定追跡 完成版
//
// A = 上
// B = 中央
// C = 下
//
// 入室
// A → B → C
//
// 退出
// C → B → A
// C → A
// ======================================================


// ======================================================
// AI・カメラ
// ======================================================

let video;
let model;
let predictions = [];


// ======================================================
// 人数
// ======================================================

let visiblePeopleCount = 0;
let enteredCount = 0;
let exitedCount = 0;
let currentPeopleCount = 0;


// ======================================================
// 状態
// ======================================================

let modelReady = false;
let cameraReady = false;
let detecting = false;


// ======================================================
// 人物追跡
// ======================================================

let tracks = [];
let nextTrackId = 1;


// ======================================================
// 感度設定
// ======================================================

// 小さいほど人を検出しやすい
const PERSON_CONFIDENCE = 0.35;

// AIから一時的に消えても同じ人物として保持
const TRACK_TIMEOUT = 4000;

// 同じ人物として認識する最大距離
const MATCH_DISTANCE = 220;


// ======================================================
// ゾーン
// ======================================================

// 上 1/3 = A
// 中央 1/3 = B
// 下 1/3 = C

const ZONE_A_END = 0.33;
const ZONE_B_END = 0.66;


// ======================================================
// カウント間隔
// ======================================================

const COUNT_COOLDOWN = 1200;


// ======================================================
// リセット
// ======================================================

let lastResetTime = 0;


// ======================================================
// キャンバス
// ======================================================

let canvasWidth = 1280;
let canvasHeight = 720;


// ======================================================
// setup
// ======================================================

function setup() {

  updateCanvasSize();

  const canvas = createCanvas(
    canvasWidth,
    canvasHeight
  );

  canvas.parent("app");


  // ==================================================
  // 背面カメラ
  // ==================================================

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


  // ==================================================
  // AI
  // ==================================================

  loadAIModel();

}


// ======================================================
// キャンバスサイズ
// ======================================================

function updateCanvasSize() {

  if (windowWidth >= windowHeight) {

    canvasWidth = windowWidth;
    canvasHeight = windowHeight;

  } else {

    canvasWidth = windowWidth;
    canvasHeight =
      windowWidth * 9 / 16;

  }

}


// ======================================================
// 画面サイズ変更
// ======================================================

function windowResized() {

  updateCanvasSize();

  resizeCanvas(
    canvasWidth,
    canvasHeight
  );

}


// ======================================================
// AI読み込み
// ======================================================

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

  } catch (error) {

    console.error(
      "AIモデル読み込みエラー:",
      error
    );

  }

}


// ======================================================
// 人物検出
// ======================================================

async function detectPeople() {

  if (detecting) {
    return;
  }

  if (
    !modelReady ||
    !cameraReady
  ) {
    return;
  }

  detecting = true;

  try {

    predictions =
      await model.detect(
        video.elt
      );


    let persons = [];


    // ==================================================
    // 人物だけ抽出
    // ==================================================

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


    // ==================================================
    // カメラ内人数
    // ==================================================

    visiblePeopleCount =
      persons.length;


    // ==================================================
    // 人物追跡
    // ==================================================

    updateTracks(
      persons
    );


    // ==================================================
    // Firebase
    // ==================================================

    sendPeopleData();

  } catch (error) {

    console.error(
      "AI認識エラー:",
      error
    );

  }

  detecting = false;

}


// ======================================================
// 人物追跡
// ======================================================

function updateTracks(persons) {

  const now =
    Date.now();


  let detections = [];


  // ==================================================
  // 検出された人物の中心座標を作る
  // ==================================================

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


  // ==================================================
  // 既存人物との照合
  // ==================================================

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


    // ==================================================
    // 同じ人物として更新
    // ==================================================

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


      // 少しだけ位置を滑らかにする
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


      // 最新ゾーン
      if (
        newZone !== track.currentZone
      ) {

        updateZoneHistory(
          track,
          oldZone,
          newZone
        );

      }

    }

  }


  // ==================================================
  // 新しい人物
  // ==================================================

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


    tracks.push({

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

      currentZone:
        initialZone,

      zoneHistory:
        [initialZone],

      // ----------------------------------------------
      // 入室
      // ----------------------------------------------

      inside:
        false,

      entryProgress:
        0,

      // ----------------------------------------------
      // 退出
      //
      // 0 = 通常
      // 1 = C到達
      // 2 = C→B確認
      // ----------------------------------------------

      exitState:
        0,

      lastCountTime:
        0

    });


    console.log(
      "新しい人物:",
      nextTrackId - 1,
      "ZONE:",
      initialZone
    );

  }


  // ==================================================
  // 古い人物を削除
  // ==================================================

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


// ======================================================
// 実際のカメラ幅
// ======================================================

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


// ======================================================
// 実際のカメラ高さ
// ======================================================

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


// ======================================================
// カメラ映像とキャンバスの共通座標
// ======================================================

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


  // ==================================================
  // 横長カメラ
  // ==================================================

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

  // ==================================================
  // 縦長カメラ
  // ==================================================

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


// ======================================================
// ★縦方向A/B/C判定
//
// A = 上
// B = 中央
// C = 下
// ======================================================

function getZone(
  x,
  y
) {

  const actualVideoHeight =
    getActualVideoHeight();


  const ratio =
    y /
    actualVideoHeight;


  if (
    ratio <
    ZONE_A_END
  ) {

    return "A";

  }


  if (
    ratio <
    ZONE_B_END
  ) {

    return "B";

  }


  return "C";

}


// ======================================================
// ゾーン変更
// ======================================================

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


  // ==================================================
  // 履歴
  // ==================================================

  track.zoneHistory.push(
    newZone
  );


  if (
    track.zoneHistory.length >
    12
  ) {

    track.zoneHistory.shift();

  }


  track.currentZone =
    newZone;


  // ==================================================
  // 入室
  // ==================================================

  checkEntry(
    track,
    oldZone,
    newZone
  );


  // ==================================================
  // 退出
  // ==================================================

  checkExit(
    track,
    oldZone,
    newZone
  );

}


// ======================================================
// 入室
//
// A → B → C
// ======================================================

function checkEntry(
  track,
  oldZone,
  newZone
) {

  // すでに中にいる人は入室しない
  if (
    track.inside
  ) {

    return;

  }


  // ==================================================
  // A → B
  // ==================================================

  if (
    oldZone === "A" &&
    newZone === "B"
  ) {

    track.entryProgress =
      1;

    console.log(
      "人物",
      track.id,
      "A→B",
      "【入室準備】"
    );

    return;

  }


  // ==================================================
  // B → A
  //
  // 戻ったのでやり直し
  // ==================================================

  if (
    oldZone === "B" &&
    newZone === "A"
  ) {

    track.entryProgress =
      0;

    console.log(
      "人物",
      track.id,
      "B→A",
      "【入室キャンセル】"
    );

    return;

  }


  // ==================================================
  // B → C
  // ==================================================

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


  // ==================================================
  // A → C
  //
  // Bを一瞬で通過した場合
  //
  // Aにいた人がCまで進んだ場合のみ
  // 入室として扱う
  // ==================================================

  if (
    oldZone === "A" &&
    newZone === "C"
  ) {

    console.log(
      "人物",
      track.id,
      "A→C",
      "【B高速通過】"
    );

    executeEntry(
      track
    );

    return;

  }

}


// ======================================================
// 入室実行
// ======================================================

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


  // ==================================================
  // 入室
  // ==================================================

  enteredCount++;


  currentPeopleCount =
    currentPeopleCount + 1;


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
    "入室経路:",
    track.zoneHistory.join(" → ")
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


// ======================================================
// 退出
//
// C → B → A
// C → A
// ======================================================

function checkExit(
  track,
  oldZone,
  newZone
) {

  // ==================================================
  // inside=trueの人だけ退出可能
  // ==================================================

  if (
    track.inside !== true
  ) {

    return;

  }


  // ==================================================
  // C → B
  // ==================================================

  if (
    oldZone === "C" &&
    newZone === "B"
  ) {

    track.exitState =
      2;


    console.log(
      "人物",
      track.id,
      "C→B",
      "【退出準備】"
    );

    return;

  }


  // ==================================================
  // C → A
  //
  // Bを完全に飛ばした場合
  // ==================================================

  if (
    oldZone === "C" &&
    newZone === "A"
  ) {

    console.log(
      "人物",
      track.id,
      "C→A",
      "【退出】"
    );

    executeExit(
      track
    );

    return;

  }


  // ==================================================
  // B → A
  //
  // C → B → A
  // ==================================================

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
        "C→B→A",
        "【退出】"
      );

      executeExit(
        track
      );

      return;

    }


    // Cを通っていないB→Aは退出にしない
    track.exitState =
      0;

    return;

  }


  // ==================================================
  // B → C
  //
  // 戻ったので退出キャンセル
  // ==================================================

  if (
    oldZone === "B" &&
    newZone === "C"
  ) {

    track.exitState =
      0;

    console.log(
      "人物",
      track.id,
      "B→C",
      "【退出キャンセル】"
    );

    return;

  }


  // ==================================================
  // A → B
  // ==================================================

  if (
    oldZone === "A" &&
    newZone === "B"
  ) {

    track.exitState =
      0;

    return;

  }

}


// ======================================================
// 退出実行
// ======================================================

function executeExit(
  track
) {

  // inside=trueだけ退出
  if (
    track.inside !== true
  ) {

    return;

  }


  const now =
    Date.now();


  // ==================================================
  // 二重退出防止
  // ==================================================

  if (
    now -
    track.lastCountTime
    <
    COUNT_COOLDOWN
  ) {

    return;

  }


  // ==================================================
  // 退出
  // ==================================================

  exitedCount++;


  currentPeopleCount =
    Math.max(
      0,
      currentPeopleCount - 1
    );


  // ==================================================
  // 退出済みにする
  // ==================================================

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


// ======================================================
// Firebase
// ======================================================

async function sendPeopleData() {

  try {

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
        "vertical-ABC",

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


    console.log(
      "Firebase送信:",
      data
    );


  } catch (error) {

    console.error(
      "Firebase送信エラー:",
      error
    );

  }

}


// ======================================================
// リセット
// ======================================================

function resetSystem() {

  console.log(
    "=============================="
  );

  console.log(
    "★ リセット"
  );

  console.log(
    "=============================="
  );


  visiblePeopleCount =
    0;

  enteredCount =
    0;

  exitedCount =
    0;

  currentPeopleCount =
    0;


  tracks =
    [];


  nextTrackId =
    1;


  predictions =
    [];


  sendPeopleData();


  console.log(
    "★ リセット完了"
  );

}


// ======================================================
// draw
// ======================================================

function draw() {

  background(20);


  // ==================================================
  // カメラ
  // ==================================================

  if (
    cameraReady
  ) {

    drawCamera();

  } else {

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


  // ==================================================
  // A/B/C
  // ==================================================

  drawZones();


  // ==================================================
  // 人物枠
  // ==================================================

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


  // ==================================================
  // 人数
  // ==================================================

  drawPeopleCount();


  // ==================================================
  // 追跡状態
  // ==================================================

  drawTrackingInfo();


  // ==================================================
  // 状態
  // ==================================================

  drawStatus();


  // ==================================================
  // AI
  // ==================================================

  if (
    modelReady &&
    cameraReady &&
    !detecting
  ) {

    detectPeople();

  }

}


// ======================================================
// カメラ表示
// ======================================================

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


// ======================================================
// ★縦ABC表示
//
// カメラ映像と同じgeometryを使用
// ======================================================

function drawZones() {

  const geometry =
    getVideoGeometry();


  const topA =
    geometry.offsetY +
    geometry.drawHeight *
    ZONE_A_END;


  const topB =
    geometry.offsetY +
    geometry.drawHeight *
    ZONE_B_END;


  stroke(
    255,
    255,
    0
  );

  strokeWeight(4);


  // A/B境界
  line(
    geometry.offsetX,
    topA,
    geometry.offsetX +
      geometry.drawWidth,
    topA
  );


  // B/C境界
  line(
    geometry.offsetX,
    topB,
    geometry.offsetX +
      geometry.drawWidth,
    topB
  );


  noStroke();


  // ==================================================
  // A
  // ==================================================

  fill(
    0,
    0,
    0,
    150
  );

  rect(
    0,
    0,
    width,
    70
  );


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
    width / 2,
    geometry.offsetY +
      geometry.drawHeight *
      0.16
  );


  // ==================================================
  // B
  // ==================================================

  text(
    "B：中間",
    width / 2,
    geometry.offsetY +
      geometry.drawHeight *
      0.50
  );


  // ==================================================
  // C
  // ==================================================

  text(
    "C：出口",
    width / 2,
    geometry.offsetY +
      geometry.drawHeight *
      0.84
  );


  // ==================================================
  // 説明
  // ==================================================

  fill(255);

  textSize(
    Math.max(
      15,
      width * 0.017
    )
  );


  text(
    "A ↓ B ↓ C = 入室",
    width / 2,
    height - 45
  );


  text(
    "C ↑ B ↑ A / C ↑ A = 退出",
    width / 2,
    height - 18
  );

}


// ======================================================
// ★人物枠
//
// カメラ映像と完全に同じ座標変換
// ======================================================

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


  // ==================================================
  // カメラ座標 → 画面座標
  // ==================================================

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


  // ==================================================
  // 人物中心
  // ==================================================

  const centerX =
    x +
    w / 2;


  const centerY =
    y +
    h / 2;


  const zone =
    getZone(
      centerX,
      centerY
    );


  // ==================================================
  // IDを探す
  // ==================================================

  const track =
    findTrackForPrediction(
      prediction
    );


  let trackId =
    "--";


  let insideText =
    "外";


  if (track) {

    trackId =
      track.id;

    if (
      track.inside
    ) {

      insideText =
        "入室中";

    }

  }


  // ==================================================
  // 枠
  // ==================================================

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


  // ==================================================
  // ラベル背景
  // ==================================================

  noStroke();

  fill(
    0,
    0,
    0,
    200
  );


  rect(
    drawX,
    Math.max(
      0,
      drawY - 58
    ),
    220,
    58
  );


  // ==================================================
  // ラベル
  // ==================================================

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
      15,
      drawY - 43
    )
  );


  text(
    "ZONE: " +
    zone +
    "  " +
    insideText,
    drawX + 8,
    Math.max(
      37,
      drawY - 23
    )
  );


  // ==================================================
  // 信頼度
  // ==================================================

  const confidence =
    Math.round(
      prediction.score * 100
    );


  fill(
    0,
    255,
    0
  );


  text(
    confidence +
    "%",
    drawX +
      drawW -
      45,
    drawY + 20
  );

}


// ======================================================
// predictionからtrackを探す
// ======================================================

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


// ======================================================
// 人数表示
// ======================================================

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
    90,
    310,
    190,
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
    120
  );


  textSize(34);


  text(
    "現在：" +
    currentPeopleCount +
    "人",
    40,
    165
  );


  textSize(19);


  text(
    "入室：" +
    enteredCount +
    "人",
    40,
    205
  );


  text(
    "退出：" +
    exitedCount +
    "人",
    165,
    205
  );


  textSize(16);


  text(
    "カメラ内：" +
    visiblePeopleCount +
    "人",
    40,
    240
  );


  text(
    "追跡中：" +
    tracks.length +
    "人",
    40,
    265
  );

}


// ======================================================
// ★追跡状態表示
// ======================================================

function drawTrackingInfo() {

  if (
    tracks.length === 0
  ) {

    return;

  }


  const startX =
    width - 260;


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
    100,
    250,
    70 +
      tracks.length *
      42,
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


    let status =
      "外";


    if (
      track.inside
    ) {

      status =
        "入室中";

    }


    fill(255);


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


// ======================================================
// 状態表示
// ======================================================

function drawStatus() {

  textAlign(
    RIGHT
  );


  textSize(17);


  // ==================================================
  // カメラ
  // ==================================================

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

  } else {

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


  // ==================================================
  // AI
  // ==================================================

  if (
    modelReady
  ) {

    fill(
      0,
      255,
      0
    );


    text(
      "AI：高感度・追跡中",
      width - 20,
      55
    );

  } else {

    fill(255);


    text(
      "AI：読み込み中",
      width - 20,
      55
    );

  }


  // ==================================================
  // Firebase
  // ==================================================

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

  } else {

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

}
