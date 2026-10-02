========================================================
*/

let video;
let model = null;

let cameraReady = false;
let modelReady = false;
let detecting = false;

let predictions = [];
let people = [];

let nextPersonId = 1;

// -----------------------------
// カメラ設定
// -----------------------------
const CAMERA_WIDTH = 1280;
const CAMERA_HEIGHT = 720;

// -----------------------------
// AI設定
// -----------------------------
const PERSON_SCORE = 0.40;
const DETECT_INTERVAL = 120;

// -----------------------------
// トラッキング設定
// -----------------------------
const BASE_MATCH_DISTANCE = 220;
const MAX_MATCH_DISTANCE = 500;

const MAX_MISSED_FRAMES = 50;
const TRACK_TIMEOUT = 10000;

// -----------------------------
// ゾーン
// -----------------------------
const ZONE_A_END = 1 / 3;
const ZONE_B_END = 2 / 3;

const ZONE_CONFIRM_FRAMES = 2;

// -----------------------------
// カウント
// -----------------------------
let currentPeopleCount = 0;
let enteredCount = 0;
let exitedCount = 0;

// -----------------------------
// Firebase
// -----------------------------
const FIREBASE_CURRENT_PATH = "people/current";
const FIREBASE_RESET_PATH = "people/reset";

let firebaseListenerStarted = false;
let lastFirebaseWrite = 0;
let firebaseWriteTimer = null;
let lastPayloadString = "";

const FIREBASE_WRITE_INTERVAL = 300;

// -----------------------------
// リセット
// -----------------------------
let lastResetTime = 0;

// -----------------------------
// デバッグ
// -----------------------------
let eventLogs = [];
const MAX_EVENT_LOGS = 8;


/* ======================================================
   setup
====================================================== */

function setup() {
  const canvas = createCanvas(CAMERA_WIDTH, CAMERA_HEIGHT);

  if (document.getElementById("app")) {
    canvas.parent("app");
  } else if (document.getElementById("sketch-holder")) {
    canvas.parent("sketch-holder");
  }

  textFont("Arial");

  video = createCapture(
    {
      video: {
        facingMode: {
          ideal: "environment"
        },
        width: {
          ideal: CAMERA_WIDTH
        },
        height: {
          ideal: CAMERA_HEIGHT
        }
      },
      audio: false
    },
    onCameraReady
  );

  video.size(CAMERA_WIDTH, CAMERA_HEIGHT);
  video.hide();

  addEventLog("camera.js 起動");
}


/* ======================================================
   カメラ準備完了
====================================================== */

function onCameraReady() {
  cameraReady = true;

  addEventLog("カメラ準備完了");

  loadModel();
}


/* ======================================================
   AIモデル
====================================================== */

async function loadModel() {
  try {
    addEventLog("AIモデル読み込み中");

    model = await cocoSsd.load();

    modelReady = true;

    addEventLog("AIモデル準備完了");

  } catch (error) {

    console.error(error);

    addEventLog("AIモデル読み込み失敗");
  }
}


/* ======================================================
   draw
====================================================== */

function draw() {

  background(0);

  if (cameraReady) {
    drawCamera();
  } else {
    drawCenterMessage("カメラ準備中...");
  }

  drawZones();

  drawPeople();

  drawInformation();

  drawEventLog();

  setupFirebaseListener();

  const now = millis();

  if (
    cameraReady &&
    modelReady &&
    model &&
    !detecting &&
    now - lastDetectionTime >= DETECT_INTERVAL
  ) {
    lastDetectionTime = now;

    detectPeople();
  }
}


let lastDetectionTime = 0;


/* ======================================================
   カメラ表示
   AI座標と表示座標を同じ変換にする
====================================================== */

