let video;
let model;

let predictions = [];

let peopleCount = 0;

let modelReady = false;
let cameraReady = false;
let detecting = false;


// ========================================
// 初期設定
// ========================================
function setup() {

  createCanvas(960, 720);

  // ======================================
  // 背面カメラを使用
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

      console.log("背面カメラ接続成功");

    }
  );

  video.size(960, 720);

  video.hide();


  // AIモデル読み込み
  loadAIModel();

}


// ========================================
// AIモデル読み込み
// ========================================
async function loadAIModel() {

  console.log(
    "COCO-SSDを読み込んでいます..."
  );

  model = await cocoSsd.load();

  modelReady = true;

  console.log(
    "AIモデル読み込み完了"
  );

  detectPeople();

}


// ========================================
// 人物認識
// ========================================
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


    peopleCount = 0;


    // personだけ数える
    for (
      let i = 0;
      i < predictions.length;
      i++
    ) {

      let prediction =
        predictions[i];


      if (
        prediction.class === "person" &&
        prediction.score >= 0.50
      ) {

        peopleCount++;

      }

    }


    // ====================================
    // 人数データを管理画面へ送信
    // ====================================

    let data = {

      peopleCount: peopleCount,

      cameraReady: cameraReady,

      modelReady: modelReady,

      time: new Date().toLocaleTimeString()

    };


    localStorage.setItem(
      "AI_PEOPLE_DATA",
      JSON.stringify(data)
    );


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
// 画面描画
// ========================================
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


  // 人物枠
  for (
    let i = 0;
    i < predictions.length;
    i++
  ) {

    let prediction =
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


  // 人数表示
  drawPeopleCount();


  // 状態表示
  drawStatus();


  // 次のAI認識
  if (
    modelReady &&
    cameraReady &&
    !detecting
  ) {

    detectPeople();

  }

}


// ========================================
// 人物枠
// ========================================
function drawPersonBox(prediction) {

  let bbox =
    prediction.bbox;


  let x = bbox[0];
  let y = bbox[1];

  let w = bbox[2];
  let h = bbox[3];


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


  // 信頼度
  let confidence =
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
    160,
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
    330,
    120,
    10
  );


  fill(255);

  textAlign(LEFT);

  textSize(22);

  text(
    "AIカメラ",
    40,
    52
  );


  textSize(36);

  text(
    "現在：" +
    peopleCount +
    "人",
    40,
    105
  );

}


// ========================================
// 状態表示
// ========================================
function drawStatus() {

  textAlign(RIGHT);

  textSize(16);

  fill(0, 255, 0);

  text(
    "Camera：背面",
    width - 20,
    30
  );


  if (modelReady) {

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

}