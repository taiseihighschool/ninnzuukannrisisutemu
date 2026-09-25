let video;
let model;
let predictions = [];

let visiblePeopleCount = 0;
let enteredCount = 0;
let exitedCount = 0;
let currentPeopleCount = 0;

let modelReady = false;
let cameraReady = false;
let detecting = false;

let tracks = [];
let nextTrackId = 1;

const TRACK_TIMEOUT = 2500;
const MATCH_DISTANCE = 140;

// A・B・Cの境界
const ZONE_A_END = 0.33;
const ZONE_B_END = 0.66;


// ==============================
// 初期設定
// ==============================

function setup() {

  createCanvas(960, 720);

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

      console.log("背面カメラ接続成功");

    }
  );

  video.size(960, 720);
  video.hide();

  loadAIModel();
}


// ==============================
// AIモデル読み込み
// ==============================

async function loadAIModel() {

  console.log("COCO-SSDを読み込んでいます...");

  try {

    model = await cocoSsd.load();

    modelReady = true;

    console.log("AIモデル読み込み完了");

    detectPeople();

  } catch (error) {

    console.error(
      "AIモデル読み込みエラー:",
      error
    );

  }
}


// ==============================
// 人物認識
// ==============================

async function detectPeople() {

  if (detecting) return;

  if (!modelReady || !cameraReady) return;

  detecting = true;

  try {

    predictions =
      await model.detect(video.elt);

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

        persons.push(prediction);

      }

    }

    visiblePeopleCount =
      persons.length;

    updateTracks(persons);

    sendPeopleData();

  } catch (error) {

    console.error(
      "AI認識エラー:",
      error
    );

  }

  detecting = false;
}


// ==============================
// 人物追跡
// ==============================

function updateTracks(persons) {

  const now = Date.now();

  let detections = [];


  // 人物の中心座標を取得
  for (
    let i = 0;
    i < persons.length;
    i++
  ) {

    const bbox =
      persons[i].bbox;

    const centerX =
      bbox[0] + bbox[2] / 2;

    const centerY =
      bbox[1] + bbox[3] / 2;

    detections.push({

      prediction: persons[i],

      x: centerX,

      y: centerY,

      matched: false

    });

  }


  // 既存人物との照合
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

      if (detection.matched)
        continue;


      const dx =
        detection.x - track.x;

      const dy =
        detection.y - track.y;

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


    if (bestDetection) {

      bestDetection.matched =
        true;


      // 横方向でA・B・Cを判定
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


  // 新しい人物
  for (
    let i = 0;
    i < detections.length;
    i++
  ) {

    const detection =
      detections[i];

    if (detection.matched)
      continue;


    const initialZone =
      getZone(detection.x);


    tracks.push({

      id: nextTrackId++,

      x: detection.x,

      y: detection.y,

      lastSeen: now,

      prediction:
        detection.prediction,

      startZone:
        initialZone,

      currentZone:
        initialZone,

      zoneHistory:
        [initialZone],

      counted: false,

      lastCountTime: 0

    });

  }


  // 古い人物を削除
  tracks =
    tracks.filter(
      function(track) {

        return (
          now - track.lastSeen
          < TRACK_TIMEOUT
        );

      }
    );

}


// ==============================
// A・B・C判定
// 横方向バージョン
// ==============================

function getZone(x) {

  const ratio =
    x / width;


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


// ==============================
// エリア移動
// ==============================

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
    track.zoneHistory.length > 10
  ) {

    track.zoneHistory.shift();

  }


  track.currentZone =
    newZone;


  checkEntry(track);

  checkExit(track);

}


// ==============================
// 入室判定
// A → B → C
// ==============================

function checkEntry(track) {

  if (track.counted)
    return;


  const history =
    track.zoneHistory;


  if (history.length < 3)
    return;


  const n =
    history.length;


  const a =
    history[n - 3];

  const b =
    history[n - 2];

  const c =
    history[n - 1];


  if (
    a === "A" &&
    b === "B" &&
    c === "C"
  ) {

    const now =
      Date.now();


    if (
      now - track.lastCountTime
      < 2000
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


// ==============================
// 退出判定
// C → B → A
// ==============================

function checkExit(track) {

  if (track.counted)
    return;


  const history =
    track.zoneHistory;


  if (history.length < 3)
    return;


  const n =
    history.length;


  const a =
    history[n - 3];

  const b =
    history[n - 2];

  const c =
    history[n - 1];


  if (
    a === "C" &&
    b === "B" &&
    c === "A"
  ) {

    const now =
      Date.now();


    if (
      now - track.lastCountTime
      < 2000
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


// ==============================
// Firebase送信
// ==============================

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


// ==============================
// 画面描画
// ==============================

function draw() {

  background(20);


  // カメラ映像
  if (cameraReady) {

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


  // 人物枠
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


  drawZones();

  drawPeopleCount();

  drawStatus();


  // AI認識を繰り返す
  if (
    modelReady &&
    cameraReady &&
    !detecting
  ) {

    detectPeople();

  }

}


// ==============================
// 横向きA・B・C表示
// ==============================

function drawZones() {

  stroke(
    255,
    255,
    0
  );

  strokeWeight(3);


  // AとBの境界
  line(
    width * ZONE_A_END,
    0,
    width * ZONE_A_END,
    height
  );


  // BとCの境界
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


  textSize(28);


  // A
  text(
    "A：入口エリア",
    width * 0.165,
    height * 0.18
  );


  // B
  text(
    "B：中間エリア",
    width * 0.50,
    height * 0.18
  );


  // C
  text(
    "C：出口エリア",
    width * 0.83,
    height * 0.18
  );


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


// ==============================
// 人物枠
// ==============================

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


// ==============================
// 人数表示
// ==============================

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

  textAlign(LEFT);


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


// ==============================
// 状態表示
// ==============================

function drawStatus() {

  textAlign(RIGHT);

  textSize(16);


  // カメラ
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


  // AI
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


  // Firebase
  if (window.firebaseDB) {

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