function getVideoTransform() {

  const videoElement = video && video.elt;

  if (
    !videoElement ||
    !videoElement.videoWidth ||
    !videoElement.videoHeight
  ) {

    return {
      videoWidth: CAMERA_WIDTH,
      videoHeight: CAMERA_HEIGHT,
      scaleX: width / CAMERA_WIDTH,
      scaleY: height / CAMERA_HEIGHT,
      offsetX: 0,
      offsetY: 0
    };
  }

  const videoWidth = videoElement.videoWidth;
  const videoHeight = videoElement.videoHeight;

  const videoRatio = videoWidth / videoHeight;
  const canvasRatio = width / height;

  let drawWidth;
  let drawHeight;
  let offsetX;
  let offsetY;

  if (videoRatio > canvasRatio) {

    drawHeight = height;
    drawWidth = height * videoRatio;

    offsetX = (width - drawWidth) / 2;
    offsetY = 0;

  } else {

    drawWidth = width;
    drawHeight = width / videoRatio;

    offsetX = 0;
    offsetY = (height - drawHeight) / 2;
  }

  return {
    videoWidth,
    videoHeight,

    scaleX: drawWidth / videoWidth,
    scaleY: drawHeight / videoHeight,

    offsetX,
    offsetY
  };
}


function drawCamera() {

  const t = getVideoTransform();

  image(
    video,
    t.offsetX,
    t.offsetY,
    video.width * t.scaleX,
    video.height * t.scaleY
  );
}


/* ======================================================
   AI座標 → 画面座標
====================================================== */

function videoPointToCanvas(x, y) {

  const t = getVideoTransform();

  return {
    x: x * t.scaleX + t.offsetX,
    y: y * t.scaleY + t.offsetY
  };
}


/* ======================================================
   人物検出
====================================================== */

async function detectPeople() {

  if (
    detecting ||
    !model ||
    !video ||
    !video.elt
  ) {
    return;
  }

  detecting = true;

  try {

    const result = await model.detect(video.elt);

    const persons = result.filter(
      item =>
        item.class === "person" &&
        item.score >= PERSON_SCORE
    );

    predictions = persons;

    updatePeopleTracking(persons);

  } catch (error) {

    console.error("detectPeople error:", error);

  } finally {

    detecting = false;
  }
}


/* ======================================================
   人物track作成
====================================================== */

function createPersonTrack(detection) {

  const [x, y, w, h] = detection.bbox;

  const centerX = x + w / 2;
  const centerY = y + h / 2;

  const zone = getZone(centerX);

  return {

    id: nextPersonId++,

    x,
    y,
    w,
    h,

    centerX,
    centerY,

    previousCenterX: centerX,
    previousCenterY: centerY,

    velocityX: 0,
    velocityY: 0,

    lastSeen: Date.now(),

    missedFrames: 0,

    age: 1,

    zone,

    previousZone: zone,

    pendingZone: zone,
    pendingZoneFrames: 0,

    // 入室進行:
    // 0 = 未開始
    // 1 = A
    // 2 = B
    entryProgress: zone === "A" ? 1 : 0,

    // 退出関連
    inside: false,
    passedC: zone === "C",

    exitState: zone === "C" ? 1 : 0,

    exitCounted: false,

    lastStateChange: Date.now()
  };
}


/* ======================================================
   track更新
====================================================== */

