// ======================================================
// AI人数管理システム
// 横向き A → B → C
// 入室・退出・Firebase対応 完成版
// ======================================================


// ======================================================
// 基本変数
// ======================================================

let video;
let model;
let predictions = [];


// 人数
let visiblePeopleCount = 0;
let enteredCount = 0;
let exitedCount = 0;
let currentPeopleCount = 0;


// 状態
let modelReady = false;
let cameraReady = false;
let detecting = false;


// 人物追跡
let tracks = [];
let nextTrackId = 1;


// ======================================================
// 設定
// ======================================================

// 人物追跡を何ms残すか
const TRACK_TIMEOUT = 2500;

// 同じ人物と判断する最大距離
const MATCH_DISTANCE = 140;


// A・B・Cの境界
const ZONE_A_END = 0.33;
const ZONE_B_END = 0.66;


// ======================================================
// setup
// ======================================================

function setup() {

  createCanvas(960, 720);


  // --------------------------------------------------
  // 背面カメラ
  // --------------------------------------------------

  video = createCapture(
    {
      video: {
        facingMode: {
          ideal: "environment"
        }
      },
      audio: false
    },

    function () {

      cameraReady = true;

      console.log("背面カメラ接続成功");

      sendPeopleData();

    }
  );


  video.size(960, 720);

  video.hide();


  // AI読み込み
  loadAIModel();

}


// ======================================================
// AIモデル読み込み
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
// AI人物認識
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
      await model.detect(video.elt);


    let persons = [];


    // 人物だけ取り出す
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

        persons.push(prediction);

      }

    }


    // 現在カメラに映っている人数
    visiblePeopleCount =
      persons.length;


    // 人物追跡
    updateTracks(persons);


    // Firebaseへ送信
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


  // --------------------------------------------------
  // 人物の中心座標を計算
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


    let bestDetection = null;

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


    // ------------------------------------------------
    // 人物が見つかった
    // ------------------------------------------------

    if (bestDetection) {

      bestDetection.matched =
        true;


      const oldZone =
        getZone(track.x);


      const newZone =
        getZone(
          bestDetection.x
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


      // A/B/Cの移動を記録
      updateZoneHistory(
        track,
        oldZone,
        newZone
      );

    }

  }


  // --------------------------------------------------
  // 新しく見つかった人物
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


      // 最初のエリア
      currentZone:
        initialZone,


      // A/B/Cの履歴
      zoneHistory:
        [initialZone],


      // その人物が現在「校内」にいるか
      inside:
        false,


      // 入室・退出判定中
      entryProgress:
        0,

      exitProgress:
        0,


      lastCountTime:
        0

    });

  }


  // --------------------------------------------------
  // 長時間見えなくなった人物を削除
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
// A / B / C判定
// 横方向
// ======================================================

function getZone(x) {

  const ratio =
    x / width;


  // 左側
  if (
    ratio < ZONE_A_END
  ) {

    return "A";

  }


  // 中央
  if (
    ratio < ZONE_B_END
  ) {

    return "B";

  }


  // 右側
  return "C";

}


// ======================================================
// A/B/Cの移動を記録
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


  // 履歴に追加
  track.zoneHistory.push(
    newZone
  );


  // 最新10個だけ残す
  if (
    track.zoneHistory.length > 10
  ) {

    track.zoneHistory.shift();

  }


  track.currentZone =
    newZone;


  // 入室判定
  checkEntry(track);


  // 退出判定
  checkExit(track);

}


// ======================================================
// 入室判定
//
// A → B → C
// ======================================================

