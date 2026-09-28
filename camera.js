// ======================================================
// AI人数管理システム
// 退出追跡強化版
//
// 入室:
// A → B → C
//
// 退出:
// C → B → A
// C → A
//
// 退出専用状態管理:
// 0 = 通常
// 1 = C到達・退出準備
// 2 = B通過・退出中
//
// Firebase対応
// リセット対応
// 背面カメラ
// 横画面
// COCO-SSD
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
// システム状態
// ======================================================

let modelReady = false;
let cameraReady = false;
let detecting = false;


// ======================================================
// 人物追跡
// ======================================================

let tracks = [];
let nextTrackId = 1;


// AIから一時的に消えても追跡を維持する時間
const TRACK_TIMEOUT = 2500;


// 前回位置から何px以内なら同じ人物と判断するか
const MATCH_DISTANCE = 140;


// ======================================================
// A・B・Cゾーン
// ======================================================

const ZONE_A_END = 0.33;
const ZONE_B_END = 0.66;


// ======================================================
// AI検出信頼度
// ======================================================

const PERSON_CONFIDENCE = 0.50;


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
  // AI読み込み
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
// COCO-SSD
// ======================================================

async function loadAIModel() {

  console.log(
    "COCO-SSDを読み込んでいます..."
  );

  try {

    model = await cocoSsd.load();

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

  if (!modelReady || !cameraReady) {
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
    // personだけ抽出
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
    // 現在カメラに映っている人数
    // ==================================================

    visiblePeopleCount =
      persons.length;


    // ==================================================
    // 人物追跡
    // ==================================================

    updateTracks(persons);


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

  const now = Date.now();

  let detections = [];


  // ==================================================
  // 検出人物の中心座標
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
  // 既存人物と照合
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
    // 同一人物として更新
    // ==================================================

    if (bestDetection) {

      bestDetection.matched =
        true;


      const oldZone =
        getZone(track.x);


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
        detection.x
      );


    tracks.push({

      // ----------------------------------------------
      // 人物ID
      // ----------------------------------------------

      id:
        nextTrackId++,


      // ----------------------------------------------
      // 座標
      // ----------------------------------------------

      x:
        detection.x,

      y:
        detection.y,


      // ----------------------------------------------
      // 最終検出時間
      // ----------------------------------------------

      lastSeen:
        now,


      // ----------------------------------------------
      // AI検出結果
      // ----------------------------------------------

      prediction:
        detection.prediction,


      // ----------------------------------------------
      // 現在のゾーン
      // ----------------------------------------------

      currentZone:
        initialZone,


      // ----------------------------------------------
      // ゾーン履歴
      // ----------------------------------------------

      zoneHistory:
        [initialZone],


      // ----------------------------------------------
      // 入室状態
      // ----------------------------------------------

      inside:
        false,


      // ----------------------------------------------
      // 入室進行
      //
      // 0 = 何もなし
      // 1 = A→B
      // ----------------------------------------------

      entryProgress:
        0,


      // ----------------------------------------------
      // ★退出専用状態
      //
      // 0 = 通常
      // 1 = C到達
      // 2 = B通過
      // ----------------------------------------------

      exitState:
        0,


      // ----------------------------------------------
      // 最後に人数を変更した時間
      // ----------------------------------------------

      lastCountTime:
        0

    });

  }


  // ==================================================
  // 古い追跡を削除
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
// 実際のカメラ映像幅を取得
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
// 実際のカメラ映像高さ
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
// A/B/C判定
//
// ★カメラ映像の実際の幅を使用
// ======================================================

function getZone(x) {

  const actualVideoWidth =
    getActualVideoWidth();


  const ratio =
    x /
    actualVideoWidth;


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
  // ゾーン履歴
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
// 入室判定
//
// A → B → C
// ======================================================

function checkEntry(
  track,
  oldZone,
  newZone
) {

  // --------------------------------------------------
  // すでに中にいる
  // --------------------------------------------------

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
  // 入室をやめた
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


    // ------------------------------------------------
    // 連続カウント防止
    // ------------------------------------------------

    if (
      now -
      track.lastCountTime
      <
      800
    ) {

      return;

    }


    // ------------------------------------------------
    // 入室
    // ------------------------------------------------

    enteredCount++;


    currentPeopleCount =
      currentPeopleCount + 1;


    track.inside =
      true;


    track.entryProgress =
      0;


    // 退出状態を完全リセット
    track.exitState =
      0;


    track.lastCountTime =
      now;


    console.log(
      "================================"
    );

    console.log(
      "★ 入室を検出"
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
// exitState
//
// 0 = 通常
//
// 1 = C到達
//     ↓
//     退出する可能性あり
//
// 2 = B通過
//     ↓
//     Aに行けば退出
// ======================================================

function checkExit(
  track,
  oldZone,
  newZone
) {

  // ==================================================
  // 条件
  //
  // inside === true の人物だけ退出対象
  // ==================================================

  if (
    track.inside !== true
  ) {

    return;

  }


  // ==================================================
  // ★ C → B
  //
  // 退出開始
  // ==================================================

  if (
    oldZone === "C" &&
    newZone === "B"
  ) {

    track.exitState =
      2;


    console.log(
      "--------------------------------"
    );

    console.log(
      "人物",
      track.id,
      "C→B"
    );

    console.log(
      "退出状態 = 2"
    );

    console.log(
      "B通過を記録"
    );

    console.log(
      "--------------------------------"
    );


    return;

  }


  // ==================================================
  // ★ C → A
  //
  // Bを検出できなかった場合
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

    console.log(
      "Bを飛ばした退出"
    );


    executeExit(
      track
    );


    return;

  }


  // ==================================================
  // ★ B → A
  //
  // C→Bを確認していれば退出
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
        "B→A"
      );

      console.log(
        "C→B→A 退出確定"
      );


      executeExit(
        track
      );


      return;

    }


    // ------------------------------------------------
    // C→Bを確認していない場合
    // ------------------------------------------------

    track.exitState =
      0;


    return;

  }


  // ==================================================
  // ★ B → C
  //
  // 退出をキャンセル
  //
  // 例:
  // C → B → C
  // ==================================================

  if (
    oldZone === "B" &&
    newZone === "C"
  ) {

    if (
      track.exitState === 2
    ) {

      console.log(
        "人物",
        track.id,
        "B→C"
      );

      console.log(
        "退出キャンセル"
      );

    }


    track.exitState =
      0;


    return;

  }


  // ==================================================
  // ★ A → B
  //
  // 退出方向ではない
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
// ★退出実行
// ======================================================

function executeExit(
  track
) {

  // ==================================================
  // すでに退出済みなら絶対に数えない
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
    800
  ) {

    return;

  }


  // ==================================================
  // 退出人数
  // ==================================================

  exitedCount++;


  // ==================================================
  // 現在人数
  // ==================================================

  currentPeopleCount =
    Math.max(
      0,
      currentPeopleCount - 1
    );


  // ==================================================
  // ★退出済みにする
  // ==================================================

  track.inside =
    false;


  // ==================================================
  // 退出状態リセット
  // ==================================================

  track.exitState =
    0;


  track.entryProgress =
    0;


  track.lastCountTime =
    now;


  // ==================================================
  // ログ
  // ==================================================

  console.log(
    "================================"
  );

  console.log(
    "★ 退出を検出"
  );

  console.log(
    "人物ID:",
    track.id
  );

  console.log(
    "退出人数:",
    exitedCount
  );

  console.log(
    "現在人数:",
    currentPeopleCount
  );

  console.log(
    "================================"
  );


  // ==================================================
  // Firebase
  // ==================================================

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
// ★リセット
// ======================================================

function resetSystem() {

  console.log(
    "=============================="
  );

  console.log(
    "★ リセット命令を受信"
  );

  console.log(
    "=============================="
  );


  // ==================================================
  // 人数
  // ==================================================

  visiblePeopleCount =
    0;

  enteredCount =
    0;

  exitedCount =
    0;

  currentPeopleCount =
    0;


  // ==================================================
  // 人物追跡を完全リセット
  // ==================================================

  tracks =
    [];

  nextTrackId =
    1;


  // ==================================================
  // AI検出結果
  // ==================================================

  predictions =
    [];


  // ==================================================
  // Firebase
  // ==================================================

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

  if (cameraReady) {

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
  // ゾーン
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
    modelReady &&
    cameraReady &&
    !detecting
  ) {

    detectPeople();

  }

}


// ======================================================
// カメラ描画
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
// ゾーン表示
// ======================================================

function drawZones() {

  stroke(
    255,
    255,
    0
  );

  strokeWeight(4);


  // A
  line(
    width * ZONE_A_END,
    0,
    width * ZONE_A_END,
    height
  );


  // B
  line(
    width * ZONE_B_END,
    0,
    width * ZONE_B_END,
    height
  );


  noStroke();


  // ==================================================
  // 上部背景
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
    90
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
      22,
      width * 0.025
    )
  );


  text(
    "A：入口",
    width * 0.165,
    40
  );


  // ==================================================
  // B
  // ==================================================

  text(
    "B：中間",
    width * 0.50,
    40
  );


  // ==================================================
  // C
  // ==================================================

  text(
    "C：出口",
    width * 0.835,
    40
  );


  // ==================================================
  // 説明
  // ==================================================

  textSize(
    Math.max(
      16,
      width * 0.018
    )
  );


  fill(255);


  text(
    "A → B → C = 入室",
    width * 0.50,
    height - 45
  );


  text(
    "C → B → A / C → A = 退出",
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


  const actualVideoWidth =
    getActualVideoWidth();


  const actualVideoHeight =
    getActualVideoHeight();


  const scaleX =
    width /
    actualVideoWidth;


  const scaleY =
    height /
    actualVideoHeight;


  const drawX =
    x * scaleX;


  const drawY =
    y * scaleY;


  const drawW =
    w * scaleX;


  const drawH =
    h * scaleY;


  // ==================================================
  // 緑枠
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

  if (cameraReady) {

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

  if (modelReady) {

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