function updatePeopleTracking(detections) {

  const now = Date.now();

  const matchedTrackIds = new Set();
  const matchedDetectionIndexes = new Set();

  const candidates = [];

  // -----------------------------------------------
  // 全組み合わせの距離を計算
  // -----------------------------------------------

  for (
    let detectionIndex = 0;
    detectionIndex < detections.length;
    detectionIndex++
  ) {

    const detection = detections[detectionIndex];

    const [x, y, w, h] = detection.bbox;

    const centerX = x + w / 2;
    const centerY = y + h / 2;

    for (
      let trackIndex = 0;
      trackIndex < people.length;
      trackIndex++
    ) {

      const person = people[trackIndex];

      if (matchedTrackIds.has(person.id)) {
        continue;
      }

      const predicted = predictPosition(person);

      const distance = distanceBetween(
        centerX,
        centerY,
        predicted.x,
        predicted.y
      );

      const allowedDistance =
        getAllowedMatchDistance(person, w, h);

      if (distance <= allowedDistance) {

        candidates.push({
          detectionIndex,
          trackIndex,
          distance
        });
      }
    }
  }

  // -----------------------------------------------
  // 最も近いものからマッチ
  // -----------------------------------------------

  candidates.sort(
    (a, b) => a.distance - b.distance
  );

  for (const candidate of candidates) {

    if (
      matchedDetectionIndexes.has(
        candidate.detectionIndex
      )
    ) {
      continue;
    }

    const person =
      people[candidate.trackIndex];

    if (matchedTrackIds.has(person.id)) {
      continue;
    }

    updateExistingPerson(
      person,
      detections[candidate.detectionIndex],
      now
    );

    matchedDetectionIndexes.add(
      candidate.detectionIndex
    );

    matchedTrackIds.add(person.id);
  }

  // -----------------------------------------------
  // 新規人物
  // -----------------------------------------------

  for (
    let i = 0;
    i < detections.length;
    i++
  ) {

    if (matchedDetectionIndexes.has(i)) {
      continue;
    }

    const person =
      createPersonTrack(detections[i]);

    people.push(person);

    addEventLog(
      `新規ID ${person.id} / ${person.zone}`
    );
  }

  // -----------------------------------------------
  // 未検出track
  // -----------------------------------------------

  for (const person of people) {

    if (!matchedTrackIds.has(person.id)) {

      person.missedFrames++;

      // 速度を少しずつ減衰
      person.velocityX *= 0.85;
      person.velocityY *= 0.85;
    }
  }

  // -----------------------------------------------
  // 古いtrackを削除
  // -----------------------------------------------

  const before = people.length;

  people = people.filter(person => {

    const elapsed =
      Date.now() - person.lastSeen;

    return (
      elapsed < TRACK_TIMEOUT &&
      person.missedFrames <= MAX_MISSED_FRAMES
    );
  });

  if (before !== people.length) {

    addEventLog("古いtrackを削除");
  }

  queueFirebaseWrite();
}


/* ======================================================
   既存track更新
====================================================== */

function updateExistingPerson(
  person,
  detection,
  now
) {

  const [x, y, w, h] =
    detection.bbox;

  const centerX =
    x + w / 2;

  const centerY =
    y + h / 2;

  const elapsed =
    Math.max(
      (now - person.lastSeen) / 1000,
      0.05
    );

  const newVelocityX =
    (centerX - person.centerX) /
    elapsed;

  const newVelocityY =
    (centerY - person.centerY) /
    elapsed;

  // 急激な速度変化を抑える
  person.velocityX =
    person.velocityX * 0.70 +
    newVelocityX * 0.30;

  person.velocityY =
    person.velocityY * 0.70 +
    newVelocityY * 0.30;

  person.previousCenterX =
    person.centerX;

  person.previousCenterY =
    person.centerY;

  person.x = x;
  person.y = y;
  person.w = w;
  person.h = h;

  person.centerX = centerX;
  person.centerY = centerY;

  person.lastSeen = now;

  person.missedFrames = 0;

  person.age++;

  const detectedZone =
    getZone(centerX);

  updateStableZone(
    person,
    detectedZone
  );
}


/* ======================================================
   予測位置
====================================================== */

function predictPosition(person) {

  const elapsed =
    Math.min(
      (Date.now() - person.lastSeen) / 1000,
      1.2
    );

  return {

    x:
      person.centerX +
      person.velocityX * elapsed,

    y:
      person.centerY +
      person.velocityY * elapsed
  };
}


/* ======================================================
   マッチ距離
====================================================== */

function getAllowedMatchDistance(
  person,
  width,
  height
) {

  const size =
    Math.max(width, height);

  const missedBonus =
    person.missedFrames * 25;

  const sizeBonus =
    size * 0.45;

  return Math.min(
    MAX_MATCH_DISTANCE,
    BASE_MATCH_DISTANCE +
    sizeBonus +
    missedBonus
  );
}


