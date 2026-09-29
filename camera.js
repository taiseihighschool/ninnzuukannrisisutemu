// ======================================================
// AI人数管理システム
// 縦方向A・B・C + 高感度 + 退出追跡強化版
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
// ★感度設定
// ======================================================

// COCO-SSDの人物認識しきい値
// 小さくすると検出しやすくなる
const PERSON_CONFIDENCE = 0.35;


// AI認識から一時的に消えても
// この時間までは同じ人物として保持
const TRACK_TIMEOUT = 3500;


// 前回位置からこの距離以内なら
// 同じ人物として追跡
const MATCH_DISTANCE = 180;


// ======================================================
// 縦方向ゾーン
// ======================================================
//
// 上
// ┌──────┐
// │  A   │
// ├──────┤
// │  B   │
// ├──────┤
// │  C   │
// └──────┘
// 下
// ======================================================

const ZONE_A_END = 0.33;
const ZONE_B_END = 0.66;


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
  // 検出人物
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
    // 同じ人物
    // ==================================================

    if (bestDetection) {

      bestDetection.matched =
        true;


      const oldZone =
        getZone(
          track.x,
          track.y
        );


      const newZone =
        getZone(
          bestDetection.x,
          bestDetection.y
        );


      track.x =
        bestDetection.x;


      track.y =
        bestDetection.y;


      track.lastSeen =
        now;


      track.prediction =
        bestDetection.prediction;


      updateZoneHistory(
        track,
        oldZone,
        newZone
      );

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
      // 2 = B通過
      // ----------------------------------------------

      exitState:
        0,


      lastCountTime:
        0

    });

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


  return 960;

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
// ★縦方向A/B/C判定
//
// y座標で判定する
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


  // ----------------------------------------------
  // 上 1/3
  // ----------------------------------------------

  if (
    ratio <
    ZONE_A_END
  ) {

    return "A";

  }


  // ----------------------------------------------
  // 中央 1/3
  // ----------------------------------------------

  if (
    ratio <
    ZONE_B_END
  ) {

    return "B";

  }


  // ----------------------------------------------
  // 下 1/3
  // ----------------------------------------------

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

  if (
    oldZone === newZone
  ) {

    return;

  }


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
    10
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
      "A→B 入室準備"
    );


    return;

  }


  // ==================================================
  // B → A
  //
// 入室方向から戻った
  // ==================================================

  if (
    oldZone === "B" &&
    newZone === "A"
  ) {

    track.entryProgress =
      0;


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

    const now =
      Date.now();


    if (
      now -
      track.lastCountTime
      <
      500
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
      "A → B → C"
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

}


// ======================================================
// ★退出専用状態管理
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
  // inside=trueだけ
  // ==================================================

  if (
    track.inside !== true
  ) {

    return;

  }


  // ==================================================
  // C → B
  //
  // 退出準備
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
      "C→B"
    );

    console.log(
      "退出準備"
    );


    return;

  }


  // ==================================================
  // C → A
  //
  // Bを飛ばしても退出
  // ==================================================

  if (
    oldZone === "C" &&
    newZone === "A"
  ) {

    console.log(
      "人物",
      track.id,
      "C→A"
    );


    executeExit(
      track
    );


    return;

  }


  // ==================================================
  // B → A
  //
  // C→B→A
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
        "C→B→A 退出"
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
      "退出キャンセル"
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

  // ==================================================
  // 退出対象か確認
  // ==================================================

  if (
    track.inside !== true
  ) {

    return;

  }


  const now =
    Date.now();


  // ==================================================
  // 連続カウント防止
  // ==================================================

  if (
    now -
    track.lastCountTime
    <
    500
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
  // 退出済み
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
  // ABC
  // ==================================================

  drawZones();


  // ==================================================
  // 人数
  // ==================================================

  drawPeopleCount();


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

  const videoWidth =
    getActualVideoWidth();


  const videoHeight =
    getActualVideoHeight();


  if (
    !videoWidth ||
    !videoHeight
  ) {

    return;

  }


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
      (width -
        drawWidth) / 2;


    offsetY =
      0;

  } else {

    drawWidth =
      width;


    drawHeight =
      width /
      videoRatio;


    offsetX =
      0;


    offsetY =
      (height -
        drawHeight) / 2;

  }


  image(
    video,
    offsetX,
    offsetY,
    drawWidth,
    drawHeight
  );

}


// ======================================================
// ★縦ABC表示
// ======================================================

function drawZones() {

  // ==================================================
  // A/B境界
  // ==================================================

  stroke(
    255,
    255,
    0
  );

  strokeWeight(4);


  line(
    0,
    height * ZONE_A_END,
    width,
    height * ZONE_A_END
  );


  // ==================================================
  // B/C境界
  // ==================================================

  line(
    0,
    height * ZONE_B_END,
    width,
    height * ZONE_B_END
  );


  noStroke();


  // ==================================================
  // 上部表示
  // ==================================================

  fill(
    0,
    0,
    0,
    160
  );


  rect(
    0,
    0,
    width,
    80
  );


  // ==================================================
  // A
  // ==================================================

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
    height * 0.16
  );


  // ==================================================
  // B
  // ==================================================

  text(
    "B：中間",
    width / 2,
    height * 0.50
  );


  // ==================================================
  // C
  // ==================================================

  text(
    "C：出口",
    width / 2,
    height * 0.84
  );


  // ==================================================
  // 説明
  // ==================================================

  fill(255);


  textSize(
    Math.max(
      16,
      width * 0.018
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
// 人物枠
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


  const videoWidth =
    getActualVideoWidth();


  const videoHeight =
    getActualVideoHeight();


  const scaleX =
    width /
    videoWidth;


  const scaleY =
    height /
    videoHeight;


  const drawX =
    x * scaleX;


  const drawY =
    y * scaleY;


  const drawW =
    w * scaleX;


  const drawH =
    h * scaleY;


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
  // 信頼度
  // ==================================================

  const confidence =
    Math.round(
      prediction.score * 100
    );


  noStroke();


  fill(
    0,
    0,
    0,
    180
  );


  rect(
    drawX,
    Math.max(
      0,
      drawY - 32
    ),
    160,
    32
  );


  fill(255);


  textAlign(
    LEFT,
    CENTER
  );


  textSize(16);


  text(
    "Person " +
    confidence +
    "%",
    drawX + 8,
    Math.max(
      16,
      drawY - 16
    )
  );

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
    180
  );


  rect(
    20,
    100,
    300,
    175,
    15
  );


  fill(255);


  textAlign(
    LEFT
  );


  textSize(20);


  text(
    "AI入退室管理",
    40,
    130
  );


  textSize(34);


  text(
    "現在：" +
    currentPeopleCount +
    "人",
    40,
    175
  );


  textSize(19);


  text(
    "入室：" +
    enteredCount +
    "人",
    40,
    215
  );


  text(
    "退出：" +
    exitedCount +
    "人",
    165,
    215
  );


  textSize(16);


  text(
    "カメラ内：" +
    visiblePeopleCount +
    "人",
    40,
    245
  );

}


// ======================================================
// 状態
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
      "AI：高感度モード",
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
