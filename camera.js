// ======================================================
// AI人数管理システム
// タブレット横画面専用 完成版
//
// A → B → C = 入室
// C → B → A = 退出
//
// p5.js
// TensorFlow.js
// COCO-SSD
// Firebase Realtime Database
// ======================================================


let video;

let model;

let predictions = [];


// ======================================================
// 人数データ
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


const TRACK_TIMEOUT = 2500;

const MATCH_DISTANCE = 140;


// ======================================================
// A・B・C
// 横方向
// ======================================================

const ZONE_A_END = 0.33;

const ZONE_B_END = 0.66;


// ======================================================
// 画面サイズ
// ======================================================

let canvasWidth = 1280;

let canvasHeight = 720;


// ======================================================
// setup
// ======================================================

function setup() {

  // --------------------------------------------------
  // 横画面サイズを作る
  // --------------------------------------------------

  updateCanvasSize();

  const canvas =
    createCanvas(
      canvasWidth,
      canvasHeight
    );

  canvas.parent("app");


  // --------------------------------------------------
  // 背面カメラ
  // --------------------------------------------------

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


  // --------------------------------------------------
  // カメラを隠す
  // --------------------------------------------------

  video.hide();


  // --------------------------------------------------
  // AIモデル読み込み
  // --------------------------------------------------

  loadAIModel();

}


// ======================================================
// 画面サイズ更新
// ======================================================