/* ======================================================
   距離
====================================================== */

function distanceBetween(
  ax,
  ay,
  bx,
  by
) {

  return Math.hypot(
    ax - bx,
    ay - by
  );
}


/* ======================================================
   ゾーン
====================================================== */

function getZone(x) {

  const videoWidth =
    video &&
    video.elt &&
    video.elt.videoWidth
      ? video.elt.videoWidth
      : CAMERA_WIDTH;

  const ratio =
    x / videoWidth;

  if (ratio < ZONE_A_END) {
    return "A";
  }

  if (ratio < ZONE_B_END) {
    return "B";
  }

  return "C";
}


/* ======================================================
   ゾーン安定化
====================================================== */

function updateStableZone(
  person,
  newZone
) {

  if (newZone === person.zone) {

    person.pendingZone = newZone;
    person.pendingZoneFrames = 0;

    return;
  }

  if (
    newZone !==
    person.pendingZone
  ) {

    person.pendingZone =
      newZone;

    person.pendingZoneFrames = 1;

    return;
  }

  person.pendingZoneFrames++;

  if (
    person.pendingZoneFrames >=
    ZONE_CONFIRM_FRAMES
  ) {

    const oldZone =
      person.zone;

    person.previousZone =
      oldZone;

    person.zone =
      newZone;

    person.pendingZoneFrames = 0;

    handleZoneChange(
      person,
      oldZone,
      newZone
    );
  }
}


/* ======================================================
   ゾーン移動
====================================================== */

function handleZoneChange(
  person,
  oldZone,
  newZone
) {

  addEventLog(
    `ID${person.id}: ${oldZone}→${newZone}`
  );

  console.log(
    "ZONE",
    person.id,
    oldZone,
    "→",
    newZone,
    "inside:",
    person.inside,
    "entry:",
    person.entryProgress,
    "passedC:",
    person.passedC
  );

  // 重要:
  // 先に退出を確認
  // その後に入室を確認
  checkExit(
    person,
    oldZone,
    newZone
  );

  checkEntry(
    person,
    oldZone,
    newZone
  );
}


/* ======================================================
   入室判定

   A → B → C
====================================================== */

function checkEntry(
  person,
  oldZone,
  newZone
) {

  // すでに中なら入室しない
  if (person.inside) {
    return;
  }

  // Aに入った
  if (newZone === "A") {

    person.entryProgress = 1;

    return;
  }

  // A → B
  if (
    person.entryProgress === 1 &&
    newZone === "B"
  ) {

    person.entryProgress = 2;

    addEventLog(
      `ID${person.id}: A→B`
    );

    return;
  }

  // B → C
  if (
    person.entryProgress >= 2 &&
    newZone === "C"
  ) {

    enterPerson(person);

    return;
  }

  /*
   * もしBから直接Aへ戻った場合は、
   * もう一度Aからやり直す
   */
  if (newZone === "A") {

    person.entryProgress = 1;
  }
}


/* ======================================================
   入室確定
====================================================== */

function enterPerson(person) {

  if (person.inside) {
    return;
  }

  person.inside = true;

  person.entryProgress = 0;

  person.passedC = false;

  person.exitState = 0;

  person.exitCounted = false;

  currentPeopleCount++;

  enteredCount++;

  person.lastStateChange =
    Date.now();

  addEventLog(
    `★入室 ID${person.id} / 現在${currentPeopleCount}`
  );

  console.log(
    "========== 入室 ==========",
    person.id,
    currentPeopleCount
  );

  queueFirebaseWrite();
}


/* ======================================================
   退出判定

   基本:
   C → B → A

   直接:
   C → A
====================================================== */