function checkEntry(track) {

  // すでに校内にいる人は入室しない
  if (
    track.inside
  ) {

    return;

  }


  const history =
    track.zoneHistory;


  if (
    history.length < 2
  ) {

    return;

  }


  const n =
    history.length;


  const previous =
    history[n - 2];


  const current =
    history[n - 1];


  // A → B
  if (
    previous === "A" &&
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


  // B → C
  if (
    previous === "B" &&
    current === "C" &&
    track.entryProgress === 1
  ) {

    const now =
      Date.now();


    // 短時間の二重判定防止
    if (
      now -
      track.lastCountTime
      <
      2000
    ) {

      return;

    }


    // 入室
    enteredCount++;


    currentPeopleCount =
      currentPeopleCount + 1;


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
// 退出判定
//
// C → B → A
// ======================================================

function checkExit(track) {

  // 校内にいない人は退出しない
  if (
    !track.inside
  ) {

    return;

  }


  const history =
    track.zoneHistory;


  if (
    history.length < 2
  ) {

    return;

  }


  const n =
    history.length;


  const previous =
    history[n - 2];


  const current =
    history[n - 1];


  // C → B
  if (
    previous === "C" &&
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


  // B → A
  if (
    previous === "B" &&
    current === "A" &&
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


    // 退出
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
// Firebaseへ送信
// ======================================================

async function sendPeopleData() {

  try {

    // Firebaseの準備を待つ
    if (
      window.firebaseReady
    ) {

      await window.firebaseReady;

    }


    // Firebaseがまだない場合
    if (
      !window.firebaseDB ||
      !window.firebaseRef ||
      !window.firebaseSet
    ) {

      return;

    }


    // 保存場所
    const peopleRef =
      window.firebaseRef(
        window.firebaseDB,
        "people/current"
      );


    // 送信データ
    const data = {

      // 現在校内にいる人数
      peopleCount:
        currentPeopleCount,


      // 現在カメラに映っている人数
      visiblePeopleCount:
        visiblePeopleCount,


      // 入室累計
      enteredCount:
        enteredCount,


      // 退出累計
      exitedCount:
        exitedCount,


      // カメラ状態
      cameraReady:
        cameraReady,


      // AI状態
      modelReady:
        modelReady,


      // カメラ端末
      camera:
        "tablet",


      // 更新時刻
      updatedAt:
        Date.now(),


      // 表示用時刻
      time:
        new Date()
          .toLocaleTimeString()

    };


    // Firebaseへ保存
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
// 画面描画
// ======================================================

function draw() {

  background(20);


  // --------------------------------------------------
  // カメラ映像
  // --------------------------------------------------

  if (
    cameraReady
  ) {

    image(
      video,
      0,
      0,
      width,
      height
    );

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


  // --------------------------------------------------
  // 人物枠
  // --------------------------------------------------

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


  // A/B/C
  drawZones();


  // 人数
  drawPeopleCount();


  // 状態
  drawStatus();


  // --------------------------------------------------
  // AI認識を繰り返す
  // --------------------------------------------------

  if (
    modelReady &&
    cameraReady &&
    !detecting
  ) {

    detectPeople();

  }

}


// ======================================================
// A/B/C表示
// 横向き
// ======================================================

function drawZones() {

  // 境界線
  stroke(
    255,
    255,
    0
  );

  strokeWeight(3);


  // A | B
  line(
    width * ZONE_A_END,
    0,
    width * ZONE_A_END,
    height
  );


  // B | C
  line(
    width * ZONE_B_END,
    0,
    width * ZONE_B_END,
    height
  );


  noStroke();


  fill(
    255,
    255,
    0
  );


  textAlign(
    CENTER,
    CENTER
  );


  // --------------------------------------------------
  // A
  // --------------------------------------------------

  textSize(28);

  text(
    "A：入口エリア",
    width * 0.165,
    height * 0.18
  );


  // --------------------------------------------------
  // B
  // --------------------------------------------------

  text(
    "B：中間エリア",
    width * 0.50,
    height * 0.18
  );


  // --------------------------------------------------
  // C
  // --------------------------------------------------

  text(
    "C：出口エリア",
    width * 0.835,
    height * 0.18
  );


  // --------------------------------------------------
  // 入室・退出
  // --------------------------------------------------

  textSize(20);


  text(
    "A → B → C = 入室",
    width * 0.50,
    height - 70
  );


  text(
    "C → B → A = 退出",
    width * 0.50,
    height - 35
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


  // 枠
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


  // 認識率
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


// ======================================================
// 人数表示
// ======================================================

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


  // 現在人数
  textSize(36);


  text(
    "現在：" +
    currentPeopleCount +
    "人",
    40,
    100
  );


  // 入室
  textSize(20);


  text(
    "入室：" +
    enteredCount +
    "人",
    40,
    140
  );


  // 退出
  text(
    "退出：" +
    exitedCount +
    "人",
    200,
    140
  );


  // カメラ内
  textSize(16);


  text(
    "カメラ内：" +
    visiblePeopleCount +
    "人",
    40,
    175
  );

}


// ======================================================
// 状態表示
// ======================================================

function drawStatus() {

  textAlign(
    RIGHT
  );


  textSize(16);


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

  } else {

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