function updateCanvasSize() {

  const screenWidth =
    windowWidth;

  const screenHeight =
    windowHeight;


  // --------------------------------------------------
  // 横画面
  // --------------------------------------------------

  if (
    screenWidth >= screenHeight
  ) {

    canvasWidth =
      screenWidth;

    canvasHeight =
      screenHeight;

  }

  // --------------------------------------------------
  // 縦向きになった場合
  // --------------------------------------------------

  else {

    // 縦向きでも横向きの
    // 16:9領域を作る

    canvasHeight =
      screenWidth * 9 / 16;

    canvasWidth =
      screenWidth;

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
// AIモデル
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
// 人物認識
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


    // ------------------------------------------------
    // personだけ取り出す
    // ------------------------------------------------

    for (
      let i = 0;
      i < predictions.length;
      i++
    ) {

      const prediction =
        predictions[i];


      if (

        prediction.class ===
        "person"

        &&

        prediction.score >=
        0.50

      ) {

        persons.push(
          prediction
        );

      }

    }


    visiblePeopleCount =
      persons.length;


    updateTracks(
      persons
    );


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

function updateTracks(
  persons
) {

  const now =
    Date.now();


  let detections = [];


  // --------------------------------------------------
  // 検出位置
  // --------------------------------------------------

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


  // --------------------------------------------------
  // 既存人物と照合
  // --------------------------------------------------

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


    // ------------------------------------------------
    // 同じ人物として更新
    // ------------------------------------------------

    if (bestDetection) {

      bestDetection.matched =
        true;


      const oldZone =
        getZone(
          track.x
        );


      const newZone =
        getZone(
          bestDetection.x
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


  // --------------------------------------------------
  // 新しい人物
  // --------------------------------------------------

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
        detection.x
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

      inside:
        false,

      entryProgress:
        0,

      exitProgress:
        0,

      lastCountTime:
        0

    });

  }


  // --------------------------------------------------
  // 古い人物を削除
  // --------------------------------------------------

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
// A/B/C判定
// ======================================================

function getZone(
  x
) {

  const ratio =
    x / width;


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
// ゾーン移動
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


  checkEntry(
    track
  );


  checkExit(
    track
  );

}


// ======================================================
// 入室
//
// A → B → C
// ======================================================

function checkEntry(
  track
) {

  if (
    track.inside
  ) {

    return;

  }


  const history =
    track.zoneHistory;


  if (
    history.length <
    2
  ) {

    return;

  }


  const n =
    history.length;


  const previous =
    history[n - 2];


  const current =
    history[n - 1];


  // --------------------------------------------------
  // A → B
  // --------------------------------------------------

  if (

    previous === "A"

    &&

    current === "B"

  ) {

    track.entryProgress =
      1;


    console.log(

      "人物",

      track.id,

      "入室判定 A→B"

    );

  }


  // --------------------------------------------------
  // B → C
  // --------------------------------------------------

  if (

    previous === "B"

    &&

    current === "C"

    &&

    track.entryProgress === 1

  ) {

    const now =
      Date.now();


    if (

      now -
      track.lastCountTime

      <

      2000

    ) {

      return;

    }


    enteredCount++;


    currentPeopleCount++;


    track.inside =
      true;


    track.entryProgress =
      0;


    track.lastCountTime =
      now;


    console.log(
      "===================="
    );


    console.log(
      "入室を検出"
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
      "===================="
    );


    sendPeopleData();

  }

}


// ======================================================
// 退出
//
// C → B → A
// ======================================================

function checkExit(
  track
) {

  if (
    !track.inside
  ) {

    return;

  }


  const history =
    track.zoneHistory;


  if (
    history.length <
    2
  ) {

    return;

  }


  const n =
    history.length;


  const previous =
    history[n - 2];


  const current =
    history[n - 1];


  // --------------------------------------------------
  // C → B
  // --------------------------------------------------

  if (

    previous === "C"

    &&

    current === "B"

  ) {

    track.exitProgress =
      1;


    console.log(

      "人物",

      track.id,

      "退出判定 C→B"

    );

  }


  // --------------------------------------------------
  // B → A
  // --------------------------------------------------

  if (

    previous === "B"

    &&

    current === "A"

    &&

    track.exitProgress === 1

  ) {

    const now =
      Date.now();


    if (

      now -
      track.lastCountTime

      <

      2000

    ) {

      return;

    }


    exitedCount++;


    currentPeopleCount =
      Math.max(

        0,

        currentPeopleCount - 1

      );


    track.inside =
      false;


    track.exitProgress =
      0;


    track.lastCountTime =
      now;


    console.log(
      "===================="
    );


    console.log(
      "退出を検出"
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
      "===================="
    );


    sendPeopleData();

  }

}


// ======================================================
// Firebase送信
// ======================================================

async function sendPeopleData() {

  try {

    if (
      window.firebaseReady
    ) {

      await window.firebaseReady;

    }


    if (

      !window.firebaseDB

      ||

      !window.firebaseRef

      ||

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
        "landscape",

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


  } catch (error) {

    console.error(

      "Firebase送信エラー:",

      error

    );

  }

}


// ======================================================
// draw
// ======================================================

function draw() {

  background(20);


  // ==================================================
  // カメラ映像
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
  // 人物認識枠
  // ==================================================

  for (
    let i = 0;
    i < predictions.length;
    i++
  ) {

    const prediction =
      predictions[i];


    if (

      prediction.class ===
      "person"

      &&

      prediction.score >=
      0.50

    ) {

      drawPersonBox(
        prediction
      );

    }

  }


  // ==================================================
  // A/B/C
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
  // AI再実行
  // ==================================================

  if (

    modelReady

    &&

    cameraReady

    &&

    !detecting

  ) {

    detectPeople();

  }

}


// ======================================================
// カメラ映像を横画面に合わせる
// ======================================================

function drawCamera() {

  const videoWidth =
    video.width;


  const videoHeight =
    video.height;


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


  // --------------------------------------------------
  // 横画面に合わせる
  // --------------------------------------------------

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

  }


  else {

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
// A/B/C表示
// ======================================================

function drawZones() {

  // --------------------------------------------------
  // 境界線
  // --------------------------------------------------

  stroke(
    255,
    255,
    0
  );

  strokeWeight(4);


  line(

    width * ZONE_A_END,

    0,

    width * ZONE_A_END,

    height

  );


  line(

    width * ZONE_B_END,

    0,

    width * ZONE_B_END,

    height

  );


  noStroke();


  // --------------------------------------------------
  // 上部ラベル背景
  // --------------------------------------------------

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
    90
  );


  // --------------------------------------------------
  // A
  // --------------------------------------------------

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
      22,
      width * 0.025
    )
  );


  text(

    "A：入口",

    width * 0.165,

    40

  );


  // --------------------------------------------------
  // B
  // --------------------------------------------------

  text(

    "B：中間",

    width * 0.50,

    40

  );


  // --------------------------------------------------
  // C
  // --------------------------------------------------

  text(

    "C：出口",

    width * 0.835,

    40

  );


  // --------------------------------------------------
  // 入室・退出
  // --------------------------------------------------

  textSize(
    Math.max(
      16,
      width * 0.018
    )
  );


  fill(255);


  text(

    "A → B → C  =  入室",

    width * 0.50,

    height - 45

  );


  text(

    "C → B → A  =  退出",

    width * 0.50,

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


  // --------------------------------------------------
  // 元映像 960×720 を
  // 現在画面へ変換
  // --------------------------------------------------

  const scaleX =
    width /
    960;


  const scaleY =
    height /
    720;


  const drawX =
    x *
    scaleX;


  const drawY =
    y *
    scaleY;


  const drawW =
    w *
    scaleX;


  const drawH =
    h *
    scaleY;


  // --------------------------------------------------
  // 枠
  // --------------------------------------------------

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


  // --------------------------------------------------
  // 信頼度
  // --------------------------------------------------

  const confidence =
    Math.round(
      prediction.score *
      100
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

    105,

    300,

    170,

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

    135

  );


  textSize(34);


  text(

    "現在：" +
    currentPeopleCount +
    "人",

    40,

    180

  );


  textSize(19);


  text(

    "入室：" +
    enteredCount +
    "人",

    40,

    220

  );


  text(

    "退出：" +
    exitedCount +
    "人",

    165,

    220

  );


  textSize(16);


  text(

    "カメラ内：" +
    visiblePeopleCount +
    "人",

    40,

    250

  );

}


// ======================================================
// ステータス
// ======================================================

function drawStatus() {

  textAlign(
    RIGHT
  );


  textSize(17);


  // --------------------------------------------------
  // カメラ
  // --------------------------------------------------

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


  // --------------------------------------------------
  // AI
  // --------------------------------------------------

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


  // --------------------------------------------------
  // Firebase
  // --------------------------------------------------

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

}