function checkExit(
  person,
  oldZone,
  newZone
) {

  if (!person.inside) {
    return;
  }

  // Cに到達した
  if (newZone === "C") {

    person.passedC = true;

    person.exitState = 1;

    addEventLog(
      `ID${person.id}: C通過`
    );

    return;
  }

  // C → B
  if (
    person.passedC &&
    oldZone === "C" &&
    newZone === "B"
  ) {

    person.exitState = 2;

    addEventLog(
      `ID${person.id}: C→B`
    );

    return;
  }

  // C → A
  if (
    person.passedC &&
    newZone === "A"
  ) {

    exitPerson(person);

    return;
  }

  // Cを通過後、B→A
  if (
    person.passedC &&
    person.exitState >= 2 &&
    newZone === "A"
  ) {

    exitPerson(person);

    return;
  }
}


/* ======================================================
   退出確定
====================================================== */

function exitPerson(person) {

  if (!person.inside) {
    return;
  }

  if (person.exitCounted) {
    return;
  }

  person.exitCounted = true;

  currentPeopleCount =
    Math.max(
      0,
      currentPeopleCount - 1
    );

  exitedCount++;

  person.inside = false;

  person.passedC = false;

  person.exitState = 0;

  person.entryProgress = 0;

  person.lastStateChange =
    Date.now();

  addEventLog(
    `★退出 ID${person.id} / 現在${currentPeopleCount}`
  );

  console.log(
    "========== 退出 ==========",
    person.id,
    currentPeopleCount
  );

  queueFirebaseWrite();
}


/* ======================================================
   描画: ゾーン
====================================================== */

function drawZones() {

  const aX =
    width * ZONE_A_END;

  const bX =
    width * ZONE_B_END;

  stroke(255, 255, 0);
  strokeWeight(3);

  line(
    aX,
    0,
    aX,
    height
  );

  line(
    bX,
    0,
    bX,
    height
  );

  noStroke();

  fill(255);

  textAlign(
    CENTER,
    TOP
  );

  textSize(34);

  text(
    "A",
    aX / 2,
    15
  );

  text(
    "B",
    (aX + bX) / 2,
    15
  );

  text(
    "C",
    (bX + width) / 2,
    15
  );
}


/* ======================================================
   描画: 人物
====================================================== */

function drawPeople() {

  for (const person of people) {

    let x = person.x;
    let y = person.y;

    // 一時的に検出できない場合は予測位置
    if (person.missedFrames > 0) {

      const predicted =
        predictPosition(person);

      x =
        predicted.x -
        person.w / 2;

      y =
        predicted.y -
        person.h / 2;
    }

    const topLeft =
      videoPointToCanvas(
        x,
        y
      );

    const bottomRight =
      videoPointToCanvas(
        x + person.w,
        y + person.h
      );

    const boxWidth =
      bottomRight.x -
      topLeft.x;

    const boxHeight =
      bottomRight.y -
      topLeft.y;

    // 緑枠
    stroke(
      0,
      255,
      80
    );

    strokeWeight(4);

    noFill();

    rect(
      topLeft.x,
      topLeft.y,
      boxWidth,
      boxHeight
    );

    // ID
    noStroke();

    fill(
      0,
      180
    );

    rect(
      topLeft.x,
      Math.max(
        0,
        topLeft.y - 68
      ),
      270,
      64
    );

    fill(255);

    textAlign(
      LEFT,
      TOP
    );

    textSize(20);

    text(
      `ID ${person.id}  [${person.zone}]`,
      topLeft.x + 8,
      Math.max(
        2,
        topLeft.y - 63
      )
    );

    textSize(17);

    text(
      person.inside
        ? "IN / 中にいる"
        : "WAIT / 未入室",
      topLeft.x + 8,
      Math.max(
        24,
        topLeft.y - 39
      )
    );

    text(
      `A→B→C:${person.entryProgress}  C:${person.passedC ? "YES" : "NO"}`,
      topLeft.x + 8,
      Math.max(
        46,
        topLeft.y - 17
      )
    );

    // 欠落
    if (person.missedFrames > 0) {

      fill(255, 255, 0);

      textSize(16);

      text(
        `追跡中 miss=${person.missedFrames}`,
        topLeft.x,
        bottomRight.y + 5
      );
    }
  }
}


