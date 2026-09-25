let video;
let model;

let predictions = [];


// ========================================
// 人数
// ========================================

// カメラに現在映っている人数
let visiblePeopleCount = 0;

// 入室した人数
let enteredCount = 0;

// 退出した人数
let exitedCount = 0;

// 現在の人数
let currentPeopleCount = 0;


// ========================================
// 状態
// ========================================

let modelReady = false;
let cameraReady = false;
let detecting = false;


// ========================================
// 追跡
// ========================================

let tracks = [];

let nextTrackId = 1;


// 人物が一時的に見えなくなっても
// この時間までは追跡を維持する
const TRACK_TIMEOUT = 2500;


// 同じ人物と判断する距離
const MATCH_DISTANCE = 140;


// ========================================
// 3エリア
// ========================================

// 画面を3つに分ける
//
// Zone A = 入口
// Zone B = 中間
// Zone C = 出口
//
// A → B → C = 入室
// C → B → A = 退出


const ZONE_A_END = 0.33;

const ZONE_B_END = 0.66;


// ========================================
// 起動
// ========================================

function setup() {

  createCanvas(960, 720);


  // ======================================
  // 背面カメラ
  // ======================================

  video = createCapture(
    {
      video: {
        facingMode: {
          ideal: "environment"
        }
      },

      audio: false
    },

    function() {

      cameraReady = true;

      console.log(
        "背面カメラ接続成功"
      );

    }
  );


  video.size(960, 720);

  video.hide();


  // AI読み込み

  loadAIModel();

}


// ========================================
// AIモデル
// ========================================

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


    detectPeople();

  }

  catch (error) {

    console.error(
      "AIモデル読み込みエラー:",
      error
    );

  }

}


// ========================================
// 人物認識
// ========================================

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


    // ==================================
    // personだけ取り出す
    // ==================================

    let persons = [];


    for (
      let i = 0;
      i < predictions.length;
      i++
    ) {

      const prediction =
        predictions[i];


      if (
        prediction.class === "person" &&
        prediction.score >= 0.50
      ) {

        persons.push(
          prediction
        );

      }

    }


    // カメラ内人数

    visiblePeopleCount =
      persons.length;


    // ==================================
    // 追跡
    // ==================================

    updateTracks(
      persons
    );


    // ==================================
    // Firebase
    // ==================================

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


// ========================================
// 追跡更新
// ========================================

function updateTracks(persons) {

  const now =
    Date.now();


  // ======================================
  // 人物の中心座標
  // ======================================

  let detections = [];


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


  // ======================================
  // 既存人物との照合
  // ======================================

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
        distance < bestDistance
      ) {

        bestDistance =
          distance;

        bestDetection =
          detection;

      }

    }


    // ====================================
    // 同じ人物
    // ====================================

    if (bestDetection) {

      bestDetection.matched =
        true;


      const oldZone =
        getZone(
          track.y
        );


      const newZone =
        getZone(
          bestDetection.y
        );


      // 座標更新

      track.x =
        bestDetection.x;

      track.y =
        bestDetection.y;


      track.lastSeen =
        now;


      track.prediction =
        bestDetection.prediction;


      // ==================================
      // エリア移動
      // ==================================

      updateZoneHistory(
        track,
        oldZone,
        newZone
      );

    }

  }


  // ======================================
  // 新しい人物
  // ======================================

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


      // 最初にいたエリア

      startZone:
        initialZone,


      // 現在のエリア

      currentZone:
        initialZone,


      // 通過したエリア

      zoneHistory:
        [
          initialZone
        ],


      // 入退室判定済みか

      counted:
        false,


      // 最後の判定時間

      lastCountTime:
        0

    });

  }


  // ======================================
  // 古い追跡を削除
  // ======================================

  tracks =
    tracks.filter(
      function(track) {

        return (
          now -
          track.lastSeen
          <
          TRACK_TIMEOUT
        );

      }
    );

}


// ========================================
// エリア判定
// ========================================

function getZone(y) {

  const ratio =
    y / height;


  if (
    ratio < ZONE_A_END
  ) {

    return "A";

  }


  if (
    ratio < ZONE_B_END
  ) {

    return "B";

  }


  return "C";

}


// ========================================
// エリア履歴更新
// ========================================

function updateZoneHistory(
  track,
  oldZone,
  newZone
) {

  // 同じエリアなら何もしない

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


  // ======================================
  // 履歴に追加
  // ======================================

  track.zoneHistory.push(
    newZone
  );


  // 履歴を最大10個まで

  if (
    track.zoneHistory.length > 10
  ) {

    track.zoneHistory.shift();

  }


  track.currentZone =
    newZone;


  // ======================================
  // 入室判定
  // ======================================

  checkEntry(
    track
  );


  // ======================================
  // 退出判定
  // ======================================

  checkExit(
    track
  );

}


// ========================================
// 入室判定
// ========================================
//
// A → B → C
//
// を通ったら入室
// ========================================

function checkEntry(track) {

  if (
    track.counted
  ) {

    return;

  }


  const history =
    track.zoneHistory;


  // 最後の3つを見る

  if (
    history.length < 3
  ) {

    return;

  }


  const n =
    history.length;


  const a =
    history[n - 3];

  const b =
    history[n - 2];

  const c =
    history[n - 1];


  // A → B → C

  if (
    a === "A" &&
    b === "B" &&
    c === "C"
  ) {

    const now =
      Date.now();


    // 二重判定防止

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


    track.counted =
      true;


    track.lastCountTime =
      now;


    console.log(
      "=========="
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
      "=========="
    );


    sendPeopleData();

  }

}