/* ======================================================
   描画: 情報
====================================================== */

function drawInformation() {

  noStroke();

  fill(
    0,
    180
  );

  rect(
    15,
    height - 155,
    500,
    140,
    8
  );

  fill(255);

  textAlign(
    LEFT,
    TOP
  );

  textSize(27);

  text(
    `現在人数: ${currentPeopleCount}`,
    30,
    height - 145
  );

  textSize(20);

  text(
    `入室: ${enteredCount}   退出: ${exitedCount}`,
    30,
    height - 108
  );

  textSize(17);

  text(
    `人物検出: ${predictions.length}`,
    30,
    height - 80
  );

  text(
    `AI: ${modelReady ? "OK" : "待機"}  ` +
    `Camera: ${cameraReady ? "OK" : "待機"}  ` +
    `Firebase: ${isFirebaseAvailable() ? "OK" : "待機"}`,
    30,
    height - 52
  );
}


/* ======================================================
   描画: イベントログ
====================================================== */

function drawEventLog() {

  noStroke();

  fill(
    0,
    150
  );

  rect(
    width - 390,
    height - 225,
    370,
    205,
    8
  );

  fill(255);

  textAlign(
    LEFT,
    TOP
  );

  textSize(16);

  text(
    "DEBUG / ZONE LOG",
    width - 375,
    height - 210
  );

  let y =
    height - 185;

  for (const log of eventLogs) {

    text(
      log,
      width - 375,
      y
    );

    y += 21;
  }
}


/* ======================================================
   Firebase
====================================================== */

function isFirebaseAvailable() {

  return Boolean(
    window.firebaseDB &&
    window.firebaseRef &&
    window.firebaseSet
  );
}


/* ======================================================
   Firebase listener
====================================================== */

function setupFirebaseListener() {

  if (firebaseListenerStarted) {
    return;
  }

  if (
    !window.firebaseDB ||
    !window.firebaseRef ||
    !window.firebaseOnValue
  ) {
    return;
  }

  firebaseListenerStarted = true;

  try {

    const resetRef =
      window.firebaseRef(
        window.firebaseDB,
        FIREBASE_RESET_PATH
      );

    window.firebaseOnValue(
      resetRef,
      snapshot => {

        const data =
          snapshot.val();

        if (!data) {
          return;
        }

        if (
          data.command !== "reset"
        ) {
          return;
        }

        const resetTime =
          Number(
            data.time ||
            data.resetAt ||
            0
          );

        if (
          resetTime <=
          lastResetTime
        ) {
          return;
        }

        lastResetTime =
          resetTime;

        addEventLog(
          "Firebaseリセット受信"
        );

        resetSystem(
          resetTime
        );
      }
    );

    addEventLog(
      "Firebase reset監視開始"
    );

  } catch (error) {

    console.error(
      "Firebase listener error",
      error
    );

    firebaseListenerStarted = false;
  }
}


/* ======================================================
   Firebase送信予約
====================================================== */

function queueFirebaseWrite() {

  if (!isFirebaseAvailable()) {
    return;
  }

  const now =
    Date.now();

  if (
    now - lastFirebaseWrite >=
    FIREBASE_WRITE_INTERVAL
  ) {

    sendPeopleData();

    return;
  }

  if (firebaseWriteTimer) {
    return;
  }

  const wait =
    FIREBASE_WRITE_INTERVAL -
    (now - lastFirebaseWrite);

  firebaseWriteTimer =
    setTimeout(
      () => {

        firebaseWriteTimer = null;

        sendPeopleData();

      },
      Math.max(
        50,
        wait
      )
    );
}


/* ======================================================
   Firebase payload
====================================================== */

function makePeoplePayload() {

  return {

    peopleCount:
      currentPeopleCount,

    visiblePeopleCount:
      people.filter(
        p =>
          p.missedFrames <= 2
      ).length,

    enteredCount,

    exitedCount,

    cameraReady,

    modelReady,

    camera:
      "tablet",

    orientation:
      "horizontal-ABC",

    updatedAt:
      Date.now()
  };
}