// ========================================
// 退出判定
// ========================================
//
// C → B → A
//
// を通ったら退出
// ========================================

function checkExit(track) {

  if (
    track.counted
  ) {

    return;

  }


  const history =
    track.zoneHistory;


  if (
    history.length < 3
  ) {

    return;

  }


  const n =
    history.length;


  const a =
    history[n - 3];

  const b =
    history[n - 2];

  const c =
    history[n - 1];


  // C → B → A

  if (
    a === "C" &&
    b === "B" &&
    c === "A"
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


    track.counted =
      true;


    track.lastCountTime =
      now;


    console.log(
      "=========="
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
      "=========="
    );


    sendPeopleData();

  }

}


// ========================================
// Firebase送信
// ========================================

async function sendPeopleData() {

  try {

    // Firebase準備待ち

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

      // 入退室から計算した人数

      peopleCount:
        currentPeopleCount,


      // 現在カメラに映っている人数

      visiblePeopleCount:
        visiblePeopleCount,


      // 累計入室

      enteredCount:
        enteredCount,


      // 累計退出

      exitedCount:
        exitedCount,


      cameraReady:
        cameraReady,


      modelReady:
        modelReady,


      camera:
        "tablet",


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

  }

  catch (error) {

    console.error(
      "Firebase送信エラー:",
      error
    );

  }

}


// ========================================
// 画面
// ========================================

function draw() {

  background(20);


  // ======================================
  // カメラ映像
  // ======================================

  if (cameraReady) {

    image(
      video,
      0,
      0,
      width,
      height
    );

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


  // ======================================
  // 人物枠
  // ======================================

  for (
    let i = 0;
    i < predictions.length;
    i++
  ) {

    const prediction =
      predictions[i];


    if (
      prediction.class === "person" &&
      prediction.score >= 0.50
    ) {

      drawPersonBox(
        prediction
      );

    }

  }


  // ======================================
  // 3エリア表示
  // ======================================

  drawZones();


  // ======================================
  // 人数
  // ======================================

  drawPeopleCount();


  // ======================================
  // 状態
  // ======================================

  drawStatus();


  // ======================================
  // 次の認識
  // ======================================

  if (
    modelReady &&
    cameraReady &&
    !detecting
  ) {

    detectPeople();

  }

}


// ========================================
// 3エリア表示
// ========================================

function drawZones() {

  // --------------------------------------
  // AとBの境界
  // --------------------------------------

  stroke(
    255,
    255,
    0
  );

  strokeWeight(3);

  line(
    0,
    height * ZONE_A_END,
    width,
    height * ZONE_A_END
  );


  // --------------------------------------
  // BとCの境界
  // --------------------------------------

  line(
    0,
    height * ZONE_B_END,
    width,
    height * ZONE_B_END
  );


  noStroke();


  // ======================================
  // エリア名
  // ======================================

  fill(
    255,
    255,
    0
  );

  textAlign(
    CENTER,
    CENTER
  );


  textSize(24);

  text(
    "A：入口エリア",
    width / 2,
    height * 0.16
  );


  text(
    "B：中間エリア",
    width / 2,
    height * 0.50
  );


  text(
    "C：出口エリア",
    width / 2,
    height * 0.83
  );


  textSize(16);

  text(
    "A → B → C = 入室",
    width / 2,
    height * 0.29
  );


  text(
    "C → B → A = 退出",
    width / 2,
    height * 0.70
  );

}


// ========================================
// 人物枠
// ========================================

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


  noFill();

  stroke(
    0,
    255,
    0
  );

  strokeWeight(3);

  rect(
    x,
    y,
    w,
    h
  );


  const confidence =
    Math.round(
      prediction.score * 100
    );


  noStroke();

  fill(
    0,
    180
  );

  rect(
    x,
    y - 30,
    150,
    30
  );


  fill(255);

  textAlign(
    LEFT,
    CENTER
  );

  textSize(15);

  text(
    "Person " +
    confidence +
    "%",
    x + 8,
    y - 15
  );

}


// ========================================
// 人数表示
// ========================================

function drawPeopleCount() {

  noStroke();

  fill(
    0,
    190
  );


  rect(
    20,
    20,
    370,
    190,
    10
  );


  fill(255);

  textAlign(
    LEFT
  );


  textSize(22);

  text(
    "入退室管理",
    40,
    52
  );


  textSize(36);

  text(
    "現在：" +
    currentPeopleCount +
    "人",
    40,
    100
  );


  textSize(20);

  text(
    "入室：" +
    enteredCount +
    "人",
    40,
    140
  );


  text(
    "退出：" +
    exitedCount +
    "人",
    200,
    140
  );


  textSize(16);

  text(
    "カメラ内：" +
    visiblePeopleCount +
    "人",
    40,
    175
  );

}


// ========================================
// 状態表示
// ========================================

function drawStatus() {

  textAlign(
    RIGHT
  );

  textSize(16);


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

  }

  else {

    fill(255);

    text(
      "AI：読み込み中",
      width - 20,
      55
    );

  }


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