/* ======================================================
   Firebase送信
====================================================== */

function sendPeopleData() {

  if (
    !window.firebaseDB ||
    !window.firebaseRef ||
    !window.firebaseSet
  ) {
    return;
  }

  const payload =
    makePeoplePayload();

  /*
   * 比較用にはupdatedAtを除外。
   * 人数が変わっていない場合に無駄な書き込みを防ぐ。
   */
  const comparePayload = {
    peopleCount:
      payload.peopleCount,

    visiblePeopleCount:
      payload.visiblePeopleCount,

    enteredCount:
      payload.enteredCount,

    exitedCount:
      payload.exitedCount,

    cameraReady:
      payload.cameraReady,

    modelReady:
      payload.modelReady,

    camera:
      payload.camera,

    orientation:
      payload.orientation
  };

  const compareString =
    JSON.stringify(
      comparePayload
    );

  if (
    compareString ===
    lastPayloadString
  ) {
    return;
  }

  lastPayloadString =
    compareString;

  lastFirebaseWrite =
    Date.now();

  try {

    const currentRef =
      window.firebaseRef(
        window.firebaseDB,
        FIREBASE_CURRENT_PATH
      );

    const result =
      window.firebaseSet(
        currentRef,
        payload
      );

    if (
      result &&
      typeof result.catch === "function"
    ) {

      result.catch(
        error => {

          console.error(
            "Firebase送信失敗:",
            error
          );

          addEventLog(
            "Firebase送信失敗"
          );
        }
      );
    }

  } catch (error) {

    console.error(
      "Firebase write error:",
      error
    );

    addEventLog(
      "Firebase書込エラー"
    );
  }
}


/* ======================================================
   リセット
====================================================== */

function resetSystem(
  resetTime = Date.now()
) {

  currentPeopleCount = 0;

  enteredCount = 0;

  exitedCount = 0;

  predictions = [];

  people = [];

  nextPersonId = 1;

  lastResetTime =
    resetTime;

  lastPayloadString =
    "";

  addEventLog(
    "★★ SYSTEM RESET ★★"
  );

  console.log(
    "SYSTEM RESET"
  );

  // リセット直後は必ずFirebaseへ送る
  if (isFirebaseAvailable()) {

    lastFirebaseWrite = 0;

    sendPeopleData();
  }
}


/*
 * HTMLから
 * resetSystem()
 * を呼べるようにする
 */
window.resetSystem =
  resetSystem;


/* ======================================================
   キーボード
====================================================== */

function keyPressed() {

  if (
    key === "r" ||
    key === "R"
  ) {

    resetSystem();
  }
}


/* ======================================================
   イベントログ
====================================================== */

function addEventLog(message) {

  const now =
    new Date();

  const time =
    now.toLocaleTimeString(
      "ja-JP",
      {
        hour12: false
      }
    );

  eventLogs.unshift(
    `${time} ${message}`
  );

  if (
    eventLogs.length >
    MAX_EVENT_LOGS
  ) {

    eventLogs =
      eventLogs.slice(
        0,
        MAX_EVENT_LOGS
      );
  }

  console.log(
    `[${time}]`,
    message
  );
}


/* ======================================================
   中央メッセージ
====================================================== */

function drawCenterMessage(
  message
) {

  fill(255);

  textAlign(
    CENTER,
    CENTER
  );

  textSize(32);

  text(
    message,
    width / 2,
    height / 2
  );
}


/* ======================================================
   念のためページ終了時にタイマー解除
====================================================== */

window.addEventListener(
  "beforeunload",
  () => {

    if (firebaseWriteTimer) {

      clearTimeout(
        firebaseWriteTimer
      );

      firebaseWriteTimer =
        null;
    }
  }
);


/* ======================================================
   END
====================================================== */
